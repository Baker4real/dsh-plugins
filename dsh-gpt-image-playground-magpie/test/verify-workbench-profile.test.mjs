import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { decompressSnappy, readCdpProfile, readLeveldbProfile, verifyProjection } from '../scripts/verify-workbench-profile.mjs'

const profile = {
  id: 'magpie-huanling',
  name: '幻灵AI · magpie',
  provider: 'openai',
  baseUrl: 'dsh-app://app/plugins/dsh-gpt-image-playground-magpie/v1',
  model: 'ai/gpt-image-2.6-sunburst, ai/gpt-image-2.6-flare',
  apiMode: 'images',
  hasApiKey: true,
}

function settings() {
  return {
    profiles: [
      { id: 'unrelated', apiKey: 'other-provider-secret', baseUrl: 'https://unrelated.example' },
      { ...profile, apiKey: 'magpie-local' },
    ],
    activeProfileId: 'magpie-huanling',
  }
}

test('Snappy literal and overlapping copy decode a known byte sequence', () => {
  const encoded = Buffer.concat([
    Buffer.from([17, 20]),
    Buffer.from('hello ', 'utf8'),
    Buffer.from([42, 6, 0]),
  ])
  assert.equal(decompressSnappy(encoded).toString('utf8'), 'hello hello hello')
})

function varint(value) {
  const bytes = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function snappyLiteral(input) {
  assert.ok(input.length > 0 && input.length <= 65536)
  const length = input.length - 1
  const tag = length < 60 ? Buffer.from([length << 2]) : Buffer.concat([Buffer.from([61]), Buffer.from([length & 0xff, length >>> 8])])
  return Buffer.concat([varint(input.length), tag, input])
}

function compressedSstable(root) {
  const data = snappyLiteral(Buffer.from(root, 'utf8'))
  const indexValue = Buffer.concat([varint(0), varint(data.length)])
  const indexEntry = Buffer.concat([varint(0), varint(1), varint(indexValue.length), Buffer.from('k'), indexValue])
  const index = snappyLiteral(Buffer.concat([indexEntry, Buffer.alloc(4), Buffer.from([1, 0, 0, 0])]))
  const meta = Buffer.alloc(4)
  const dataOffset = 0
  const metaOffset = data.length + 5
  const indexOffset = metaOffset + meta.length + 5
  const footerHandles = Buffer.concat([varint(metaOffset), varint(meta.length), varint(indexOffset), varint(index.length)])
  const footer = Buffer.concat([footerHandles, Buffer.alloc(40 - footerHandles.length), Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb])])
  assert.equal(dataOffset, 0)
  return Buffer.concat([data, Buffer.from([1, 0, 0, 0, 0]), meta, Buffer.from([0, 0, 0, 0, 0]), index, Buffer.from([1, 0, 0, 0, 0]), footer])
}

test('a compressed SSTable with a restart array yields the same safe profile', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'magpie-sstable-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, '000005.ldb'), compressedSstable(JSON.stringify({ state: { settings: settings() }, version: 2 })))
  const result = verifyProjection(readLeveldbProfile(directory))
  assert.equal(result.ok, true)
  assert.ok(!JSON.stringify(result).includes('other-provider-secret'))
})

test('offline LevelDB parsing accepts model whitespace and emits only the target whitelist', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'magpie-leveldb-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = JSON.stringify({ state: { settings: settings() }, version: 2 })
  // An odd binary prefix exercises the other UTF-16 byte parity used by Chromium records.
  writeFileSync(join(directory, '000004.log'), Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(root, 'utf16le')]))
  writeFileSync(join(directory, '000003.ldb'), Buffer.from(JSON.stringify({ state: { settings: { profiles: [] } }, version: 2 }), 'utf8'))
  const now = new Date()
  utimesSync(join(directory, '000003.ldb'), now, now)
  utimesSync(join(directory, '000004.log'), now, now)

  const result = verifyProjection(readLeveldbProfile(directory))
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks, {
    profilePresent: true,
    active: true,
    bothModels: true,
    routeUrl: true,
    imagesApi: true,
    hasRequiredKey: true,
  })
  assert.equal(result.profile.model, profile.model)
  const output = JSON.stringify(result)
  assert.ok(!output.includes('other-provider-secret'))
  assert.ok(!output.includes('magpie-local'))
  assert.ok(!output.includes('unrelated.example'))
})

test('CDP reads the existing workbench frame and final output drops unexpected secret fields', async (t) => {
  let expression = ''
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/targets') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ targetId: 'tab-1', url: 'dsh-app://app/' }]))
      return
    }
    if (url.pathname === '/frames') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ frameId: 'frame-1', src: '/plugins/dsh-gpt-image-playground/app/index.html' }]))
      return
    }
    if (url.pathname === '/eval') {
      expression = await new Promise((resolve) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => resolve(body))
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ value: { present: true, active: true, profile: { ...profile, apiKey: 'must-not-leak', extra: 'must-not-leak-either' } } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.close()
    server.closeAllConnections()
  })

  const projected = await readCdpProfile(`http://127.0.0.1:${server.address().port}`)
  const result = verifyProjection(projected)
  assert.equal(result.ok, true)
  assert.match(expression, /localStorage\.getItem/)
  assert.match(expression, /hasApiKey/)
  const output = JSON.stringify(result)
  assert.ok(!output.includes('must-not-leak'))
  assert.equal(result.profile.extra, undefined)
  assert.equal(result.profile.apiKey, undefined)
})
