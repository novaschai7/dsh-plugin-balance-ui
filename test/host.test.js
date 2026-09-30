/**
 * Verification for the host half.
 *
 * Run with `npm test` (node:test, no dependencies).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  beijingDateKey,
  computeLedger,
  isPeakHour,
  localDateKey,
  readUsageHistory,
} from '../index.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Local midnight `offsetDays` before today. */
function localMidnight(offsetDays = 0) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - offsetDays)
  return date.getTime()
}

/** Local `YYYY-MM-DD`, written independently of the implementation. */
function ymd(timeMs) {
  const date = new Date(timeMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** One stored balance sample. */
function sample(t, total, granted = 0, toppedUp = total, currency = 'CNY') {
  return { t, total, granted, toppedUp, currency }
}

/** Build a `*.jsonl.zstd` session log the way dsh writes one. */
function sessionLog(records) {
  const body = records.map((record) => JSON.stringify(record)).join('\n')
  return zstdCompressSync(Buffer.from(body, 'utf8'))
}

/** One assistant message record. */
function assistantMessage(time, usage, model = 'deepseek-flash', provider = 'deepseek-official') {
  return {
    type: 'assistant/message',
    time,
    data: { usage, message: { source: { provider, model } } },
  }
}

test('isPeakHour follows Beijing weekday windows, weekends and holidays', () => {
  // 2026-09-30 is a Wednesday.
  assert.equal(isPeakHour(Date.parse('2026-09-30T02:00:00Z')), true, 'Beijing 10:00 on a Wednesday is peak')
  assert.equal(isPeakHour(Date.parse('2026-09-30T04:30:00Z')), false, 'Beijing 12:30 is the lunch break')
  assert.equal(isPeakHour(Date.parse('2026-09-30T06:00:00Z')), true, 'Beijing 14:00 is peak again')
  assert.equal(isPeakHour(Date.parse('2026-09-30T10:00:00Z')), false, 'Beijing 18:00 ends peak')
  assert.equal(isPeakHour(Date.parse('2026-09-30T00:30:00Z')), false, 'Beijing 08:30 is before peak')
  assert.equal(isPeakHour(Date.parse('2026-10-03T02:00:00Z')), false, 'a Saturday is never peak')
  // 国庆节 2026-10-01..07, a Thursday inside the holiday.
  assert.equal(isPeakHour(Date.parse('2026-10-01T02:00:00Z')), false, 'a weekday holiday is off-peak')
  assert.equal(beijingDateKey(Date.parse('2026-09-30T16:30:00Z')), '2026-10-01', 'UTC+8 rolls the date over')
})

test('computeLedger counts only balance decreases as spending', () => {
  const anchor = localMidnight(3) + 12 * HOUR // predates the window, so it sets the opening balance
  const base = localMidnight(2) + 12 * HOUR
  const ledger = computeLedger([
    sample(anchor, 100),
    sample(base, 99.5),
    sample(base + HOUR, 150), // top-up of 50.5
    sample(base + 2 * HOUR, 149), // spend of 1
  ], 3, base + 3 * HOUR)

  assert.equal(ledger.days, 3)
  assert.ok(Math.abs(ledger.spend - 1.5) < 1e-9, `spend was ${ledger.spend}`)
  assert.ok(Math.abs(ledger.topUp - 50.5) < 1e-9, `topUp was ${ledger.topUp}`)
  assert.equal(ledger.grant, 0)
  assert.equal(ledger.covered, true)
})

test('computeLedger reports grants separately from spend and top-ups', () => {
  const base = localMidnight(1) + 9 * HOUR
  const ledger = computeLedger([
    sample(base, 100, 0, 100),
    sample(base + HOUR, 120, 20, 100), // a 20 grant
  ], 2, base + 2 * HOUR)

  assert.equal(ledger.spend, 0)
  assert.equal(ledger.topUp, 0)
  assert.equal(ledger.grant, 20)
})

test('computeLedger marks a window that opened without a known balance', () => {
  const base = localMidnight(0) + 9 * HOUR
  const ledger = computeLedger([
    sample(base, 100),
    sample(base + HOUR, 98),
  ], 7, base + 2 * HOUR)

  assert.equal(ledger.covered, false, 'no sample predates the window, so it is not covered')
  assert.equal(ledger.coveredFrom, new Date(base).toISOString())
  assert.ok(Math.abs(ledger.spend - 2) < 1e-9)
})

test('computeLedger flags a sampling gap wide enough to hide spending', () => {
  const base = localMidnight(1) + 9 * HOUR
  const ledger = computeLedger([
    sample(base, 100),
    sample(base + 10 * HOUR, 90),
  ], 2, base + 11 * HOUR)

  assert.equal(ledger.gapSuspect, true)
  assert.equal(ledger.maxGapMs, 10 * HOUR)
})

test('computeLedger tolerates an empty or corrupt store', () => {
  for (const input of [[], null, undefined, [{ t: 'nope' }], [{ t: 1 }]]) {
    const ledger = computeLedger(input, 7, Date.now())
    assert.equal(ledger.spend, 0)
    assert.equal(ledger.covered, false)
    assert.equal(ledger.currency, null)
  }
})

test('readUsageHistory buckets records per local day and fills empty days', async () => {
  const home = await mkdtemp(join(tmpdir(), 'balance-ui-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = join(home, 'sessions', 'project-a')
    await mkdir(dir, { recursive: true })

    const today = localMidnight(0) + 10 * HOUR
    const yesterday = localMidnight(1) + 11 * HOUR
    const tooOld = localMidnight(9) + 12 * HOUR

    await writeFile(join(dir, 'session-a.jsonl.zstd'), sessionLog([
      assistantMessage(yesterday, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, reasoningTokens: 10 }),
      assistantMessage(today, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 0 }),
      assistantMessage(today, { inputTokens: 300, outputTokens: 30, cacheReadTokens: 100, reasoningTokens: 5 }, 'deepseek-v4-pro'),
      assistantMessage(tooOld, { inputTokens: 9999, outputTokens: 9999, cacheReadTokens: 0, reasoningTokens: 0 }),
    ]))

    const result = await readUsageHistory(3)
    assert.equal(result.days, 3)
    assert.equal(result.history.length, 3)

    const keys = result.history.map((row) => row.date)
    assert.deepEqual(keys, [ymd(localMidnight(2)), ymd(localMidnight(1)), ymd(localMidnight(0))])

    const [empty, yday, now] = result.history
    assert.equal(empty.requests, 0, 'a day with no activity is still emitted')
    assert.equal(empty.totalTokens, 0)

    assert.equal(yday.requests, 1)
    assert.equal(yday.totalTokens, 1000 + 100 + 500)

    assert.equal(now.requests, 2)
    assert.equal(now.totalTokens, (200 + 20 + 0) + (300 + 30 + 100))
    assert.ok(now.models.some((row) => row.model === 'deepseek-v4-pro'), 'per-model rows survive the fold')

    // The out-of-window record must not leak into any day.
    const total = result.history.reduce((sum, row) => sum + row.totalTokens, 0)
    assert.equal(total, 1000 + 100 + 500 + 200 + 20 + 300 + 30 + 100)

    // Every record lands in exactly one billing window.
    for (const row of result.history) {
      const bucketed = row.peak.inputTokens + row.peak.outputTokens + row.peak.cacheReadTokens
        + row.offPeak.inputTokens + row.offPeak.outputTokens + row.offPeak.cacheReadTokens
      assert.equal(bucketed, row.totalTokens, `${row.date} must be fully attributed to peak or off-peak`)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('readUsageHistory clamps the requested window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'balance-ui-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'sessions'), { recursive: true })
    assert.equal((await readUsageHistory(0)).days, 1)
    assert.equal((await readUsageHistory(-5)).days, 1)
    assert.equal((await readUsageHistory(9999)).days, 30)
    assert.equal((await readUsageHistory('nonsense')).days, 7)
    assert.equal(localDateKey(localMidnight(0)), ymd(localMidnight(0)))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
