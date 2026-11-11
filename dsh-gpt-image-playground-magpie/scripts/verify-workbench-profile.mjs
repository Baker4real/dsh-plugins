#!/usr/bin/env node
/** Read-only verification of the workbench's magpie profile through CDP or an offline LevelDB copy. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const PROFILE_ID = 'magpie-huanling'
export const ROUTE_SUFFIX = '/plugins/dsh-gpt-image-playground-magpie/v1'
export const EXPECTED_MODELS = ['ai/gpt-image-2.6-sunburst', 'ai/gpt-image-2.6-flare']

const STORE_KEY = 'gpt-image-playground'
const APP_FRAME = '/plugins/dsh-gpt-image-playground/app/'

function project(settings) {
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : []
  const profile = profiles.find((item) => item?.id === PROFILE_ID)
  return {
    present: profile !== undefined,
    active: settings?.activeProfileId === PROFILE_ID,
    profile: profile
      ? {
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiMode: profile.apiMode,
          hasApiKey: typeof profile.apiKey === 'string' && profile.apiKey.length > 0,
        }
      : null,
  }
}

export function verifyProjection(projected) {
  const profile = projected?.profile
  const models = typeof profile?.model === 'string' ? profile.model.split(',').map((item) => item.trim()) : []
  const checks = {
    profilePresent: projected?.present === true,
    active: projected?.active === true,
    bothModels: EXPECTED_MODELS.every((model) => models.includes(model)),
    routeUrl: typeof profile?.baseUrl === 'string' && profile.baseUrl.replace(/\/+$/, '').endsWith(ROUTE_SUFFIX),
    imagesApi: profile?.apiMode === 'images',
    hasRequiredKey: profile?.hasApiKey === true,
  }
  const safeProfile = profile
    ? {
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiMode: profile.apiMode,
        hasApiKey: profile.hasApiKey === true,
      }
    : null
  return { ok: Object.values(checks).every(Boolean), checks, profile: safeProfile }
}

/** Parse the first complete JSON object without consuming any following LevelDB bytes. */
function parseJsonPrefix(text) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(0, index + 1))
    }
  }
  return undefined
}

function candidatesFromText(text, file, mtimeMs) {
  const candidates = []
  const marker = `"id":"${PROFILE_ID}"`
  let markerAt = text.indexOf(marker)
  while (markerAt >= 0) {
    const starts = [...text.slice(0, markerAt).matchAll(/\{\s*"state"\s*:/g)]
    const start = starts.at(-1)?.index
    if (start !== undefined) {
      try {
        const root = parseJsonPrefix(text.slice(start))
        if (root?.state?.settings !== undefined) candidates.push({ root, mtimeMs, file, offset: markerAt })
      } catch {
        // A partial or historical record is not evidence; other records may still parse.
      }
    }
    markerAt = text.indexOf(marker, markerAt + marker.length)
  }
  return candidates
}

function readVarint(bytes, offset) {
  let value = 0
  let shift = 0
  for (let cursor = offset; cursor < bytes.length && shift <= 49; cursor += 1) {
    const byte = bytes[cursor]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: cursor + 1 }
    shift += 7
  }
  throw new Error('invalid varint')
}

/** Decode the raw Snappy format used by LevelDB blocks. */
export function decompressSnappy(bytes) {
  const expected = readVarint(bytes, 0)
  const output = Buffer.alloc(expected.value)
  let input = expected.next
  let written = 0
  while (input < bytes.length && written < expected.value) {
    const tag = bytes[input]
    input += 1
    const kind = tag & 3
    if (kind === 0) {
      let length = tag >>> 2
      if (length >= 60) {
        const extra = length - 59
        if (input + extra > bytes.length) throw new Error('truncated Snappy literal length')
        length = bytes.readUIntLE(input, extra) + 1
        input += extra
      } else length += 1
      if (input + length > bytes.length || written + length > expected.value) throw new Error('invalid Snappy literal')
      bytes.copy(output, written, input, input + length)
      input += length
      written += length
      continue
    }
    let length
    let offset
    if (kind === 1) {
      if (input >= bytes.length) throw new Error('truncated Snappy copy')
      length = 4 + ((tag >>> 2) & 7)
      offset = ((tag & 0xe0) << 3) | bytes[input]
      input += 1
    } else {
      const width = kind === 2 ? 2 : 4
      if (input + width > bytes.length) throw new Error('truncated Snappy offset')
      length = 1 + (tag >>> 2)
      offset = bytes.readUIntLE(input, width)
      input += width
    }
    if (offset < 1 || offset > written || written + length > expected.value) throw new Error('invalid Snappy copy')
    for (let index = 0; index < length; index += 1) {
      output[written] = output[written - offset]
      written += 1
    }
  }
  if (written !== expected.value) throw new Error(`incomplete Snappy block (${written}/${expected.value}, input ${input}/${bytes.length})`)
  return output
}

function readHandle(bytes, offset) {
  const blockOffset = readVarint(bytes, offset)
  const blockSize = readVarint(bytes, blockOffset.next)
  return { offset: blockOffset.value, size: blockSize.value, next: blockSize.next }
}

function readTableBlock(bytes, handle) {
  if (handle.offset + handle.size + 5 > bytes.length) throw new Error('LevelDB block outside file')
  const raw = bytes.subarray(handle.offset, handle.offset + handle.size)
  const compression = bytes[handle.offset + handle.size]
  if (compression === 0) return raw
  if (compression === 1) return decompressSnappy(raw)
  throw new Error(`unsupported LevelDB compression ${compression} at ${handle.offset}+${handle.size}`)
}

/** Read data-block handles from the footer/index; record contents stay opaque. */
function readTableDataBlocks(bytes) {
  if (bytes.length < 48 || bytes.readUInt32LE(bytes.length - 8) !== 0x8b80fb57 || bytes.readUInt32LE(bytes.length - 4) !== 0xdb477524) {
    throw new Error('not a LevelDB SSTable')
  }
  const footer = readHandle(bytes, bytes.length - 48)
  const indexHandle = readHandle(bytes, footer.next)
  const index = readTableBlock(bytes, indexHandle)
  const blocks = []
  if (index.length < 4) throw new Error('invalid LevelDB index block')
  const restartCount = index.readUInt32LE(index.length - 4)
  const entriesEnd = index.length - (restartCount + 1) * 4
  if (entriesEnd < 0) throw new Error('invalid LevelDB restart array')
  let cursor = 0
  while (cursor < entriesEnd) {
    const shared = readVarint(index, cursor)
    const nonShared = readVarint(index, shared.next)
    const valueLength = readVarint(index, nonShared.next)
    const valueAt = valueLength.next + nonShared.value
    const valueEnd = valueAt + valueLength.value
    if (valueEnd > entriesEnd) throw new Error('invalid LevelDB index entry')
    const handle = readHandle(index, valueAt)
    try {
      blocks.push(readTableBlock(bytes, handle))
    } catch (error) {
      throw new Error(`data block ${blocks.length} at ${handle.offset}+${handle.size}: ${error.message}`)
    }
    cursor = valueEnd
  }
  return blocks
}

/** Reassemble LevelDB write-ahead log fragments into complete records. */
function readLogRecords(bytes) {
  const records = []
  let fragments = []
  let offset = 0
  while (offset + 7 <= bytes.length) {
    const remaining = 32768 - (offset % 32768)
    if (remaining < 7) {
      offset += remaining
      continue
    }
    const length = bytes.readUInt16LE(offset + 4)
    const type = bytes[offset + 6]
    if (type === 0 && length === 0) {
      offset += remaining
      continue
    }
    if (offset + 7 + length > bytes.length) break
    const payload = bytes.subarray(offset + 7, offset + 7 + length)
    if (type === 1) records.push(payload)
    else if (type === 2) fragments = [payload]
    else if (type === 3) fragments.push(payload)
    else if (type === 4) {
      fragments.push(payload)
      records.push(Buffer.concat(fragments))
      fragments = []
    }
    offset += 7 + length
  }
  return records
}

/** Return only the latest parsable profile projection; never returns other profiles or raw keys. */
export function readLeveldbProfile(directory) {
  const candidates = []
  const formatErrors = []
  const files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && ['.log', '.ldb'].includes(entry.name.slice(entry.name.lastIndexOf('.'))))
  const collect = (bytes, file, mtimeMs) => {
    candidates.push(...candidatesFromText(bytes.toString('utf8'), file, mtimeMs))
    // Chromium UTF-16 values can begin at either byte parity inside a record.
    for (const parity of [0, 1]) {
      candidates.push(...candidatesFromText(bytes.subarray(parity).toString('utf16le'), file, mtimeMs + parity / 10))
    }
  }
  for (const entry of files) {
    const file = join(directory, entry.name)
    const bytes = readFileSync(file)
    const { mtimeMs } = statSync(file)
    collect(bytes, entry.name, mtimeMs)
    try {
      const records = entry.name.endsWith('.log') ? readLogRecords(bytes) : readTableDataBlocks(bytes)
      records.forEach((record, index) => collect(record, entry.name, mtimeMs + index / 1_000_000))
    } catch (error) {
      formatErrors.push(`${entry.name}: ${error.message}`)
      // Raw records can still be usable; fail closed below if none contain the target.
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.offset - right.offset)
  const latest = candidates.at(-1)
  if (latest === undefined) {
    const detail = formatErrors.length > 0 ? ` (${formatErrors.join('; ')})` : ''
    throw new Error(`no parsable ${PROFILE_ID} profile found in ${directory}${detail}`)
  }
  return project(latest.root.state.settings)
}

async function cdpJson(base, path, init) {
  const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, init)
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`CDP ${path} returned HTTP ${response.status}: ${text.slice(0, 160)}`)
  }
  if (!response.ok) throw new Error(`CDP ${path} returned HTTP ${response.status}: ${payload.error ?? text.slice(0, 160)}`)
  return payload
}

/** Read only an existing DSH tab and its existing workbench frame; creates or changes nothing. */
export async function readCdpProfile(base = 'http://localhost:3456', targetHint = '') {
  const targets = await cdpJson(base, '/targets')
  const target = targets.find((item) => {
    const url = String(item?.url ?? '')
    return targetHint ? url.includes(targetHint) : url.startsWith('dsh-app://app') || url.includes('127.0.0.1:1903')
  })
  if (!target?.targetId) throw new Error(targetHint ? `no CDP target contains ${targetHint}` : 'no DSH target found; pass --target to select one')
  const frames = await cdpJson(base, `/frames?target=${encodeURIComponent(target.targetId)}`)
  const frame = frames.find((item) => item?.frameId && `${item.url ?? ''} ${item.src ?? ''}`.includes(APP_FRAME))
  if (!frame) throw new Error('the selected DSH tab has no loaded GPT Image Playground frame; open 生图工作台 first')
  const expression = `(() => {
    const root = JSON.parse(localStorage.getItem(${JSON.stringify(STORE_KEY)}) || 'null');
    const settings = root && root.state && root.state.settings;
    const profiles = settings && Array.isArray(settings.profiles) ? settings.profiles : [];
    const p = profiles.find((item) => item && item.id === ${JSON.stringify(PROFILE_ID)});
    return {
      present: !!p,
      active: settings && settings.activeProfileId === ${JSON.stringify(PROFILE_ID)},
      profile: p ? {
        id: p.id, name: p.name, provider: p.provider, baseUrl: p.baseUrl,
        model: p.model, apiMode: p.apiMode, hasApiKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
      } : null,
    };
  })()`
  const result = await cdpJson(base, `/eval?target=${encodeURIComponent(target.targetId)}&frame=${encodeURIComponent(frame.frameId)}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: expression,
  })
  if (result.error) throw new Error(`CDP eval failed: ${result.error}`)
  return result.value
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      cdp: { type: 'string' },
      target: { type: 'string', default: '' },
      leveldb: { type: 'string' },
    },
  })
  if ([values.cdp !== undefined, values.leveldb !== undefined].filter(Boolean).length !== 1) {
    throw new Error('choose exactly one source: --cdp http://localhost:3456 or --leveldb <directory>')
  }
  const projected = values.cdp !== undefined ? await readCdpProfile(values.cdp, values.target) : readLeveldbProfile(values.leveldb)
  const result = verifyProjection(projected)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
    },
  )
}
