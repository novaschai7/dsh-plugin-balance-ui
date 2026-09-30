/**
 * dsh-plugin-balance-ui — account and usage panel for the dsh Web client.
 *
 * Two faces, one package:
 *   - host half (this file): GET /dsh-balance (upstream account balance) and
 *     GET /dsh-usage (today's token usage folded out of the local session logs).
 *   - browser half (./client.js): renders both in the sidebar footer.
 *
 * Installed as a dsh bundle: package.json declares `dsh.bundle.patch`, and
 * ./cordis.patch.yml inserts this entry into the profile's layer stack.
 *
 * The DeepSeek credential never leaves this process: no response, log line, or
 * error message contains the API key.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Account-balance route. */
const BALANCE_PATH = '/dsh-balance'
/** Today's-usage route. */
const USAGE_PATH = '/dsh-usage'
/** Credential reference resolved through the host credential seam. */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
/** Upstream account endpoint. */
const UPSTREAM_URL = 'https://api.deepseek.com/user/balance'
/** How long one balance answer is reused for every caller. */
const BALANCE_CACHE_MS = 30_000
/** How long one usage fold is reused; the fold walks session logs. */
const USAGE_CACHE_MS = 10_000
/** Upstream request deadline. */
const REQUEST_TIMEOUT_MS = 10_000
/** Zstandard frame magic; session logs are a concatenation of independent frames. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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

export const inject = ['webServer', 'credentials']

/** Exported for out-of-tree verification of the fold. */
export { readUsage as readTodayUsage }

/** Exported for out-of-tree verification of the peak/off-peak calendar. */
export { isPeakHour }

/** Local day boundary: the most recent local midnight. */
function startOfToday() {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.getTime()
}

/** Coerce an unknown token field to a number. */
function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
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
 * `cacheWriteTokens` is always 0: DeepSeek's price table lists cache-hit input,
 * cache-miss input and output only, so a cache write is never billed.
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

/** Absolute path of the directory holding every session log. */
function sessionsRoot() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'sessions')
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

/** Fold every assistant message in one session log that landed today. */
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
        const usage = record.data?.usage
        if (usage === undefined || usage === null) continue
        const input = tokens(usage.inputTokens)
        const output = tokens(usage.outputTokens)
        const cacheRead = tokens(usage.cacheReadTokens)
        const reasoning = tokens(usage.reasoningTokens)
        // Which rate tier this message is billed at.
        const window = isPeakHour(record.time) ? 'peak' : 'offPeak'
        acc.requests += 1
        acc.inputTokens += input
        acc.outputTokens += output
        acc.cacheReadTokens += cacheRead
        acc.reasoningTokens += reasoning
        addToBucket(acc[window], input, output, cacheRead)
        const source = record.data?.message?.source
        const provider = typeof source?.provider === 'string' ? source.provider : 'unknown'
        const model = typeof source?.model === 'string' ? source.model : 'unknown'
        const key = `${provider}/${model}`
        const row = acc.byModel.get(key) ?? {
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
        row.requests += 1
        row.inputTokens += input
        row.outputTokens += output
        row.cacheReadTokens += cacheRead
        row.reasoningTokens += reasoning
        addToBucket(row[window], input, output, cacheRead)
        acc.byModel.set(key, row)
      }
    } catch {
      acc.failedFrames += 1
    }
    start = next
  }
}

/** Fold today's usage across every session log. */
async function readUsage() {
  const since = startOfToday()
  const logs = []
  await collectLogs(sessionsRoot(), since, logs)
  const acc = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    failedFrames: 0,
    byModel: new Map(),
    peak: zeroBucket(),
    offPeak: zeroBucket(),
  }
  for (const log of logs) await foldLog(log, since, acc)
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
    sessionFiles: logs.length,
    failedFrames: acc.failedFrames,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Mount both routes behind one short-lived cache each.
 * @param ctx - Host root context.
 */
export function apply(ctx) {
  let cachedBalance
  let inflightBalance
  let cachedUsage
  let inflightUsage

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
  function cached(ttl, readCache, writeCache, readInflight, writeInflight, produce) {
    const at = readCache()
    if (at !== undefined && Date.now() - at.at < ttl) return Promise.resolve(at.payload)
    const running = readInflight()
    if (running !== undefined) return running
    const promise = produce()
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
      .then((payload) => {
        writeCache({ at: Date.now(), payload })
        return payload
      })
      .finally(() => {
        writeInflight(undefined)
      })
    writeInflight(promise)
    return promise
  }

  const readBalance = () => cached(
    BALANCE_CACHE_MS,
    () => cachedBalance,
    (value) => { cachedBalance = value },
    () => inflightBalance,
    (value) => { inflightBalance = value },
    loadBalance,
  )

  const readUsageCached = () => cached(
    USAGE_CACHE_MS,
    () => cachedUsage,
    (value) => { cachedUsage = value },
    () => inflightUsage,
    (value) => { inflightUsage = value },
    readUsage,
  )

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
        const payload = await produce()
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

  route(BALANCE_PATH, readBalance)
  route(USAGE_PATH, readUsageCached)
}
