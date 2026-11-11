import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { apply, ROUTE } from '../index.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

function serve(t, handler) {
  const server = http.createServer(handler)
  t.after(() => {
    server.close()
    server.closeAllConnections()
  })
  return listen(server)
}

async function mountRoute(t, gatewayHandler) {
  const gatewayOrigin = await serve(t, gatewayHandler)
  let route
  const warnings = []
  const disposers = []
  apply(
    {
      webServer: {
        getOrigin: () => 'http://127.0.0.1:1903',
        register(entry) {
          route = entry
          return () => {
            route = undefined
          }
        },
      },
      effect(fn) {
        disposers.push(fn())
      },
      logger: { warn: (message) => warnings.push(message) },
    },
    { gatewayUrl: `${gatewayOrigin}/v1` },
  )
  t.after(() => {
    for (const dispose of disposers) dispose()
  })
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE)
  const origin = await serve(t, (req, res) => route.handler(req, res))
  return { origin: `${origin}${ROUTE}`, warnings }
}

async function drain(req) {
  for await (const _ of req) {
    // Tests do not inspect the request body; consuming it keeps the connection reusable.
  }
}

test('models strips browser identity and uses only the configured gateway key', async (t) => {
  process.env.MAGPIE_GATEWAY_KEY = 'test-gateway-key'
  t.after(() => delete process.env.MAGPIE_GATEWAY_KEY)
  let seen
  const { origin } = await mountRoute(t, async (req, res) => {
    seen = req.headers
    if ((req.headers['user-agent'] ?? '').includes('Python-urllib')) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"error code: 1010"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=do-not-forward' })
    res.end('{"data":[{"id":"ai/gpt-image-2.6-sunburst"}]}')
  })

  const response = await fetch(`${origin}/models`, {
    headers: {
      authorization: 'Bearer magpie-local',
      cookie: 'dsh=do-not-forward',
      origin: 'http://127.0.0.1:1903',
      'user-agent': 'Python-urllib/3.15',
      accept: 'application/json',
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { data: [{ id: 'ai/gpt-image-2.6-sunburst' }] })
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(seen.authorization, 'Bearer test-gateway-key')
  assert.equal(seen.cookie, undefined)
  assert.equal(seen.accept, 'application/json')
  assert.ok(!String(seen['user-agent']).includes('Python-urllib'))
})

test('successful image URLs are downloaded with a browser UA and returned as b64_json', async (t) => {
  delete process.env.MAGPIE_GATEWAY_KEY
  let gatewayAuth
  let imageUa
  let imageOrigin
  const { origin } = await mountRoute(t, async (req, res) => {
    await drain(req)
    gatewayAuth = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ url: `${imageOrigin}/image.png`, revised_prompt: 'kept prompt' }] }))
  })
  imageOrigin = await serve(t, (req, res) => {
    imageUa = req.headers['user-agent']
    if (!String(imageUa).startsWith('Mozilla/')) {
      res.writeHead(403)
      res.end('error code: 1010\n')
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })

  const response = await fetch(`${origin}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer magpie-local' },
    body: '{"prompt":"magpie"}',
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.data[0].url, undefined)
  assert.ok(Buffer.from(payload.data[0].b64_json, 'base64').equals(PNG))
  assert.equal(payload.data[0].revised_prompt, 'kept prompt')
  assert.equal(gatewayAuth, undefined)
  assert.match(imageUa, /^Mozilla\//)
})

test('an image URL that answers 403 remains a URL and emits a diagnostic', async (t) => {
  let imageOrigin
  const { origin, warnings } = await mountRoute(t, async (req, res) => {
    await drain(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ url: `${imageOrigin}/forbidden.png`, revised_prompt: 'kept prompt' }] }))
  })
  imageOrigin = await serve(t, (req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('error code: 1010\n')
  })

  const response = await fetch(`${origin}/images/edits`, { method: 'POST', body: new FormData() })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.data[0].url, `${imageOrigin}/forbidden.png`)
  assert.equal(payload.data[0].b64_json, undefined)
  assert.equal(payload.data[0].revised_prompt, 'kept prompt')
  assert.ok(warnings.some((message) => message.includes('HTTP 403')))
})

test('cross-origin browser requests are rejected before reaching the gateway', async (t) => {
  let gatewayCalls = 0
  const { origin } = await mountRoute(t, async (req, res) => {
    gatewayCalls += 1
    await drain(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
  })

  const response = await fetch(`${origin}/images/generations`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'text/plain' },
    body: '{"prompt":"must not run"}',
  })
  assert.equal(response.status, 403)
  assert.equal(gatewayCalls, 0)
})

test('upstream failures pass through unchanged and route policy stays closed', async (t) => {
  let generationCalls = 0
  const { origin } = await mountRoute(t, async (req, res) => {
    generationCalls += 1
    await drain(req)
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"error code: 1010","type":"permission_error"}}')
  })

  const failed = await fetch(`${origin}/images/generations`, { method: 'POST', body: '{}' })
  assert.equal(failed.status, 403)
  assert.deepEqual(await failed.json(), { error: { message: 'error code: 1010', type: 'permission_error' } })

  const wrongPath = await fetch(`${origin}/responses`, { method: 'POST', body: '{}' })
  assert.equal(wrongPath.status, 404)
  const wrongMethod = await fetch(`${origin}/models`, { method: 'POST', body: '{}' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(generationCalls, 1)
})
