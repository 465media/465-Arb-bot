// Shared summary of logged opportunity windows (used by the CLI report and the status page).
import fs from "node:fs";
import path from "node:path";

export interface WindowRow {
  cycle: string; legs: number; openedAt: string; durationMs: number; openSlot: number; closeSlot: number; slots: number;
  peakNetSol: number; peakSizeSol: number; peakEdgeBps: number; evals: number; sizeApprox: boolean; suspect: boolean;
}

export function loadRows(files: string[]): WindowRow[] {
  return files.flatMap((f) => {
    try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  });
}
export function logFiles(dir: string, lastDays = 0): string[] {
  try {
    const all = fs.readdirSync(dir).filter((f) => /^windows-.*\.jsonl$/.test(f)).sort();
    return (lastDays ? all.slice(-lastDays) : all).map((f) => path.join(dir, f));
  } catch { return []; }
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)] ?? 0; };

export function summarize(rows: WindowRow[]) {
  const real = rows.filter((r) => !r.suspect);
  const catchable = real.filter((r) => r.slots >= 2);
  const groups = new Map<string, WindowRow[]>();
  for (const r of real) { const k = r.cycle.split("  [")[0]; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  return {
    windows: rows.length, suspect: rows.length - real.length, catchable: catchable.length,
    catchableSol: +catchable.reduce((s, r) => s + r.peakNetSol, 0).toFixed(6),
    medianProfitSol: q(real.map((r) => r.peakNetSol), 0.5), p90ProfitSol: q(real.map((r) => r.peakNetSol), 0.9),
    medianSlots: q(real.map((r) => r.slots), 0.5), p90Slots: q(real.map((r) => r.slots), 0.9),
    routes: [...groups].map(([route, l]) => {
      const c = l.filter((r) => r.slots >= 2);
      return { route, windows: l.length, catchable: c.length, catchableSol: +c.reduce((s, r) => s + r.peakNetSol, 0).toFixed(6),
        maxSol: Math.max(...l.map((r) => r.peakNetSol)), approx: l.some((r) => r.sizeApprox) };
    }).sort((a, b) => b.catchableSol - a.catchableSol || b.windows - a.windows),
    top: catchable.sort((a, b) => b.peakNetSol - a.peakNetSol).slice(0, 15),
  };
}
