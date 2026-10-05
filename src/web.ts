// Tiny status page so the scanner can run as an xCloud Node site (xCloud proxies to $PORT).
// GET /            light-theme dashboard (auto-refreshes every 30s)
// GET /status.json live counters + today's/7-day summaries
// Set STATUS_TOKEN to require ?token=... on every request.
import http from "node:http";
import { loadRows, logFiles, summarize } from "./summary.js";
import { loadPaper, summarizePaper, type PaperTrader } from "./paper.js";

export interface LiveState {
  startedAt: number; phase: string; rpcHost: string; pools: number; cycles: number; subscriptions: number;
  slot: number; updatesLastMin: number; openWindows: number; closedWindows: number;
  watch: { label: string; pair: string; fee: number; id: string }[];
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function startWeb(state: LiveState, logDir: string, log: (...a: unknown[]) => void, paper?: PaperTrader) {
  const port = Number(process.env.PORT ?? 3000);
  const token = process.env.STATUS_TOKEN;
  const data = () => {
    const files = logFiles(logDir);
    return { live: state, today: summarize(loadRows(files.slice(-1))), last7d: summarize(loadRows(files.slice(-7))),
      paper: { ...summarizePaper(loadPaper(logDir, 7)), session: paper?.stats ?? null, settings: paper?.cfg ?? null } };
  };
  http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (token && url.searchParams.get("token") !== token) { res.writeHead(401).end("unauthorized"); return; }
    if (url.pathname === "/status.json") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data(), null, 2)); return; }
    if (url.pathname !== "/") { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(data()));
  }).listen(port, () => log(`status page on :${port}`));
}

function page({ live, today, last7d, paper }: ReturnType<typeof Object> & any) {
  const up = Math.round((Date.now() - live.startedAt) / 60000);
  const stat = (k: string, v: unknown) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  const routes = last7d.routes.slice(0, 20).map((r: any) =>
    `<tr><td>${esc(r.route)}</td><td>${r.windows}</td><td>${r.catchable}</td><td>${r.catchableSol.toFixed(4)}</td><td>${r.maxSol.toFixed(4)}</td><td>${r.approx ? "~" : ""}</td></tr>`).join("");
  const top = last7d.top.slice(0, 15).map((r: any) =>
    `<tr><td>${esc(r.openedAt.slice(0, 19).replace("T", " "))}</td><td>${r.peakNetSol}</td><td>${r.slots}</td><td>${r.peakEdgeBps}</td><td>${r.peakSizeSol}</td><td class="mono">${esc(r.cycle)}</td></tr>`).join("");
  const pr = paper.routes.slice(0, 15).map((r: any) =>
    `<tr><td>${esc(r.route)}</td><td>${r.attempts}</td><td>${r.wins}</td><td>${r.paperSol.toFixed(4)}</td><td>${r.avgPredicted.toFixed(5)}</td><td>${r.avgQuoted.toFixed(5)}</td></tr>`).join("");
  const pt = paper.recent.map((r: any) =>
    `<tr><td>${esc(r.at.slice(5, 19).replace("T", " "))}</td><td class="${r.won ? "win" : "loss"}">${r.error ? "error" : r.won ? "win" : "miss"}</td><td>${r.sizeSol}</td><td>${r.predictedNetSol}</td><td>${r.quotedNetSol ?? esc(r.error ?? "")}</td><td>${r.latencyMs}</td><td class="mono">${esc(r.route)}</td></tr>`).join("");
  const pools = live.watch.map((p: any) =>
    `<tr><td>${esc(p.label)}</td><td>${esc(p.pair)}</td><td>${(p.fee * 100).toFixed(3)}%</td><td class="mono">${esc(p.id)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Arb Scanner</title><style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1d2330;--mut:#6b7385;--line:#e4e7ee;--acc:#2f6fed;--ok:#1a8f4c}
:root[data-theme=dark]{--bg:#12151b;--card:#1b2029;--fg:#e6e9ef;--mut:#9aa3b5;--line:#2a313d;--acc:#6f9bff;--ok:#4cc27f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:24px 0 8px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px}.mut{color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.k{color:var(--mut);font-size:12px}.v{font-size:18px;font-weight:600}
.tbl{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mut);font-weight:500;font-size:12px}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}
.win{color:var(--ok);font-weight:600}.loss{color:var(--mut)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);margin-right:6px}</style></head><body><main>
<header><div><h1>Arb Scanner</h1><div class="mut"><span class="dot"></span>${esc(live.phase)} · up ${up} min · read-only, no wallet</div></div>
<button onclick="t()">Toggle theme</button></header>
<div class="grid">${stat("Slot", live.slot)}${stat("Updates / min", live.updatesLastMin)}${stat("Pools", live.pools)}${stat("Routes", live.cycles)}
${stat("Open windows", live.openWindows)}${stat("Windows today", today.windows)}${stat("≥2 slots today", today.catchable)}${stat("Catchable SOL today", today.catchableSol)}
${stat("Catchable SOL 7d", last7d.catchableSol)}${stat("RPC", live.rpcHost)}</div>
<h2>Paper trades, last 7 days</h2>
<p class="mut" style="margin:0 0 8px">When a gap opens, the bot re-prices the exact trade with live Jupiter quotes, like a real bot would right before sending. "Win" = still profitable after real quotes, delay and ${paper.settings?.costSol ?? "?"} SOL cost. Nothing is ever sent.</p>
<div class="grid" style="margin-top:0">${stat("Paper profit (SOL)", paper.paperSol)}${stat("Wins / attempts", `${paper.wins} / ${paper.attempts - paper.errors}`)}${stat("Win rate", paper.winRate + "%")}${stat("Predicted (SOL)", paper.predictedSol)}${stat("Median latency", paper.medianLatencyMs + " ms")}${stat("Skipped (rate limit)", paper.session?.skippedRate ?? 0)}</div>
<div class="tbl" style="margin-top:10px"><table><tr><th>Route</th><th>Attempts</th><th>Wins</th><th>Paper SOL</th><th>Avg predicted</th><th>Avg quoted</th></tr>${pr || '<tr><td colspan="6" class="mut">No paper trades yet</td></tr>'}</table></div>
<div class="tbl" style="margin-top:10px"><table><tr><th>Time (UTC)</th><th>Result</th><th>Size SOL</th><th>Predicted</th><th>Quoted net</th><th>ms</th><th>Route</th></tr>${pt || '<tr><td colspan="7" class="mut">Nothing yet</td></tr>'}</table></div>
<h2>Routes, last 7 days</h2><div class="tbl"><table><tr><th>Route</th><th>Windows</th><th>≥2 slots</th><th>SOL (≥2)</th><th>Max SOL</th><th>Approx</th></tr>${routes || '<tr><td colspan="6" class="mut">Nothing yet</td></tr>'}</table></div>
<h2>Best windows that lasted ≥2 slots, last 7 days</h2><div class="tbl"><table><tr><th>Opened (UTC)</th><th>Net SOL</th><th>Slots</th><th>Edge bps</th><th>Size SOL</th><th>Route</th></tr>${top || '<tr><td colspan="6" class="mut">Nothing yet</td></tr>'}</table></div>
<h2>Watched pools</h2><div class="tbl"><table><tr><th>Pool</th><th>Pair</th><th>Fee</th><th>Address</th></tr>${pools}</table></div>
<p class="mut">"≥2 slots" means the gap stayed open at least ~0.8s; shorter ones are effectively uncatchable. "Approx" means a CLMM/Whirlpool leg is in the route, so large sizes are optimistic.</p>
</main><script>function t(){var r=document.documentElement,n=r.dataset.theme==="dark"?"light":"dark";r.dataset.theme=n;try{localStorage.setItem("theme",n)}catch(e){}}
try{var s=localStorage.getItem("theme");if(s)document.documentElement.dataset.theme=s}catch(e){}</script></body></html>`;
}
