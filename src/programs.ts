// Program IDs and raw account decoders for supported pool types.
// Offsets were checked against live mainnet accounts (see scripts/verify-decoders.ts).
import { PublicKey } from "@solana/web3.js";

export const PROGRAMS = {
  RAY_AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RAY_CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1R",
  RAY_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
} as const;

export type PoolKind = "ray_v4" | "ray_cpmm" | "ray_clmm" | "orca_wp" | "met_dlmm" | "pumpswap";

export const KIND_BY_PROGRAM: Record<string, PoolKind> = {
  [PROGRAMS.RAY_AMM_V4]: "ray_v4",
  [PROGRAMS.RAY_CPMM]: "ray_cpmm",
  [PROGRAMS.RAY_CLMM]: "ray_clmm",
  [PROGRAMS.ORCA_WHIRLPOOL]: "orca_wp",
  [PROGRAMS.METEORA_DLMM]: "met_dlmm",
  [PROGRAMS.PUMPSWAP]: "pumpswap",
};

const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

// SPL token account: amount at offset 64
export const tokenAmount = (d: Buffer) => u64(d, 64);
// SPL mint: decimals at offset 44
export const mintDecimals = (d: Buffer) => d.readUInt8(44);

export interface RayV4 { baseVault: string; quoteVault: string; baseMint: string; quoteMint: string;
  baseDec: number; quoteDec: number; feeNum: bigint; feeDen: bigint; baseNeedTakePnl: bigint; quoteNeedTakePnl: bigint; }
export function decodeRayV4(d: Buffer): RayV4 {
  return {
    baseDec: Number(u64(d, 32)), quoteDec: Number(u64(d, 40)),
    feeNum: u64(d, 22 * 8), feeDen: u64(d, 23 * 8), // swapFeeNumerator / Denominator
    baseNeedTakePnl: u64(d, 24 * 8), quoteNeedTakePnl: u64(d, 25 * 8),
    baseVault: pk(d, 336), quoteVault: pk(d, 368), baseMint: pk(d, 400), quoteMint: pk(d, 432),
  };
}

export interface RayCpmm { ammConfig: string; vault0: string; vault1: string; mint0: string; mint1: string;
  dec0: number; dec1: number; protoFee0: bigint; protoFee1: bigint; fundFee0: bigint; fundFee1: bigint; }
export function decodeRayCpmm(d: Buffer): RayCpmm {
  return {
    ammConfig: pk(d, 8), vault0: pk(d, 72), vault1: pk(d, 104), mint0: pk(d, 168), mint1: pk(d, 200),
    dec0: d.readUInt8(331), dec1: d.readUInt8(332),
    protoFee0: u64(d, 341), protoFee1: u64(d, 349), fundFee0: u64(d, 357), fundFee1: u64(d, 365),
  };
}
// CPMM AmmConfig: trade_fee_rate u64 @12 (1e6 = 100%)
export const cpmmTradeFeeRate = (d: Buffer) => Number(u64(d, 12)) / 1e6;

export interface Clmm { ammConfig: string; mint0: string; mint1: string; dec0: number; dec1: number;
  liquidity: bigint; sqrtPriceX64: bigint; tick: number; }
export function decodeRayClmm(d: Buffer): Clmm {
  return {
    ammConfig: pk(d, 9), mint0: pk(d, 73), mint1: pk(d, 105), dec0: d.readUInt8(233), dec1: d.readUInt8(234),
    liquidity: u128(d, 237), sqrtPriceX64: u128(d, 253), tick: d.readInt32LE(269),
  };
}
// CLMM AmmConfig: trade_fee_rate u32 @47 (1e6 = 100%)
export const clmmTradeFeeRate = (d: Buffer) => d.readUInt32LE(47) / 1e6;

export interface Whirlpool { feeRate: number; liquidity: bigint; sqrtPriceX64: bigint; tick: number; mintA: string; mintB: string; }
export function decodeWhirlpool(d: Buffer): Whirlpool {
  return {
    feeRate: d.readUInt16LE(45) / 1e6, liquidity: u128(d, 49), sqrtPriceX64: u128(d, 65), tick: d.readInt32LE(81),
    mintA: pk(d, 101), mintB: pk(d, 181),
  };
}

export interface Dlmm { mintX: string; mintY: string; activeId: number; binStep: number; baseFee: number; variableFee: number; }
export function decodeDlmm(d: Buffer): Dlmm {
  const baseFactor = d.readUInt16LE(8);
  const variableFeeControl = d.readUInt32LE(16);
  const baseFeePowerFactor = d.readUInt8(37);
  const volatilityAccumulator = d.readUInt32LE(40);
  const binStep = d.readUInt16LE(80);
  // Fees in 1e9 precision (Meteora LB CLMM math)
  const baseFee = (baseFactor * binStep * 10 * 10 ** baseFeePowerFactor) / 1e9;
  const vb = BigInt(volatilityAccumulator) * BigInt(binStep);
  const variableFee = Number((vb * vb * BigInt(variableFeeControl) + 99_999_999_999n) / 100_000_000_000n) / 1e9;
  return { activeId: d.readInt32LE(76), binStep, baseFee, variableFee, mintX: pk(d, 88), mintY: pk(d, 120) };
}

export interface PumpSwap { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string; }
export function decodePumpSwap(d: Buffer): PumpSwap {
  return { baseMint: pk(d, 43), quoteMint: pk(d, 75), baseVault: pk(d, 139), quoteVault: pk(d, 171) };
}
