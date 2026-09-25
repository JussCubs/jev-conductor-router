#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { assessDelegation, assessTask, selectRoute, validateConnections, validatePolicy } from "./router.js";
import { observeRun, readRuns, updateRuns } from "./store.js";
try { process.loadEnvFile(); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  snapshot: { type: "string", default: "connections.json" }, policy: { type: "string", default: "examples/policy.json" },
  state: { type: "string", default: ".jev-router-state.json" }, "task-file": { type: "string" },
  delegation: { type: "string", default: "auto" },
  project: { type: "string" }, agent: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
  session: { type: "string" }, success: { type: "string" }, dataset: { type: "string" },
} });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function conductor(path: string, payload?: unknown) {
  const key = process.env.CONDUCTOR_API_KEY || process.env.CONDUCTOR_API_TOKEN;
  if (!key) throw new Error("CONDUCTOR_API_KEY is required for launch, status or feedback");
  const response = await fetch("https://api.conductor.build" + path, { method: payload ? "POST" : "GET", redirect: "error",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  if (!response.ok) throw new Error(`Conductor returned ${response.status}; check account/model/repository access. Launches are not automatically retried.`);
  return response.json() as Promise<any>;
}
async function main() {
  const command = positionals[0];
  const policy = validatePolicy(await json(args.policy));
  if (command === "evaluate") {
    if (!args.dataset) throw new Error("Pass --dataset with labeled route fixtures");
    const rows = await json(args.dataset);
    if (!Array.isArray(rows)) throw new Error("Dataset must be an array");
    const results = rows.map((row: any) => {
      const common = { policy, difficulty: row.difficulty, connections: row.connections, now: row.now };
      const baseline = selectRoute(common);
      const learned = selectRoute({ ...common, evidence: row.evidence ?? [] });
      return { name: row.name, baseline: baseline.model, learned: learned.model, expected: row.expectedModel,
        matchesExpected: row.expectedModel ? row.expectedModel === learned.model : null, changed: baseline.model !== learned.model };
    });
    print({ fixtures: results.length, expectedMatches: results.filter((r) => r.matchesExpected).length, results,
      note: "Offline routing regression, not a counterfactual estimate of real task quality or Jev classification accuracy." });
    if (results.some((r) => r.matchesExpected === false)) process.exitCode = 1;
    return;
  }
  if (!["route", "launch", "status", "feedback"].includes(command)) throw new Error("Commands: route, launch, status, feedback, evaluate. See README.md for flags.");
  const snapshot = await json(args.snapshot);
  const connections = validateConnections(snapshot.connections);
  if (!snapshot.conductor?.userId || !snapshot.conductor?.organizationId) throw new Error("Snapshot must include the discovered Conductor owner and organization");
  const account = createHash("sha256").update(snapshot.conductor.organizationId + ":" + snapshot.conductor.userId).digest("hex");
  const state = resolve(args.state);
  if (command !== "route") {
    const identity = await conductor("/me");
    if (identity.userId !== snapshot.conductor.userId || identity.organizationId !== snapshot.conductor.organizationId) throw new Error("Conductor key does not match this discovery snapshot");
  }
  if (command === "status" || command === "feedback") {
    if (!args.session) throw new Error("Pass the exact tracked --session");
    const tracked = (await readRuns(state)).find((r) => r.account === account && r.sessionId === args.session);
    if (!tracked) throw new Error("No tracked session belongs to this account");
    if (command === "status") {
      const status = await conductor("/v0/sessions/" + encodeURIComponent(args.session) + "/status");
      await updateRuns(state, (rows) => rows.map((r) => r.account === account && r.sessionId === args.session ? observeRun(r, status.status) : r));
      print({ sessionId: args.session, status: status.status, note: "Operational status is not task-quality feedback" });
    } else {
      if (!["true", "false"].includes(args.success ?? "")) throw new Error("Provide your explicit review with --success true or --success false");
      await updateRuns(state, (rows) => rows.map((r) => r.account === account && r.sessionId === args.session
        ? { ...r, quality: args.success === "true", qualityAt: r.qualityAt ?? new Date().toISOString() } : r));
      print({ saved: true, sessionId: args.session });
    }
    return;
  }
  if (!args["task-file"]) throw new Error("Pass --task-file with the task brief");
  const task = await readFile(args["task-file"], "utf8");
  if (!task.trim()) throw new Error("The task brief is empty");
  if (!["auto", "conductor"].includes(args.delegation)) throw new Error("--delegation must be auto or conductor");
  const delegation = args.delegation === "conductor" ? { useConductor: true, source: "explicit", reason: "Explicit user request for Conductor." } : await assessDelegation(task);
  if (!delegation.useConductor) { print({ launched: false, delegation }); return; }
  const assessment = args.model ? { level: 2, label: "explicit", source: "explicit", confidence: null } : await assessTask(task);
  const evidence = (await readRuns(state)).filter((r) => r.account === account);
  const decision = selectRoute({ policy, connections, evidence, difficulty: assessment.level, agent: args.agent, model: args.model, effort: args.effort });
  if (command === "route") { print({ delegation, assessment, ...decision }); return; }
  if (!args.project) throw new Error("Launch requires an exact Conductor --project ID");
  // One mutation only: a dropped response may have launched a real job.
  const result = await conductor("/v0/workspaces", { projectId: args.project, message: task,
    agent: decision.agent, model: decision.model, effort: decision.effort, fastMode: false });
  const sessionId = result.sessionId;
  let learningSaved = false;
  if (sessionId) {
    try {
      await updateRuns(state, (rows) => rows.some((r) => r.account === account && r.sessionId === sessionId) ? rows : [...rows, {
        account, sessionId, workspaceId: result.workspaceId || result.id, createdAt: new Date().toISOString(),
        agent: decision.agent, model: decision.model, effort: decision.effort ?? "default", difficulty: args.model ? -1 : assessment.level,
        seenWorking: false, reliability: null, reliabilityAt: null, quality: null, qualityAt: null, decision: { assessment, ...decision },
      }]); learningSaved = true;
    } catch { /* An accepted launch must not be reported as a failed mutation. */ }
  }
  print({ launched: true, workspaceId: result.workspaceId || result.id, sessionId, deepLink: result.deepLink,
    learningSaved, delegation, assessment, ...decision });
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Routing failed"); process.exitCode = 1; });
