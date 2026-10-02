// Pool models: hold live state and quote swaps locally (no RPC calls on the hot path).
// All amounts are raw integer units as JS numbers (fine for a scanner; not for execution).
import * as P from "./programs.js";
import { PublicKey } from "@solana/web3.js";
const DLMM_PROGRAM = new PublicKey(P.PROGRAMS.METEORA_DLMM);

export const Q64 = 2 ** 64;

export abstract class Pool {
  abstract kind: P.PoolKind;
  /** accounts to subscribe to; onAccount(key, data) is called for each */
  abstract watchKeys(): string[];
  abstract onAccount(key: string, data: Buffer, slot: number): void;
  /** raw out for raw in, aToB = mintA -> mintB */
  abstract quote(amountIn: number, aToB: boolean): number;
  abstract ready(): boolean;
  fee = 0;
  lastSlot = 0;
  /** true when size estimates are optimistic (depth not fully modelled) */
  sizeApprox = false;
  constructor(public id: string, public mintA: string, public mintB: string, public decA: number, public decB: number, public dex: string) {}
  /** human price of A in units of B */
  spot(): number {
    const tiny = 10 ** this.decA / 1e6; // quote a tiny amount to get marginal price incl. no fee
    const out = this.quoteNoFee(tiny, true);
    return (out / 10 ** this.decB) / (tiny / 10 ** this.decA);
  }
  protected quoteNoFee(amountIn: number, aToB: boolean) { const f = this.fee; this.fee = 0; const o = this.quote(amountIn, aToB); this.fee = f; return o; }
  label() { return `${this.dex}:${this.id.slice(0, 6)}`; }
}

/** constant-product pool driven by two vault balances (Raydium v4, CPMM, PumpSwap) */
export class CpPool extends Pool {
  rA = 0; rB = 0; adjA = 0; adjB = 0; // adj = amounts in vault that are not swappable (pnl / fees)
  slotA = 0; slotB = 0;
  constructor(id: string, public kind: P.PoolKind, mintA: string, mintB: string, decA: number, decB: number, public vaultA: string, public vaultB: string, fee: number, dex: string) {
    super(id, mintA, mintB, decA, decB, dex); this.fee = fee;
  }
  watchKeys() { return [this.vaultA, this.vaultB]; }
  onAccount(key: string, data: Buffer, slot: number) {
    const amt = Number(P.tokenAmount(data));
    if (key === this.vaultA) { this.rA = amt; this.slotA = slot; }
    if (key === this.vaultB) { this.rB = amt; this.slotB = slot; }
    this.lastSlot = Math.max(this.slotA, this.slotB);
  }
  ready() { return this.rA - this.adjA > 0 && this.rB - this.adjB > 0; }
  quote(x: number, aToB: boolean) {
    const ra = this.rA - this.adjA, rb = this.rB - this.adjB;
    const [rin, rout] = aToB ? [ra, rb] : [rb, ra];
    const xin = x * (1 - this.fee);
    return (rout * xin) / (rin + xin);
  }
}

/** concentrated liquidity (Raydium CLMM, Orca Whirlpool): treated as constant-product on the
 *  current range's virtual reserves. Ignores tick crossings, so large sizes are optimistic. */
export class ClPool extends Pool {
  L = 0; sqrtP = 0; // sqrtP in raw units (token1 per token0)
  sizeApprox = true;
  constructor(id: string, public kind: P.PoolKind, mintA: string, mintB: string, decA: number, decB: number, fee: number, dex: string) {
    super(id, mintA, mintB, decA, decB, dex); this.fee = fee;
  }
  watchKeys() { return [this.id]; }
  onAccount(_k: string, d: Buffer, slot: number) {
    const s = this.kind === "orca_wp" ? P.decodeWhirlpool(d) : P.decodeRayClmm(d);
    this.L = Number(s.liquidity); this.sqrtP = Number(s.sqrtPriceX64) / Q64; this.lastSlot = slot;
    if (this.kind === "orca_wp") this.fee = (s as P.Whirlpool).feeRate;
  }
  ready() { return this.L > 0 && this.sqrtP > 0; }
  quote(x: number, aToB: boolean) {
    const vx = this.L / this.sqrtP, vy = this.L * this.sqrtP; // virtual reserves of token0 / token1
    const [rin, rout] = aToB ? [vx, vy] : [vy, vx];
    const xin = x * (1 - this.fee);
    return (rout * xin) / (rin + xin);
  }
}

/** Meteora DLMM: walks real bin liquidity from the bin arrays around the active bin
 *  (active array +/- 1, i.e. ~140-210 bins). Liquidity beyond loaded arrays is treated as absent. */
export class DlmmPool extends Pool {
  kind: P.PoolKind = "met_dlmm";
  activeId = 0; binStep = 0; init = false;
  bins = new Map<number, { x: number; y: number }>();
  arrays = new Map<string, number>(); // bin array PDA -> array index
  watchKeys() { return [this.id]; }
  /** bin-array accounts this pool currently needs (scanner subscribes to new ones) */
  dynamicKeys(): string[] {
    const idx = Math.floor(this.activeId / 70);
    return [idx - 1, idx, idx + 1].map((i) => {
      const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(i));
      const k = PublicKey.findProgramAddressSync([Buffer.from("bin_array"), new PublicKey(this.id).toBuffer(), b],
        DLMM_PROGRAM)[0].toBase58();
      this.arrays.set(k, i); return k;
    });
  }
  onAccount(k: string, d: Buffer, slot: number) {
    this.lastSlot = Math.max(this.lastSlot, slot);
    if (k === this.id) {
      const s = P.decodeDlmm(d);
      this.activeId = s.activeId; this.binStep = s.binStep; this.fee = Math.min(s.baseFee + s.variableFee, 0.1);
      this.init = true; return;
    }
    const idx = Number(d.readBigInt64LE(8));
    for (let j = 0; j < 70; j++) {
      const o = 56 + j * 144;
      this.bins.set(idx * 70 + j, { x: Number(d.readBigUInt64LE(o)), y: Number(d.readBigUInt64LE(o + 8)) });
    }
  }
  ready() { return this.init && this.bins.has(this.activeId); }
  quote(x: number, aToB: boolean) {
    let rem = x * (1 - this.fee), out = 0, i = this.activeId;
    const g = 1 + this.binStep / 1e4;
    for (let n = 0; n < 400 && rem > 0; n++) {
      const b = this.bins.get(i); if (!b) break;
      const p = g ** i; // raw Y per raw X
      if (aToB) { const cap = b.y / p; if (rem <= cap) { out += rem * p; rem = 0; } else { out += b.y; rem -= cap; } i--; }
      else { const cap = b.x * p; if (rem <= cap) { out += rem / p; rem = 0; } else { out += b.x; rem -= cap; } i++; }
    }
    return out;
  }
}
