// Live trader (guarded). Modes, set with env LIVE_MODE:
//   off       (default) does nothing
//   simulate  builds the real transaction and runs it through simulateTransaction; never sends
//   live      sends the transaction as a Jito bundle
// Safety:
//   * every trade is ONE atomic transaction; the last swap has a minimum-out equal to
//     size + tip + fee + minProfit, so an unprofitable trade reverts. Jito drops reverted
//     bundles, so a lost race costs nothing.
//   * route allowlist, max size, one trade in flight, per-route cooldown
//   * circuit breaker: halts if the wallet falls more than maxLossSol below its starting balance,
//     or below minBalanceSol
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import { JUP_LABEL, type PaperLeg } from "./paper.js";
import { flashBorrow, flashRepay, createAtaIdempotent, closeWsolAta } from "./flash.js";

const LAMPORTS = 1e9;
const BASE_FEE = 5000;
const FLASH_FEE_RATE = 0.00001; // Kamino SOL reserve: measured 10_000 lamports per 1 SOL borrowed (0.001%)

export interface LiveConfig {
  mode: "off" | "simulate" | "live";
  routes: string[]; maxSizeSol: number; maxOwnSol: number; useFlashLoan: boolean; minProfitSol: number; tipMinSol: number; tipShare: number;
  cooldownMs: number; maxLossSol: number; minBalanceSol: number; minPredictedNetSol: number;
  jupBase: string; jitoUrl: string;
}

export interface LiveRow {
  at: string; mode: string; route: string; sizeSol: number; predictedNetSol: number;
  quotedNetSol?: number; tipSol?: number; outcome: string; detail?: string; ms: number;
  sig?: string; bundleId?: string; realizedSol?: number; simDeltaSol?: number; txBytes?: number;
  via?: string; simAtSend?: string; jitoStatus?: string;
}

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
const toIx = (i: JupIx) => new TransactionInstruction({
  programId: new PublicKey(i.programId), data: Buffer.from(i.data, "base64"),
  keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
});

export function parseSecret(s: string): Keypair {
  const t = s.trim();
  return Keypair.fromSecretKey(t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t));
}

export class LiveTrader {
  wallet: Keypair | null = null;
  pubkey: PublicKey | null = null; // may be set without a key for simulation-only testing
  tipAccounts: PublicKey[] = [];
  alts = new Map<string, AddressLookupTableAccount>();
  blockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
  busy = false;
  lastByRoute = new Map<string, number>();
  state = { mode: "off", reason: "", wallet: "", startBalanceSol: 0, balanceSol: 0, halted: false, waiting: false,
    attempts: 0, noGo: 0, simulatedOk: 0, sent: 0, landed: 0, notLanded: 0, lostAuction: 0, gapClosed: 0, failed: 0, realizedSol: 0 };

  constructor(public cfg: LiveConfig, public conn: Connection, public logDir: string, public log: (...a: unknown[]) => void) {
    this.state.mode = cfg.mode;
  }

  async init() {
    if (this.cfg.mode === "off") { this.state.reason = "LIVE_MODE is off"; return; }
    try {
      if (process.env.WALLET_SECRET) { this.wallet = parseSecret(process.env.WALLET_SECRET); this.pubkey = this.wallet.publicKey; }
      else if (this.cfg.mode === "simulate" && process.env.SIM_PUBKEY) this.pubkey = new PublicKey(process.env.SIM_PUBKEY);
    } catch (e) { this.disable(`bad WALLET_SECRET: ${(e as Error).message}`); return; }
    if (!this.pubkey) { this.disable("no WALLET_SECRET set"); return; }
    if (this.cfg.mode === "live" && !this.wallet) { this.disable("live mode needs WALLET_SECRET"); return; }
    this.state.wallet = this.pubkey.toBase58();
    const bal = await this.conn.getBalance(this.pubkey, "confirmed");
    this.state.startBalanceSol = this.state.balanceSol = bal / LAMPORTS;
    await this.checkBalance();
    await this.refreshBlockhash();
    setInterval(() => this.refreshBlockhash().catch(() => {}), 10_000);
    setInterval(() => this.checkBalance().catch(() => {}), 30_000);
    if (this.cfg.mode === "live") {
      const r = await fetch(this.cfg.jitoUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }) });
      this.tipAccounts = ((await r.json()) as { result: string[] }).result.map((a) => new PublicKey(a));
    }
    this.log(`LIVE ${this.cfg.mode}: wallet ${this.state.wallet} balance ${this.state.balanceSol} SOL, routes: ${this.cfg.routes.join(", ")}`);
  }

  private disable(reason: string) { this.state.mode = "off"; this.state.reason = reason; this.log(`LIVE disabled: ${reason}`); }

  private async refreshBlockhash() { this.blockhash = await this.conn.getLatestBlockhash("confirmed"); }

  private async checkBalance() {
    if (!this.pubkey) return;
    this.state.balanceSol = (await this.conn.getBalance(this.pubkey, "confirmed")) / LAMPORTS;
    // not funded yet (or funded after start): wait instead of tripping the breaker, and
    // take the first funded balance as the starting point
    if (this.state.attempts === 0 && this.state.startBalanceSol < this.cfg.minBalanceSol) {
      if (this.state.balanceSol >= this.cfg.minBalanceSol) {
        this.state.startBalanceSol = this.state.balanceSol; this.state.waiting = false; this.state.reason = "";
        this.log(`LIVE funded: starting balance ${this.state.balanceSol} SOL`);
      } else { this.state.waiting = true; this.state.reason = "waiting for the wallet to be funded"; }
      return;
    }
    const lost = this.state.startBalanceSol - this.state.balanceSol;
    if (!this.state.halted && this.cfg.mode === "live" && (lost > this.cfg.maxLossSol || this.state.balanceSol < this.cfg.minBalanceSol)) {
      this.state.halted = true;
      this.state.reason = `circuit breaker: balance ${this.state.balanceSol.toFixed(4)} SOL (start ${this.state.startBalanceSol.toFixed(4)})`;
      this.log(`LIVE HALTED ${this.state.reason}`);
    }
  }

  consider(route: string, legs: PaperLeg[], sizeLamports: number, predictedNetLamports: number) {
    if (this.state.mode === "off" || this.state.halted || this.state.waiting || this.busy) return;
    const key = route.split("  [")[0];
    if (!this.cfg.routes.includes(key)) return;
    if (predictedNetLamports < this.cfg.minPredictedNetSol * LAMPORTS) return;
    const now = Date.now();
    if (now - (this.lastByRoute.get(key) ?? 0) < this.cfg.cooldownMs) return;
    this.lastByRoute.set(key, now);
    this.busy = true;
    const size = Math.floor(Math.min(sizeLamports, (this.cfg.useFlashLoan ? this.cfg.maxSizeSol : this.cfg.maxOwnSol) * LAMPORTS));
    this.run(route, legs, size, predictedNetLamports)
      .catch((e) => this.record({ route, size, predicted: predictedNetLamports, t0: now, outcome: "error", detail: (e as Error).message }))
      .finally(() => { this.busy = false; });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (process.env.JUP_API_KEY) h["x-api-key"] = process.env.JUP_API_KEY;
    return h;
  }

  private async quote(l: PaperLeg, amount: number) {
    const u = new URL(`${this.cfg.jupBase}/quote`);
    Object.entries({ inputMint: l.from, outputMint: l.to, amount: String(amount), slippageBps: "0",
      onlyDirectRoutes: "true", dexes: JUP_LABEL[l.kind] }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`quote ${r.status}`);
    return (await r.json()) as any;
  }

  private async swapIxs(q: any, wrap = true) {
    const r = await fetch(`${this.cfg.jupBase}/swap-instructions`, {
      method: "POST", headers: this.headers(), signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ quoteResponse: q, userPublicKey: this.pubkey!.toBase58(), wrapAndUnwrapSol: wrap }),
    });
    if (!r.ok) throw new Error(`swap-instructions ${r.status}`);
    const d = (await r.json()) as any;
    if (d.error) throw new Error(`swap-instructions: ${d.error}`);
    return d;
  }

  private async lookupTables(addrs: string[]) {
    const missing = addrs.filter((a) => !this.alts.has(a));
    await Promise.all(missing.map(async (a) => {
      const r = await this.conn.getAddressLookupTable(new PublicKey(a));
      if (r.value) this.alts.set(a, r.value);
    }));
    return addrs.map((a) => this.alts.get(a)).filter(Boolean) as AddressLookupTableAccount[];
  }

  /** own-funds size cap: configured max, but never more than balance minus a 0.05 SOL reserve */
  private ownCap() { return Math.floor(Math.max(0, Math.min(this.cfg.maxOwnSol, this.state.balanceSol - 0.05)) * LAMPORTS); }

  private async run(route: string, legs: PaperLeg[], size: number, predicted: number) {
    const t0 = Date.now();
    this.state.attempts++;
    if (this.cfg.useFlashLoan) {
      const r = await this.attempt(route, legs, size, predicted, t0, true);
      if (r !== "too-large") return;
      // flash loan made the tx too big (usually 3-leg routes): retry with own funds at a smaller size
      const own = Math.min(size, this.ownCap());
      if (own <= 0) return this.record({ route, size, predicted, t0, outcome: "too-large", detail: "flash tx too large and no own funds" });
      await this.attempt(route, legs, own, predicted, t0, false);
    } else {
      await this.attempt(route, legs, Math.min(size, this.ownCap()), predicted, t0, false);
    }
  }

  private async attempt(route: string, legs: PaperLeg[], size: number, predicted: number, t0: number, flash: boolean): Promise<string> {
    const via = flash ? "flash" : "own";
    // 1) fresh quotes, chained
    const quotes: any[] = [];
    let amt = size;
    for (const l of legs) { const q = await this.quote(l, amt); quotes.push(q); amt = Number(q.outAmount); }
    const out = amt;
    const flashFee = flash ? Math.ceil(size * FLASH_FEE_RATE) + 1 : 0;
    const gross = out - size - flashFee - BASE_FEE;
    const tip = Math.max(this.cfg.tipMinSol * LAMPORTS, Math.floor(gross * this.cfg.tipShare));
    const required = size + flashFee + BASE_FEE + tip + this.cfg.minProfitSol * LAMPORTS;
    const quotedNet = gross - tip;
    if (out < required) {
      this.state.noGo++;
      this.record({ route, size, predicted, t0, outcome: "no-go", quotedNet, tip, via, detail: "gap gone on fresh quote" });
      return "no-go";
    }
    // 2) profit guard: the last leg must return at least `required`, or the whole tx reverts
    const last = quotes[quotes.length - 1];
    const bps = Math.floor(((out - required) / out) * 1e4);
    last.slippageBps = Math.max(0, bps);
    last.otherAmountThreshold = String(Math.ceil(out * (1 - last.slippageBps / 1e4)));
    if (Number(last.otherAmountThreshold) < required) last.otherAmountThreshold = String(required);
    // test hook (simulate mode only): demand more than the quote to prove the guard reverts on-chain
    const extra = this.cfg.mode === "simulate" ? Number(process.env.GUARD_TEST_EXTRA_LAMPORTS ?? 0) : 0;
    if (extra > 0) { last.slippageBps = 0; last.outAmount = String(out + extra); last.otherAmountThreshold = String(out + extra); }
    // 3) instructions for every leg, in parallel (flash: work in wSOL, no auto wrap/unwrap)
    const ix = await Promise.all(quotes.map((q) => this.swapIxs(q, !flash)));
    const seen = new Set<string>();
    const setups: TransactionInstruction[] = [];
    for (const d of ix) for (const st of d.setupInstructions as JupIx[]) {
      const k = st.programId + st.data + st.accounts.map((a) => a.pubkey).join();
      if (!seen.has(k)) { seen.add(k); setups.push(toIx(st)); }
    }
    const me = this.pubkey!;
    const cu = Math.min(1_400_000, ix.reduce((a, d) => a + (d.computeUnitLimit ?? 200_000), 0) + (flash ? 150_000 : 50_000));
    const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu })];
    if (flash) instructions.push(createAtaIdempotent(me, me));
    instructions.push(...setups);
    let borrowIdx = -1;
    if (flash) { borrowIdx = instructions.length; instructions.push(flashBorrow(me, BigInt(size))); }
    instructions.push(...ix.map((d) => toIx(d.swapInstruction)));
    if (flash) instructions.push(flashRepay(me, BigInt(size), borrowIdx), closeWsolAta(me));
    else if (ix[ix.length - 1].cleanupInstruction) instructions.push(toIx(ix[ix.length - 1].cleanupInstruction));
    if (this.cfg.mode === "live") {
      const tipAcct = this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)];
      instructions.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: tipAcct, lamports: tip }));
    }
    const alts = await this.lookupTables([...new Set(ix.flatMap((d) => d.addressLookupTableAddresses as string[]))]);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: this.blockhash!.blockhash, instructions })
      .compileToV0Message(alts));
    let bytes: number;
    try {
      if (this.wallet) tx.sign([this.wallet]);
      bytes = tx.serialize().length;
      if (bytes > 1232) throw new Error(`tx ${bytes} bytes > 1232`);
    } catch (e) {
      if (flash) return "too-large"; // caller retries with own funds
      this.record({ route, size, predicted, t0, outcome: "too-large", quotedNet, tip, via, detail: (e as Error).message.slice(0, 120) });
      return "too-large";
    }

    const simulate = () => this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed",
      accounts: { encoding: "base64", addresses: [me.toBase58()] } });

    if (this.cfg.mode === "simulate") {
      const pre = await this.conn.getBalance(me, "processed");
      const sim = await simulate();
      const err = sim.value.err;
      const post = sim.value.accounts?.[0]?.lamports;
      if (!err) this.state.simulatedOk++;
      this.record({ route, size, predicted, t0, outcome: err ? "sim-revert" : "sim-ok", quotedNet, tip, via, txBytes: bytes,
        simDeltaSol: post !== undefined ? (post - pre - BASE_FEE) / LAMPORTS : undefined,
        detail: err ? JSON.stringify(err).slice(0, 160) : undefined });
      return err ? "sim-revert" : "sim-ok";
    }

    // live: send as a Jito bundle, and simulate the same tx at the same moment for diagnosis
    const sig = bs58.encode(tx.signatures[0]);
    const simP = simulate().then((r) => (r.value.err ? `revert ${JSON.stringify(r.value.err).slice(0, 80)}` : "ok")).catch(() => "unknown");
    const r = await fetch(this.cfg.jitoUrl, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[Buffer.from(tx.serialize()).toString("base64")], { encoding: "base64" }] }) });
    const jr = (await r.json()) as { result?: string; error?: { message: string } };
    const simAtSend = await simP;
    if (!jr.result) {
      this.state.failed++;
      this.record({ route, size, predicted, t0, outcome: "send-failed", quotedNet, tip, via, sig, txBytes: bytes, simAtSend, detail: jr.error?.message ?? `http ${r.status}` });
      return "send-failed";
    }
    this.state.sent++;
    // wait a few slots, then check whether it landed, why not, and what it actually made
    await new Promise((res) => setTimeout(res, 6000));
    const jitoStatus = await this.bundleStatus(jr.result);
    const st = await this.conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (!s) {
      this.state.notLanded++;
      // sim ok when sent => the trade was valid and we were outbid/too slow; revert => gap already closed
      const why = simAtSend === "ok" ? "lost-auction" : simAtSend.startsWith("revert") ? "gap-closed" : "not-landed";
      if (why === "lost-auction") this.state.lostAuction++; else if (why === "gap-closed") this.state.gapClosed++;
      this.record({ route, size, predicted, t0, outcome: why, quotedNet, tip, via, sig, bundleId: jr.result, txBytes: bytes, simAtSend, jitoStatus });
      return why;
    }
    const txi = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const realized = txi?.meta ? (txi.meta.postBalances[0] - txi.meta.preBalances[0]) / LAMPORTS : undefined;
    if (s.err) this.state.failed++; else { this.state.landed++; this.state.realizedSol += realized ?? 0; }
    await this.checkBalance();
    this.record({ route, size, predicted, t0, outcome: s.err ? "landed-failed" : "landed", quotedNet, tip, via, sig, bundleId: jr.result,
      realizedSol: realized, txBytes: bytes, simAtSend, jitoStatus, detail: s.err ? JSON.stringify(s.err).slice(0, 160) : undefined });
    return "landed";
  }

  private async bundleStatus(id: string): Promise<string> {
    try {
      const r = await fetch(this.cfg.jitoUrl, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getInflightBundleStatuses", params: [[id]] }) });
      const j = (await r.json()) as any;
      return j?.result?.value?.[0]?.status ?? "unknown";
    } catch { return "unknown"; }
  }

  private record(o: { route: string; size: number; predicted: number; t0: number; outcome: string; quotedNet?: number; tip?: number;
    detail?: string; sig?: string; bundleId?: string; realizedSol?: number; simDeltaSol?: number; txBytes?: number;
    via?: string; simAtSend?: string; jitoStatus?: string }) {
    const row: LiveRow = {
      at: new Date(o.t0).toISOString(), mode: this.state.mode, route: o.route, sizeSol: +(o.size / LAMPORTS).toFixed(4),
      predictedNetSol: +(o.predicted / LAMPORTS).toFixed(6), outcome: o.outcome, ms: Date.now() - o.t0,
      ...(o.quotedNet !== undefined ? { quotedNetSol: +(o.quotedNet / LAMPORTS).toFixed(6) } : {}),
      ...(o.tip !== undefined ? { tipSol: +(o.tip / LAMPORTS).toFixed(6) } : {}),
      ...(o.detail ? { detail: o.detail } : {}), ...(o.sig ? { sig: o.sig } : {}), ...(o.bundleId ? { bundleId: o.bundleId } : {}),
      ...(o.realizedSol !== undefined ? { realizedSol: o.realizedSol } : {}),
      ...(o.simDeltaSol !== undefined ? { simDeltaSol: +o.simDeltaSol.toFixed(6) } : {}),
      ...(o.txBytes ? { txBytes: o.txBytes } : {}),
      ...(o.via ? { via: o.via } : {}), ...(o.simAtSend ? { simAtSend: o.simAtSend } : {}), ...(o.jitoStatus ? { jitoStatus: o.jitoStatus } : {}),
    };
    fs.appendFileSync(path.join(this.logDir, `live-${row.at.slice(0, 10)}.jsonl`), JSON.stringify(row) + "\n");
    if (row.outcome !== "no-go") this.log(`LIVE ${row.outcome} ${row.route} size=${row.sizeSol} q=${row.quotedNetSol} ${row.detail ?? ""}`);
  }
}

export function loadLive(dir: string, lastDays: number): LiveRow[] {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^live-.*\.jsonl$/.test(f)).sort().slice(-lastDays);
    return files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  } catch { return []; }
}

export function liveConfigFrom(cfgJson: any): LiveConfig {
  const c = cfgJson?.live ?? {};
  const env = process.env;
  const mode = (env.LIVE_MODE ?? c.mode ?? "off") as LiveConfig["mode"];
  return {
    mode: ["off", "simulate", "live"].includes(mode) ? mode : "off",
    routes: (env.LIVE_ROUTES ? env.LIVE_ROUTES.split(",").map((s) => s.trim()) : c.routes) ?? [],
    maxSizeSol: Number(env.LIVE_MAX_SIZE_SOL ?? c.maxSizeSol ?? 5),
    maxOwnSol: Number(c.maxOwnSol ?? 0.5),
    useFlashLoan: String(env.LIVE_FLASH ?? c.useFlashLoan ?? "true") === "true",
    minProfitSol: Number(c.minProfitSol ?? 0.00005),
    tipMinSol: Number(c.tipMinSol ?? 0.00002),
    tipShare: Number(c.tipShare ?? 0.75),
    cooldownMs: Number(c.cooldownMs ?? 3000),
    maxLossSol: Number(env.LIVE_MAX_LOSS_SOL ?? c.maxLossSol ?? 0.05),
    minBalanceSol: Number(c.minBalanceSol ?? 0.05),
    minPredictedNetSol: Number(c.minPredictedNetSol ?? 0.0003),
    jupBase: c.jupBase ?? "https://lite-api.jup.ag/swap/v1",
    jitoUrl: c.jitoUrl ?? "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  };
}
