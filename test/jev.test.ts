import assert from "node:assert/strict";
import test from "node:test";
import { assessTask, assessDelegation } from "../src/jev.js";
const answer = () => Response.json({ answers: { difficulty: { type: "choice", choice: "standard", probabilities: { standard: 0.99 }, confidence: 0.99 } } });
test("OpenRouter uses Decisions and TypeSafe uses its native System One contract", async () => {
  for (const provider of ["openrouter", "typesafe"]) {
    const result = await assessTask("Implement a bounded feature", { env: { JEV_PROVIDER: provider, OPENROUTER_API_KEY: "fixture-key", TYPESAFE_API_KEY: "fixture-key" },
      fetch: async (url, init) => {
        assert.equal(String(url), provider === "openrouter" ? "https://openrouter.ai/api/alpha/decisions" : "https://api.typesafe.ai/v1/systemone");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.questions.difficulty.type, "choice");
        assert.equal(Object.keys(body.questions.difficulty.criteria).length, 4);
        assert.ok(!body.messages); assert.equal(init?.redirect, "error"); return answer();
      } });
    assert.equal(result.level, 1); assert.equal(result.provider, provider);
  }
});
test("configured secondary handles transient provider failure", async () => {
  let calls = 0;
  const result = await assessTask("Task", { env: { JEV_PROVIDER: "openrouter", JEV_FALLBACK_PROVIDER: "typesafe", OPENROUTER_API_KEY: "fixture", TYPESAFE_API_KEY: "fixture" },
    fetch: async () => ++calls === 1 ? new Response("busy", { status: 429 }) : answer() });
  assert.equal(calls, 2); assert.equal(result.provider, "typesafe");
});
test("uncertainty, malformed answers and auth failures use a bounded fallback", async () => {
  for (const response of [new Response("unauthorized", { status: 401 }), Response.json({}), Response.json({ answers: { difficulty: { type: "choice", choice: "routine", probabilities: { routine: 0.2 }, confidence: 0.2 } } })]) {
    const r = await assessTask("Task", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => response });
    assert.equal(r.level, 1); assert.equal(r.source, "bounded_fallback");
  }
});
test("missing keys and unknown providers fail clearly before network access", async () => {
  await assert.rejects(assessTask("Task", { env: {} }), /Missing OPENROUTER_API_KEY/);
  await assert.rejects(assessTask("Task", { env: { JEV_PROVIDER: "unknown" } }), /must be openrouter or typesafe/);
});

test("routine-standard uncertainty cannot escalate to frontier", async () => {
  const r = await assessTask("Remove a phrase everywhere, run the build, open a PR", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => Response.json({ answers: {
    difficulty: { type: "choice", choice: "routine", probabilities: { routine: 0.54, standard: 0.45, complex: 0.01, frontier: 0 }, confidence: 0.37 },
  } }) });
  assert.equal(r.level, 1); assert.equal(r.source, "jev");
});
test("delegation distinguishes direct answers and coding work; failure never launches", async () => {
  for (const choice of ["direct", "conductor"]) {
    const r = await assessDelegation("Task", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => Response.json({ answers: {
      delegation: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 },
    } }) });
    assert.equal(r.useConductor, choice === "conductor");
  }
  assert.equal((await assessDelegation("Task", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => new Response("down", { status: 503 }) })).useConductor, false);
});
