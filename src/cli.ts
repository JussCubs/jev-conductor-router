#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createFromPlan, saveFeedback } from "./actions.js";
import { accountKey } from "./account.js";
import { ConductorClient } from "./conductor.js";
import { planLaunch } from "./gate.js";
import { selectRoute, validateConnections, validatePolicy } from "./router.js";
import { startMcpServer } from "./mcp.js";
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

async function main() {
  const command = positionals[0];
  if (command === "mcp") { await startMcpServer(); return; }
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
  if (!["route", "launch", "status", "feedback"].includes(command)) throw new Error("Commands: mcp, route, launch, status, feedback, evaluate. See README.md for flags.");
  const snapshot = await json(args.snapshot);
  const connections = validateConnections(snapshot.connections);
  if (!snapshot.conductor?.userId || !snapshot.conductor?.organizationId) throw new Error("Snapshot must include the discovered Conductor owner and organization");
  const account = accountKey(snapshot.conductor.organizationId, snapshot.conductor.userId);
  const state = resolve(args.state);
  const client = new ConductorClient();
  if (command !== "route") {
    const identity = await client.me();
    if (identity.userId !== snapshot.conductor.userId || identity.organizationId !== snapshot.conductor.organizationId) throw new Error("Conductor key does not match this discovery snapshot");
  }
  if (command === "status" || command === "feedback") {
    if (!args.session) throw new Error("Pass the exact tracked --session");
    if (command === "status") {
      const tracked = (await readRuns(state)).find((row) => row.account === account && row.sessionId === args.session);
      if (!tracked) throw new Error("No tracked session belongs to this account");
      const status = await client.sessionStatus(args.session);
      await updateRuns(state, (rows) => rows.map((row) => row.account === account && row.sessionId === args.session ? observeRun(row, status.status) : row));
      print({ sessionId: args.session, status: status.status, note: "Operational status is not task-quality feedback" });
    } else {
      if (!["true", "false"].includes(args.success ?? "")) throw new Error("Provide your explicit review with --success true or --success false");
      await saveFeedback({ sessionId: args.session, success: args.success === "true", statePath: state, client, account });
      print({ saved: true, sessionId: args.session });
    }
    return;
  }
  if (!args["task-file"]) throw new Error("Pass --task-file with the task brief");
  const task = await readFile(args["task-file"], "utf8");
  const evidence = (await readRuns(state)).filter((row) => row.account === account);
  const plan = await planLaunch({ task, delegation: args.delegation, agent: args.agent, model: args.model, effort: args.effort, connections, policy, evidence });
  if (!plan.create) { print({ launched: false, delegation: plan.delegation }); return; }
  if (!plan.route) throw new Error("No route. Refresh the discovery snapshot or pass --agent and --model.");
  if (command === "route") { print({ delegation: plan.delegation, assessment: plan.assessment, ...plan.route }); return; }
  if (!args.project) throw new Error("Launch requires an exact Conductor --project ID");
  print(await createFromPlan(plan, { task, projectId: args.project, statePath: state, account, agent: args.agent, model: args.model, effort: args.effort }, client));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Routing failed"); process.exitCode = 1; });
