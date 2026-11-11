import test from 'node:test'
import assert from 'node:assert/strict'
import { capDiagnostics, diffCssRule, formatCssDiff } from '../scripts/css-diff.mjs'

test('selector diff reports the exact added native declaration without dumping the bundle', () => {
  const golden = '.dsh-sam-head{display:flex}.dsh-sam-close{flex:0 0 auto;color:red}'
  const built = '.dsh-sam-head{display:grid}.dsh-sam-close{-webkit-app-region:no-drag;flex:0 0 auto;color:red}'
  const diff = diffCssRule(golden, built, '.dsh-sam-close')
  assert.deepEqual(diff.changes, [{ kind: 'added', property: '-webkit-app-region', built: 'no-drag' }])
  const output = formatCssDiff(diff)
  assert.ok(output.includes('+ -webkit-app-region: no-drag'))
  assert.ok(!output.includes('.dsh-sam-head'))
})

test('selector diff handles changed, removed and missing rules explicitly', () => {
  const diff = diffCssRule('.a{color:red;margin:0}', '.a{color:blue}', '.a')
  assert.deepEqual(diff.changes, [
    { kind: 'changed', property: 'color', golden: 'red', built: 'blue' },
    { kind: 'removed', property: 'margin', golden: '0' },
  ])
  assert.equal(diffCssRule('', '.a{color:red}', '.a').golden, null)
  assert.equal(diffCssRule('.a{color:red}', '', '.a').built, null)
})

test('CSS diagnostics do not split on delimiters inside strings or data URLs', () => {
  const golden = '.a{background:url("data:image/svg+xml;utf8,<svg>}</svg>");content:"};";color:red}'
  const built = '.a{background:url("data:image/svg+xml;utf8,<svg>}</svg>");content:"};";margin:0;color:red}'
  assert.deepEqual(diffCssRule(golden, built, '.a').changes, [{ kind: 'added', property: 'margin', built: '0' }])
})

test('diagnostic cap is bounded and retains an explicit truncation marker', () => {
  const output = capDiagnostics('x'.repeat(5000), 200)
  assert.ok(output.length <= 200)
  assert.ok(output.includes('diagnostics truncated'))
  assert.equal(capDiagnostics('short', 200), 'short')
})
