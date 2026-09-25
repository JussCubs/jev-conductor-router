import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { selectRoute, validatePolicy, quotaState, type Connection } from "../src/router.js";
import { learnedRouteScore } from "../src/learning.js";
import { observeRun, readRuns, updateRuns, type Run } from "../src/store.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const policy = validatePolicy(JSON.parse(readFileSync(new URL("../examples/policy.json", import.meta.url), "utf8")));
const now = Date.parse("2026-09-25T18:00:00Z");
function connections(): Connection[] {
  return (["codex", "cursor", "claude"] as const).map((agent) => ({ agent, accountFingerprint: "a".repeat(64), authKind: "subscription", enabled: true,
    models: policy.models.filter((m) => m.agent === agent).map((m) => m.model), observedAt: new Date(now).toISOString(),
    windows: [{ usedPercent: 20, resetsAt: new Date(now + 86400_000).toISOString() }], quotaError: null }));
}
test("capability floor wins over abundant quota on a weaker harness", () => {
  const c = connections(); c[0].windows[0].usedPercent = 95; c[2].enabled = false;
  const r = selectRoute({ difficulty: 3, connections: c, policy, now });
  assert.equal(r.model, "gpt-6-astra"); assert.equal(r.fastMode, false); assert.equal(r.effort, "max");
});
test("eligible peers use headroom then stable configured preference", () => {
  const c = connections(); c[0].windows[0].usedPercent = 95; c[2].enabled = false;
  assert.equal(selectRoute({ difficulty: 2, connections: c, policy, now }).model, "grok-4.7");
  assert.equal(selectRoute({ difficulty: 1, connections: connections(), policy, now }).model, "gpt-6-luna");
});
test("stale unknown quota is not full and known exhaustion stays blocked until reset", () => {
  const c = connections()[0]; c.observedAt = "2000-01-01";
  assert.equal(quotaState(c, policy, now).remainingPercent, null);
  c.windows[0].usedPercent = 100;
  assert.equal(quotaState(c, policy, now).state, "exhausted");
  c.windows[0].resetsAt = new Date(now - 1).toISOString();
  assert.equal(quotaState(c, policy, now).state, "unknown");
});
test("explicit models and effort are preserved or rejected, never substituted", () => {
  const c = connections();
  assert.equal(selectRoute({ difficulty: 3, connections: c, policy, now, model: "gpt-6-luna", effort: "low" }).model, "gpt-6-luna");
  assert.throws(() => selectRoute({ difficulty: 0, connections: c, policy, now, model: "grok-4.7", effort: "ultra" }));
  c[0].windows[0].usedPercent = 100;
  assert.throws(() => selectRoute({ difficulty: 0, connections: c, policy, now, model: "gpt-6-luna" }));
});
test("malformed snapshots and policies cannot turn invalid values into quota", () => {
  const c = connections(); c[0].windows[0].usedPercent = NaN;
  assert.throws(() => selectRoute({ difficulty: 1, connections: c, policy, now }));
  assert.throws(() => validatePolicy({ ...policy, learning: { ...policy.learning, maxAdjustment: 999 } }));
  assert.throws(() => selectRoute({ difficulty: 1, connections: [], policy, now }));
});
test("learning is bounded, contextual, decays, and keeps quality separate", () => {
  const identity = { agent: "codex", model: "gpt-6-sol", effort: "xhigh", difficulty: 2 };
  const evidence = Array.from({ length: 20 }, () => ({ ...identity, reliability: true, reliabilityAt: new Date(now).toISOString(), quality: false, qualityAt: new Date(now).toISOString() }));
  const r = learnedRouteScore({ ...identity, evidence, policy: policy.learning, now });
  assert.ok(r.adjustment < 0 && r.adjustment >= -12);
  assert.equal(learnedRouteScore({ ...identity, effort: "low", evidence, policy: policy.learning, now }).adjustment, 0);
  assert.equal(learnedRouteScore({ ...identity, evidence, policy: policy.learning, now: now + 365 * 86400_000 }).adjustment, 0);
  assert.equal(selectRoute({ difficulty: 2, connections: connections(), policy, now, evidence }).model, "opus-5-5-1m");
});
test("idle before working, cancellation and repeated polling do not manufacture successful tasks", async () => {
  const run: Run = { agent: "codex", model: "gpt-6-sol", effort: "xhigh", difficulty: 2, account: "test-owner", sessionId: "test-session",
    createdAt: new Date(now).toISOString(), seenWorking: false, reliability: null, reliabilityAt: null, quality: null, qualityAt: null, decision: {} };
  assert.equal(observeRun(run, "idle").reliability, null);
  assert.equal(observeRun(run, "cancelled").reliability, null);
  const done = observeRun(observeRun(run, "working"), "idle", new Date(now).toISOString());
  assert.equal(done.reliability, true); assert.equal(done.quality, null);
  assert.deepEqual(observeRun(done, "idle"), done);
  const directory = await mkdtemp(join(tmpdir(), "jev-router-test-"));
  try {
    const path = join(directory, "state.json");
    await updateRuns(path, () => [done]);
    assert.equal((await readRuns(path)).length, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
