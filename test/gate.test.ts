import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planLaunch } from "../src/gate.js";
import { createConductorWorkspace } from "../src/actions.js";
import { validatePolicy, type Connection } from "../src/router.js";

const policy = validatePolicy(JSON.parse(readFileSync(new URL("../examples/policy.json", import.meta.url), "utf8")));
const now = Date.parse("2026-09-25T18:00:00Z");
function connections(): Connection[] {
  return (["codex", "cursor", "claude"] as const).map((agent) => ({ agent, accountFingerprint: "a".repeat(64), authKind: "subscription", enabled: true,
    models: policy.models.filter((model) => model.agent === agent).map((model) => model.model), observedAt: new Date(now).toISOString(),
    windows: [{ usedPercent: 20, resetsAt: new Date(now + 86400_000).toISOString() }], quotaError: null }));
}
const delegation = (probability: number) => Response.json({ answers: { delegation: { type: "choice", choice: "conductor", probabilities: { conductor: probability, direct: 1 - probability }, confidence: 0.8 } } });

test("conductor probability below 0.65 does not plan a launch", async () => {
  const plan = await planLaunch({ task: "Explain this function", connections: connections(), policy, now, env: { OPENROUTER_API_KEY: "fixture" },
    fetch: async () => delegation(0.649) });
  assert.equal(plan.create, false);
  assert.equal(plan.route, null);
});

test("a passing gate routes at the safe standard tier when difficulty classification fails", async () => {
  let calls = 0;
  const plan = await planLaunch({ task: "Add a bounded test", connections: connections(), policy, now, env: { OPENROUTER_API_KEY: "fixture" },
    fetch: async () => ++calls === 1 ? delegation(0.65) : new Response("down", { status: 503 }) });
  assert.equal(plan.create, true);
  assert.equal(plan.assessment?.source, "bounded_fallback");
  assert.equal(plan.assessment?.level, 1);
  assert.equal(plan.route?.model, "gpt-6-luna");
  assert.equal(plan.route?.fastMode, false);
});

test("explicit conductor still uses the standard tier when Jev difficulty fails", async () => {
  const plan = await planLaunch({ task: "Ship the fix", delegation: "conductor", connections: connections(), policy, now, env: { OPENROUTER_API_KEY: "fixture" },
    fetch: async () => new Response("down", { status: 502 }) });
  assert.equal(plan.create, true);
  assert.equal(plan.delegation.source, "explicit");
  assert.equal(plan.assessment?.level, 1);
});

test("a blocked gate never calls Conductor", async () => {
  const urls: string[] = [];
  const result = await createConductorWorkspace({ task: "Summarize the README", projectId: "project-1", env: { OPENROUTER_API_KEY: "fixture", CONDUCTOR_API_KEY: "conductor" },
    fetch: async (url) => { urls.push(String(url)); return delegation(0.1); } });
  assert.equal(result.launched, false);
  assert.deepEqual(urls, ["https://openrouter.ai/api/alpha/decisions"]);
});
