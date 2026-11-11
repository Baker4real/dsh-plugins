function topLevelDelimiters(source, start, delimiter) {
  const indexes = []
  let quote = null
  let comment = false
  let parentheses = 0
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (comment) {
      if (char === '*' && next === '/') { comment = false; index++ }
      continue
    }
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '*') { comment = true; index++; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') { parentheses++; continue }
    if (char === ')') { parentheses = Math.max(0, parentheses - 1); continue }
    if (parentheses === 0 && char === delimiter) indexes.push(index)
  }
  return indexes
}

function declarations(body) {
  const values = new Map()
  if (body === null) return values
  const separators = topLevelDelimiters(body, 0, ';')
  let start = 0
  for (const end of [...separators, body.length]) {
    const declaration = body.slice(start, end)
    start = end + 1
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim()
    if (property) values.set(property, declaration.slice(colon + 1).trim())
  }
  return values
}

function ruleBody(source, selector) {
  const start = source.indexOf(`${selector}{`)
  if (start < 0) return null
  const bodyStart = start + selector.length + 1
  const [end] = topLevelDelimiters(source, bodyStart, '}')
  return end === undefined ? null : source.slice(bodyStart, end)
}

export function diffCssRule(golden, built, selector) {
  const goldenBody = ruleBody(golden, selector)
  const builtBody = ruleBody(built, selector)
  const before = declarations(goldenBody)
  const after = declarations(builtBody)
  const changes = []
  for (const [property, goldenValue] of before) {
    if (!after.has(property)) changes.push({ kind: 'removed', property, golden: goldenValue })
    else if (after.get(property) !== goldenValue) changes.push({ kind: 'changed', property, golden: goldenValue, built: after.get(property) })
  }
  for (const [property, builtValue] of after) if (!before.has(property)) changes.push({ kind: 'added', property, built: builtValue })
  return { selector, golden: goldenBody, built: builtBody, changes }
}

export function formatCssDiff(diff) {
  const lines = [`CSS selector ${diff.selector}:`]
  if (diff.golden === null) lines.push('  golden rule: <missing>')
  if (diff.built === null) lines.push('  built rule: <missing>')
  for (const change of diff.changes) {
    if (change.kind === 'added') lines.push(`  + ${change.property}: ${change.built}`)
    else if (change.kind === 'removed') lines.push(`  - ${change.property}: ${change.golden}`)
    else lines.push(`  ~ ${change.property}: ${change.golden} -> ${change.built}`)
  }
  if (diff.golden !== null && diff.built !== null && diff.changes.length === 0) lines.push('  declarations identical')
  return lines.join('\n')
}

export function capDiagnostics(text, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 80) throw new Error('maxChars must be an integer of at least 80')
  if (text.length <= maxChars) return text
  const marker = '\n... diagnostics truncated; increase --max-chars ...'
  return text.slice(0, maxChars - marker.length) + marker
}
