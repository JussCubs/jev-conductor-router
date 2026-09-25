import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoutingEvidence } from "./learning.js";
export interface Run extends RoutingEvidence {
  account: string; sessionId: string; workspaceId?: string; createdAt: string;
  seenWorking: boolean; decision: unknown;
}
export async function readRuns(path: string): Promise<Run[]> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new Error("Invalid learning state");
    return value;
  } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
}
/** Atomic replace + exclusive lock avoids corrupt or duplicated observations.
 * A stale lock is explicit; do not guess whether another launch still owns it. */
export async function updateRuns(path: string, update: (rows: Run[]) => Run[]) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(path + ".lock", "wx", 0o600).catch(() => { throw new Error("Learning state is locked; retry after the other process finishes"); });
  const temporary = path + ".tmp-" + process.pid;
  try {
    const rows = update(await readRuns(path)).slice(-2000);
    await writeFile(temporary, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }); await lock.close(); await rm(path + ".lock", { force: true });
  }
}
export function observeRun(run: Run, status: string, now = new Date().toISOString()): Run {
  if (run.reliability !== null) return run;
  if (status === "working") return { ...run, seenWorking: true };
  if (status === "error") return { ...run, reliability: false, reliabilityAt: now };
  if (status === "idle" && run.seenWorking) return { ...run, reliability: true, reliabilityAt: now };
  return run;
}
