// Paper trader: when the scanner opens a new opportunity window, re-price the exact route
// with real Jupiter quotes (same DEX per leg, direct routes only) at the scanner's chosen size,
// the way a live bot would right before sending. Records whether the trade would still have
// been profitable after real quotes, real latency and a realistic cost. Never sends anything.
import fs from "node:fs";
import path from "node:path";
import type { PoolKind } from "./programs.js";

export const JUP_LABEL: Record<PoolKind, string> = {
  ray_v4: "Raydium", ray_cpmm: "Raydium CP", ray_clmm: "Raydium CLMM",
  orca_wp: "Whirlpool", met_dlmm: "Meteora DLMM", pumpswap: "Pump.fun Amm",
};

export interface PaperConfig {
  enabled: boolean; minPredictedNetSol: number; costSol: number; cooldownMs: number;
  quoteUrl: string; bucketSize: number; refillPerSec: number;
}
export interface PaperLeg { kind: PoolKind; poolId: string; from: string; to: string }
export interface PaperRow {
  at: string; route: string; legs: number; sizeSol: number; predictedNetSol: number;
  quotedOutSol: number | null; quotedNetSol: number | null; won: boolean; latencyMs: number;
  samePools: number; error?: string;
}

const LAMPORTS = 1e9;

export class PaperTrader {
  tokens: number; lastRefill = Date.now();
  lastByRoute = new Map<string, number>();
  busy = 0;
  stats = { considered: 0, skippedCooldown: 0, skippedRate: 0, attempts: 0, wins: 0, errors: 0 };

  constructor(public cfg: PaperConfig, public logDir: string, public log: (...a: unknown[]) => void) {
    this.tokens = cfg.bucketSize;
  }

  private take(n: number) {
    const now = Date.now();
    this.tokens = Math.min(this.cfg.bucketSize, this.tokens + ((now - this.lastRefill) / 1000) * this.cfg.refillPerSec);
    this.lastRefill = now;
    if (this.tokens < n) return false;
    this.tokens -= n; return true;
  }

  /** called when a new window opens; fires a paper trade if it qualifies */
  consider(route: string, legs: PaperLeg[], sizeLamports: number, predictedNetLamports: number) {
    if (!this.cfg.enabled || predictedNetLamports < this.cfg.minPredictedNetSol * LAMPORTS) return;
    this.stats.considered++;
    const now = Date.now();
    if (now - (this.lastByRoute.get(route) ?? 0) < this.cfg.cooldownMs) { this.stats.skippedCooldown++; return; }
    if (this.busy >= 2 || !this.take(legs.length)) { this.stats.skippedRate++; return; }
    this.lastByRoute.set(route, now);
    this.busy++;
    this.run(route, legs, Math.floor(sizeLamports), predictedNetLamports).finally(() => this.busy--);
  }

  private async run(route: string, legs: PaperLeg[], size: number, predicted: number) {
    const t0 = Date.now();
    let amt = size, same = 0, error: string | undefined;
    try {
      for (const l of legs) {
        const u = new URL(this.cfg.quoteUrl);
        Object.entries({ inputMint: l.from, outputMint: l.to, amount: String(amt), slippageBps: "0",
          onlyDirectRoutes: "true", dexes: JUP_LABEL[l.kind] }).forEach(([k, v]) => u.searchParams.set(k, v));
        const headers: Record<string, string> = {};
        if (process.env.JUP_API_KEY) headers["x-api-key"] = process.env.JUP_API_KEY;
        const r = await fetch(u, { headers, signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(`quote ${r.status}`);
        const q = (await r.json()) as { outAmount: string; routePlan?: { swapInfo: { ammKey: string } }[] };
        amt = Number(q.outAmount);
        if (q.routePlan?.some((s) => s.swapInfo.ammKey === l.poolId)) same++;
        if (!(amt > 0)) throw new Error("zero out");
      }
    } catch (e) { error = (e as Error).message; }
    const latencyMs = Date.now() - t0;
    const quotedOut = error ? null : amt;
    const quotedNet = quotedOut === null ? null : quotedOut - size - this.cfg.costSol * LAMPORTS;
    const won = quotedNet !== null && quotedNet > 0;
    this.stats.attempts++; if (won) this.stats.wins++; if (error) this.stats.errors++;
    const row: PaperRow = {
      at: new Date(t0).toISOString(), route, legs: legs.length, sizeSol: +(size / LAMPORTS).toFixed(4),
      predictedNetSol: +(predicted / LAMPORTS).toFixed(6),
      quotedOutSol: quotedOut === null ? null : +(quotedOut / LAMPORTS).toFixed(6),
      quotedNetSol: quotedNet === null ? null : +(quotedNet / LAMPORTS).toFixed(6),
      won, latencyMs, samePools: same, ...(error ? { error } : {}),
    };
    fs.appendFileSync(path.join(this.logDir, `paper-${row.at.slice(0, 10)}.jsonl`), JSON.stringify(row) + "\n");
    if (won) this.log(`PAPER WIN ${row.quotedNetSol} SOL (predicted ${row.predictedNetSol}) ${latencyMs}ms  ${route}`);
  }
}

export function loadPaper(dir: string, lastDays: number): PaperRow[] {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^paper-.*\.jsonl$/.test(f)).sort().slice(-lastDays);
    return files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  } catch { return []; }
}

export function summarizePaper(rows: PaperRow[]) {
  const ok = rows.filter((r) => !r.error);
  const wins = ok.filter((r) => r.won);
  const sum = (a: number[]) => +a.reduce((s, x) => s + x, 0).toFixed(6);
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)] ?? 0; };
  const byRoute = new Map<string, PaperRow[]>();
  for (const r of ok) { const k = r.route.split("  [")[0]; (byRoute.get(k) ?? byRoute.set(k, []).get(k)!).push(r); }
  return {
    attempts: rows.length, errors: rows.length - ok.length, wins: wins.length,
    winRate: ok.length ? +(wins.length / ok.length * 100).toFixed(1) : 0,
    // a live bot with a profit-or-revert guard only lands winners; losers cost ~nothing via Jito bundles
    paperSol: sum(wins.map((r) => r.quotedNetSol!)),
    predictedSol: sum(ok.map((r) => r.predictedNetSol)),
    medianLatencyMs: med(ok.map((r) => r.latencyMs)),
    routes: [...byRoute].map(([route, l]) => {
      const w = l.filter((r) => r.won);
      return { route, attempts: l.length, wins: w.length, paperSol: sum(w.map((r) => r.quotedNetSol!)),
        avgPredicted: +(sum(l.map((r) => r.predictedNetSol)) / l.length).toFixed(6),
        avgQuoted: +(sum(l.map((r) => r.quotedNetSol!)) / l.length).toFixed(6) };
    }).sort((a, b) => b.paperSol - a.paperSol || b.attempts - a.attempts),
    recent: rows.slice(-15).reverse(),
  };
}
