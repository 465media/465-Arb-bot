// Summarise logged opportunity windows.  npm run report [-- file.jsonl ...]
import { loadRows, logFiles, summarize } from "../src/summary.js";

const files = process.argv.slice(2).length ? process.argv.slice(2) : logFiles(process.env.LOG_DIR ?? "logs");
const rows = loadRows(files);
if (!rows.length) { console.log("no windows logged yet"); process.exit(0); }
const s = summarize(rows);
console.log(`files: ${files.length}   windows: ${s.windows}   suspect (>20% edge, likely bad data): ${s.suspect}`);
console.log(`lasted >=2 slots: ${s.catchable}   theoretical profit if all caught: ${s.catchableSol} SOL`);
console.log(`profit/window SOL  median ${s.medianProfitSol}  p90 ${s.p90ProfitSol}`);
console.log(`duration slots     median ${s.medianSlots}  p90 ${s.p90Slots}\n`);
console.log("route".padEnd(28), "windows", ">=2slots", "sumSOL(>=2)", "maxSOL", "approx");
for (const r of s.routes.slice(0, 25))
  console.log(r.route.padEnd(28), String(r.windows).padStart(7), String(r.catchable).padStart(8),
    r.catchableSol.toFixed(4).padStart(11), r.maxSol.toFixed(4).padStart(7), r.approx ? "  yes" : "");
console.log("\nTop by profit (lasted >=2 slots):");
for (const r of s.top.slice(0, 10))
  console.log(`  ${r.peakNetSol} SOL  ${r.slots} slots  ${r.peakEdgeBps}bps  size ${r.peakSizeSol}  ${r.openedAt}  ${r.cycle}`);
