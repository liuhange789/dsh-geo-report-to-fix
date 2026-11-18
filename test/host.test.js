import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/** Load the built host entry the way the loader does (real plugin apply). */
async function loadHost() {
  const module = await import(pathToFileURL(path.resolve('lib/index.js')).href)
  const tools = {}
  const ctx = {
    fiber: { state: 0 },
    tools: { register(tool) { tools[tool.name] = tool } },
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    on() {},
    logger: console,
    inject() {},
  }
  module.apply(ctx)
  return { module, tools }
}

/** Real workspace exec context. */
const execFor = workspace => ({ agent: { session: { header: { cwd: workspace } } } })

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <title>Example Site — 面向团队的异步协作 API</title>
  <meta name="description" content="Example Site 提供可编程的异步协作 API，帮助团队把审批、通知和定时任务从人肉流程里拿出来，接入现有系统只需一次改造。">
  <link rel="canonical" href="http://127.0.0.1:PORT/docs">
  <meta property="og:site_name" content="Example Site">
</head>
<body>
  <h1>异步协作 API</h1>
  <h2>鉴权</h2>
  <h2>事件订阅</h2>
  <img src="/a.png" alt="架构图">
  <img src="/b.png" alt="">
  <img src="/c.png" data-alt="伪装的 alt">
  <a href="/docs/quickstart">快速开始</a>
  <a href="/pricing">价格</a>
  <a href="/search?q=geo&amp;lang=en">搜索 geo</a>
  <a href="https://other.example.com/x">外部链接</a>
  <a href="#top">锚点</a>
</body>
</html>`

/** Start a throwaway site on loopback. */
async function withSite(run) {
  let port = 0
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/' })
      response.end()
      return
    }
    if (request.url === '/boom') {
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>oops</body></html>')
      return
    }
    if (request.url === '/utf16') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-16le' })
      response.end(Buffer.from(PAGE.replace(/PORT/g, String(port)), 'utf16le'))
      return
    }
    if (request.url === '/llms.txt') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    if (request.url === '/json-endpoint') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE.replace(/PORT/g, String(port)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('registers geo_fix with a required url parameter', async () => {
  const { tools } = await loadHost()
  assert.ok(tools.geo_fix)
  assert.ok(tools.geo_fix.parameters.properties.url)
  assert.deepEqual(tools.geo_fix.parameters.required, ['url'])
})

test('audit scores the page and writes llms.txt + jsonld.html', async () => {
  const { tools } = await loadHost()
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geo-fix-'))
  const exec = execFor(workspace)

  await withSite(async base => {
    const result = await tools.geo_fix.execute({ url: `${base}/redirect`, outputDir: 'geo-fix-test' }, exec)

    assert.equal(result.finalUrl, `${base}/`)
    // Redirect followed, page parsed.
    assert.match(result.title, /Example Site/)
    assert.equal(result.siteName, 'Example Site')
    assert.ok(result.score >= 0 && result.score <= 100)
    assert.ok(result.failed > 0, 'page has no JSON-LD and no llms.txt')

    const byId = Object.fromEntries(result.checks.map(check => [check.id, check]))
    assert.equal(byId.title.passed, true)
    assert.equal(byId.description.passed, true)
    assert.equal(byId.headings.passed, true)
    assert.equal(byId['org-schema'].passed, false)
    assert.equal(byId['website-schema'].passed, false)
    assert.equal(byId['llms-txt'].passed, false)
    assert.equal(byId.canonical.passed, true)
    assert.equal(byId.lang.passed, true)
    assert.equal(byId['image-alt'].passed, false, 'only 1 of 3 images has a real alt')
    assert.match(byId['image-alt'].detail, /1\/3 有 alt/)
    assert.equal(byId.indexable.passed, true)
    assert.equal(byId['structured-extra'].passed, false)
    assert.ok(result.recommendations.length > 0)
    assert.ok(result.recommendations[0].length > 0)
    assert.ok(result.elapsedMs < 10_000)
    assert.match(tools.geo_fix.output.render({}, result)[0].text, /GEO 审计/)

    assert.equal(result.llmsTxtPath, 'geo-fix-test/llms.txt')
    assert.equal(result.jsonLdPath, 'geo-fix-test/jsonld.html')
    const llms = await readFile(path.join(workspace, 'geo-fix-test/llms.txt'), 'utf8')
    assert.match(llms, /^# Example Site/)
    assert.match(llms, /> Example Site 提供可编程的异步协作 API/)
    assert.match(llms, /\[快速开始\]\(/)
    assert.match(llms, /search\?q=geo&amp;lang=en|search\?q=geo&lang=en/)
    assert.match(llms, /- 鉴权/)
    assert.equal(llms.includes('other.example.com'), false, 'only same-origin links')

    const jsonLd = await readFile(path.join(workspace, 'geo-fix-test/jsonld.html'), 'utf8')
    assert.match(jsonLd, /<script type="application\/ld\+json">/)
    assert.match(jsonLd, /"@context": "https:\/\/schema\.org"/)
    assert.match(jsonLd, /"@type": "Organization"/)
    assert.match(jsonLd, /"@type": "WebSite"/)
    assert.match(jsonLd, /"name": "Example Site"/)
    assert.match(jsonLd, /"inLanguage": "zh-CN"/)

    assert.deepEqual(await readdir(path.join(workspace, 'geo-fix-test')), ['jsonld.html', 'llms.txt'])
  })
})

test('llms.txt is credited when the site already serves one', async () => {
  const { tools } = await loadHost()
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geo-fix-'))
  const server = createServer((request, response) => {
    if (request.url === '/llms.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('# Existing\n\n> already documented\n')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE.replace(/PORT/g, String(server.address().port)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const result = await tools.geo_fix.execute({ url: base }, execFor(workspace))
    const llmsCheck = result.checks.find(check => check.id === 'llms-txt')
    assert.equal(llmsCheck.passed, true)
    assert.ok(result.score > 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('rejects non-http schemes, non-HTML bodies and failing statuses', async () => {
  const { tools } = await loadHost()
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geo-fix-'))
  await assert.rejects(tools.geo_fix.execute({ url: 'file:///etc/passwd' }, execFor(workspace)), /http\/https/)
  await assert.rejects(tools.geo_fix.execute({ url: 'not a url' }, execFor(workspace)), /无法解析/)
  await withSite(async base => {
    await assert.rejects(tools.geo_fix.execute({ url: `${base}/json-endpoint` }, execFor(workspace)), /不是 HTML/)
    await assert.rejects(tools.geo_fix.execute({ url: `${base}/boom` }, execFor(workspace)), /抓取返回 500/)
    const utf16 = await tools.geo_fix.execute({ url: `${base}/utf16` }, execFor(workspace))
    assert.match(utf16.title, /Example Site — 面向团队的异步协作 API/)
  })
  await assert.rejects(tools.geo_fix.execute({ url: 'http://127.0.0.1:1/' }, execFor(workspace)), /抓取失败|抓取超时/)
})

test('refuses to write outside the workspace', async () => {
  const { tools } = await loadHost()
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geo-fix-'))
  await withSite(async base => {
    await assert.rejects(tools.geo_fix.execute({ url: base, outputDir: '../../escape' }, execFor(workspace)), /工作区内/)
  })
  assert.deepEqual(await readdir(workspace), [])
})
