/**
 * dsh-plugin-balance-ui — account, usage and reconciliation panel for dsh.
 *
 * Two faces, one package:
 *   - host half (this file): GET /dsh-balance (upstream account balance),
 *     GET /dsh-usage (today's token usage), GET /dsh-usage-history (per-day
 *     usage for a window) and GET /dsh-spend-ledger (what the account balance
 *     actually did over that window, sampled locally).
 *   - browser half (./client.js): renders all four in the sidebar footer.
 *
 * Installed as a dsh bundle: package.json declares `dsh.bundle.patch`, and
 * ./cordis.patch.yml inserts this entry into the profile's layer stack.
 *
 * WHY THE LEDGER EXISTS
 * Local session logs record what dsh spent; the account balance records what
 * the account was actually charged. Nothing local can see the difference, so
 * this plugin samples the balance on a timer and keeps a small local history.
 * Comparing the two is the only way to tell a user why their own numbers and
 * their bill disagree — and to say honestly which of the causes can and cannot
 * be seen from this machine.
 *
 * The DeepSeek credential never leaves this process: no response, log line, or
 * error message contains the API key.
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Account-balance route. */
const BALANCE_PATH = '/dsh-balance'
/** Today's-usage route. */
const USAGE_PATH = '/dsh-usage'
/** Per-day usage history route. */
const HISTORY_PATH = '/dsh-usage-history'
/** Locally sampled account-balance ledger route. */
const LEDGER_PATH = '/dsh-spend-ledger'
/** Credential reference resolved through the host credential seam. */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
/** Upstream account endpoint. */
const UPSTREAM_URL = 'https://api.deepseek.com/user/balance'
/** How long one balance answer is reused for every caller. */
const BALANCE_CACHE_MS = 30_000
/** How long one usage fold is reused; the fold walks session logs. */
const USAGE_CACHE_MS = 10_000
/** The history fold reads more logs than the today fold, so it is cached longer. */
const HISTORY_CACHE_MS = 60_000
/** The ledger only changes when the sampler runs, so it is cached longer still. */
const LEDGER_CACHE_MS = 60_000
/** Upstream request deadline. */
const REQUEST_TIMEOUT_MS = 10_000
/** Zstandard frame magic; session logs are a concatenation of independent frames. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** How many days of per-day usage history a request may ask for. */
const HISTORY_MAX_DAYS = 30
/** Default history window when a request does not ask for one. */
const HISTORY_DEFAULT_DAYS = 7
/** How often the host samples the balance, whether or not a UI is open. */
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000
/** Two samples closer together than this are collapsed. */
const SAMPLE_MIN_INTERVAL_MS = 60 * 1000
/** A changed or unchanged balance is still recorded at least this often. */
const SAMPLE_HEARTBEAT_MS = 6 * 60 * 60 * 1000
/** Samples older than this are pruned from the local store. */
const SAMPLE_RETENTION_MS = 120 * 24 * 60 * 60 * 1000
/** A gap this wide means the ledger may have missed spending inside it. */
const LEDGER_GAP_WARN_MS = 3 * 60 * 60 * 1000

/**
 * Chinese public holidays, as Beijing-time `YYYY-MM-DD` days that are OFF-peak
 * even when they land on a weekday.
 *
 * DeepSeek defines peak as "Monday to Friday, excluding Chinese public
 * holidays"; weekends are off-peak regardless, so statutory make-up workdays
 * (调休上班的周六周日) need no entry here — they stay off-peak either way.
 *
 * Source: 国务院办公厅关于2026年部分节假日安排的通知, 国办发明电〔2025〕7号
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * This list must be refreshed once a year; the notice is published each
 * November for the following year. A date outside the listed years is simply
 * treated as a normal weekday, so a stale entry degrades to an over-estimate
 * inside peak hours rather than to a crash.
 *
 * MIRRORED IN ./client.js — keep the two copies identical.
 */
const HOLIDAYS = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

/** Beijing-time (UTC+8) `YYYY-MM-DD` for an epoch millisecond value. */
function beijingDateKey(timeMs) {
  const shifted = new Date(timeMs + 8 * 60 * 60 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/** Local-time `YYYY-MM-DD` for an epoch millisecond value. */
function localDateKey(timeMs) {
  const date = new Date(timeMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export const inject = ['webServer', 'credentials']

/** Exported for out-of-tree verification of the fold. */
export { readUsage as readTodayUsage }

/** Exported for out-of-tree verification of the per-day fold. */
export { readUsageHistory }

/** Exported for out-of-tree verification of the peak/off-peak calendar. */
export { isPeakHour }

/** Exported for out-of-tree verification of the balance ledger. */
export { computeLedger }

/** Exported for out-of-tree verification of day bucketing. */
export { localDateKey, beijingDateKey }

/** Local day boundary `offsetDays` before today (0 = today). */
function startOfLocalDay(offsetDays = 0) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  now.setDate(now.getDate() - offsetDays)
  return now.getTime()
}

/** Coerce an unknown token field to a number. */
function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Coerce a balance amount, which the upstream API sends as a string, to a number. */
function amount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Whether `timeMs` falls in DeepSeek's peak billing window.
 *
 * Peak is Beijing time (UTC+8) 09:00-12:00 and 14:00-18:00, Monday to Friday,
 * excluding Chinese public holidays; every other hour — weekends and holidays
 * included — is off-peak, billed at half the peak rate.
 *
 * The offsets are applied to the epoch value and then read with the UTC
 * getters, which is equivalent to reading Beijing wall-clock fields.
 */
function isPeakHour(timeMs) {
  const shifted = new Date(timeMs + 8 * 60 * 60 * 1000)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  if (HOLIDAYS.has(beijingDateKey(timeMs))) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/**
 * A zeroed token bucket for one billing window.
 *
 * `cacheWriteTokens` is always 0: DeepSeek's local session records do not carry
 * a cache-write field at all, and the published price table lists cache-hit
 * input, cache-miss input and output only.
 */
function zeroBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** Accumulate one assistant message's tokens into a billing-window bucket. */
function addToBucket(bucket, input, output, cacheRead) {
  bucket.inputTokens += input
  bucket.outputTokens += output
  bucket.cacheReadTokens += cacheRead
}

/** A fresh accumulator for one day. */
function emptyDay() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    peak: zeroBucket(),
    offPeak: zeroBucket(),
    byModel: new Map(),
  }
}

/** A fresh accumulator for a whole fold. */
function emptyAccumulator() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    failedFrames: 0,
    byModel: new Map(),
    peak: zeroBucket(),
    offPeak: zeroBucket(),
    byDay: new Map(),
  }
}

/** One model row inside a day or a whole fold. */
function emptyModelRow(provider, model) {
  return {
    provider,
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    peak: zeroBucket(),
    offPeak: zeroBucket(),
  }
}

/** Accumulate one assistant message into a model map. */
function addToModel(map, provider, model, window, input, output, cacheRead, reasoning) {
  const key = `${provider}/${model}`
  const row = map.get(key) ?? emptyModelRow(provider, model)
  row.requests += 1
  row.inputTokens += input
  row.outputTokens += output
  row.cacheReadTokens += cacheRead
  row.reasoningTokens += reasoning
  addToBucket(row[window], input, output, cacheRead)
  map.set(key, row)
}

/** Fold one qualifying assistant message into both the whole-fold and per-day totals. */
function addRecord(acc, record) {
  const usage = record.data?.usage
  if (usage === undefined || usage === null) return
  const input = tokens(usage.inputTokens)
  const output = tokens(usage.outputTokens)
  const cacheRead = tokens(usage.cacheReadTokens)
  const reasoning = tokens(usage.reasoningTokens)
  const window = isPeakHour(record.time) ? 'peak' : 'offPeak'
  const source = record.data?.message?.source
  const provider = typeof source?.provider === 'string' ? source.provider : 'unknown'
  const model = typeof source?.model === 'string' ? source.model : 'unknown'

  acc.requests += 1
  acc.inputTokens += input
  acc.outputTokens += output
  acc.cacheReadTokens += cacheRead
  acc.reasoningTokens += reasoning
  addToBucket(acc[window], input, output, cacheRead)
  addToModel(acc.byModel, provider, model, window, input, output, cacheRead, reasoning)

  const key = localDateKey(record.time)
  const day = acc.byDay.get(key) ?? emptyDay()
  day.requests += 1
  day.inputTokens += input
  day.outputTokens += output
  day.cacheReadTokens += cacheRead
  day.reasoningTokens += reasoning
  addToBucket(day[window], input, output, cacheRead)
  addToModel(day.byModel, provider, model, window, input, output, cacheRead, reasoning)
  acc.byDay.set(key, day)
}

/** Absolute path of the dsh home directory. */
function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** Absolute path of the directory holding every session log. */
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** Absolute path of the plugin's own local balance-sample store. */
function sampleStorePath() {
  return join(dshHome(), 'dsh-plugin-balance-ui', 'balance-samples.json')
}

/** Collect session-log files touched at or after `since`, newest last. */
async function collectLogs(dir, since, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectLogs(path, since, out)
      continue
    }
    if (!entry.name.endsWith('.jsonl.zstd')) continue
    try {
      const info = await stat(path)
      if (info.mtimeMs >= since) out.push(path)
    } catch {
      /* a session removed mid-scan is not an error */
    }
  }
}

/** Fold every assistant message in one session log that landed at or after `since`. */
async function foldLog(path, since, acc) {
  let buffer
  try {
    buffer = await readFile(path)
  } catch {
    return
  }
  let start = buffer.indexOf(FRAME_MAGIC)
  while (start !== -1) {
    const next = buffer.indexOf(FRAME_MAGIC, start + 4)
    const end = next === -1 ? buffer.length : next
    try {
      const text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      for (const line of text.split('\n')) {
        if (line === '') continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record.type !== 'assistant/message') continue
        if (typeof record.time !== 'number' || record.time < since) continue
        addRecord(acc, record)
      }
    } catch {
      acc.failedFrames += 1
    }
    start = next
  }
}

/** Clamp a requested history window into the supported range. */
function clampDays(value, fallback = HISTORY_DEFAULT_DAYS) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(1, parsed), HISTORY_MAX_DAYS)
}

/** Fold usage across every session log for a window of `days` local days. */
async function foldWindow(days) {
  const since = startOfLocalDay(days - 1)
  const logs = []
  await collectLogs(sessionsRoot(), since, logs)
  const acc = emptyAccumulator()
  for (const log of logs) await foldLog(log, since, acc)
  return { since, logs: logs.length, acc }
}

/** Shape one accumulator into a JSON-friendly usage summary. */
function summarize(acc, sessionFiles, since) {
  return {
    ok: true,
    since: new Date(since).toISOString(),
    requests: acc.requests,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    reasoningTokens: acc.reasoningTokens,
    totalTokens: acc.inputTokens + acc.outputTokens + acc.cacheReadTokens,
    // Same tokens as above, split by DeepSeek's peak / off-peak rate tiers.
    peak: acc.peak,
    offPeak: acc.offPeak,
    models: [...acc.byModel.values()].sort((left, right) => right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens)),
    sessionFiles,
    failedFrames: acc.failedFrames,
    fetchedAt: new Date().toISOString(),
  }
}

/** Shape one day's accumulator into a JSON-friendly row. */
function summarizeDay(key, day) {
  return {
    date: key,
    requests: day.requests,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    cacheReadTokens: day.cacheReadTokens,
    reasoningTokens: day.reasoningTokens,
    totalTokens: day.inputTokens + day.outputTokens + day.cacheReadTokens,
    peak: day.peak,
    offPeak: day.offPeak,
    models: [...day.byModel.values()].sort((left, right) => right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens)),
  }
}

/** Fold today's usage across every session log. */
async function readUsage() {
  const { since, logs, acc } = await foldWindow(1)
  return summarize(acc, logs, since)
}

/**
 * Fold `days` of per-day usage across every session log.
 *
 * Days with no recorded activity are still emitted, so the client can line the
 * window up against the ledger without inferring missing days.
 */
async function readUsageHistory(days) {
  const window = clampDays(days)
  const { since, logs, acc } = await foldWindow(window)
  const rows = []
  for (let offset = window - 1; offset >= 0; offset -= 1) {
    const key = localDateKey(startOfLocalDay(offset))
    const day = acc.byDay.get(key)
    rows.push(day === undefined ? summarizeDay(key, emptyDay()) : summarizeDay(key, day))
  }
  return {
    ...summarize(acc, logs, since),
    days: window,
    history: rows,
  }
}

/** Whether a value is a usable stored balance sample. */
function isSample(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.t === 'number'
    && Number.isFinite(value.t)
    && typeof value.total === 'number'
    && Number.isFinite(value.total)
}

/** Read the local balance-sample store, tolerating any corruption. */
async function loadSamples() {
  try {
    const parsed = JSON.parse(await readFile(sampleStorePath(), 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed?.samples
    return Array.isArray(list) ? list.filter(isSample) : []
  } catch {
    return []
  }
}

/** Write the local balance-sample store through a temporary file. */
async function saveSamples(samples) {
  const path = sampleStorePath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify({ version: 1, samples }, null, 0), 'utf8')
  await rename(temporary, path)
}

/**
 * Turn a run of balance samples into per-day account movement.
 *
 * The account only ever exposes its CURRENT balance, so the amount actually
 * charged is recovered as the sum of the decreases between consecutive
 * samples. Increases are classified as top-ups (a rise in `topped_up_balance`)
 * or grants (a rise in `granted_balance`) and are never counted as spending.
 *
 * Two honest limitations fall out of that, and both are reported rather than
 * hidden:
 *   - A decrease is attributed to the local day of the LATER sample, because
 *     that is the moment it was observed, not necessarily when it happened.
 *   - If a top-up and some spending fall inside one sampling gap, the two can
 *     cancel out and the spending becomes invisible. `maxGapMs` and
 *     `coveredFrom` let the client say how much of the window that affects.
 *
 * @param samples - stored `{ t, total, granted, toppedUp, currency }` rows.
 * @param days - window length in local days, ending today.
 * @param nowMs - current time, injectable for verification.
 */
function computeLedger(samples, days, nowMs = Date.now()) {
  const windowDays = Math.max(1, Math.trunc(days) || 1)
  const windowStart = startOfLocalDay(windowDays - 1)
  const clean = (Array.isArray(samples) ? samples : [])
    .filter(isSample)
    .slice()
    .sort((left, right) => left.t - right.t)

  const byDay = new Map()
  const rowFor = (timeMs) => {
    const key = localDateKey(timeMs)
    let row = byDay.get(key)
    if (row === undefined) {
      row = { date: key, spend: 0, topUp: 0, grant: 0, observations: 0 }
      byDay.set(key, row)
    }
    return row
  }

  // The anchor is the newest sample at or before the window opened: it is the
  // account's opening value, and every later change is measured against it.
  let anchor
  for (const sample of clean) {
    if (sample.t <= windowStart) anchor = sample
    else break
  }
  const firstInside = clean.find((sample) => sample.t > windowStart)

  const events = []
  let maxGapMs = 0
  let previous = anchor
  for (const sample of clean) {
    if (sample.t <= windowStart) continue
    if (previous !== undefined) {
      const gap = sample.t - previous.t
      if (gap > maxGapMs) maxGapMs = gap
      const spent = previous.total - sample.total
      const toppedUp = (sample.toppedUp ?? 0) - (previous.toppedUp ?? 0)
      const granted = (sample.granted ?? 0) - (previous.granted ?? 0)
      const row = rowFor(sample.t)
      row.observations += 1
      if (spent > 0) {
        row.spend += spent
        events.push({ at: sample.t, kind: 'spend', amount: spent })
      }
      if (toppedUp > 0) {
        row.topUp += toppedUp
        events.push({ at: sample.t, kind: 'topUp', amount: toppedUp })
      }
      if (granted > 0) {
        row.grant += granted
        events.push({ at: sample.t, kind: 'grant', amount: granted })
      }
    }
    previous = sample
  }

  const days_rows = []
  let spend = 0
  let topUp = 0
  let grant = 0
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const key = localDateKey(startOfLocalDay(offset))
    const row = byDay.get(key) ?? { date: key, spend: 0, topUp: 0, grant: 0, observations: 0 }
    spend += row.spend
    topUp += row.topUp
    grant += row.grant
    days_rows.push(row)
  }

  const newest = clean.length > 0 ? clean[clean.length - 1] : undefined
  const coveredFrom = anchor !== undefined ? anchor.t : firstInside?.t
  return {
    ok: true,
    days: windowDays,
    currency: newest?.currency ?? null,
    spend,
    topUp,
    grant,
    balance: newest?.total ?? null,
    granted: newest?.granted ?? null,
    toppedUp: newest?.toppedUp ?? null,
    sampleCount: clean.length,
    // Whether the window opened with a known balance, and how far back the
    // samples actually reach.
    covered: anchor !== undefined,
    coveredFrom: coveredFrom === undefined ? null : new Date(coveredFrom).toISOString(),
    unobservedMs: coveredFrom === undefined ? null : Math.max(0, nowMs - coveredFrom),
    maxGapMs,
    gapSuspect: maxGapMs > LEDGER_GAP_WARN_MS,
    events: events.slice(-40),
    rows: days_rows,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Mount the routes and the background sampler.
 * @param ctx - Host root context.
 */
export function apply(ctx) {
  const balanceSlot = {}
  const usageSlot = {}
  const historyCache = new Map()
  const ledgerCache = new Map()

  /** Resolved balance samples, loaded from disk once. */
  let samples
  let samplesLoaded = false
  let sampling = false

  /** Read the balance from the upstream account API. */
  async function loadBalance() {
    let resolved
    try {
      resolved = await ctx.credentials.resolve(CREDENTIAL_REF)
    } catch (error) {
      return { ok: false, error: `cannot resolve ${CREDENTIAL_REF}: ${String(error?.message ?? error)}` }
    }
    const key = resolved?.value
    if (typeof key !== 'string' || key === '') {
      return { ok: false, error: `${CREDENTIAL_REF} is not set` }
    }

    let response
    try {
      response = await fetch(UPSTREAM_URL, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { ok: false, error: `upstream unreachable: ${String(error?.message ?? error)}` }
    }
    if (!response.ok) {
      return { ok: false, error: `upstream returned ${String(response.status)}` }
    }

    let body
    try {
      body = await response.json()
    } catch {
      return { ok: false, error: 'upstream returned a non-JSON body' }
    }
    const infos = Array.isArray(body?.balance_infos)
      ? body.balance_infos.map((info) => ({
        currency: String(info?.currency ?? ''),
        total: String(info?.total_balance ?? ''),
        granted: String(info?.granted_balance ?? ''),
        toppedUp: String(info?.topped_up_balance ?? ''),
      }))
      : []
    return { ok: true, available: body?.is_available === true, infos }
  }

  /** Reuse one cached answer for a short window, collapsing concurrent callers. */
  function cached(slot, ttl, produce) {
    const at = slot.value
    if (at !== undefined && Date.now() - at.at < ttl) return Promise.resolve(at.payload)
    if (slot.inflight !== undefined) return slot.inflight
    const promise = produce()
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
      .then((payload) => {
        slot.value = { at: Date.now(), payload }
        return payload
      })
      .finally(() => {
        slot.inflight = undefined
      })
    slot.inflight = promise
    return promise
  }

  const readBalance = () => cached(balanceSlot, BALANCE_CACHE_MS, loadBalance)

  const readUsageCached = () => cached(usageSlot, USAGE_CACHE_MS, readUsage)

  /** Cache one promise per key, for the routes whose answer depends on `days`. */
  function cachedByKey(map, ttl, key, produce) {
    const hit = map.get(key)
    if (hit !== undefined) {
      if (hit.value !== undefined && Date.now() - hit.value.at < ttl) return Promise.resolve(hit.value.payload)
      if (hit.inflight !== undefined) return hit.inflight
    }
    const slot = hit ?? {}
    map.set(key, slot)
    const promise = produce()
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
      .then((payload) => {
        slot.value = { at: Date.now(), payload }
        return payload
      })
      .finally(() => {
        slot.inflight = undefined
      })
    slot.inflight = promise
    return promise
  }

  const readHistory = (days) => cachedByKey(historyCache, HISTORY_CACHE_MS, clampDays(days), () => readUsageHistory(clampDays(days)))

  /** Ensure the sample store has been read from disk exactly once. */
  async function ensureSamples() {
    if (samplesLoaded) return samples
    samples = await loadSamples()
    samplesLoaded = true
    return samples
  }

  /**
   * Record one balance reading, best-effort.
   *
   * Called both from the sampler timer and from the balance route, so a UI
   * that is open produces denser samples than an idle machine. The network
   * read behind it is already cached, so the extra call is cheap.
   */
  async function sampleOnce() {
    if (sampling) return
    sampling = true
    try {
      const payload = await readBalance()
      if (payload.ok !== true) return
      const info = Array.isArray(payload.infos) ? payload.infos[0] : undefined
      if (info === undefined) return
      const total = amount(info.total)
      if (total === undefined) return
      const granted = amount(info.granted)
      const toppedUp = amount(info.toppedUp)
      const list = await ensureSamples()
      const now = Date.now()
      const last = list[list.length - 1]
      const changed = last === undefined
        || last.total !== total
        || last.granted !== granted
        || last.toppedUp !== toppedUp
        || last.currency !== info.currency
      const elapsed = last === undefined ? Number.POSITIVE_INFINITY : now - last.t
      if (!(last === undefined || (changed && elapsed >= SAMPLE_MIN_INTERVAL_MS) || elapsed >= SAMPLE_HEARTBEAT_MS)) return
      list.push({ t: now, currency: info.currency, total, granted, toppedUp })
      const cutoff = now - SAMPLE_RETENTION_MS
      while (list.length > 0 && list[0].t < cutoff) list.shift()
      await saveSamples(list)
    } catch {
      /* sampling is best-effort and must never disturb the host */
    } finally {
      sampling = false
    }
  }

  const readLedger = (days) => cachedByKey(ledgerCache, LEDGER_CACHE_MS, clampDays(days), async () => {
    const list = await ensureSamples()
    return { ...computeLedger(list, clampDays(days)), store: sampleStorePath() }
  })

  // Sample on a timer so the ledger keeps filling even with no UI open. The
  // timer is unref'd, so it can never hold the process open on its own.
  ctx.effect(() => {
    void sampleOnce()
    const timer = setInterval(() => { void sampleOnce() }, SAMPLE_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => { clearInterval(timer) }
  }, 'balance-ui: balance sampler')

  /** Register one same-origin JSON GET route. */
  function route(path, produce) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const origin = req.headers.origin
        const host = req.headers.host
        if (typeof origin === 'string' && typeof host === 'string' && new URL(origin).host !== host) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        const payload = await produce(req)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
          ...payload,
          fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
        }))
      },
    }), `balance-ui: ${path} route`)
  }

  /** Read `?days=` off a request without letting it influence the fold. */
  function daysOf(req) {
    const query = req.url?.includes('?') === true ? req.url.slice(req.url.indexOf('?') + 1) : ''
    return clampDays(new URLSearchParams(query).get('days'))
  }

  route(BALANCE_PATH, async () => {
    const payload = await readBalance()
    void sampleOnce()
    return payload
  })
  route(USAGE_PATH, () => readUsageCached())
  route(HISTORY_PATH, (req) => readHistory(daysOf(req)))
  route(LEDGER_PATH, (req) => readLedger(daysOf(req)))
}
