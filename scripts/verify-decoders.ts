import { Connection, PublicKey } from "@solana/web3.js";
import * as P from "../src/programs.js";
const c = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const pools: Record<string,string> = {
  wp_zbcn_sol: "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w",
  dlmm_zbcn_usdc: "6Mo8W6b67brHWokLNeXPdfwH7B1ir3xYCGd4EcBen6eM",
  clmm_zbcn_sol: "FkggXKXmxaQ8tT46NnpcTW3tWjtSerJ7YdGuqGF9FbjX",
  v4_sol_usdc: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
  pump_sol_usdc: "Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v",
};
const accs = await c.getMultipleAccountsInfo(Object.values(pools).map(k=>new PublicKey(k)));
const d = Object.fromEntries(Object.keys(pools).map((k,i)=>[k, accs[i]!.data as Buffer]));
const wp = P.decodeWhirlpool(d.wp_zbcn_sol); console.log("wp", wp);
const dl = P.decodeDlmm(d.dlmm_zbcn_usdc); console.log("dlmm", dl, "price", (1+dl.binStep/1e4)**dl.activeId * 10**(5-6));
const cl = P.decodeRayClmm(d.clmm_zbcn_sol); console.log("clmm", cl);
const cfg = await c.getAccountInfo(new PublicKey(cl.ammConfig)); console.log("clmm fee", P.clmmTradeFeeRate(cfg!.data as Buffer));
const v4 = P.decodeRayV4(d.v4_sol_usdc); console.log("v4", v4);
const ps = P.decodePumpSwap(d.pump_sol_usdc); console.log("pump", ps);
const vs = await c.getMultipleAccountsInfo([v4.baseVault, v4.quoteVault, ps.baseVault, ps.quoteVault].map(k=>new PublicKey(k)));
const a = vs.map(v=>P.tokenAmount(v!.data as Buffer));
console.log("v4 price", Number(a[1]-v4.quoteNeedTakePnl)/1e6 / (Number(a[0]-v4.baseNeedTakePnl)/1e9));
console.log("pump price", Number(a[3])/1e6 / (Number(a[2])/1e9));
const sp = (x:bigint)=> (Number(x)/2**64)**2;
console.log("wp price SOL/ZBCN", sp(wp.sqrtPriceX64)*10**(5-9), "clmm", sp(cl.sqrtPriceX64)*10**(cl.dec0-cl.dec1));
