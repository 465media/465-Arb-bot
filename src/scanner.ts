// Read-only arbitrage scanner: streams pool state, finds SOL-start cycles (2 and 3 legs),
// and logs every "opportunity window" (how big, how long it lasted) to logs/windows-YYYY-MM-DD.jsonl.
// It never sends a transaction.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { discover, refreshAdjustments, getMany, type Config } from "./discovery.js";
import { Pool, DlmmPool } from "./pools.js";

const cfg: Config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WS = process.env.WS_URL ?? RPC.replace(/^http/, "ws");
const conn = new Connection(RPC, { commitment: "processed", wsEndpoint: WS });
const SOL = cfg.quotes.SOL;
const LAMPORTS = 1e9;
const symbols = new Map(Object.entries({ ...cfg.quotes, ...cfg.tokens }).map(([s, m]) => [m, s]));
const sym = (m: string) => symbols.get(m) ?? m.slice(0, 4);
const LOG_DIR = path.resolve(process.env.LOG_DIR ?? "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const now = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(now(), ...a);

interface Leg { pool: Pool; aToB: boolean; from: string; to: string }
interface Cycle { id: string; legs: Leg[]; name: string }
interface Window { opened: number; openSlot: number; peakNet: number; peakSize: number; peakEdgeBps: number; evals: number; lastSlot: number }

function legsFrom(pools: Pool[], mint: string): Leg[] {
  const out: Leg[] = [];
  for (const p of pools) {
    if (p.mintA === mint) out.push({ pool: p, aToB: true, from: mint, to: p.mintB });
    if (p.mintB === mint) out.push({ pool: p, aToB: false, from: mint, to: p.mintA });
  }
  return out;
}

function buildCycles(pools: Pool[]): Cycle[] {
  const cycles: Cycle[] = [];
  const mk = (legs: Leg[]): Cycle => ({
    id: legs.map((l) => `${l.pool.id}${l.aToB ? ">" : "<"}`).join(""),
    legs,
    name: [SOL, ...legs.map((l) => l.to)].map(sym).join("→") + "  [" + legs.map((l) => l.pool.label()).join(" | ") + "]",
  });
  for (const l1 of legsFrom(pools, SOL)) {
    for (const l2 of legsFrom(pools, l1.to)) {
      if (l2.pool === l1.pool) continue;
      if (l2.to === SOL) { cycles.push(mk([l1, l2])); continue; }
      for (const l3 of legsFrom(pools, l2.to)) {
        if (l3.to !== SOL || l3.pool === l1.pool || l3.pool === l2.pool) continue;
        cycles.push(mk([l1, l2, l3]));
      }
    }
  }
  return cycles;
}

function runCycle(c: Cycle, lamportsIn: number) {
  let x = lamportsIn;
  for (const l of c.legs) x = l.pool.quote(x, l.aToB);
  return x;
}

/** best size by ternary search on a concave profit curve */
function evaluate(c: Cycle) {
  const tiny = 1e5;
  const rate = runCycle(c, tiny) / tiny; // marginal round-trip rate after fees
  if (!(rate > 1)) return null;
  let lo = tiny, hi = cfg.maxTradeSol * LAMPORTS;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (runCycle(c, m1) - m1 < runCycle(c, m2) - m2) lo = m1; else hi = m2;
  }
  const size = (lo + hi) / 2;
  const gross = runCycle(c, size) - size;
  return { edgeBps: (rate - 1) * 1e4, size, gross, net: gross - cfg.fixedCostSol * LAMPORTS };
}

async function main() {
  log(`discovering pools (rpc=${new URL(RPC).host})...`);
  const pools = await discover(conn, cfg, log);
  const cycles = buildCycles(pools);
  log(`${pools.length} pools, ${cycles.length} cycles`);

  const byKey = new Map<string, Pool[]>();
  for (const p of pools) for (const k of p.watchKeys()) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(p);
  const cyclesByPool = new Map<Pool, Cycle[]>();
  for (const c of cycles) for (const l of c.legs) (cyclesByPool.get(l.pool) ?? cyclesByPool.set(l.pool, []).get(l.pool)!).push(c);

  // initial snapshot
  const keys = [...byKey.keys()];
  const snap = await getMany(conn, keys);
  keys.forEach((k, i) => snap.data[i] && byKey.get(k)!.forEach((p) => p.onAccount(k, snap.data[i]!, 0)));

  const open = new Map<string, Window>();
  let updates = 0, closed = 0, lastSlot = await conn.getSlot("processed");
  const day = () => new Date().toISOString().slice(0, 10);

  const closeWindow = (c: Cycle, w: Window) => {
    open.delete(c.id); closed++;
    const rec = {
      cycle: c.name, legs: c.legs.length,
      openedAt: new Date(w.opened).toISOString(), durationMs: Date.now() - w.opened,
      openSlot: w.openSlot, closeSlot: lastSlot, slots: lastSlot - w.openSlot,
      peakNetSol: +(w.peakNet / LAMPORTS).toFixed(6), peakSizeSol: +(w.peakSize / LAMPORTS).toFixed(4),
      peakEdgeBps: +w.peakEdgeBps.toFixed(1), evals: w.evals,
      sizeApprox: c.legs.some((l) => l.pool.sizeApprox), suspect: w.peakEdgeBps > 2000,
    };
    fs.appendFileSync(path.join(LOG_DIR, `windows-${day()}.jsonl`), JSON.stringify(rec) + "\n");
    if (rec.peakNetSol >= 0.001) log(`WINDOW ${rec.peakNetSol} SOL  ${rec.slots} slots  ${rec.peakEdgeBps}bps  ${c.name}`);
  };

  const check = (c: Cycle) => {
    if (!c.legs.every((l) => l.pool.ready())) return;
    const r = evaluate(c);
    const w = open.get(c.id);
    if (r && r.net > cfg.minProfitSol * LAMPORTS) {
      if (!w) open.set(c.id, { opened: Date.now(), openSlot: lastSlot, peakNet: r.net, peakSize: r.size, peakEdgeBps: r.edgeBps, evals: 1, lastSlot });
      else { w.evals++; if (r.net > w.peakNet) { w.peakNet = r.net; w.peakSize = r.size; } w.peakEdgeBps = Math.max(w.peakEdgeBps, r.edgeBps); }
    } else if (w) closeWindow(c, w);
  };

  const scheduled = new Set<Pool>();
  const onUpdate = (p: Pool) => {
    if (scheduled.has(p)) return;
    scheduled.add(p);
    setTimeout(() => { scheduled.delete(p); for (const c of cyclesByPool.get(p) ?? []) check(c); }, cfg.debounceMs);
  };

  const subscribed = new Set<string>();
  const subscribe = (k: string) => {
    if (subscribed.has(k)) return; subscribed.add(k);
    conn.onAccountChange(new PublicKey(k), (acc, ctx) => {
      updates++; lastSlot = Math.max(lastSlot, ctx.slot);
      for (const p of byKey.get(k)!) { p.onAccount(k, acc.data as Buffer, ctx.slot); onUpdate(p); if (p instanceof DlmmPool) ensureDynamic(p); }
    }, { commitment: "processed", encoding: "base64" } as any);
  };
  // DLMM bin arrays follow the active bin: fetch + subscribe to any new ones
  const ensureDynamic = (p: DlmmPool) => {
    const fresh = p.dynamicKeys().filter((k) => !subscribed.has(k));
    if (!fresh.length) return;
    for (const k of fresh) { (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(p); subscribe(k); }
    getMany(conn, fresh).then((r) => fresh.forEach((k, i) => r.data[i] && p.onAccount(k, r.data[i]!, lastSlot)))
      .catch((e) => log("bin fetch error", e.message));
  };
  for (const k of keys) subscribe(k);
  const dl = pools.filter((p): p is DlmmPool => p instanceof DlmmPool);
  const binKeys = dl.flatMap((p) => p.dynamicKeys().map((k) => [k, p] as const));
  const binSnap = await getMany(conn, binKeys.map(([k]) => k));
  binKeys.forEach(([k, p], i) => { (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(p); subscribe(k); if (binSnap.data[i]) p.onAccount(k, binSnap.data[i]!, lastSlot); });
  for (const p of pools) log(`  ${p.label().padEnd(22)} ${sym(p.mintA)}/${sym(p.mintB)}  fee=${(p.fee * 100).toFixed(3)}%  ready=${p.ready()}  ${p.id}`);
  for (const c of cycles) check(c);
  log(`subscribed to ${subscribed.size} accounts; logging to ${LOG_DIR}`);

  setInterval(() => refreshAdjustments(conn, pools).catch((e) => log("refresh error", e.message)), 60_000);
  setInterval(() => {
    const best = [...open.entries()].sort((a, b) => b[1].peakNet - a[1].peakNet)[0];
    log(`status: slot=${lastSlot} updates=${updates} open=${open.size} closed=${closed}` +
      (best ? `  best-open=${(best[1].peakNet / LAMPORTS).toFixed(5)} SOL ${cycles.find((c) => c.id === best[0])?.name}` : ""));
    updates = 0;
  }, cfg.statusEverySec * 1000);

  const shutdown = () => { for (const c of cycles) { const w = open.get(c.id); if (w) closeWindow(c, w); } process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
