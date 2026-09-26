import assert from "node:assert/strict";
import test from "node:test";
import { assessTask, assessDelegation, askJev, CONDUCTOR_GATE_THRESHOLD } from "../src/jev.js";
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
test("uncertainty and malformed answers use a bounded fallback", async () => {
  for (const response of [Response.json({}), Response.json({ answers: { difficulty: { type: "choice", choice: "routine", probabilities: { routine: 0.2 }, confidence: 0.2 } } })]) {
    const r = await assessTask("Task", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => response });
    assert.equal(r.level, 1); assert.equal(r.source, "bounded_fallback");
  }
});
test("missing keys and unknown providers fail clearly before network access", async () => {
  await assert.rejects(assessTask("Task", { env: {} }), /No Jev provider key configured/);
  await assert.rejects(assessTask("Task", { env: { JEV_PROVIDER: "openrouter" } }), /Missing OPENROUTER_API_KEY/);
  await assert.rejects(assessTask("Task", { env: { JEV_PROVIDER: "unknown" } }), /must be orbio, openrouter, or typesafe/);
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
const choice = (name: string, probability = 1) => Response.json({ answers: { [name]: { type: "choice", choice: name === "delegation" ? "conductor" : "standard", probabilities: { [name === "delegation" ? "conductor" : "standard"]: probability }, confidence: 0.9 } } });
test("default chain is orbio, then openrouter, then typesafe", async () => {
  const urls: string[] = [];
  const result = await assessTask("Task", { env: { ORBIO_API_KEY: "a", OPENROUTER_API_KEY: "b", TYPESAFE_API_KEY: "c", JEV_MODEL: "typesafe/jev-1.13" },
    fetch: async (url, init) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body));
      if (urls.length === 1) assert.equal(body.model, "typesafe/jev-1.13");
      if (urls.length === 3) assert.equal(body.model, "jev-1.13.0");
      return urls.length < 3 ? new Response("busy", { status: urls.length === 2 ? 503 : 429 }) : choice("difficulty");
    } });
  assert.deepEqual(urls, ["https://api.orbio.so/api/alpha/decisions", "https://openrouter.ai/api/alpha/decisions", "https://api.typesafe.ai/v1/systemone"]);
  assert.equal(result.provider, "typesafe");
});
test("explicit fallback does not insert an unused configured provider", async () => {
  const urls: string[] = [];
  await assessTask("Task", { env: { JEV_PROVIDER: "openrouter", JEV_FALLBACK_PROVIDER: "typesafe", ORBIO_API_KEY: "a", OPENROUTER_API_KEY: "b", TYPESAFE_API_KEY: "c" },
    fetch: async (url) => { urls.push(String(url)); return urls.length === 1 ? new Response("later", { status: 408 }) : choice("difficulty"); } });
  assert.deepEqual(urls, ["https://openrouter.ai/api/alpha/decisions", "https://api.typesafe.ai/v1/systemone"]);
});
test("client errors are surfaced instead of falling back", async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    await assert.rejects(assessTask("Task", { env: { ORBIO_API_KEY: "a", OPENROUTER_API_KEY: "b" },
      fetch: async () => { calls += 1; return new Response("no", { status }); } }), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
});
test("payment, timeout and rate-limit failures try the next configured provider", async () => {
  let calls = 0;
  const result = await assessDelegation("Task", { env: { ORBIO_BASE_URL: "https://jev.example.test/api/alpha/decisions", ORBIO_API_KEY: "a", OPENROUTER_API_KEY: "b" },
    fetch: async (url) => {
      calls += 1;
      if (calls === 1) { assert.equal(String(url), "https://jev.example.test/api/alpha/decisions"); return new Response("pay", { status: 402 }); }
      throw new DOMException("timed out", "TimeoutError");
    } });
  assert.equal(calls, 2);
  assert.equal(result.useConductor, false);
});
test("gate threshold is 0.65 and a custom score question is sent through", async () => {
  assert.equal(CONDUCTOR_GATE_THRESHOLD, 0.65);
  const below = await assessDelegation("Task", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => Response.json({ answers: {
    delegation: { type: "choice", choice: "conductor", probabilities: { conductor: 0.649 }, confidence: 0.4 },
  } }) });
  assert.equal(below.useConductor, false);
  const above = await assessDelegation("Task", { env: { OPENROUTER_API_KEY: "fixture" }, fetch: async () => Response.json({ answers: {
    delegation: { type: "choice", choice: "conductor", probabilities: { conductor: 0.65 }, confidence: 0.4 },
  } }) });
  assert.equal(above.useConductor, true);
  let sent: any;
  const scored = await askJev("Task", { risk: { type: "score", instructions: "Rank risk.", criteria: ["low", "high"] } }, { env: { ORBIO_API_KEY: "fixture" },
    fetch: async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ answers: { risk: { score: 0.2, legend: ["low", "high"] } } }); } });
  assert.deepEqual(sent.questions.risk.criteria, ["low", "high"]);
  assert.equal((scored?.answers.risk as { score: number }).score, 0.2);
});
