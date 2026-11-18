/**
 * Dependency-free HTML probing. This is not a parser — it extracts the exact
 * handful of signals a GEO audit needs, and documents where it can miss:
 * attributes must not contain `>` inside quoted values, and script bodies are
 * only read for `application/ld+json`.
 */

/** One `<a>` on the page. */
export interface PageLink {
  href: string
  text: string
}

/** One JSON-LD object found on the page. */
export interface StructuredNode {
  /** `@type` values, flattened from arrays and `@graph`. */
  types: string[]
  /** The parsed object, used for name/url extraction. */
  value: Record<string, unknown>
}

/** Everything the analyzer reads from one page. */
export interface PageData {
  requestedUrl: string
  finalUrl: string
  /** `<title>`, trimmed and entity-decoded. */
  title: string
  /** `meta[name=description]`, else `og:description`. */
  description: string
  /** `og:site_name`, else the title prefix. */
  siteName: string
  /** `<html lang>`. */
  lang: string
  /** Absolute `link[rel=canonical]`, empty when absent. */
  canonical: string
  /** `meta[name=robots]`, lowercase. */
  robots: string
  h1: string[]
  h2: string[]
  images: { total: number; withAlt: number }
  /** Absolute same-origin links, deduplicated. */
  links: PageLink[]
  /** Parsed JSON-LD nodes. */
  structured: StructuredNode[]
  /** Number of `application/ld+json` blocks seen. */
  jsonLdBlocks: number
}

/** Decode the handful of entities that matter for titles and headings. */
function decode(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, '\'')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

/** Strip tags and collapse whitespace. */
function plain(value: string): string {
  return decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Read one attribute from a tag's source text (quoted, single-quoted, or bare). */
function attribute(tag: string, name: string): string {
  const wanted = name.toLowerCase()
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  for (const match of tag.matchAll(pattern)) {
    if ((match[1] ?? '').toLowerCase() !== wanted) continue
    return decode((match[2] ?? match[3] ?? match[4] ?? '').trim())
  }
  return ''
}

/** Collect source text of every `<tag ...>` in the document. */
function tagSources(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  return [...html.matchAll(pattern)].map(match => match[0])
}

/** Flatten `@type` from one JSON-LD object, following `@graph`. */
function collectNodes(value: unknown): StructuredNode[] {
  if (Array.isArray(value)) return value.flatMap(item => collectNodes(item))
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record['@graph'])) return collectNodes(record['@graph'])
  const type = record['@type']
  const types = Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string') : typeof type === 'string' ? [type] : []
  return [{ types, value: record }]
}

/** First string value among candidate keys. */
function stringField(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * Extract the audit signals from one fetched page.
 * @param html - decoded response body.
 * @param requestedUrl - URL the caller asked for.
 * @param finalUrl - URL after redirects, used as the base for relative links.
 * @returns the page projection.
 */
export function parsePage(html: string, requestedUrl: string, finalUrl: string): PageData {
  const base = finalUrl === '' ? requestedUrl : finalUrl
  const origin = new URL(base).origin

  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleTag === null ? '' : plain(titleTag[1] ?? '')

  const metaTags = tagSources(html, 'meta')
  const metaByName = (name: string): string => {
    const found = metaTags.find(tag => attribute(tag, 'name').toLowerCase() === name || attribute(tag, 'property').toLowerCase() === name)
    return found === undefined ? '' : attribute(found, 'content')
  }
  const description = metaByName('description') !== '' ? metaByName('description') : metaByName('og:description')
  const robots = metaByName('robots').toLowerCase()
  const siteName = metaByName('og:site_name')

  const htmlTag = tagSources(html, 'html')[0] ?? ''
  const lang = attribute(htmlTag, 'lang')

  const linkTags = tagSources(html, 'link')
  const canonicalTag = linkTags.find(tag => attribute(tag, 'rel').toLowerCase().split(/\s+/).includes('canonical'))
  let canonical = ''
  if (canonicalTag !== undefined) {
    const href = attribute(canonicalTag, 'href')
    if (href !== '') canonical = new URL(href, base).href
  }

  const headingTexts = (tag: 'h1' | 'h2'): string[] => {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
    return [...html.matchAll(pattern)].map(match => plain(match[1] ?? '')).filter(text => text !== '')
  }

  const imageTags = tagSources(html, 'img')
  const images = {
    total: imageTags.length,
    withAlt: imageTags.filter(tag => attribute(tag, 'alt') !== '').length,
  }

  const seen = new Set<string>()
  const links: PageLink[] = []
  const anchorPattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(anchorPattern)) {
    const tag = match[0].slice(0, (match[0].indexOf('>') + 1))
    const href = attribute(tag, 'href')
    if (href === '' || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    let absolute: URL
    try {
      absolute = new URL(href, base)
    } catch {
      continue
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue
    if (absolute.origin !== origin) continue
    const path = absolute.pathname
    if (path === '/' && absolute.search === '') continue
    // Keep query and hash: a search page without `?q=` is a dead link.
    const key = `${path}${absolute.search}${absolute.hash}`
    if (seen.has(key) || links.length >= 80) continue
    seen.add(key)
    links.push({ href: absolute.href, text: plain(match[1] ?? '') })
  }

  const structured: StructuredNode[] = []
  let jsonLdBlocks = 0
  const scriptPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(scriptPattern)) {
    jsonLdBlocks += 1
    const text = (match[1] ?? '').trim()
    if (text === '') continue
    try {
      structured.push(...collectNodes(JSON.parse(text) as unknown))
    } catch {
      // Invalid JSON-LD is reported as a missing structure, not a crash.
    }
  }

  return {
    requestedUrl,
    finalUrl: base,
    title,
    description,
    siteName: siteName !== '' ? siteName : title.split(/\s+[-|–—]\s+/)[0] ?? '',
    lang,
    canonical,
    robots,
    h1: headingTexts('h1'),
    h2: headingTexts('h2'),
    images,
    links,
    structured,
    jsonLdBlocks,
  }
}

/** All distinct `@type` values found on the page. */
export function structuredTypes(page: PageData): string[] {
  const types = new Set<string>()
  for (const node of page.structured) for (const type of node.types) types.add(type)
  return [...types]
}

/** The Organization/WebSite node that best matches the page, when present. */
export function findNode(page: PageData, type: string): Record<string, unknown> | null {
  for (const node of page.structured) {
    if (node.types.some(candidate => candidate.toLowerCase() === type.toLowerCase())) return node.value
  }
  return null
}

/** Name for the JSON-LD Organization, preferring the page's own node. */
export function organizationName(page: PageData): string {
  const node = findNode(page, 'Organization')
  if (node !== null) {
    const name = stringField(node, ['name', 'legalName'])
    if (name !== '') return name
  }
  return page.siteName === '' ? page.title : page.siteName
}
