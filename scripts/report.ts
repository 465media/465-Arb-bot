// Summarise logged opportunity windows.  npm run report [-- logs/windows-2026-10-02.jsonl ...]
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync("logs").filter((f) => f.endsWith(".jsonl")).map((f) => path.join("logs", f));
const rows = files.flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
if (!rows.length) { console.log("no windows logged yet"); process.exit(0); }

const real = rows.filter((r) => !r.suspect);
const catchable = real.filter((r) => r.slots >= 2); // lasted at least ~2 slots (~800ms)
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)] ?? 0; };

console.log(`files: ${files.length}   windows: ${rows.length}   suspect (>20% edge, likely bad data): ${rows.length - real.length}`);
console.log(`lasted >=2 slots: ${catchable.length}   theoretical profit if all caught: ${catchable.reduce((s, r) => s + r.peakNetSol, 0).toFixed(4)} SOL`);
console.log(`profit/window SOL  median ${q(real.map((r) => r.peakNetSol), 0.5)}  p90 ${q(real.map((r) => r.peakNetSol), 0.9)}`);
console.log(`duration slots     median ${q(real.map((r) => r.slots), 0.5)}  p90 ${q(real.map((r) => r.slots), 0.9)}\n`);

// group by token route (ignoring which exact pools)
const groups = new Map<string, any[]>();
for (const r of real) { const k = r.cycle.split("  [")[0]; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
console.log("route".padEnd(28), "windows", ">=2slots", "sumSOL(>=2)", "maxSOL", "approx");
for (const [k, l] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
  const c = l.filter((r) => r.slots >= 2);
  console.log(k.padEnd(28), String(l.length).padStart(7), String(c.length).padStart(8),
    c.reduce((s, r) => s + r.peakNetSol, 0).toFixed(4).padStart(11), Math.max(...l.map((r) => r.peakNetSol)).toFixed(4).padStart(7),
    l.some((r) => r.sizeApprox) ? "  yes" : "");
}
console.log("\nTop 10 by profit (lasted >=2 slots):");
for (const r of catchable.sort((a, b) => b.peakNetSol - a.peakNetSol).slice(0, 10))
  console.log(`  ${r.peakNetSol} SOL  ${r.slots} slots  ${r.peakEdgeBps}bps  size ${r.peakSizeSol}  ${r.openedAt}  ${r.cycle}`);
