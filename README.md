# dsh-geo-report-to-fix

**输入一个网址，拿到 GEO 体检分 + 可直接粘贴的修复文件。**
**Give it a URL, get a GEO score and a paste-ready fix pack.**

AI 搜索（ChatGPT / Perplexity / 豆包等）引用页面时最看重：实体结构化数据、可抓取的摘要文件、干净的标题层级。这个插件把这三件事做成一次调用：抓取 → 打分 → 直接产出 `llms.txt` 与 `jsonld.html`，不需要读源码、不需要手写 JSON。

## Install

```bash
npm install @liuhange/dsh-geo-report-to-fix
```

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@liuhange/dsh-geo-report-to-fix"
      ]
    }
  },
  "dependencies": {
    "@liuhange/dsh-geo-report-to-fix": "0.1.0"
  }
}
```

Restart the profile. One tool appears: `geo_fix`.

## Quick start

```
你：帮我看看 https://example.com/pricing 的 GEO 情况，并生成修复文件
模型：geo_fix  url="https://example.com/pricing"

### GEO 审计：C · 62/100
✅ Title 长度 10-70 字且存在（10 分）— 「Pricing — Example」
⚠️ Organization JSON-LD（15 分）— 没有 Organization 结构化数据
⚠️ 站点根目录有 llms.txt（15 分）— 未找到 https://example.com/llms.txt
...
**已生成修复包**
- geo-fix-1763450000000/llms.txt → 放到网站根目录
- geo-fix-1763450000000/jsonld.html → 粘贴到 <head>
```

## Command

### `geo_fix`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 完整 URL，只接受 `http` / `https` |
| `outputDir` | 否 | 工作区内的输出目录，默认 `geo-fix-<时间戳>` |

返回：`url`、`finalUrl`、`title`、`siteName`、`score`（0-100）、`grade`、`passed` / `failed`（通过/未通过项数）、`checks`（每项含 `id`/`label`/`weight`/`passed`/`detail`，detail 是实测值）、`recommendations`（按权重排序的修复建议）、`structuredTypes`、`truncated`（页面是否超过 2MB 被截断）、`llmsTxtPath`、`jsonLdPath`、`elapsedMs`。

## Scoring (weights sum to 100)

| 检查 | 权重 | 通过条件 |
| --- | --- | --- |
| Title | 10 | 存在且 10-70 字 |
| Meta description | 10 | 存在且 40-200 字（回退 `og:description`） |
| 标题结构 | 10 | 恰好 1 个 H1，至少 2 个 H2 |
| Organization JSON-LD | 15 | 存在且含 `name` + `url` |
| WebSite JSON-LD | 10 | 存在 |
| `llms.txt` | 15 | 站点根目录返回非空 2xx |
| Canonical | 5 | 存在且指向本站 |
| `<html lang>` | 5 | 非空 |
| 图片 alt | 10 | 覆盖率 ≥ 80%（无图片按通过） |
| 页面级结构化数据 | 5 | Article / FAQPage / BreadcrumbList / Product / SoftwareApplication / HowTo |
| 可索引 | 5 | `meta robots` 不含 `noindex` / `none` |

分数 = 加权通过率；A ≥ 90，B ≥ 75，C ≥ 60，D < 60。

## Generated files

```
geo-fix-<timestamp>/
  llms.txt       # H1 站点名 + 摘要 + 核心页面链接 + 内容结构，放站点根目录
  jsonld.html    # Organization + WebSite 两段 JSON-LD，粘贴到 <head>
```

`llms.txt` 只收录同源链接（跳过锚点、`mailto:`、外链、登录/隐私页），最多 10 条核心页面与 12 个 H2 小节。`jsonld.html` 里的 JSON 对 `<`、`>`、`&` 做了转义，可安全内联在 `<script>` 中。

替换已有脚本时请**替换**而非叠加，避免出现两个 `Organization`。

## Runtime contract

- 页面抓取：6 秒超时、2MB 上限、自动跟随重定向；`/llms.txt` 探测 3 秒；整次调用 < 10 秒。
- 按响应头的 `charset` 解码（GBK/GB18030 等中文站点不会乱码），未声明或无法识别时回退 UTF-8。
- 页面超过 2MB 时截断分析，并在返回值 `truncated=true` 与结果文案中提示。
- 只接受 `http` / `https`；非 HTML 响应、空页面、非 2xx 状态直接报错，不产出半成品。
- 工具会写文件，因此声明为不可并发调用；同时转发宿主取消信号，用户中断时立即停止抓取。
- 输出目录必须位于当前会话工作区内。
- 零第三方依赖：原生 `fetch` + 正则提取，不引入浏览器内核。

## Known limits

- 提取器是"信号提取"而非完整 HTML 解析：属性值里出现 `>` 可能漏读；压缩/动态渲染（CSR）页面只能读到首屏 HTML。
- 超过 2MB 的页面只分析前 2MB，返回 `truncated=true`；这类页面通常需要先精简再体检。
- 不解析外部站点、不做多页爬取、不校验 `llms.txt` 内容质量，只判断存在与否。
- 分数是工程启发式，不代表任何具体搜索引擎的官方排名。

## Development

```bash
npm install
npm run typecheck   # strict, no any
npm test            # build + real plugin load + local HTTP server calls
```

## License

MIT
