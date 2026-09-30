/**
 * dsh-plugin-balance-ui — browser half.
 *
 * Renders the DeepSeek account balance and today's token usage in the sidebar
 * footer (slot `sidebar.footer.action`, a list slot, so it sits beside the
 * Cordis indicator and above Settings).
 *
 * Hand-written bundle in the lazy-CJS registration format the client module
 * system expects; it must be plain JS, not TypeScript.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-balance-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    /**
     * Polling cadence. The host `/dsh-usage` route caches for 10s and the fold
     * behind it measures ~100-300ms, so a 10s poll is roughly the shortest
     * interval that still returns fresh data.
     */
    const POLL_MS = 10_000;

    /**
     * Reconciliation refresh cadence. The history fold walks more logs than the
     * today fold, and the host caches both for 60s, so asking faster would only
     * return the same answer.
     */
    const RECON_MS = 60_000;

    /** Days of history the reconciliation compares over. */
    const RECON_DAYS = 7;

    /**
     * Token rates, CNY per million tokens — DeepSeek's official list price.
     *
     * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
     *
     * These are the published RMB figures, quoted directly. No currency
     * conversion happens anywhere in this file: the account balance is already
     * in CNY, so an RMB rate table removes the old USD round trip.
     *
     * DeepSeek bills two tiers. Off-peak is exactly half of peak. Peak is
     * Beijing time 09:00-12:00 and 14:00-18:00, Monday to Friday; weekends and
     * Chinese public holidays are off-peak all day. The host attributes every
     * message to its own window, so each tier is priced at its own rate rather
     * than a blended average.
     *
     * `cacheWrite` is 0 across the board: the published table prices cache-hit
     * input, cache-miss input and output only.
     *
     * `aliases` maps retired model ids onto the id that now serves them.
     * Session logs record `deepseek-flash`; the catalog shipped with the
     * harness still lists the retired `deepseek-v4-flash` and
     * `deepseek-v4-flash-vision-exp` names, which DeepSeek still accepts but
     * serves with DeepSeek-V4.1-Flash and bills at the Flash price. Delete an
     * alias to make that id report as unpriced ("—") instead.
     */
    const PRICING = {
      rates: {
        "deepseek-flash": {
          peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
          offPeak: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 },
        },
        "deepseek-v4-pro": {
          peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 },
          offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
        },
      },
      aliases: {
        "deepseek-v4-flash": "deepseek-flash",
        "deepseek-v4-flash-vision-exp": "deepseek-flash",
      },
    };

    /** Spend for one token bucket at one rate tier, in CNY. */
    function bucketCost(bucket, rate) {
      if (bucket === undefined || rate === undefined) return 0;
      return (bucket.inputTokens || 0) / 1e6 * rate.input
        + (bucket.outputTokens || 0) / 1e6 * rate.output
        + (bucket.cacheReadTokens || 0) / 1e6 * rate.cacheRead
        + (bucket.cacheWriteTokens || 0) / 1e6 * rate.cacheWrite;
    }

    /**
     * Chinese public holidays, as Beijing-time `YYYY-MM-DD` days that count as
     * off-peak even when they land on a weekday.
     *
     * DeepSeek bills peak as "Monday to Friday, excluding Chinese public
     * holidays"; weekends are off-peak regardless, so statutory make-up
     * workdays (调休上班的周六周日) need no entry — they stay off-peak either way.
     *
     * Source: 国务院办公厅关于2026年部分节假日安排的通知, 国办发明电〔2025〕7号
     * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
     *
     * MIRRORED IN ./index.js — keep the two copies identical. Refresh annually;
     * the notice is published each November for the following year. A year not
     * listed here degrades to "no holidays", i.e. a mild over-estimate during
     * weekday peak hours, never a crash.
     */
    const HOLIDAYS = new Set([
      // 元旦
      "2026-01-01", "2026-01-02", "2026-01-03",
      // 春节
      "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
      "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
      // 清明节
      "2026-04-04", "2026-04-05", "2026-04-06",
      // 劳动节
      "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
      // 端午节
      "2026-06-19", "2026-06-20", "2026-06-21",
      // 中秋节
      "2026-09-25", "2026-09-26", "2026-09-27",
      // 国庆节
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
      "2026-10-05", "2026-10-06", "2026-10-07",
    ]);

    /** Beijing-time (UTC+8) `YYYY-MM-DD` for an epoch millisecond value. */
    function beijingDateKey(timeMs) {
      const shifted = new Date(timeMs + 8 * 60 * 60 * 1000);
      const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
      const day = String(shifted.getUTCDate()).padStart(2, "0");
      return `${shifted.getUTCFullYear()}-${month}-${day}`;
    }

    /** Beijing-time `MM-DD HH:MM`, for the next tier switch. */
    function beijingStamp(timeMs) {
      const shifted = new Date(timeMs + 8 * 60 * 60 * 1000);
      const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
      const day = String(shifted.getUTCDate()).padStart(2, "0");
      const hour = String(shifted.getUTCHours()).padStart(2, "0");
      const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
      return `${month}-${day} ${hour}:${minute}`;
    }

    /** Whether `timeMs` is inside the peak billing window. */
    function isPeak(timeMs) {
      const shifted = new Date(timeMs + 8 * 60 * 60 * 1000);
      const day = shifted.getUTCDay();
      if (day === 0 || day === 6) return false;
      if (HOLIDAYS.has(beijingDateKey(timeMs))) return false;
      const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
    }

    /** The billing tier in force at `timeMs`; also the key into PRICING.rates. */
    function tierAt(timeMs) {
      return isPeak(timeMs) ? "peak" : "offPeak";
    }

    /**
     * Epoch ms of the next instant the tier can change.
     *
     * The tier is a step function whose only steps are Beijing 09:00, 12:00,
     * 14:00 and 18:00, plus 00:00 for weekday/weekend/holiday transitions. The
     * badge is rescheduled off this rather than off the poll, so it flips on
     * the boundary instead of up to one poll interval late.
     */
    function nextTierChangeMs(nowMs) {
      const DAY = 86_400_000;
      const BEIJING = 8 * 60 * 60 * 1000;
      const shifted = nowMs + BEIJING;
      const midnight = Math.floor(shifted / DAY) * DAY;
      for (const hour of [9, 12, 14, 18, 24]) {
        const candidate = midnight + hour * 3_600_000;
        if (candidate > shifted) return candidate - BEIJING;
      }
      return midnight + DAY - BEIJING;
    }

    /**
     * Estimate spend for one usage payload, in CNY.
     *
     * `inputTokens` is the uncached (cache-miss) prompt only — the host reports
     * totalTokens = inputTokens + outputTokens + cacheReadTokens — and
     * reasoningTokens is a subset of outputTokens, so neither is billed twice.
     *
     * Each model row carries its own `peak` / `offPeak` buckets, priced at that
     * tier's official rate. A host older than the peak/off-peak split reports
     * flat totals instead; those are billed wholly off-peak and `split` comes
     * back false so the tooltip can say so.
     *
     * @param usage - a /dsh-usage response body.
     * @returns CNY total, the peak and off-peak subtotals, whether any row was
     *   unpriced, and whether peak/off-peak was actually distinguished.
     */
    function estimateCost(usage) {
      const rows = Array.isArray(usage.models) && usage.models.length > 0
        ? usage.models
        : [{
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          peak: usage.peak,
          offPeak: usage.offPeak,
        }];
      let cny = 0;
      let peakCny = 0;
      let offPeakCny = 0;
      let unpriced = false;
      let split = true;
      for (const row of rows) {
        const alias = row.model === undefined ? undefined : PRICING.aliases[row.model];
        const id = alias !== undefined ? alias : row.model;
        const rate = PRICING.rates[id];
        if (rate === undefined) {
          unpriced = true;
          continue;
        }
        if (row.peak === undefined || row.offPeak === undefined) {
          split = false;
          const flat = bucketCost(row, rate.offPeak);
          offPeakCny += flat;
          cny += flat;
          continue;
        }
        const peak = bucketCost(row.peak, rate.peak);
        const off = bucketCost(row.offPeak, rate.offPeak);
        peakCny += peak;
        offPeakCny += off;
        cny += peak + off;
      }
      return { cny, peakCny, offPeakCny, unpriced, split };
    }

    /** Currency symbol for the account currency code. */
    function symbolOf(currency) {
      if (currency === "CNY") return "\u00a5";
      if (currency === "USD") return "$";
      return currency === "" ? "" : `${currency} `;
    }

    /** Compact token count: 1234 -> "1.2K", 8_273_664 -> "8.3M". */
    function compact(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
      if (value < 1000) return String(value);
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
      if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      return `${(value / 1_000_000_000).toFixed(2)}B`;
    }

    /** Thousands separators for exact figures shown in the tooltip. */
    function exact(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "0";
      return value.toLocaleString("en-US");
    }

    /** `MM-DD` label for a `YYYY-MM-DD` day key. */
    function shortDate(key) {
      return typeof key === "string" && key.length >= 10 ? key.slice(5) : String(key);
    }

    /**
     * Local `YYYY-MM-DD` for an ISO timestamp.
     *
     * History day keys are LOCAL days (the host buckets them with
     * `localDateKey`), so the covered-from instant has to be reduced to a local
     * day the same way rather than compared as a UTC date.
     */
    function localDayKey(iso) {
      const parsed = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
      if (!Number.isFinite(parsed)) return null;
      const date = new Date(parsed);
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${date.getFullYear()}-${month}-${day}`;
    }

    /** Whole hours, for the sampling-gap caveat. */
    function hours(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0";
      return (ms / 3_600_000).toFixed(ms < 3_600_000 ? 1 : 0);
    }

    /** Signed CNY, e.g. "+¥0.05" / "-¥0.12". */
    function signed(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return `${value >= 0 ? "+" : "-"}\u00a5${Math.abs(value).toFixed(2)}`;
    }

    /**
     * Compare what the local logs say was spent against what the account
     * balance actually did over the same window.
     *
     * The two figures are expected to differ, and the point of this function is
     * to say by how much and why, not to force them to agree. Every cause it
     * lists is one it can actually observe; the cache-write caveat is listed
     * unconditionally because local session logs carry no cache-write field at
     * all, so that charge is structurally invisible here.
     *
     * @param history - a /dsh-usage-history body.
     * @param ledger - a /dsh-spend-ledger body.
     * @returns null while either half is still missing.
     */
    function buildReconciliation(history, ledger) {
      if (history === null || ledger === null) return null;
      if (history.ok !== true || ledger.ok !== true) return null;

      const rows = Array.isArray(history.history) ? history.history : [];
      const ledgerRows = new Map(
        (Array.isArray(ledger.rows) ? ledger.rows : []).map((row) => [row.date, row]),
      );

      // Price every day the history reported, then keep only the days the
      // ledger fully covers. A day is comparable once sampling reaches back
      // past its midnight; otherwise the estimate would span more time than
      // the balance movement does, and every gap would read as a false drift.
      const everyDay = [];
      for (const row of rows) {
        const tokens = typeof row.totalTokens === "number" ? row.totalTokens : 0;
        let cny = 0;
        let dayUnpriced = false;
        if (tokens > 0) {
          const cost = estimateCost(row);
          cny = cost.cny;
          dayUnpriced = cost.unpriced;
        }
        const actualRow = ledgerRows.get(row.date);
        everyDay.push({
          date: row.date,
          tokens,
          estimated: cny,
          actual: actualRow === undefined ? 0 : actualRow.spend,
          unpriced: dayUnpriced,
        });
      }

      const coveredKey = localDayKey(ledger.coveredFrom);
      const days = coveredKey === null ? everyDay : everyDay.filter((day) => day.date > coveredKey);
      const estimated = days.reduce((sum, day) => sum + day.estimated, 0);
      const actual = days.reduce((sum, day) => sum + day.actual, 0);
      const unpriced = days.some((day) => day.unpriced);
      const drift = actual - estimated;
      // The rate table is CNY, so an account in another currency cannot be
      // compared against it at all rather than compared wrongly.
      const comparable = ledger.currency === "CNY";
      const sampled = typeof ledger.sampleCount === "number" && ledger.sampleCount > 0;
      const ready = comparable && sampled && days.length > 0;

      const causes = [];
      if (!comparable) {
        causes.push(`账户以 ${ledger.currency || "未知币种"} 计价，本插件按人民币价目表估算，因此不做对账`);
      } else if (!sampled) {
        causes.push("还没有余额采样样本，插件运行一段时间后才可对账");
      } else if (days.length === 0) {
        causes.push("对账需要至少一整天完整的余额采样，明天起可用");
      } else if (coveredKey !== null && days.length < everyDay.length) {
        causes.push(`对账区间为 ${shortDate(days[0].date)} 起，更早的时段没有采样`);
      }
      if (ledger.gapSuspect === true) {
        causes.push(`采样间隔最长 ${hours(ledger.maxGapMs)} 小时，期间的消耗与充值可能互相抵消而看不到`);
      }
      if (typeof ledger.topUp === "number" && ledger.topUp > 0) {
        causes.push(`窗口内充值 \u00a5${ledger.topUp.toFixed(2)}，充值不计入消耗`);
      }
      if (typeof ledger.grant === "number" && ledger.grant > 0) {
        causes.push(`窗口内赠送额度入账 \u00a5${ledger.grant.toFixed(2)}，属于免费额度`);
      }
      if (unpriced) {
        causes.push("有模型的 token 不在费率表内，未计入估算");
      }
      const holidays = days.filter((day) => HOLIDAYS.has(day.date)).map((day) => shortDate(day.date));
      if (holidays.length > 0) {
        causes.push(`窗口内 ${holidays.join("、")} 是法定节假日，按空闲档计价`);
      }
      if (ready && Math.abs(drift) >= 0.005) {
        causes.push(drift > 0
          ? "实际高于估算：可能有本机日志未记录的调用（其他客户端或直连 API），或费率表低于实际计费"
          : "实际低于估算：可能有折扣或赠送抵扣，或费率表高于实际计费");
      }
      causes.push("本地会话日志不记录缓存写入 token，若上游对其计费，这部分无法从本机估算");

      return {
        days,
        dayCount: days.length,
        ready,
        comparable,
        currency: ledger.currency,
        estimated,
        actual,
        drift,
        covered: ledger.covered === true,
        coveredFrom: ledger.coveredFrom,
        gapSuspect: ledger.gapSuspect === true,
        maxGapMs: ledger.maxGapMs,
        topUp: ledger.topUp,
        grant: ledger.grant,
        unpriced,
        causes,
      };
    }

    /** Read one JSON route, returning null instead of throwing. */
    async function readRoute(path, signal) {
      try {
        const response = await fetch(path, { signal, headers: { accept: "application/json" } });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }

    const styles = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "6px 10px",
        minWidth: 0,
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontSize: "12px",
        lineHeight: "16px",
        fontVariantNumeric: "tabular-nums",
        userSelect: "text",
        cursor: "default",
      },
      rootRail: {
        alignItems: "center",
        padding: "6px 0",
        fontSize: "10px",
      },
      line: {
        display: "flex",
        alignItems: "baseline",
        gap: "6px",
        minWidth: 0,
        whiteSpace: "nowrap",
      },
      value: {
        color: "var(--dsw-alias-label-primary, inherit)",
        fontWeight: 600,
      },
      caption: {
        color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit))",
        fontSize: "11px",
      },
      /** Peak is the expensive tier, so it is the one that gets emphasis. */
      tierPeak: {
        color: "var(--dsw-alias-label-warning, #d97706)",
        fontWeight: 600,
      },
      tierOff: {
        color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit))",
        fontWeight: 600,
      },
    };

    /**
     * Footer row: account balance on the first line, today's usage on the second.
     * @param props - slot props; `wide` is false while the sidebar is collapsed.
     */
    function BalanceFooter(props) {
      const wide = props?.wide !== false;
      const [balance, setBalance] = react.useState(null);
      const [usage, setUsage] = react.useState(null);
      const [recon, setRecon] = react.useState(null);
      const [tier, setTier] = react.useState(() => tierAt(Date.now()));

      // The tier changes on wall-clock boundaries rather than on data arriving,
      // so drive it from its own timer instead of the poll. This is what makes
      // the badge flip exactly at 09:00 / 12:00 / 14:00 / 18:00 / midnight.
      react.useEffect(() => {
        let timer;
        const step = () => {
          const now = Date.now();
          setTier(tierAt(now));
          // +500ms so a timer firing marginally early cannot read the old tier.
          timer = setTimeout(step, Math.max(1000, nextTierChangeMs(now) - now + 500));
        };
        step();
        return () => clearTimeout(timer);
      }, []);

      react.useEffect(() => {
        let alive = true;
        const controller = new AbortController();

        const tick = async () => {
          const [nextBalance, nextUsage] = await Promise.all([
            readRoute("./dsh-balance", controller.signal),
            readRoute("./dsh-usage", controller.signal),
          ]);
          if (!alive) return;
          if (nextBalance !== null) setBalance(nextBalance);
          if (nextUsage !== null) setUsage(nextUsage);
        };

        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
          controller.abort();
        };
      }, []);

      // Reconciliation moves far more slowly than the footer's own numbers, so
      // it gets its own slower tick rather than riding the 10s poll.
      react.useEffect(() => {
        let alive = true;
        const controller = new AbortController();

        const tick = async () => {
          const [nextHistory, nextLedger] = await Promise.all([
            readRoute(`./dsh-usage-history?days=${RECON_DAYS}`, controller.signal),
            readRoute(`./dsh-spend-ledger?days=${RECON_DAYS}`, controller.signal),
          ]);
          if (!alive) return;
          if (nextHistory !== null || nextLedger !== null) {
            setRecon((previous) => ({
              history: nextHistory ?? previous?.history ?? null,
              ledger: nextLedger ?? previous?.ledger ?? null,
            }));
          }
        };

        tick();
        const timer = setInterval(tick, RECON_MS);
        return () => {
          alive = false;
          clearInterval(timer);
          controller.abort();
        };
      }, []);

      const info = balance && balance.ok === true ? balance.infos?.[0] : undefined;
      const balanceText = info !== undefined
        ? `${symbolOf(info.currency)}${info.total}`
        : balance && balance.ok === false
          ? "\u2014"
          : "\u2026";

      const usageTokens = usage && usage.ok === true ? usage.totalTokens : undefined;
      const usageText = usage === null ? "\u2026" : compact(usageTokens);

      const cost = usage && usage.ok === true ? estimateCost(usage) : null;
      const costKnown = cost !== null && !(cost.unpriced && cost.cny === 0);
      const costText = cost === null
        ? "\u2026"
        : costKnown
          ? `\u7ea6 \u00a5${cost.cny.toFixed(2)}`
          : "\u2014";

      const costNote = cost !== null && !cost.split
        ? "\uff08\u5bbf\u4e3b\u7aef\u672a\u533a\u5206\u5cf0\u8c37\uff0c\u6309\u7a7a\u95f2\u65f6\u6bb5\u4ef7\u4f30\u7b97\uff09"
        : "";

      // The tier in force right now, and when it next moves. Computed from the
      // local clock, so it is correct even before the host reports buckets.
      const rateNow = PRICING.rates["deepseek-flash"][tier];
      const tierText = tier === "peak" ? "\u9ad8\u5cf0" : "\u7a7a\u95f2";
      const nextSwitchText = beijingStamp(nextTierChangeMs(Date.now()));
      const bucketed = usage !== null && usage.peak !== undefined && usage.offPeak !== undefined;

      // --- Reconciliation -------------------------------------------------
      const reconView = recon === null ? null : buildReconciliation(recon.history, recon.ledger);
      // Distinguish "still loading" from "the host has nothing to give": a
      // fetch that came back empty means the host half is not serving the
      // reconciliation routes at all, which is what an un-restarted service
      // looks like.
      const reconUnavailable = recon !== null && reconView === null;
      const reconText = recon === null
        ? "\u2026"
        : reconUnavailable
          ? "\u2014"
          : reconView.ready
            ? `${reconView.dayCount}\u65e5 ${signed(reconView.drift)}`
            : "\u6837\u672c\u4e0d\u8db3";
      const reconDetail = recon === null
        ? []
        : reconView === null
          ? ["\u5bf9\u8d26\u4e0d\u53ef\u7528\uff1a\u5bbf\u4e3b\u7aef\u672a\u63d0\u4f9b /dsh-usage-history \u6216 /dsh-spend-ledger\uff0c\u901a\u5e38\u610f\u5473\u7740 dsh \u670d\u52a1\u8fd8\u6ca1\u6709\u91cd\u542f"]
          : [
            reconView.ready
              ? `\u5bf9\u8d26\uff08${reconView.dayCount} \u5929\uff09\u4f30\u7b97 \u00a5${reconView.estimated.toFixed(2)}\uff0c\u5b9e\u9645\u4f59\u989d\u6d88\u8017 \u00a5${reconView.actual.toFixed(2)}\uff0c\u5dee ${signed(reconView.drift)}`
              : "\u5bf9\u8d26\uff1a\u6682\u65e0\u6cd5\u6bd4\u8f83",
            ...reconView.days
              .filter((day) => day.tokens > 0 || day.actual > 0)
              .map((day) => `${shortDate(day.date)} \u4f30\u7b97 \u00a5${day.estimated.toFixed(2)} / \u5b9e\u9645 \u00a5${day.actual.toFixed(2)}`),
            ...reconView.causes.map((cause) => `\u00b7 ${cause}`),
          ];

      const detail = [
        `当前时段 ${tierText}\uff08deepseek-flash \u8f93\u5165 \u00a5${rateNow.input} / \u8f93\u51fa \u00a5${rateNow.output} \u6bcf\u767e\u4e07 tokens\uff09\uff0c\u4e0b\u6b21\u5207\u6362 ${nextSwitchText}`,
        info !== undefined && info.toppedUp !== undefined ? `充值 ${symbolOf(info.currency)}${info.toppedUp}` : null,
        info !== undefined && info.granted !== undefined ? `赠送 ${symbolOf(info.currency)}${info.granted}` : null,
        usage && usage.ok === true
          ? `今日 输入 ${exact(usage.inputTokens)} / 输出 ${exact(usage.outputTokens)} / 缓存命中 ${exact(usage.cacheReadTokens)}`
          : null,
        usage && usage.ok === true ? `请求 ${exact(usage.requests)} 次` : null,
        costKnown
          ? `估算花费 \u00a5${cost.cny.toFixed(2)}\uff08\u5b98\u65b9\u4eba\u6c11\u5e01\u4ef7${
            cost.split ? "\uff0c\u5cf0\u8c37\u5206\u6863" : ""}\uff09${costNote}`
          : null,
        bucketed && cost !== null
          ? `今日高峰 ${exact(usage.peak.inputTokens)} \u5165 / ${exact(usage.peak.outputTokens)} \u51fa / ${
            exact(usage.peak.cacheReadTokens)} \u7f13\u5b58 \u2192 \u00a5${cost.peakCny.toFixed(2)}`
          : null,
        bucketed && cost !== null
          ? `今日空闲 ${exact(usage.offPeak.inputTokens)} \u5165 / ${exact(usage.offPeak.outputTokens)} \u51fa / ${
            exact(usage.offPeak.cacheReadTokens)} \u7f13\u5b58 \u2192 \u00a5${cost.offPeakCny.toFixed(2)}`
          : null,
        cost !== null && !costKnown ? "该模型无费率，无法估算花费" : null,
        ...reconDetail,
        balance && balance.ok === false ? `余额读取失败：${balance.error}` : null,
        usage && usage.ok === false ? `用量读取失败：${usage.error}` : null,
      ].filter(Boolean).join("\n");

      const tierBadge = react.createElement(
        "span",
        { style: tier === "peak" ? styles.tierPeak : styles.tierOff },
        tierText,
      );

      if (!wide) {
        return react.createElement(
          "div",
          { style: { ...styles.root, ...styles.rootRail }, title: detail || undefined },
          react.createElement("div", { style: styles.value }, balanceText),
          react.createElement("div", { style: { fontSize: "9px" } }, usageText),
          react.createElement("div", { style: { fontSize: "9px" } }, costText),
          react.createElement(
            "div",
            { style: tier === "peak" ? { fontSize: "9px", ...styles.tierPeak } : { fontSize: "9px" } },
            tier === "peak" ? "\u5cf0" : "\u95f2",
          ),
          react.createElement("div", { style: { fontSize: "9px" } }, reconText),
        );
      }

      return react.createElement(
        "div",
        { style: styles.root, title: detail || undefined },
        react.createElement(
          "div",
          { style: styles.line },
          react.createElement("span", { style: styles.caption }, "余额"),
          react.createElement("span", { style: styles.value }, balanceText),
        ),
        react.createElement(
          "div",
          { style: styles.line },
          react.createElement("span", { style: styles.caption }, "今日"),
          react.createElement("span", { style: styles.value }, usageText),
          react.createElement("span", { style: styles.caption }, "tokens"),
        ),
        react.createElement(
          "div",
          { style: styles.line },
          react.createElement("span", { style: styles.caption }, "花费"),
          react.createElement("span", { style: styles.value }, costText),
        ),
        react.createElement(
          "div",
          { style: styles.line },
          react.createElement("span", { style: styles.caption }, "时段"),
          tierBadge,
        ),
        react.createElement(
          "div",
          { style: styles.line },
          react.createElement("span", { style: styles.caption }, "对账"),
          react.createElement("span", { style: styles.value }, reconText),
        ),
      );
    }

    /** Service names this plugin needs from the client kernel. */
    const inject = ["slots"];

    /**
     * Mount the footer row.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "balance-footer",
        order: 10,
      }, BalanceFooter));
    }

    exports.BalanceFooter = BalanceFooter;
    /** Exported for out-of-tree verification of the pricing maths. */
    exports.estimateCost = estimateCost;
    /** Exported for out-of-tree verification of the reconciliation maths. */
    exports.buildReconciliation = buildReconciliation;
    /** Exported for out-of-tree verification of the peak/off-peak calendar. */
    exports.tierAt = tierAt;
    exports.nextTierChangeMs = nextTierChangeMs;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
