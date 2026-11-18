// src/host/index.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/core/fetcher.ts
import { TextDecoder } from "node:util";
var USER_AGENT = "dsh-geo-report-to-fix/0.1.0";
function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`URL \u65E0\u6CD5\u89E3\u6790\uFF1A${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`\u53EA\u652F\u6301 http/https\uFF0C\u6536\u5230 ${url.protocol}`);
  }
  if (url.hostname === "") throw new Error(`URL \u7F3A\u5C11\u4E3B\u673A\u540D\uFF1A${value}`);
  return url;
}
function charsetOf(contentType) {
  const match = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i);
  return match === null ? "" : (match[1] ?? "").trim();
}
function decoderFor(label) {
  if (label === "") return new TextDecoder("utf-8");
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder("utf-8");
  }
}
function abortWithin(timeoutMs, outer) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const forward = () => controller.abort();
  if (outer !== void 0) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    }
  };
}
async function readCapped(body, maxBytes, charset) {
  if (body === null) return { text: "", bytes: 0, truncated: false };
  const reader = body.getReader();
  const decoder = decoderFor(charset);
  let bytes = 0;
  let truncated = false;
  let text = "";
  try {
    for (; ; ) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        const keep = Math.max(0, chunk.byteLength - (bytes - maxBytes));
        text += decoder.decode(chunk.subarray(0, keep));
        truncated = true;
        break;
      }
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
  text += decoder.decode();
  return { text, bytes, truncated };
}
function describeFailure(cause, url, timeoutMs, timedOut, outer) {
  if (outer !== void 0 && outer.aborted) return new Error(`\u6293\u53D6\u88AB\u53D6\u6D88\uFF1A${url}`);
  if (timedOut) return new Error(`\u6293\u53D6\u8D85\u65F6\uFF08>${timeoutMs}ms\uFF09\uFF1A${url}`);
  return new Error(`\u6293\u53D6\u5931\u8D25\uFF1A${url}\uFF08${cause instanceof Error ? cause.message : String(cause)}\uFF09`);
}
async function fetchText(value, limits) {
  const url = assertHttpUrl(value);
  const abort = abortWithin(limits.timeoutMs, limits.signal);
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: abort.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,*/*" }
    });
  } catch (cause) {
    abort.dispose();
    throw describeFailure(cause, url.href, limits.timeoutMs, abort.timedOut(), limits.signal);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const charset = charsetOf(contentType);
  let read;
  try {
    read = await readCapped(response.body, limits.maxBytes, charset);
  } catch (cause) {
    throw describeFailure(cause, response.url === "" ? url.href : response.url, limits.timeoutMs, abort.timedOut(), limits.signal);
  } finally {
    abort.dispose();
  }
  return {
    url: response.url === "" ? url.href : response.url,
    status: response.status,
    body: read.text,
    bytes: read.bytes,
    truncated: read.truncated,
    contentType,
    charset: charset === "" ? "utf-8" : charset
  };
}
async function probeLlmsTxt(origin, timeoutMs, signal) {
  const url = `${origin}/llms.txt`;
  try {
    const document = await fetchText(url, { timeoutMs, maxBytes: 256 * 1024, signal });
    const present = document.status >= 200 && document.status < 300 && document.body.trim() !== "";
    return { url, present, bytes: document.bytes, excerpt: present ? document.body.slice(0, 400) : "" };
  } catch {
    return { url, present: false, bytes: 0, excerpt: "" };
  }
}

// src/core/html.ts
function decode(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'").replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}
function plain(value) {
  return decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function attribute(tag, name2) {
  const wanted = name2.toLowerCase();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    if ((match[1] ?? "").toLowerCase() !== wanted) continue;
    return decode((match[2] ?? match[3] ?? match[4] ?? "").trim());
  }
  return "";
}
function tagSources(html, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  return [...html.matchAll(pattern)].map((match) => match[0]);
}
function collectNodes(value) {
  if (Array.isArray(value)) return value.flatMap((item) => collectNodes(item));
  if (typeof value !== "object" || value === null) return [];
  const record = value;
  if (Array.isArray(record["@graph"])) return collectNodes(record["@graph"]);
  const type = record["@type"];
  const types = Array.isArray(type) ? type.filter((item) => typeof item === "string") : typeof type === "string" ? [type] : [];
  return [{ types, value: record }];
}
function stringField(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return "";
}
function parsePage(html, requestedUrl, finalUrl) {
  const base = finalUrl === "" ? requestedUrl : finalUrl;
  const origin = new URL(base).origin;
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleTag === null ? "" : plain(titleTag[1] ?? "");
  const metaTags = tagSources(html, "meta");
  const metaByName = (name2) => {
    const found = metaTags.find((tag) => attribute(tag, "name").toLowerCase() === name2 || attribute(tag, "property").toLowerCase() === name2);
    return found === void 0 ? "" : attribute(found, "content");
  };
  const description = metaByName("description") !== "" ? metaByName("description") : metaByName("og:description");
  const robots = metaByName("robots").toLowerCase();
  const siteName = metaByName("og:site_name");
  const htmlTag = tagSources(html, "html")[0] ?? "";
  const lang = attribute(htmlTag, "lang");
  const linkTags = tagSources(html, "link");
  const canonicalTag = linkTags.find((tag) => attribute(tag, "rel").toLowerCase().split(/\s+/).includes("canonical"));
  let canonical = "";
  if (canonicalTag !== void 0) {
    const href = attribute(canonicalTag, "href");
    if (href !== "") canonical = new URL(href, base).href;
  }
  const headingTexts = (tag) => {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    return [...html.matchAll(pattern)].map((match) => plain(match[1] ?? "")).filter((text) => text !== "");
  };
  const imageTags = tagSources(html, "img");
  const images = {
    total: imageTags.length,
    withAlt: imageTags.filter((tag) => attribute(tag, "alt") !== "").length
  };
  const seen = /* @__PURE__ */ new Set();
  const links = [];
  const anchorPattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const href = attribute(tag, "href");
    if (href === "" || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    let absolute;
    try {
      absolute = new URL(href, base);
    } catch {
      continue;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
    if (absolute.origin !== origin) continue;
    const path2 = absolute.pathname;
    if (path2 === "/" && absolute.search === "") continue;
    const key = `${path2}${absolute.search}${absolute.hash}`;
    if (seen.has(key) || links.length >= 80) continue;
    seen.add(key);
    links.push({ href: absolute.href, text: plain(match[1] ?? "") });
  }
  const structured = [];
  let jsonLdBlocks = 0;
  const scriptPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    jsonLdBlocks += 1;
    const text = (match[1] ?? "").trim();
    if (text === "") continue;
    try {
      structured.push(...collectNodes(JSON.parse(text)));
    } catch {
    }
  }
  return {
    requestedUrl,
    finalUrl: base,
    title,
    description,
    siteName: siteName !== "" ? siteName : title.split(/\s+[-|–—]\s+/)[0] ?? "",
    lang,
    canonical,
    robots,
    h1: headingTexts("h1"),
    h2: headingTexts("h2"),
    images,
    links,
    structured,
    jsonLdBlocks
  };
}
function structuredTypes(page) {
  const types = /* @__PURE__ */ new Set();
  for (const node of page.structured) for (const type of node.types) types.add(type);
  return [...types];
}
function findNode(page, type) {
  for (const node of page.structured) {
    if (node.types.some((candidate) => candidate.toLowerCase() === type.toLowerCase())) return node.value;
  }
  return null;
}
function organizationName(page) {
  const node = findNode(page, "Organization");
  if (node !== null) {
    const name2 = stringField(node, ["name", "legalName"]);
    if (name2 !== "") return name2;
  }
  return page.siteName === "" ? page.title : page.siteName;
}

// src/core/analyzer.ts
function length(text) {
  return [...text].length;
}
function gradeOf(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  return "D";
}
function analyze(page, llms) {
  const types = structuredTypes(page);
  const org = findNode(page, "Organization");
  const website = findNode(page, "WebSite");
  const orgComplete = org !== null && typeof org.name === "string" && org.name.trim() !== "" && typeof org.url === "string" && org.url.trim() !== "";
  const extra = types.some((type) => ["Article", "FAQPage", "BreadcrumbList", "Product", "SoftwareApplication", "HowTo"].includes(type));
  const altCoverage = page.images.total === 0 ? 1 : page.images.withAlt / page.images.total;
  const canonicalOk = page.canonical !== "" && new URL(page.canonical).origin === new URL(page.finalUrl).origin;
  const titleOk = length(page.title) >= 10 && length(page.title) <= 70;
  const descriptionOk = length(page.description) >= 40 && length(page.description) <= 200;
  const headingsOk = page.h1.length === 1 && page.h2.length >= 2;
  const indexable = page.robots === "" || !page.robots.includes("noindex") && !page.robots.includes("none");
  const checks = [
    {
      id: "title",
      label: "Title \u957F\u5EA6 10-70 \u5B57\u4E14\u5B58\u5728",
      weight: 10,
      passed: titleOk,
      detail: page.title === "" ? "\u7F3A\u5C11 <title>" : `\u300C${page.title}\u300D\uFF08${length(page.title)} \u5B57\uFF09`,
      fix: "\u628A title \u5199\u6210\u300C\u6838\u5FC3\u5173\u952E\u8BCD + \u4E00\u53E5\u4EF7\u503C\u4E3B\u5F20\u300D\uFF0C\u63A7\u5236\u5728 10-70 \u5B57\uFF0C\u907F\u514D\u7EAF\u54C1\u724C\u540D\u3002"
    },
    {
      id: "description",
      label: "Meta description 40-200 \u5B57",
      weight: 10,
      passed: descriptionOk,
      detail: page.description === "" ? "\u7F3A\u5C11 meta description \u4E0E og:description" : `${length(page.description)} \u5B57`,
      fix: "\u8865\u4E00\u6761 40-200 \u5B57\u7684 description\uFF0C\u5199\u6E05\u300C\u662F\u4EC0\u4E48\u3001\u7ED9\u8C01\u7528\u3001\u6709\u4EC0\u4E48\u4E0D\u540C\u300D\uFF0CAI \u6458\u8981\u4F1A\u76F4\u63A5\u5F15\u7528\u3002"
    },
    {
      id: "headings",
      label: "\u5355\u4E00 H1 \u4E14\u81F3\u5C11\u6709 2 \u4E2A H2",
      weight: 10,
      passed: headingsOk,
      detail: `H1 ${page.h1.length} \u4E2A / H2 ${page.h2.length} \u4E2A`,
      fix: "\u4FDD\u7559\u4E00\u4E2A H1 \u6982\u62EC\u4E3B\u9898\uFF0C\u7528 H2 \u5207\u5206\u53EF\u88AB\u5355\u72EC\u5F15\u7528\u7684\u95EE\u7B54\u5F0F\u5C0F\u8282\u3002"
    },
    {
      id: "org-schema",
      label: "Organization JSON-LD\uFF08name + url\uFF09",
      weight: 15,
      passed: orgComplete,
      detail: org === null ? "\u6CA1\u6709 Organization \u7ED3\u6784\u5316\u6570\u636E" : "Organization \u5B58\u5728\u4F46\u7F3A\u5C11 name \u6216 url",
      fix: "\u5728 <head> \u52A0\u5165 Organization JSON-LD\uFF08name\u3001url\u3001logo\u3001sameAs\uFF09\uFF0C\u8FD9\u662F AI \u8BC6\u522B\u5B9E\u4F53\u5F52\u5C5E\u7684\u5165\u53E3\u3002"
    },
    {
      id: "website-schema",
      label: "WebSite JSON-LD",
      weight: 10,
      passed: website !== null,
      detail: website === null ? "\u6CA1\u6709 WebSite \u7ED3\u6784\u5316\u6570\u636E" : "\u5DF2\u5B58\u5728 WebSite",
      fix: "\u8865\u5145 WebSite JSON-LD\uFF08name\u3001url\uFF09\uFF0C\u8BA9 AI \u628A\u7AD9\u70B9\u5F53\u6210\u4E00\u4E2A\u53EF\u5F15\u7528\u5B9E\u4F53\u800C\u975E\u6563\u843D\u9875\u9762\u3002"
    },
    {
      id: "llms-txt",
      label: "\u7AD9\u70B9\u6839\u76EE\u5F55\u6709 llms.txt",
      weight: 15,
      passed: llms.present,
      detail: llms.present ? `${llms.bytes} \u5B57\u8282` : `\u672A\u627E\u5230 ${llms.url}`,
      fix: "\u628A\u751F\u6210\u7684 llms.txt \u653E\u5230\u7AD9\u70B9\u6839\u76EE\u5F55\uFF0C\u7528 H1 + \u6458\u8981 + \u6838\u5FC3\u94FE\u63A5\u544A\u8BC9 AI \u54EA\u4E9B\u5185\u5BB9\u503C\u5F97\u5F15\u7528\u3002"
    },
    {
      id: "canonical",
      label: "Canonical \u6307\u5411\u672C\u7AD9",
      weight: 5,
      passed: canonicalOk,
      detail: page.canonical === "" ? "\u7F3A\u5C11 rel=canonical" : page.canonical,
      fix: "\u4E3A\u6BCF\u4E2A\u9875\u9762\u58F0\u660E\u81EA\u5F15\u7528 canonical\uFF0C\u907F\u514D\u540C\u4E00\u5185\u5BB9\u4EE5\u591A\u4E2A URL \u88AB\u91CD\u590D\u5F15\u7528\u3002"
    },
    {
      id: "lang",
      label: "<html lang> \u5DF2\u58F0\u660E",
      weight: 5,
      passed: page.lang !== "",
      detail: page.lang === "" ? "\u7F3A\u5C11 lang \u5C5E\u6027" : page.lang,
      fix: "\u5728 <html> \u4E0A\u58F0\u660E lang\uFF08\u5982 zh-CN\uFF09\uFF0C\u5F71\u54CD AI \u7684\u8BED\u8A00\u5224\u5B9A\u4E0E\u5730\u533A\u5339\u914D\u3002"
    },
    {
      id: "image-alt",
      label: "\u56FE\u7247 alt \u8986\u76D6\u7387 \u2265 80%",
      weight: 10,
      passed: altCoverage >= 0.8,
      detail: page.images.total === 0 ? "\u9875\u9762\u65E0\u56FE\u7247\uFF08\u6309\u901A\u8FC7\u8BA1\uFF09" : `${page.images.withAlt}/${page.images.total} \u6709 alt`,
      fix: "\u4E3A\u4FE1\u606F\u6027\u56FE\u7247\u8865 alt\uFF0CAI \u8BFB\u4E0D\u5230\u56FE\uFF0C\u53EA\u80FD\u9760 alt \u7406\u89E3\u56FE\u7247\u5185\u5BB9\u3002"
    },
    {
      id: "structured-extra",
      label: "\u5B58\u5728\u9875\u9762\u7EA7\u7ED3\u6784\u5316\u6570\u636E\uFF08Article/FAQ/Product \u7B49\uFF09",
      weight: 5,
      passed: extra,
      detail: types.length === 0 ? "\u6CA1\u6709\u53EF\u89E3\u6790\u7684 JSON-LD" : `\u5DF2\u53D1\u73B0\uFF1A${types.join(" / ")}`,
      fix: "\u6309\u5185\u5BB9\u7C7B\u578B\u8865 Article / FAQPage / BreadcrumbList / Product\uFF0C\u7ED3\u6784\u5316\u5B57\u6BB5\u662F AI \u6458\u8981\u7684\u4E8B\u5B9E\u6765\u6E90\u3002"
    },
    {
      id: "indexable",
      label: "\u672A\u88AB robots \u7981\u6B62\u7D22\u5F15",
      weight: 5,
      passed: indexable,
      detail: page.robots === "" ? "\u672A\u58F0\u660E robots\uFF08\u9ED8\u8BA4\u53EF\u7D22\u5F15\uFF09" : page.robots,
      fix: "\u79FB\u9664 meta robots \u7684 noindex/none\uFF0C\u5426\u5219\u6293\u53D6\u65B9\u4F1A\u76F4\u63A5\u8DF3\u8FC7\u8BE5\u9875\u3002"
    }
  ];
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const score = Math.round(earned / totalWeight * 100);
  const failed = checks.filter((check) => !check.passed);
  return {
    score,
    grade: gradeOf(score),
    checks,
    passed: checks.length - failed.length,
    failed: failed.length,
    structuredTypes: types,
    recommendations: failed.slice().sort((left, right) => right.weight - left.weight).map((check) => check.fix)
  };
}

// src/core/generator.ts
function scriptJson(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
function bullet(text, href) {
  const label = text.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\|/g, "/").trim();
  return `- [${label === "" ? href : label}](${href})`;
}
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}
function generateFixPack(page, report) {
  const origin = new URL(page.finalUrl).origin;
  const site = organizationName(page);
  const summary = oneLine(page.description) === "" ? `${page.title}\uFF08${origin}\uFF09` : oneLine(page.description);
  const core = page.links.filter((link) => link.text !== "" && !/^(登录|注册|sign in|log in|privacy|隐私|条款|terms)/i.test(link.text)).slice(0, 10);
  const sections = page.h2.slice(0, 12);
  const llms = [
    `# ${site}`,
    "",
    `> ${summary}`,
    "",
    "\u672C\u7AD9\u9762\u5411 AI \u641C\u7D22\u4E0E\u7B54\u6848\u5F15\u64CE\u63D0\u4F9B\u53EF\u5F15\u7528\u7684\u539F\u59CB\u4FE1\u606F\u3002\u4EE5\u4E0B\u4E3A\u63A8\u8350\u5165\u53E3\u4E0E\u5185\u5BB9\u7ED3\u6784\u3002",
    "",
    "## \u6838\u5FC3\u9875\u9762",
    "",
    core.length === 0 ? `- [${site}](${origin})` : core.map((link) => bullet(link.text, link.href)).join("\n"),
    "",
    "## \u5185\u5BB9\u7ED3\u6784",
    "",
    sections.length === 0 ? "- \u65E0 H2 \u5C0F\u8282\uFF08\u5EFA\u8BAE\u7528 H2 \u5207\u5206\u4E3B\u9898\uFF09" : sections.map((section) => `- ${section}`).join("\n"),
    "",
    "## \u53EF\u9009",
    "",
    `- [\u7AD9\u70B9\u9996\u9875](${origin})`,
    "",
    `<!-- \u7531 dsh-geo-report-to-fix \u751F\u6210 \xB7 \u5BA1\u8BA1\u5F97\u5206 ${report.score}/100\uFF08${report.grade}\uFF09 -->`,
    ""
  ].join("\n");
  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: site,
    url: origin
  };
  if (oneLine(page.description) !== "") organization.description = oneLine(page.description).slice(0, 300);
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: site,
    url: origin
  };
  if (page.lang !== "") website.inLanguage = page.lang;
  if (oneLine(page.description) !== "") website.description = oneLine(page.description).slice(0, 300);
  const jsonLd = [
    "<!-- \u7531 dsh-geo-report-to-fix \u751F\u6210\uFF1A\u628A\u4E0B\u9762\u4E24\u6BB5\u7C98\u8D34\u5230\u7AD9\u70B9 <head>\uFF1B\u5DF2\u6709\u540C\u7C7B\u811A\u672C\u8BF7\u66FF\u6362\u800C\u975E\u53E0\u52A0 -->",
    '<script type="application/ld+json">',
    scriptJson(organization),
    "</script>",
    '<script type="application/ld+json">',
    scriptJson(website),
    "</script>",
    ""
  ].join("\n");
  return { llmsTxt: llms, jsonLd };
}

// src/host/index.ts
var name = "geo-report-to-fix";
var inject = ["tools"];
var TOTAL_BUDGET_MS = 9500;
var PAGE_TIMEOUT_MS = 6e3;
var LLMS_TIMEOUT_MS = 3e3;
var PAGE_MAX_BYTES = 2 * 1024 * 1024;
function workspaceOf(exec) {
  const view = exec;
  const cwd = view.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}
var CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    label: { type: "string", required: true },
    weight: { type: "integer", required: true },
    passed: { type: "boolean", required: true },
    detail: { type: "string", required: true }
  }
};
function checkLine(check) {
  return `${check.passed ? "\u2705" : "\u26A0\uFE0F"} ${check.label}\uFF08${check.weight} \u5206\uFF09\u2014 ${check.detail}`;
}
function requireHtml(contentType, url) {
  const lowered = contentType.toLowerCase();
  if (!lowered.includes("html")) throw new Error(`\u4E0D\u662F HTML \u9875\u9762\uFF08content-type: ${contentType || "\u672A\u77E5"}\uFF09\uFF1A${url}`);
}
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "geo_fix",
    description: [
      "Audit one public URL for AI-search (GEO) readiness and generate a paste-ready fix pack.",
      "Checks: title/meta-description length, single H1 with H2 sections, Organization and WebSite JSON-LD, /llms.txt presence, canonical, html lang, image alt coverage, page-level structured data, robots indexability. Score is the weighted pass rate over 100.",
      "Writes `geo-fix-<timestamp>/llms.txt` and `geo-fix-<timestamp>/jsonld.html` inside the session workspace; the user drops them into the site root / <head>. Fails fast on non-http(s) URLs, non-HTML bodies, and responses over the 6s/2MB budget."
    ].join(" "),
    parameters: {
      url: { type: "string", required: true, description: "\u8981\u4F53\u68C0\u7684\u5B8C\u6574 URL\uFF0C\u4F8B\u5982 https://example.com/pricing" },
      outputDir: { type: "string", description: "\u5DE5\u4F5C\u533A\u5185\u7684\u8F93\u51FA\u76EE\u5F55\uFF0C\u9ED8\u8BA4 geo-fix-<\u65F6\u95F4\u6233>" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          finalUrl: { type: "string", required: true },
          siteName: { type: "string", required: true },
          title: { type: "string", required: true },
          score: { type: "integer", required: true },
          grade: { type: "string", required: true },
          passed: { type: "integer", required: true },
          failed: { type: "integer", required: true },
          checks: { type: "array", required: true, items: CHECK_SCHEMA },
          recommendations: { type: "array", required: true, items: { type: "string" } },
          structuredTypes: { type: "array", required: true, items: { type: "string" } },
          truncated: { type: "boolean", required: true },
          llmsTxtPath: { type: "string", required: true },
          jsonLdPath: { type: "string", required: true },
          elapsedMs: { type: "integer", required: true }
        }
      },
      render(_args, value) {
        const failures = value.checks.filter((check) => !check.passed);
        return [{
          type: "text",
          text: [
            `### GEO \u5BA1\u8BA1\uFF1A${value.grade} \xB7 ${value.score}/100`,
            `${value.finalUrl}`,
            "",
            value.checks.map(checkLine).join("\n"),
            "",
            failures.length === 0 ? "\u6240\u6709\u68C0\u67E5\u9879\u901A\u8FC7\u3002\u4FEE\u590D\u5305\u4ECD\u5305\u542B\u4E00\u4EFD\u89C4\u8303\u5316 llms.txt \u4E0E JSON-LD\uFF0C\u53EF\u76F4\u63A5\u66FF\u6362\u73B0\u6709\u7248\u672C\u3002" : `**\u4F18\u5148\u4FEE\u590D\uFF08\u6309\u6743\u91CD\uFF09**
${value.recommendations.slice(0, 5).map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
            "",
            value.truncated ? "\u6CE8\u610F\uFF1A\u9875\u9762\u8D85\u8FC7 2MB\uFF0C\u5206\u6790\u57FA\u4E8E\u622A\u65AD\u540E\u7684\u5185\u5BB9\u3002\n" : "",
            "**\u5DF2\u751F\u6210\u4FEE\u590D\u5305**",
            `- ${value.llmsTxtPath} \u2192 \u653E\u5230\u7F51\u7AD9\u6839\u76EE\u5F55`,
            `- ${value.jsonLdPath} \u2192 \u7C98\u8D34\u5230 <head>`,
            `\u8017\u65F6 ${value.elapsedMs}ms`
          ].join("\n")
        }];
      }
    },
    presentCall(args) {
      return { card: "generic", title: `GEO \u4F53\u68C0\uFF1A${args.url}`, kind: "fetch", rawInput: { url: args.url } };
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const startedAt = Date.now();
      const workspace = workspaceOf(exec);
      const signal = exec.signal;
      const directoryName = args.outputDir === void 0 || args.outputDir.trim() === "" ? `geo-fix-${startedAt}` : args.outputDir;
      const target = path.resolve(workspace, directoryName);
      const relative = path.relative(workspace, target);
      if (relative === "" || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) {
        throw new Error("outputDir \u5FC5\u987B\u4F4D\u4E8E\u5F53\u524D\u5DE5\u4F5C\u533A\u5185");
      }
      const page = await fetchText(args.url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES, signal });
      if (page.status < 200 || page.status >= 300) throw new Error(`\u6293\u53D6\u8FD4\u56DE ${page.status}\uFF1A${page.url}`);
      requireHtml(page.contentType, page.url);
      if (page.body.trim() === "") throw new Error(`\u9875\u9762\u5185\u5BB9\u4E3A\u7A7A\uFF1A${page.url}`);
      const base = new URL(page.url).origin;
      const remaining = Math.max(500, TOTAL_BUDGET_MS - (Date.now() - startedAt));
      const llms = await probeLlmsTxt(base, Math.min(LLMS_TIMEOUT_MS, remaining), signal);
      if (signal?.aborted === true) throw new Error("\u6293\u53D6\u88AB\u53D6\u6D88");
      const parsed = parsePage(page.body, args.url, page.url);
      const report = analyze(parsed, llms);
      const pack = generateFixPack(parsed, report);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "llms.txt"), pack.llmsTxt, "utf8");
      await writeFile(path.join(target, "jsonld.html"), pack.jsonLd, "utf8");
      return {
        url: args.url,
        finalUrl: parsed.finalUrl,
        siteName: parsed.siteName,
        title: parsed.title,
        score: report.score,
        grade: report.grade,
        passed: report.passed,
        failed: report.failed,
        checks: report.checks.map((check) => ({ id: check.id, label: check.label, weight: check.weight, passed: check.passed, detail: check.detail })),
        recommendations: report.recommendations,
        structuredTypes: report.structuredTypes,
        truncated: page.truncated,
        llmsTxtPath: `${relative.split(path.sep).join("/")}/llms.txt`,
        jsonLdPath: `${relative.split(path.sep).join("/")}/jsonld.html`,
        elapsedMs: Date.now() - startedAt
      };
    }
  }));
}
export {
  apply,
  inject,
  name
};
