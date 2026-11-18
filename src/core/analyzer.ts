/**
 * GEO scoring. Every check is a deterministic predicate over the parsed page
 * plus the `/llms.txt` probe; weights sum to 100 and the score is the weighted
 * pass rate, so a new check never silently rebalances the scale.
 */

import { findNode, structuredTypes, type PageData } from './html.js'
import type { LlmsProbe } from './fetcher.js'

/** One scored check. */
export interface CheckItem {
  /** Stable id, used by tests and the report. */
  id: string
  /** Short label shown to the user. */
  label: string
  /** Contribution to the 100-point scale. */
  weight: number
  /** Whether the page satisfies the check. */
  passed: boolean
  /** What was actually found. */
  detail: string
  /** What to do when it failed. */
  fix: string
}

/** Audit result. */
export interface AuditReport {
  /** 0-100, weighted pass rate. */
  score: number
  /** Letter grade derived from the score. */
  grade: 'A' | 'B' | 'C' | 'D'
  checks: CheckItem[]
  passed: number
  failed: number
  /** Structured data types found on the page. */
  structuredTypes: string[]
  /** Failed checks' fix text, ordered by weight. */
  recommendations: string[]
}

/** Count characters rather than UTF-16 units, so CJK titles are measured fairly. */
function length(text: string): number {
  return [...text].length
}

/** Rank grade from the score. */
function gradeOf(score: number): 'A' | 'B' | 'C' | 'D' {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  return 'D'
}

/**
 * Score an audited page.
 * @param page - parsed page signals.
 * @param llms - `/llms.txt` probe result.
 */
export function analyze(page: PageData, llms: LlmsProbe): AuditReport {
  const types = structuredTypes(page)
  const org = findNode(page, 'Organization')
  const website = findNode(page, 'WebSite')
  const orgComplete = org !== null
    && typeof org.name === 'string' && org.name.trim() !== ''
    && typeof org.url === 'string' && org.url.trim() !== ''
  const extra = types.some(type => ['Article', 'FAQPage', 'BreadcrumbList', 'Product', 'SoftwareApplication', 'HowTo'].includes(type))
  const altCoverage = page.images.total === 0 ? 1 : page.images.withAlt / page.images.total
  const canonicalOk = page.canonical !== '' && new URL(page.canonical).origin === new URL(page.finalUrl).origin
  const titleOk = length(page.title) >= 10 && length(page.title) <= 70
  const descriptionOk = length(page.description) >= 40 && length(page.description) <= 200
  const headingsOk = page.h1.length === 1 && page.h2.length >= 2
  const indexable = page.robots === '' || (!page.robots.includes('noindex') && !page.robots.includes('none'))

  const checks: CheckItem[] = [
    {
      id: 'title',
      label: 'Title 长度 10-70 字且存在',
      weight: 10,
      passed: titleOk,
      detail: page.title === '' ? '缺少 <title>' : `「${page.title}」（${length(page.title)} 字）`,
      fix: '把 title 写成「核心关键词 + 一句价值主张」，控制在 10-70 字，避免纯品牌名。',
    },
    {
      id: 'description',
      label: 'Meta description 40-200 字',
      weight: 10,
      passed: descriptionOk,
      detail: page.description === '' ? '缺少 meta description 与 og:description' : `${length(page.description)} 字`,
      fix: '补一条 40-200 字的 description，写清「是什么、给谁用、有什么不同」，AI 摘要会直接引用。',
    },
    {
      id: 'headings',
      label: '单一 H1 且至少有 2 个 H2',
      weight: 10,
      passed: headingsOk,
      detail: `H1 ${page.h1.length} 个 / H2 ${page.h2.length} 个`,
      fix: '保留一个 H1 概括主题，用 H2 切分可被单独引用的问答式小节。',
    },
    {
      id: 'org-schema',
      label: 'Organization JSON-LD（name + url）',
      weight: 15,
      passed: orgComplete,
      detail: org === null ? '没有 Organization 结构化数据' : 'Organization 存在但缺少 name 或 url',
      fix: '在 <head> 加入 Organization JSON-LD（name、url、logo、sameAs），这是 AI 识别实体归属的入口。',
    },
    {
      id: 'website-schema',
      label: 'WebSite JSON-LD',
      weight: 10,
      passed: website !== null,
      detail: website === null ? '没有 WebSite 结构化数据' : '已存在 WebSite',
      fix: '补充 WebSite JSON-LD（name、url），让 AI 把站点当成一个可引用实体而非散落页面。',
    },
    {
      id: 'llms-txt',
      label: '站点根目录有 llms.txt',
      weight: 15,
      passed: llms.present,
      detail: llms.present ? `${llms.bytes} 字节` : `未找到 ${llms.url}`,
      fix: '把生成的 llms.txt 放到站点根目录，用 H1 + 摘要 + 核心链接告诉 AI 哪些内容值得引用。',
    },
    {
      id: 'canonical',
      label: 'Canonical 指向本站',
      weight: 5,
      passed: canonicalOk,
      detail: page.canonical === '' ? '缺少 rel=canonical' : page.canonical,
      fix: '为每个页面声明自引用 canonical，避免同一内容以多个 URL 被重复引用。',
    },
    {
      id: 'lang',
      label: '<html lang> 已声明',
      weight: 5,
      passed: page.lang !== '',
      detail: page.lang === '' ? '缺少 lang 属性' : page.lang,
      fix: '在 <html> 上声明 lang（如 zh-CN），影响 AI 的语言判定与地区匹配。',
    },
    {
      id: 'image-alt',
      label: '图片 alt 覆盖率 ≥ 80%',
      weight: 10,
      passed: altCoverage >= 0.8,
      detail: page.images.total === 0 ? '页面无图片（按通过计）' : `${page.images.withAlt}/${page.images.total} 有 alt`,
      fix: '为信息性图片补 alt，AI 读不到图，只能靠 alt 理解图片内容。',
    },
    {
      id: 'structured-extra',
      label: '存在页面级结构化数据（Article/FAQ/Product 等）',
      weight: 5,
      passed: extra,
      detail: types.length === 0 ? '没有可解析的 JSON-LD' : `已发现：${types.join(' / ')}`,
      fix: '按内容类型补 Article / FAQPage / BreadcrumbList / Product，结构化字段是 AI 摘要的事实来源。',
    },
    {
      id: 'indexable',
      label: '未被 robots 禁止索引',
      weight: 5,
      passed: indexable,
      detail: page.robots === '' ? '未声明 robots（默认可索引）' : page.robots,
      fix: '移除 meta robots 的 noindex/none，否则抓取方会直接跳过该页。',
    },
  ]

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0)
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0)
  const score = Math.round((earned / totalWeight) * 100)
  const failed = checks.filter(check => !check.passed)
  return {
    score,
    grade: gradeOf(score),
    checks,
    passed: checks.length - failed.length,
    failed: failed.length,
    structuredTypes: types,
    recommendations: failed.slice().sort((left, right) => right.weight - left.weight).map(check => check.fix),
  }
}
