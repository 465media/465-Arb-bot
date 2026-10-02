# sol-arb-scanner

A read-only Solana DEX arbitrage scanner. It **never sends transactions** and needs no wallet.

It streams pool state over WebSockets and checks every SOL → … → SOL route (2 and 3 legs) across the watched pools. Whenever a route would clear its fees plus `fixedCostSol`, it logs an *opportunity window*: how big the profit was, at what size, and how many slots it lasted. Run it for a week, then look at the report.

## Supported pools
Raydium AMM v4, Raydium CPMM, Raydium CLMM, Orca Whirlpool, Meteora DLMM (with real bin depth), PumpSwap.
Meteora DAMM v1/v2 are skipped for now.

## Setup
```bash
git clone https://github.com/465media/sol-arb-scanner.git && cd sol-arb-scanner
npm install
cp .env.example .env   # add your Helius key
npm run verify         # sanity-check decoders against live pools
npm start              # run the scanner (Ctrl-C to stop)
npm run report         # summarise logs/windows-*.jsonl
```
Run it under systemd with `deploy/sol-arb-scanner.service` (user unit). You can also use pm2/tmux.

## Deploy on xCloud (Node site)
- Build command: `npm ci`
- Start command: `npm start`, serving mode SSR, port `3000` (the scanner serves its status page on `$PORT`)
- Environment: `RPC_URL`, `WS_URL` (Helius), optional `STATUS_TOKEN` (requires `?token=` on the status page), optional `LOG_DIR`
- `logs/` is gitignored, so redeploys don't wipe it.

## Status page
`/` shows a light dashboard (theme toggle included) and refreshes every 30s. `/status.json` returns the same data as JSON.

## Config (`config.json`)
- `tokens` / `quotes`: watch list, keyed by **mint address**. Restart after editing.
- `minLiquidityUsd`, `maxPoolsPerPair`: control which pools get watched.
- `maxTradeSol`: upper bound for the size search.
- `fixedCostSol`: base fee + priority fee + Jito tip estimate, subtracted from every window.

## Reading the results
- `slots`: how long the gap stayed open. A 1-slot window (about 400ms) is effectively uncatchable without serious infrastructure. The ones that matter are **≥ 2 slots**.
- `sizeApprox: true`: at least one leg is a CLMM/Whirlpool pool. Those are modelled on the current tick range only, so large sizes are optimistic.
- `suspect: true`: the edge was over 20%, which is almost always bad data or a dead pool.
- Majors (SOL/USDC, JUP, etc.) are the **calibration set**. If they show many lasting windows, the math is wrong somewhere, not the market.

## Known limits (v0.1)
- PumpSwap uses the baseline 0.25–0.30% fee and ignores market-cap fee tiers, which is conservative.
- No Token-2022 transfer fees.
- Pools are discovered once at startup via DexScreener. Restart to rediscover.
- The public RPC throttles more than about 50 subscriptions. Use Helius.
