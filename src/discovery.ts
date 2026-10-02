// Find pools for the watch list via DexScreener, then build local pool models from on-chain state.
import { Connection, PublicKey } from "@solana/web3.js";
import * as P from "./programs.js";
import { Pool, CpPool, ClPool, DlmmPool } from "./pools.js";

export interface Config {
  quotes: Record<string, string>; tokens: Record<string, string>;
  minLiquidityUsd: number; maxPoolsPerPair: number; maxTradeSol: number;
  fixedCostSol: number; minProfitSol: number; debounceMs: number; statusEverySec: number;
}

interface Pair { pairAddress: string; dexId: string; labels?: string[]; liquidity?: { usd?: number };
  baseToken: { address: string }; quoteToken: { address: string } }

const DEFAULT_PK = "11111111111111111111111111111111";

async function getMany(c: Connection, keys: string[]) {
  const out: (Buffer | null)[] = []; const owners: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await c.getMultipleAccountsInfo(keys.slice(i, i + 100).map((k) => new PublicKey(k)));
    for (const a of r) { out.push(a ? (a.data as Buffer) : null); owners.push(a ? a.owner.toBase58() : null); }
  }
  return { data: out, owners };
}

export async function discover(c: Connection, cfg: Config, log = console.log): Promise<Pool[]> {
  const watched = new Set([...Object.values(cfg.quotes), ...Object.values(cfg.tokens)]);
  const pairs = new Map<string, Pair>();
  for (const mint of watched) {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`);
    if (!r.ok) { log(`dexscreener ${r.status} for ${mint}`); continue; }
    for (const p of (await r.json()) as Pair[]) {
      if (!watched.has(p.baseToken.address) || !watched.has(p.quoteToken.address)) continue;
      if ((p.liquidity?.usd ?? 0) < cfg.minLiquidityUsd) continue;
      pairs.set(p.pairAddress, p);
    }
    await new Promise((r) => setTimeout(r, 250)); // be polite to the free API
  }
  // cap pools per mint pair, deepest first
  const byPair = new Map<string, Pair[]>();
  for (const p of pairs.values()) {
    const k = [p.baseToken.address, p.quoteToken.address].sort().join("|");
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p);
  }
  const chosen = [...byPair.values()].flatMap((l) =>
    l.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, cfg.maxPoolsPerPair));

  const { data, owners } = await getMany(c, chosen.map((p) => p.pairAddress));
  const decCache = new Map<string, number>();
  const needDec = new Set<string>(watched);
  const dec = await getMany(c, [...needDec]);
  [...needDec].forEach((m, i) => dec.data[i] && decCache.set(m, P.mintDecimals(dec.data[i]!)));
  const d = (m: string) => decCache.get(m) ?? 0;

  const pools: Pool[] = [];
  const skipped: Record<string, number> = {};
  const cfgKeys = new Set<string>();
  const pending: { pool: Pool; cfgKey?: string; build?: (cfgData: Buffer) => void }[] = [];

  chosen.forEach((p, i) => {
    const buf = data[i]; const kind = owners[i] ? P.KIND_BY_PROGRAM[owners[i]!] : undefined;
    if (!buf || !kind) { const k = `${p.dexId}/${(p.labels ?? []).join(",") || "-"}`; skipped[k] = (skipped[k] ?? 0) + 1; return; }
    const id = p.pairAddress;
    switch (kind) {
      case "ray_v4": {
        const s = P.decodeRayV4(buf);
        const pool = new CpPool(id, kind, s.baseMint, s.quoteMint, s.baseDec, s.quoteDec, s.baseVault, s.quoteVault,
          Number(s.feeNum) / Number(s.feeDen), "raydium-v4");
        pool.adjA = Number(s.baseNeedTakePnl); pool.adjB = Number(s.quoteNeedTakePnl);
        pending.push({ pool }); break;
      }
      case "ray_cpmm": {
        const s = P.decodeRayCpmm(buf);
        const pool = new CpPool(id, kind, s.mint0, s.mint1, s.dec0, s.dec1, s.vault0, s.vault1, 0.0025, "raydium-cpmm");
        pool.adjA = Number(s.protoFee0 + s.fundFee0); pool.adjB = Number(s.protoFee1 + s.fundFee1);
        cfgKeys.add(s.ammConfig);
        pending.push({ pool, cfgKey: s.ammConfig, build: (cd) => (pool.fee = P.cpmmTradeFeeRate(cd)) }); break;
      }
      case "pumpswap": {
        const s = P.decodePumpSwap(buf);
        const creator = new PublicKey(buf.subarray(211, 243)).toBase58();
        // GlobalConfig baseline: 20 bps LP + 5 bps protocol (+5 bps coin creator). Market-cap fee tiers ignored (conservative).
        const fee = creator === DEFAULT_PK ? 0.0025 : 0.003;
        pending.push({ pool: new CpPool(id, kind, s.baseMint, s.quoteMint, d(s.baseMint), d(s.quoteMint), s.baseVault, s.quoteVault, fee, "pumpswap") });
        break;
      }
      case "ray_clmm": {
        const s = P.decodeRayClmm(buf);
        const pool = new ClPool(id, kind, s.mint0, s.mint1, s.dec0, s.dec1, 0, "raydium-clmm");
        cfgKeys.add(s.ammConfig);
        pending.push({ pool, cfgKey: s.ammConfig, build: (cd) => (pool.fee = P.clmmTradeFeeRate(cd)) }); break;
      }
      case "orca_wp": {
        const s = P.decodeWhirlpool(buf);
        pending.push({ pool: new ClPool(id, kind, s.mintA, s.mintB, d(s.mintA), d(s.mintB), s.feeRate, "orca") }); break;
      }
      case "met_dlmm": {
        const s = P.decodeDlmm(buf);
        pending.push({ pool: new DlmmPool(id, s.mintX, s.mintY, d(s.mintX), d(s.mintY), "meteora-dlmm") }); break;
      }
    }
  });

  const cfgList = [...cfgKeys];
  const cfgData = await getMany(c, cfgList);
  const cfgMap = new Map(cfgList.map((k, i) => [k, cfgData.data[i]]));
  for (const p of pending) {
    if (p.cfgKey && p.build) { const cd = cfgMap.get(p.cfgKey); if (!cd) continue; p.build(cd); }
    pools.push(p.pool);
  }
  if (Object.keys(skipped).length) log(`skipped unsupported pools: ${JSON.stringify(skipped)}`);
  return pools;
}

/** refresh slow-changing pool fields (v4 pnl, cpmm accrued fees) */
export async function refreshAdjustments(c: Connection, pools: Pool[]) {
  const cps = pools.filter((p): p is CpPool => p instanceof CpPool && (p.kind === "ray_v4" || p.kind === "ray_cpmm"));
  if (!cps.length) return;
  const { data } = await getMany(c, cps.map((p) => p.id));
  cps.forEach((p, i) => {
    const b = data[i]; if (!b) return;
    if (p.kind === "ray_v4") { const s = P.decodeRayV4(b); p.adjA = Number(s.baseNeedTakePnl); p.adjB = Number(s.quoteNeedTakePnl); }
    else { const s = P.decodeRayCpmm(b); p.adjA = Number(s.protoFee0 + s.fundFee0); p.adjB = Number(s.protoFee1 + s.fundFee1); }
  });
}

export { getMany };
