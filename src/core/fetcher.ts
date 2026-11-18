/**
 * Tiny fetching layer: scheme allow-list, hard timeout, capped body reads.
 * Uses the platform `fetch` only — no browser, no proxy, no retries.
 */

import { TextDecoder } from 'node:util'

/** Hard limits for one request. */
export interface FetchLimits {
  /** Abort the whole request after this many milliseconds. */
  timeoutMs: number
  /** Stop reading the body after this many bytes. */
  maxBytes: number
  /** Caller cancellation (tool run context); combined with the timeout. */
  signal?: AbortSignal
}

/** What one document read produced. */
export interface FetchedText {
  /** URL after redirects. */
  url: string
  /** HTTP status of the final response. */
  status: number
  /** Decoded body, possibly truncated. */
  body: string
  /** Bytes actually read. */
  bytes: number
  /** Whether the body hit `maxBytes`. */
  truncated: boolean
  /** Response content-type, empty when absent. */
  contentType: string
  /** Charset label actually used for decoding. */
  charset: string
}

/** Header the plugin sends on every request. */
const USER_AGENT = 'dsh-geo-report-to-fix/0.1.0'

/** Reject anything that is not an absolute http(s) URL. */
export function assertHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`URL 无法解析：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到 ${url.protocol}`)
  }
  if (url.hostname === '') throw new Error(`URL 缺少主机名：${value}`)
  return url
}

/** `charset=` from a content-type header, else an empty string. */
function charsetOf(contentType: string): string {
  const match = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)
  return match === null ? '' : (match[1] ?? '').trim()
}

/** Build a decoder for the declared charset, falling back to UTF-8. */
function decoderFor(label: string): TextDecoder {
  if (label === '') return new TextDecoder('utf-8')
  try {
    return new TextDecoder(label)
  } catch {
    return new TextDecoder('utf-8')
  }
}

/** One abort signal that fires on timeout or caller cancellation. */
function abortWithin(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()
  const forward = (): void => controller.abort()
  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
    },
  }
}

/** Read a stream with a byte cap, decoding with the page's charset. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  charset: string,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (body === null) return { text: '', bytes: 0, truncated: false }
  const reader = body.getReader()
  const decoder = decoderFor(charset)
  let bytes = 0
  let truncated = false
  let text = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        const keep = Math.max(0, chunk.byteLength - (bytes - maxBytes))
        text += decoder.decode(chunk.subarray(0, keep))
        truncated = true
        break
      }
      text += decoder.decode(chunk, { stream: true })
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  text += decoder.decode()
  return { text, bytes, truncated }
}

/** Wrap a fetch/read failure in a message an operator can act on. */
function describeFailure(cause: unknown, url: string, timeoutMs: number, timedOut: boolean, outer?: AbortSignal): Error {
  if (outer !== undefined && outer.aborted) return new Error(`抓取被取消：${url}`)
  if (timedOut) return new Error(`抓取超时（>${timeoutMs}ms）：${url}`)
  return new Error(`抓取失败：${url}（${cause instanceof Error ? cause.message : String(cause)}）`)
}

/**
 * Fetch one text document.
 * @param value - absolute http(s) URL.
 * @param limits - timeout, byte cap, and optional cancellation signal.
 * @returns the final response plus the decoded body.
 */
export async function fetchText(value: string, limits: FetchLimits): Promise<FetchedText> {
  const url = assertHttpUrl(value)
  const abort = abortWithin(limits.timeoutMs, limits.signal)
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: abort.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
    })
  } catch (cause) {
    abort.dispose()
    throw describeFailure(cause, url.href, limits.timeoutMs, abort.timedOut(), limits.signal)
  }
  const contentType = response.headers.get('content-type') ?? ''
  const charset = charsetOf(contentType)
  let read: { text: string; bytes: number; truncated: boolean }
  try {
    read = await readCapped(response.body, limits.maxBytes, charset)
  } catch (cause) {
    throw describeFailure(cause, response.url === '' ? url.href : response.url, limits.timeoutMs, abort.timedOut(), limits.signal)
  } finally {
    abort.dispose()
  }
  return {
    url: response.url === '' ? url.href : response.url,
    status: response.status,
    body: read.text,
    bytes: read.bytes,
    truncated: read.truncated,
    contentType,
    charset: charset === '' ? 'utf-8' : charset,
  }
}

/** Result of looking for `/llms.txt` at the site root. */
export interface LlmsProbe {
  /** Absolute URL that was requested. */
  url: string
  /** Whether a non-empty 2xx response was found. */
  present: boolean
  /** Bytes read. */
  bytes: number
  /** Short excerpt, used by the report only when present. */
  excerpt: string
}

/**
 * Probe `<origin>/llms.txt` without failing the audit when it is missing.
 * @param origin - scheme + host of the audited page.
 * @param timeoutMs - short budget; a missing file is the common case.
 * @param signal - caller cancellation.
 */
export async function probeLlmsTxt(origin: string, timeoutMs: number, signal?: AbortSignal): Promise<LlmsProbe> {
  const url = `${origin}/llms.txt`
  try {
    const document = await fetchText(url, { timeoutMs, maxBytes: 256 * 1024, signal })
    const present = document.status >= 200 && document.status < 300 && document.body.trim() !== ''
    return { url, present, bytes: document.bytes, excerpt: present ? document.body.slice(0, 400) : '' }
  } catch {
    return { url, present: false, bytes: 0, excerpt: '' }
  }
}
