// Funding-rate scanner for Hyperliquid perps (read-only, no keys, no orders).
// Idea: hold spot + short the same amount of perp = price-neutral; collect funding when longs pay shorts.
// This module only measures which coins have paid steady positive funding and whether a spot hedge exists.
import fs from "node:fs";
import path from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const HOURS_YEAR = 24 * 365;
/** Hyperliquid's baseline: 0.00125%/h interest component ≈ 10.95% APR when premium is ~0 */
export const BASELINE_APR = 0.0000125 * HOURS_YEAR * 100;
/** rough round-trip cost (open + close, both legs, taker) as % of notional; amortised over a 30-day hold */
const ROUND_TRIP_COST_PCT = 0.25;

export interface FundingRow {
  coin: string; markPx: number; oiUsd: number; volUsd: number; maxLev: number;
  aprNow: number; apr24h: number; apr7d: number; apr30d: number; posShare30d: number;
  worstDayApr: number; hours: number;
  spot: { name: string; volUsd: number } | null;
  netApr30d: number; score: number;
}
export interface FundingSnapshot { at: string; nextHistoryAt: string; coins: number; scanned: number; rows: FundingRow[]; error?: string }

async function info<T>(body: unknown): Promise<T> {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return (await r.json()) as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export class FundingScanner {
  snapshot: FundingSnapshot = { at: "", nextHistoryAt: "", coins: 0, scanned: 0, rows: [] };
  private history = new Map<string, { time: number; rate: number }[]>();
  private lastHistory = 0;

  constructor(public logDir: string, public log: (...a: unknown[]) => void,
    public opts = { minOiUsd: 1_000_000, minVolUsd: 1_000_000, refreshMs: 5 * 60_000, historyMs: 6 * 3600_000 }) {}

  start() {
    const tick = () => this.refresh().catch((e) => { this.snapshot.error = (e as Error).message; this.log("funding error", (e as Error).message); });
    tick();
    setInterval(tick, this.opts.refreshMs);
  }

  private async fetchHistory(coin: string) {
    const start = Date.now() - 30 * 24 * 3600_000;
    let from = start;
    const out: { time: number; rate: number }[] = [];
    for (let page = 0; page < 3; page++) { // 500 rows per page, 720 hours in 30d
      const d = await info<{ time: number; fundingRate: string }[]>({ type: "fundingHistory", coin, startTime: from });
      if (!d.length) break;
      for (const x of d) out.push({ time: x.time, rate: Number(x.fundingRate) });
      if (d.length < 500) break;
      from = d[d.length - 1].time + 1;
      await sleep(300);
    }
    return out;
  }

  async refresh() {
    const [[meta, ctxs], spotMeta, spotCtxs] = await Promise.all([
      info<[{ universe: { name: string; maxLeverage: number; isDelisted?: boolean }[] }, any[]]>({ type: "metaAndAssetCtxs" }),
      info<{ tokens: { name: string; index: number }[]; universe: { name: string; tokens: number[]; index: number }[] }>({ type: "spotMeta" }),
      info<[unknown, { coin: string; dayNtlVlm: string }[]]>({ type: "spotMetaAndAssetCtxs" }).then((x) => x[1]).catch(() => []),
    ]);
    // spot markets quoted in USDC, keyed by base token name (BTC/ETH/SOL trade as UBTC/UETH/USOL)
    const tok = new Map(spotMeta.tokens.map((t) => [t.index, t.name]));
    const spotVol = new Map((spotCtxs as any[]).map((c) => [c.coin, Number(c.dayNtlVlm)]));
    const spotByBase = new Map<string, { name: string; volUsd: number }>();
    for (const u of spotMeta.universe) {
      const [b, q] = u.tokens.map((i) => tok.get(i) ?? "");
      if (q !== "USDC") continue;
      const v = spotVol.get(u.name) ?? 0;
      const prev = spotByBase.get(b);
      if (!prev || v > prev.volUsd) spotByBase.set(b, { name: `${b}/USDC`, volUsd: v });
    }

    const live = meta.universe.map((a, i) => ({ a, c: ctxs[i] })).filter(({ a, c }) => !a.isDelisted && c)
      .map(({ a, c }) => ({ coin: a.name, maxLev: a.maxLeverage, markPx: Number(c.markPx), rate: Number(c.funding),
        oiUsd: Number(c.openInterest) * Number(c.markPx), volUsd: Number(c.dayNtlVlm) }));
    const eligible = live.filter((x) => x.oiUsd >= this.opts.minOiUsd && x.volUsd >= this.opts.minVolUsd);

    // 30-day history: slow refresh, spaced out to stay well inside rate limits
    if (Date.now() - this.lastHistory > this.opts.historyMs || this.history.size === 0) {
      for (const x of eligible) {
        try { this.history.set(x.coin, await this.fetchHistory(x.coin)); } catch (e) { this.log(`funding history ${x.coin}: ${(e as Error).message}`); }
        await sleep(400);
      }
      this.lastHistory = Date.now();
    }

    const now = Date.now();
    const rows: FundingRow[] = eligible.map((x) => {
      const h = this.history.get(x.coin) ?? [];
      const since = (ms: number) => h.filter((p) => p.time >= now - ms).map((p) => p.rate);
      const apr = (rates: number[]) => mean(rates) * HOURS_YEAR * 100;
      const h30 = since(30 * 86400_000);
      // worst rolling 24h window in the last 30 days (how bad can a day get)
      let worst = Infinity;
      for (let i = 0; i + 24 <= h30.length; i += 6) worst = Math.min(worst, apr(h30.slice(i, i + 24)));
      const apr30d = apr(h30), posShare = h30.length ? h30.filter((r) => r > 0).length / h30.length : 0;
      const base = x.coin.startsWith("k") ? x.coin.slice(1) : x.coin; // kPEPE etc. are 1000x contracts
      const spot = spotByBase.get(x.coin) ?? spotByBase.get(base) ?? spotByBase.get("U" + base) ?? null;
      const netApr30d = apr30d - ROUND_TRIP_COST_PCT * 12;
      return {
        coin: x.coin, markPx: x.markPx, oiUsd: x.oiUsd, volUsd: x.volUsd, maxLev: x.maxLev,
        aprNow: x.rate * HOURS_YEAR * 100, apr24h: apr(since(86400_000)), apr7d: apr(since(7 * 86400_000)), apr30d,
        posShare30d: posShare, worstDayApr: Number.isFinite(worst) ? worst : 0, hours: h30.length, spot,
        netApr30d, score: Math.max(0, netApr30d) * posShare * (spot && spot.volUsd >= 100_000 ? 1 : 0.5),
      };
    }).sort((a, b) => b.score - a.score);

    this.snapshot = { at: new Date().toISOString(), nextHistoryAt: new Date(this.lastHistory + this.opts.historyMs).toISOString(),
      coins: live.length, scanned: eligible.length, rows };
    try {
      fs.writeFileSync(path.join(this.logDir, "funding-latest.json"), JSON.stringify(this.snapshot));
      const day = this.snapshot.at.slice(0, 10);
      const top = rows.slice(0, 15).map((r) => ({ c: r.coin, now: +r.aprNow.toFixed(2), d7: +r.apr7d.toFixed(2), d30: +r.apr30d.toFixed(2), pos: +r.posShare30d.toFixed(2) }));
      fs.appendFileSync(path.join(this.logDir, `funding-${day}.jsonl`), JSON.stringify({ at: this.snapshot.at, top }) + "\n");
    } catch { /* logging is best-effort */ }
  }
}
