/**
 * Host half of dsh-geo-report-to-fix.
 *
 * `geo_fix` fetches one page, scores its AI-search friendliness, and writes a
 * ready-to-paste fix pack (`llms.txt` + `jsonld.html`) into the workspace.
 * Three stages, one tool: fetch → analyze → generate. No browser, no model.
 *
 * @module dsh-geo-report-to-fix
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { fetchText, probeLlmsTxt } from '../core/fetcher.js'
import { parsePage } from '../core/html.js'
import { analyze, type AuditReport } from '../core/analyzer.js'
import { generateFixPack } from '../core/generator.js'

/** Plugin id used by the loader entry and diagnostics. */
export const name = 'geo-report-to-fix'

/** Only the tool registry is a hard dependency. */
export const inject = ['tools']

/** Whole-call budget; the performance contract is under 10 seconds. */
const TOTAL_BUDGET_MS = 9_500
/** Page budget. */
const PAGE_TIMEOUT_MS = 6_000
/** `llms.txt` probe budget; a miss is the common case. */
const LLMS_TIMEOUT_MS = 3_000
/** Cap for the page body. */
const PAGE_MAX_BYTES = 2 * 1024 * 1024

/** Narrow view of the session header the file tools also read. */
interface WorkspaceExec {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** The calling session's workspace, with `process.cwd()` as the fallback. */
function workspaceOf(exec: ToolRunContext): string {
  const view = exec as unknown as WorkspaceExec
  const cwd = view.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** The check shape returned to the model. */
const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    weight: { type: 'integer', required: true },
    passed: { type: 'boolean', required: true },
    detail: { type: 'string', required: true },
  },
} as const

/** Render one check line from the schema-shaped value. */
function checkLine(check: { passed: boolean; label: string; weight: number; detail: string }): string {
  return `${check.passed ? '✅' : '⚠️'} ${check.label}（${check.weight} 分）— ${check.detail}`
}

/** Validate the tool's own output before it reaches the model. */
function requireHtml(contentType: string, url: string): void {
  const lowered = contentType.toLowerCase()
  if (!lowered.includes('html')) throw new Error(`不是 HTML 页面（content-type: ${contentType || '未知'}）：${url}`)
}

/** Register the host plugin. */
export function apply(ctx: { tools: { register(definition: unknown): () => void } }): void {
  ctx.tools.register(defineTool({
    name: 'geo_fix',
    description: [
      'Audit one public URL for AI-search (GEO) readiness and generate a paste-ready fix pack.',
      'Checks: title/meta-description length, single H1 with H2 sections, Organization and WebSite JSON-LD, /llms.txt presence, canonical, html lang, image alt coverage, page-level structured data, robots indexability. Score is the weighted pass rate over 100.',
      'Writes `geo-fix-<timestamp>/llms.txt` and `geo-fix-<timestamp>/jsonld.html` inside the session workspace; the user drops them into the site root / <head>. Fails fast on non-http(s) URLs, non-HTML bodies, and responses over the 6s/2MB budget.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: '要体检的完整 URL，例如 https://example.com/pricing' },
      outputDir: { type: 'string', description: '工作区内的输出目录，默认 geo-fix-<时间戳>' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          finalUrl: { type: 'string', required: true },
          siteName: { type: 'string', required: true },
          title: { type: 'string', required: true },
          score: { type: 'integer', required: true },
          grade: { type: 'string', required: true },
          passed: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          checks: { type: 'array', required: true, items: CHECK_SCHEMA },
          recommendations: { type: 'array', required: true, items: { type: 'string' } },
          structuredTypes: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
          llmsTxtPath: { type: 'string', required: true },
          jsonLdPath: { type: 'string', required: true },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        const failures = value.checks.filter(check => !check.passed)
        return [{
          type: 'text',
          text: [
            `### GEO 审计：${value.grade} · ${value.score}/100`,
            `${value.finalUrl}`,
            '',
            value.checks.map(checkLine).join('\n'),
            '',
            failures.length === 0
              ? '所有检查项通过。修复包仍包含一份规范化 llms.txt 与 JSON-LD，可直接替换现有版本。'
              : `**优先修复（按权重）**\n${value.recommendations.slice(0, 5).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            '',
            value.truncated ? '注意：页面超过 2MB，分析基于截断后的内容。\n' : '',
            '**已生成修复包**',
            `- ${value.llmsTxtPath} → 放到网站根目录`,
            `- ${value.jsonLdPath} → 粘贴到 <head>`,
            `耗时 ${value.elapsedMs}ms`,
          ].join('\n'),
        }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: `GEO 体检：${args.url}`, kind: 'fetch', rawInput: { url: args.url } }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const startedAt = Date.now()
      const workspace = workspaceOf(exec)
      const signal = (exec as unknown as { signal?: AbortSignal }).signal
      const directoryName = args.outputDir === undefined || args.outputDir.trim() === '' ? `geo-fix-${startedAt}` : args.outputDir
      const target = path.resolve(workspace, directoryName)
      const relative = path.relative(workspace, target)
      if (relative === '' || relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)) {
        throw new Error('outputDir 必须位于当前工作区内')
      }

      const page = await fetchText(args.url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES, signal })
      if (page.status < 200 || page.status >= 300) throw new Error(`抓取返回 ${page.status}：${page.url}`)
      requireHtml(page.contentType, page.url)
      if (page.body.trim() === '') throw new Error(`页面内容为空：${page.url}`)

      const base = new URL(page.url).origin
      const remaining = Math.max(500, TOTAL_BUDGET_MS - (Date.now() - startedAt))
      const llms = await probeLlmsTxt(base, Math.min(LLMS_TIMEOUT_MS, remaining), signal)
      if (signal?.aborted === true) throw new Error('抓取被取消')

      const parsed = parsePage(page.body, args.url, page.url)
      const report: AuditReport = analyze(parsed, llms)
      const pack = generateFixPack(parsed, report)

      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'llms.txt'), pack.llmsTxt, 'utf8')
      await writeFile(path.join(target, 'jsonld.html'), pack.jsonLd, 'utf8')

      return {
        url: args.url,
        finalUrl: parsed.finalUrl,
        siteName: parsed.siteName,
        title: parsed.title,
        score: report.score,
        grade: report.grade,
        passed: report.passed,
        failed: report.failed,
        checks: report.checks.map(check => ({ id: check.id, label: check.label, weight: check.weight, passed: check.passed, detail: check.detail })),
        recommendations: report.recommendations,
        structuredTypes: report.structuredTypes,
        truncated: page.truncated,
        llmsTxtPath: `${relative.split(path.sep).join('/')}/llms.txt`,
        jsonLdPath: `${relative.split(path.sep).join('/')}/jsonld.html`,
        elapsedMs: Date.now() - startedAt,
      }
    },
  }))
}
