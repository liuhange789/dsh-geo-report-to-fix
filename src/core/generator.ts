/**
 * Fix-pack rendering: pure templates that turn the audit into files a site
 * owner can paste without editing code.
 */

import { organizationName, type PageData } from './html.js'

/** The two generated files. */
export interface FixPack {
  /** `llms.txt`, rooted at the site H1 with a summary and the core links. */
  llmsTxt: string
  /** `jsonld.html`, two `<script type="application/ld+json">` blocks. */
  jsonLd: string
}

/** JSON that is safe inside an HTML `<script>` body. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

/** One Markdown list item; `[` in a label would break the link syntax. */
function bullet(text: string, href: string): string {
  const label = text.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\|/g, '/').trim()
  return `- [${label === '' ? href : label}](${href})`
}

/** Collapse a description to one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Render both files.
 * @param page - parsed page.
 * @param report - audit result, for the failing-check notes.
 * @returns the fix pack.
 */
export function generateFixPack(page: PageData, report: { score: number; grade: string; recommendations: string[] }): FixPack {
  const origin = new URL(page.finalUrl).origin
  const site = organizationName(page)
  const summary = oneLine(page.description) === ''
    ? `${page.title}（${origin}）`
    : oneLine(page.description)

  const core = page.links
    .filter(link => link.text !== '' && !/^(登录|注册|sign in|log in|privacy|隐私|条款|terms)/i.test(link.text))
    .slice(0, 10)
  const sections = page.h2.slice(0, 12)

  const llms = [
    `# ${site}`,
    '',
    `> ${summary}`,
    '',
    '本站面向 AI 搜索与答案引擎提供可引用的原始信息。以下为推荐入口与内容结构。',
    '',
    '## 核心页面',
    '',
    core.length === 0 ? `- [${site}](${origin})` : core.map(link => bullet(link.text, link.href)).join('\n'),
    '',
    '## 内容结构',
    '',
    sections.length === 0 ? '- 无 H2 小节（建议用 H2 切分主题）' : sections.map(section => `- ${section}`).join('\n'),
    '',
    '## 可选',
    '',
    `- [站点首页](${origin})`,
    '',
    `<!-- 由 dsh-geo-report-to-fix 生成 · 审计得分 ${report.score}/100（${report.grade}） -->`,
    '',
  ].join('\n')

  const organization: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: site,
    url: origin,
  }
  if (oneLine(page.description) !== '') organization.description = oneLine(page.description).slice(0, 300)
  const website: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    name: site,
    url: origin,
  }
  if (page.lang !== '') website.inLanguage = page.lang
  if (oneLine(page.description) !== '') website.description = oneLine(page.description).slice(0, 300)

  const jsonLd = [
    '<!-- 由 dsh-geo-report-to-fix 生成：把下面两段粘贴到站点 <head>；已有同类脚本请替换而非叠加 -->',
    '<script type="application/ld+json">',
    scriptJson(organization),
    '</script>',
    '<script type="application/ld+json">',
    scriptJson(website),
    '</script>',
    '',
  ].join('\n')

  return { llmsTxt: llms, jsonLd }
}
