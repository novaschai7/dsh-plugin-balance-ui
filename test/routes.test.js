/**
 * End-to-end verification of the host routes.
 *
 * Drives `apply()` against a fake cordis context and a stubbed upstream, so the
 * real sampler, the real sample store and the real route guards are exercised
 * without touching the network or a live dsh process.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const BALANCE_BODY = {
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    total_balance: '12.34',
    granted_balance: '2.00',
    topped_up_balance: '10.34',
  }],
}

/** A fake cordis context that records the routes the plugin registers. */
function fakeContext(resolveCredential = async () => ({ value: 'test-key' })) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    credentials: { resolve: resolveCredential },
    webServer: {
      register(entry) {
        routes.set(entry.path, entry.handler)
        return () => {}
      },
    },
    effect(run) {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  return { ctx, routes, disposers }
}

/** A fake ServerResponse that records what the handler wrote. */
function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: undefined,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

/** A same-origin request. */
function request(url, overrides = {}) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    ...overrides,
  }
}

/** Wait until `probe` returns true, or fail. */
async function waitFor(probe, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** Let the sampler's in-flight work settle before a temp home is removed. */
async function drain() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Run `body` with a temp DSH_HOME, a stubbed fetch and a live plugin. */
async function withPlugin(body, resolveCredential) {
  const home = await mkdtemp(join(tmpdir(), 'balance-ui-routes-'))
  const previousHome = process.env.DSH_HOME
  const originalFetch = globalThis.fetch
  process.env.DSH_HOME = home
  globalThis.fetch = async () => ({ ok: true, json: async () => BALANCE_BODY })

  const { ctx, routes, disposers } = fakeContext(resolveCredential)
  try {
    apply(ctx)
    await body({ home, routes })
  } finally {
    for (const dispose of disposers) dispose()
    await drain()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = originalFetch
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

/** Call one registered route and return `{ status, json, text, res }`. */
async function call(routes, url, req = request(url)) {
  const path = url.split('?')[0]
  const handler = routes.get(path)
  assert.equal(typeof handler, 'function', `${path} should be registered`)
  const res = fakeResponse()
  await handler(req, res)
  const contentType = res.headers?.['content-type'] ?? ''
  const json = res.body !== undefined && contentType.includes('application/json')
    ? JSON.parse(res.body)
    : undefined
  return { status: res.statusCode, json, text: res.body, res }
}

test('registers every route the client asks for', async () => {
  await withPlugin(async ({ routes }) => {
    for (const path of ['/dsh-balance', '/dsh-usage', '/dsh-usage-history', '/dsh-spend-ledger']) {
      assert.equal(typeof routes.get(path), 'function', `${path} is missing`)
    }
  })
})

test('serves the balance and records a sample in the local store', async () => {
  await withPlugin(async ({ home, routes }) => {
    const { status, json } = await call(routes, '/dsh-balance')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.infos[0].total, '12.34')

    const store = join(home, 'dsh-plugin-balance-ui', 'balance-samples.json')
    const written = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(store, 'utf8'))
        return parsed.samples.length > 0
      } catch {
        return false
      }
    })
    assert.equal(written, true, 'the sampler should persist a sample')

    const parsed = JSON.parse(await readFile(store, 'utf8'))
    assert.equal(parsed.samples.length, 1)
    assert.equal(parsed.samples[0].total, 12.34, 'amounts are stored as numbers, not strings')
    assert.equal(parsed.samples[0].currency, 'CNY')
  })
})

test('the ledger exposes the sampled balance as the account movement', async () => {
  await withPlugin(async ({ home, routes }) => {
    await call(routes, '/dsh-balance')
    const store = join(home, 'dsh-plugin-balance-ui', 'balance-samples.json')
    await waitFor(async () => {
      try {
        return JSON.parse(await readFile(store, 'utf8')).samples.length > 0
      } catch {
        return false
      }
    })

    const { status, json } = await call(routes, '/dsh-spend-ledger?days=7')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.currency, 'CNY')
    assert.equal(json.sampleCount, 1)
    assert.equal(json.spend, 0, 'a single sample cannot show spending yet')
  })
})

test('the history route honours ?days= and clamps nonsense', async () => {
  await withPlugin(async ({ routes }) => {
    const seven = await call(routes, '/dsh-usage-history')
    assert.equal(seven.json.days, 7)
    assert.equal(seven.json.history.length, 7)

    const three = await call(routes, '/dsh-usage-history?days=3')
    assert.equal(three.json.days, 3)
    assert.equal(three.json.history.length, 3)

    const clamped = await call(routes, '/dsh-usage-history?days=9999')
    assert.equal(clamped.json.days, 30)

    const nonsense = await call(routes, '/dsh-usage-history?days=abc')
    assert.equal(nonsense.json.days, 7)
  })
})

test('rejects cross-origin requests and non-read methods', async () => {
  await withPlugin(async ({ routes }) => {
    const foreign = await call(routes, '/dsh-balance', request('/dsh-balance', {
      headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
    }))
    assert.equal(foreign.status, 403)

    const post = await call(routes, '/dsh-balance', request('/dsh-balance', { method: 'POST' }))
    assert.equal(post.status, 405)
    assert.equal(post.res.headers.allow, 'GET, HEAD')

    const head = await call(routes, '/dsh-balance', request('/dsh-balance', { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal(head.res.body, undefined, 'HEAD sends no body')
  })
})

test('reports an upstream failure instead of throwing', async () => {
  await withPlugin(async ({ routes }) => {
    globalThis.fetch = async () => ({ ok: false, status: 500 })
    const { status, json } = await call(routes, '/dsh-balance')
    assert.equal(status, 200)
    assert.equal(json.ok, false)
    assert.match(json.error, /500/)
  })
})

test('reports a missing credential instead of calling upstream', async () => {
  let fetched = false
  await withPlugin(async ({ routes }) => {
    globalThis.fetch = async () => {
      fetched = true
      throw new Error('upstream must not be called')
    }
    const { status, json } = await call(routes, '/dsh-balance')
    assert.equal(status, 200)
    assert.equal(json.ok, false)
    assert.match(json.error, /DEEPSEEK_API_KEY/)
    assert.equal(fetched, false, 'upstream must not be called without a credential')
  }, async () => ({ value: '' }))
})

test('the sampler writes to the home it was applied with, not a later one', async () => {
  // Regression: sampleOnce spans several awaits, so a store path resolved from
  // the environment on each use could be redirected mid-flight. That is how a
  // test harness ends up writing into the real ~/.dsh.
  const first = await mkdtemp(join(tmpdir(), 'balance-ui-home-a-'))
  const second = await mkdtemp(join(tmpdir(), 'balance-ui-home-b-'))
  const previousHome = process.env.DSH_HOME
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => BALANCE_BODY })

  const { ctx, disposers } = fakeContext()
  const storeIn = (home) => join(home, 'dsh-plugin-balance-ui', 'balance-samples.json')
  const exists = async (path) => {
    try {
      await readFile(path, 'utf8')
      return true
    } catch {
      return false
    }
  }

  try {
    process.env.DSH_HOME = first
    apply(ctx)
    process.env.DSH_HOME = second // re-point while the first sample is in flight
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(await exists(storeIn(first)), true, 'the sample lands in the home captured at apply time')
    assert.equal(await exists(storeIn(second)), false, 'a later DSH_HOME must not redirect the store')
  } finally {
    for (const dispose of disposers) dispose()
    await drain()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = originalFetch
    await rm(first, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await rm(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
