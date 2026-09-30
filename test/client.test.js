/**
 * Verification for the browser half.
 *
 * client.js is a lazy-CJS module for the dsh client loader, not an ES module,
 * so this loads it the way the loader does — by capturing the factory it hands
 * to `window.__ModuleLoader__.load` — and then drives the exported pure
 * functions. React is only needed to build the component, never to call them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
// eslint-disable-next-line no-new-func
new Function(source)()

const reactStub = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
}

const client = captured.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
})

/** One local-day usage row, as /dsh-usage-history emits it. */
function dayRow(date, inputTokens, outputTokens) {
  const bucket = (input, output) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 })
  return {
    date,
    requests: 1,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    peak: bucket(inputTokens, outputTokens),
    offPeak: bucket(0, 0),
    models: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      requests: 1,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      peak: bucket(inputTokens, outputTokens),
      offPeak: bucket(0, 0),
    }],
  }
}

/** A /dsh-spend-ledger body built around the given per-day actuals. */
function ledgerBody(rows, overrides = {}) {
  return {
    ok: true,
    days: rows.length,
    currency: 'CNY',
    spend: rows.reduce((sum, row) => sum + row.spend, 0),
    topUp: 0,
    grant: 0,
    sampleCount: 10,
    covered: true,
    coveredFrom: '2026-09-20T00:00:00.000Z',
    maxGapMs: 60_000,
    gapSuspect: false,
    events: [],
    rows,
    ...overrides,
  }
}

test('client module registers itself under its package id', () => {
  assert.equal(captured.id, 'dsh-plugin-balance-ui')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots'])
})

test('buildReconciliation reports drift as actual minus estimated', () => {
  const history = { ok: true, history: [dayRow('2026-09-29', 1_000_000, 0)] }
  const ledger = ledgerBody([{ date: '2026-09-29', spend: 3, topUp: 0, grant: 0, observations: 1 }])
  const recon = client.buildReconciliation(history, ledger)

  assert.equal(recon.ready, true)
  assert.equal(recon.comparable, true)
  // 1M peak input tokens on flash = ¥2.
  assert.ok(Math.abs(recon.estimated - 2) < 1e-9, `estimated was ${recon.estimated}`)
  assert.equal(recon.actual, 3)
  assert.ok(Math.abs(recon.drift - 1) < 1e-9)
  assert.ok(recon.causes.some((cause) => cause.includes('实际高于估算')))
})

test('buildReconciliation names a negative drift as discounts or an over-high table', () => {
  const history = { ok: true, history: [dayRow('2026-09-29', 1_000_000, 0)] }
  const ledger = ledgerBody([{ date: '2026-09-29', spend: 0.5, topUp: 0, grant: 0, observations: 1 }])
  const recon = client.buildReconciliation(history, ledger)

  assert.ok(recon.drift < 0)
  assert.ok(recon.causes.some((cause) => cause.includes('实际低于估算')))
})

test('buildReconciliation refuses to compare a non-CNY account', () => {
  const history = { ok: true, history: [dayRow('2026-09-29', 1_000_000, 0)] }
  const ledger = ledgerBody([{ date: '2026-09-29', spend: 3, topUp: 0, grant: 0, observations: 1 }], { currency: 'USD' })
  const recon = client.buildReconciliation(history, ledger)

  assert.equal(recon.comparable, false)
  assert.equal(recon.ready, false)
  assert.ok(recon.causes.some((cause) => cause.includes('USD')))
  assert.ok(!recon.causes.some((cause) => cause.includes('实际高于估算')), 'a non-CNY account must not be reported as drift')
})

test('buildReconciliation stays unready without samples and says so', () => {
  const history = { ok: true, history: [dayRow('2026-09-29', 1_000_000, 0)] }
  const recon = client.buildReconciliation(history, ledgerBody([], { sampleCount: 0, covered: false }))

  assert.equal(recon.ready, false)
  assert.ok(recon.causes.some((cause) => cause.includes('还没有余额采样样本')))
})

test('buildReconciliation always states the cache-write blind spot', () => {
  const history = { ok: true, history: [] }
  const recon = client.buildReconciliation(history, ledgerBody([]))
  assert.ok(recon.causes.some((cause) => cause.includes('缓存写入')), 'the cache-write caveat is unconditional')
})

test('buildReconciliation surfaces top-ups, grants, gaps and holidays', () => {
  const history = { ok: true, history: [dayRow('2026-10-01', 1_000_000, 0)] }
  const ledger = ledgerBody(
    [{ date: '2026-10-01', spend: 1, topUp: 50, grant: 20, observations: 1 }],
    { topUp: 50, grant: 20, gapSuspect: true, maxGapMs: 5 * 3_600_000 },
  )
  const recon = client.buildReconciliation(history, ledger)

  assert.ok(recon.causes.some((cause) => cause.includes('充值')))
  assert.ok(recon.causes.some((cause) => cause.includes('赠送额度')))
  assert.ok(recon.causes.some((cause) => cause.includes('采样间隔')))
  assert.ok(recon.causes.some((cause) => cause.includes('法定节假日')), '2026-10-01 is a holiday')
})

test('buildReconciliation reports an unpriced model instead of silently costing it', () => {
  const row = dayRow('2026-09-29', 1_000_000, 0)
  row.models[0].model = 'some-unlisted-model'
  const recon = client.buildReconciliation({ ok: true, history: [row] }, ledgerBody([]))

  assert.equal(recon.unpriced, true)
  assert.equal(recon.estimated, 0)
  assert.ok(recon.causes.some((cause) => cause.includes('不在费率表内')))
})

test('buildReconciliation returns null until both halves have arrived', () => {
  assert.equal(client.buildReconciliation(null, ledgerBody([])), null)
  assert.equal(client.buildReconciliation({ ok: true, history: [] }, null), null)
  assert.equal(client.buildReconciliation({ ok: false, error: 'x' }, ledgerBody([])), null)
})
