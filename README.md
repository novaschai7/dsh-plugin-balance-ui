# dsh-plugin-balance-ui

Account and usage panel for the [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) Web client. It adds a block to the sidebar footer showing your DeepSeek account balance, today's token usage, an estimate of today's spend, and whether the current Beijing-time billing tier is peak or off-peak.

[中文说明](./README.zh.md)

## What it shows

With the sidebar expanded:

| Row | Meaning |
| --- | --- |
| 余额 | Account balance from `GET /user/balance`, in the account's own currency |
| 今日 | Today's total tokens (input + output + cache hits), compacted |
| 花费 | Estimated spend for today, in CNY |
| 时段 | `高峰` or `空闲` for the billing tier in force right now |

While the sidebar is collapsed, the same four values are stacked as compact text inside the rail.

Hovering the block shows a tooltip with the exact figures: topped-up and granted balance, input / output / cache-hit token counts, request count, the per-tier subtotals behind the spend estimate, the current per-million-token rates, and the Beijing-time stamp of the next tier switch.

## How the numbers are produced

Everything is derived on your machine from data dsh already has. The plugin does not call any service other than DeepSeek's own balance endpoint.

- **Balance** — the host half calls `https://api.deepseek.com/user/balance` with the credential resolved through dsh's credential seam, cached for 30 seconds.
- **Usage** — the host half walks the session logs under `$DSH_HOME/sessions` (default `~/.dsh/sessions`), decompresses the `.jsonl.zstd` files, and folds every `assistant/message` record whose timestamp falls after local midnight. The result is cached for 10 seconds. Files are only read; nothing is written back.
- **Spend** — the browser half prices each model row against DeepSeek's published CNY list prices, using the peak bucket and the off-peak bucket separately.

`reasoningTokens` is reported by the host but never billed separately, because it is already a subset of `outputTokens`. Cache-write tokens are priced at zero: DeepSeek's published table lists cache-hit input, cache-miss input, and output only.

### Peak and off-peak

DeepSeek bills two tiers, with off-peak at half the peak rate. Peak is Beijing time (UTC+8) 09:00–12:00 and 14:00–18:00, Monday to Friday, excluding Chinese public holidays; every other hour, including all weekends and holidays, is off-peak.

The host tags each assistant message with the window it landed in, so each tier is priced at its own rate rather than a blended average. The tier badge is driven by its own timer scheduled on the next Beijing boundary, so it flips at 09:00 / 12:00 / 14:00 / 18:00 / midnight rather than up to one poll interval late.

### Rates

Quoted from <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>, CNY per million tokens:

| Model | Tier | Input | Output | Cache hit |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | peak | ¥2 | ¥8 | ¥0.04 |
| `deepseek-flash` | off-peak | ¥1 | ¥4 | ¥0.02 |
| `deepseek-v4-pro` | peak | ¥9 | ¥27 | ¥0.3 |
| `deepseek-v4-pro` | off-peak | ¥4.5 | ¥13.5 | ¥0.15 |

Retired ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are aliased to `deepseek-flash`, since the service still accepts them and bills them at the Flash price. A model with no entry in the rate table is reported as unpriced, and the spend row renders `—` instead of guessing.

The 2026 Chinese public holidays are listed explicitly, from 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号). Statutory make-up workdays (调休上班的周六周日) need no entry, because weekends are off-peak regardless. **The holiday list needs refreshing once a year** — the notice for the following year is published each November. A year not in the list is treated as having no holidays, which over-estimates spend mildly during weekday peak hours rather than failing.

**The spend figure is an estimate, not a bill.** It is computed from locally recorded token counts and published list prices. It does not know about discounts, grants, or any pricing change DeepSeek makes after this release.

## Install

From the plugin market (dsh-market), search for `balance-ui`.

Or from the command line:

```sh
dsh plugin --profile web add dsh-plugin-balance-ui
```

Then restart the dsh service so the new profile layer is composed.

## Requirements

- A dsh profile backed by the Web app.
- A DeepSeek API key available to dsh's credential seam as `DEEPSEEK_API_KEY`. Without it the usage rows still work; only the balance row shows an error.
- Node.js ≥ 22.15.0 (the host half uses `zlib.zstdDecompressSync`).

## Routes

The host half registers two same-origin, read-only JSON routes:

| Route | Payload |
| --- | --- |
| `GET /dsh-balance` | `{ ok, available, infos: [{ currency, total, granted, toppedUp }] }` |
| `GET /dsh-usage` | Today's token totals, peak/off-peak buckets, and per-model rows |

Both reject non-`GET`/`HEAD` methods and cross-origin requests, and send `cache-control: no-store`.

## Privacy

The API key is resolved inside the dsh process and used only for the upstream balance request. It is never written to a response, a log line, or an error message. The plugin reads session logs and writes nothing. There is no telemetry and no third-party service.

## License

MIT — see [LICENSE](./LICENSE).
