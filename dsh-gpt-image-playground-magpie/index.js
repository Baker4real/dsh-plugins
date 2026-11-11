/**
 * dsh-gpt-image-playground-magpie — Host half.
 *
 * The GPT Image Playground workbench (package `dsh-gpt-image-playground`) runs
 * inside the Harness page and cannot call the local magpie gateway directly:
 * the gateway answers no CORS preflight. This plugin adds a same-origin route,
 * `/plugins/dsh-gpt-image-playground-magpie/v1/<path>`, that forwards to the
 * gateway's OpenAI-compatible `/v1/<path>`, limited to the endpoints the
 * workbench uses in Images API mode.
 *
 * The browser's Authorization header (a placeholder the workbench requires),
 * cookies and User-Agent never reach the gateway; MAGPIE_GATEWAY_KEY is sent
 * instead when the Host process has it. magpie passes a client User-Agent on
 * to 幻灵AI, whose Cloudflare answers a non-browser one with `error code: 1010`;
 * without one, magpie sends its own, which passes.
 *
 * 幻灵AI returns each image as a temporary `https://api.huanling.icu/...` URL
 * that sends no CORS header and refuses non-browser User-Agents, so the
 * workbench could not download it from the page. Successful JSON image
 * responses are rewritten here: each `url` item is fetched on the Host and
 * returned as `b64_json`.
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const name = 'gpt-image-playground-magpie'

export const inject = ['webServer']

export const ROUTE = '/plugins/dsh-gpt-image-playground-magpie/v1'

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:3425/v1'
const TIMEOUT_MS = 900_000
const MAX_BODY_BYTES = 96 * 1024 * 1024

/** Gateway paths the workbench calls in Images API mode, with their methods. */
const ALLOWED = new Map([
  ['models', new Set(['GET', 'HEAD'])],
  ['images/generations', new Set(['POST'])],
  ['images/edits', new Set(['POST'])],
])

const REQUEST_HEADERS = ['content-type', 'accept', 'accept-language']
const WITHHELD_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie'])

/** 幻灵AI's image links reject non-browser User-Agents (Cloudflare 1010). */
const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

function gatewayBase(config) {
  const configured = typeof config?.gatewayUrl === 'string' ? config.gatewayUrl.trim() : ''
  const raw = configured.length > 0 ? configured : DEFAULT_GATEWAY_URL
  const protocol = new URL(raw).protocol
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`gatewayUrl must be an http(s) URL: ${raw}`)
  return raw.replace(/\/+$/, '')
}

/** OpenAI-shaped error, so the workbench shows the reason instead of "Failed to fetch". */
function fail(res, status, message, headers = {}) {
  const payload = JSON.stringify({ error: { message, type: 'magpie_route_error' } })
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

class BodyTooLarge extends Error {}

/** Raw bytes: multipart reference-image uploads must pass through unchanged. */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function downloadImage(link, signal) {
  const target = new URL(link)
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`unsupported image link scheme ${target.protocol}`)
  const response = await fetch(target, { headers: { 'user-agent': DOWNLOAD_USER_AGENT, accept: 'image/*' }, signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`image link answered HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES} bytes`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES} bytes`)
  return bytes
}

/**
 * Replace `data[].url` with `data[].b64_json` in an OpenAI Images response.
 * An item whose link fails keeps its `url`, so the workbench reports that
 * download itself; anything that is not such a response passes unchanged.
 */
async function inlineImageLinks(text, signal, warn) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return text
  }
  const items = Array.isArray(payload?.data) ? payload.data : []
  let changed = false
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.b64_json === 'string') continue
    try {
      item.b64_json = (await downloadImage(item.url, signal)).toString('base64')
      delete item.url
      changed = true
    } catch (error) {
      if (signal.aborted) throw error
      warn?.(`gpt-image-playground-magpie: kept image link, download failed: ${error?.cause?.message ?? error?.message ?? error}`)
    }
  }
  return changed ? JSON.stringify(payload) : text
}

/**
 * Mount the forwarding route.
 * @param ctx - Host context carrying the web server.
 * @param config - `{ gatewayUrl?: string }`, default `http://127.0.0.1:3425/v1`.
 */
export function apply(ctx, config = {}) {
  const base = gatewayBase(config)

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const suffix = url.pathname.slice(ROUTE.length).replace(/^\/+|\/+$/g, '')
    const methods = ALLOWED.get(suffix)
    if (methods === undefined) {
      return fail(res, 404, `magpie 生图路由只转发 ${[...ALLOWED.keys()].map((path) => `/v1/${path}`).join('、')}，不转发 /v1/${suffix}`)
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (!methods.has(method)) return fail(res, 405, `/v1/${suffix} 不接受 ${method}`, { allow: [...methods].join(', ') })

    // A cross-site page must not trigger paid generation through the loopback
    // route. Desktop strips Origin while bridging dsh-app://app; the Web page
    // sends the Host origin, and non-browser smoke tests normally send none.
    const browserOrigin = req.headers.origin
    if (browserOrigin !== undefined && browserOrigin !== 'dsh-app://app' && browserOrigin !== ctx.webServer.getOrigin()) {
      return fail(res, 403, '只允许 DSH 同源页面调用生图路由')
    }

    const headers = {}
    for (const key of REQUEST_HEADERS) {
      const value = req.headers[key]
      if (typeof value === 'string') headers[key] = value
    }
    const gatewayKey = process.env.MAGPIE_GATEWAY_KEY
    if (typeof gatewayKey === 'string' && gatewayKey.length > 0) headers.authorization = `Bearer ${gatewayKey}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    // A closed panel or reloaded page must not leave the generation running upstream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    const target = `${base}/${suffix}${url.search}`
    try {
      const body = method === 'POST' ? await readBody(req) : undefined
      const response = await fetch(target, { method, headers, body, signal: controller.signal, redirect: 'manual' })
      const outgoing = {}
      for (const [key, value] of response.headers) if (!WITHHELD_RESPONSE_HEADERS.has(key)) outgoing[key] = value
      outgoing['cache-control'] = 'no-store'
      // Streamed (SSE) and failed responses pass through as they arrive.
      if (method === 'POST' && response.ok && (response.headers.get('content-type') ?? '').includes('application/json')) {
        const text = await inlineImageLinks(await response.text(), controller.signal, (message) => ctx.logger?.warn?.(message))
        outgoing['content-length'] = String(Buffer.byteLength(text))
        res.writeHead(response.status, outgoing)
        res.end(text)
        return
      }
      res.writeHead(response.status, outgoing)
      if (response.body !== null && method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res)
      else res.end()
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof BodyTooLarge) return fail(res, 413, '请求体超过 96 MB')
      const reason = controller.signal.aborted ? '请求被取消或超时' : (error?.cause?.message ?? error?.message ?? String(error))
      ctx.logger?.warn?.(`gpt-image-playground-magpie: ${method} ${target}: ${reason}`)
      return fail(res, 502, `magpie 网关不可达（${base}）：${reason}。请确认 magpie 正在运行。`)
    } finally {
      clearTimeout(timer)
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
  ctx.logger?.info?.(`gpt-image-playground-magpie: ${ROUTE} -> ${base}`)
}
