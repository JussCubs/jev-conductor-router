import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { catalogConnections, clearCatalogCache, fetchModelCatalog, parseListModels, parseOpenApiCatalog, policyForCatalog } from "../src/catalog.js";
import { planLaunch, previewTask } from "../src/gate.js";
import { builtinQuestions } from "../src/jev.js";
import { loadDefaultPolicy, DEFAULT_POLICY_PATH } from "../src/policy.js";
import { DIFFICULTIES } from "../src/jev.js";

// Shape returned by Conductor's hosted MCP list_models tool (trimmed).
const listModels = (overrides: Record<string, Partial<{ configured: boolean; models: string[]; efforts: string[] }>> = {}) => ({
  agents: [
    { agent: "claude", configured: true, models: ["fable-5-1", "fable-5", "opus-5-5-1m", "opus-5-1m", "sonnet-5-1m", "haiku-4-5"], efforts: ["low", "medium", "high", "xhigh", "max"], defaultModel: "opus-5-1m", defaultEffort: "high" },
    { agent: "codex", configured: true, models: ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"], efforts: ["none", "low", "medium", "high", "xhigh", "max", "ultra"], defaultModel: "gpt-5.6-sol", defaultEffort: "high" },
    { agent: "cursor", configured: true, models: ["auto", "composer-2.5", "grok-4.7"], efforts: ["low", "medium", "high", "xhigh"], defaultModel: "composer-2.5", defaultEffort: "high" },
  ].map((row) => ({ ...row, ...(overrides[row.agent] ?? {}) })),
});
const openApi = { paths: { "/v0/workspaces": { post: { description: "Creates a workspace. Accepted model ids by agent \u2014 claude: fable-5-1, opus-5-5-1m, sonnet-5-1m; codex: gpt-6-astra, gpt-6-sol, gpt-6-luna; cursor: auto, composer-2.5, grok-4.7. Accepted effort levels by agent \u2014 claude: low, medium, high, xhigh, max; codex: none, low, medium, high, xhigh, max, ultra; cursor: low, medium, high, xhigh; codex max and ultra require support." } } } };

type Handler = (url: string, body: any) => Response | Promise<Response>;
function jevAndConductor(tier: string, conductor: Handler, delegation = 0.97) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (href.includes("conductor.build")) return conductor(href, body);
    if (body?.questions?.delegation) return Response.json({ answers: { delegation: { type: "choice", choice: "conductor", probabilities: { conductor: delegation, direct: 1 - delegation }, confidence: 0.9 } } });
    const probabilities = Object.fromEntries(DIFFICULTIES.map((label) => [label, label === tier ? 1 : 0]));
    return Response.json({ answers: { difficulty: { type: "choice", choice: tier, probabilities, confidence: 0.9 } } });
  }) as typeof fetch;
  return { fetch, calls };
}
const mcpResult = (payload: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
const env = { ORBIO_API_KEY: "fixture", CONDUCTOR_API_KEY: "conductor-fixture" };

beforeEach(() => clearCatalogCache());

test("the default policy resolves from the package, not the working directory", async () => {
  assert.match(DEFAULT_POLICY_PATH, /examples[\\/]policy\.json$/);
  const cwd = process.cwd();
  process.chdir("/");
  try { assert.ok((await loadDefaultPolicy()).models.length > 0); } finally { process.chdir(cwd); }
});

test("every Jev difficulty label maps onto a policy capability tier", async () => {
  const policy = await loadDefaultPolicy();
  for (let level = 0; level < DIFFICULTIES.length; level++) {
    assert.ok(policy.models.some((m) => m.capability >= level), `no model for ${DIFFICULTIES[level]}`);
  }
  assert.deepEqual(Object.keys(builtinQuestions("difficulty").difficulty.criteria as Record<string, string>), [...DIFFICULTIES]);
});

test("conductor_route returns a populated route for each tier from Conductor's live catalog", async () => {
  const expected: Record<string, { agent: string; model: string; effort: string | undefined }> = {
    routine: { agent: "codex", model: "gpt-6-luna", effort: "low" },
    standard: { agent: "codex", model: "gpt-6-luna", effort: "high" },
    complex: { agent: "codex", model: "gpt-6-sol", effort: "xhigh" },
    frontier: { agent: "codex", model: "gpt-6-astra", effort: "max" },
  };
  for (const tier of DIFFICULTIES) {
    clearCatalogCache();
    let bodySeen: any;
    const { fetch } = jevAndConductor(tier, (url, body) => { bodySeen = body; assert.equal(url, "https://api.conductor.build/mcp"); return mcpResult(listModels()); });
    const preview = await previewTask({ task: `A ${tier} task`, env, fetch });
    assert.equal(bodySeen.params.name, "list_models");
    assert.equal(preview.wouldLaunch, true);
    assert.equal(preview.assessment.label, tier);
    assert.equal(preview.routeError, null, `${tier}: ${preview.routeError}`);
    assert.ok(preview.route, `${tier} route`);
    assert.deepEqual({ agent: preview.route!.agent, model: preview.route!.model, effort: preview.route!.effort }, expected[tier]);
    assert.equal(preview.availability?.source, "conductor_list_models");
  }
});

test("harnesses Conductor reports as not configured are never routed", async () => {
  const { fetch } = jevAndConductor("complex", () => mcpResult(listModels({ codex: { configured: false } })));
  const preview = await previewTask({ task: "Multi-file refactor", env, fetch });
  assert.equal(preview.route?.agent, "claude");
  assert.equal(preview.route?.model, "opus-5-5-1m");
  assert.equal(preview.route?.effort, "xhigh");
  assert.ok(preview.route!.candidates.every((c) => c.agent !== "codex"));
});

test("models and efforts come from the catalog, not from the policy file", async () => {
  const { fetch } = jevAndConductor("frontier", () => mcpResult(listModels({ codex: { models: ["gpt-6-sol", "gpt-6-luna"], efforts: ["low", "medium", "high"] } })));
  const preview = await previewTask({ task: "Novel architecture", env, fetch });
  // gpt-6-astra is in the policy but Conductor no longer lists it.
  assert.equal(preview.route?.agent, "claude");
  assert.equal(preview.route?.model, "fable-5-1");
  const catalog = await fetchModelCatalog({ env, fetch: (async () => mcpResult(listModels({ codex: { efforts: ["low", "medium", "high"] } }))) as typeof fetch, maxAgeMs: 0 });
  const tuned = policyForCatalog(await loadDefaultPolicy(), catalog);
  assert.deepEqual(tuned.models.find((m) => m.model === "gpt-6-astra")?.efforts, ["low", "medium", "high"]);
});

test("an explicit model Conductor accepts but the policy has not ranked still routes", async () => {
  const { fetch } = jevAndConductor("standard", () => mcpResult(listModels()));
  const preview = await previewTask({ task: "Use gpt-5.5", model: "gpt-5.5", env, fetch });
  assert.equal(preview.route?.agent, "codex");
  assert.equal(preview.route?.model, "gpt-5.5");
});

test("a failed catalog yields routeError, never a silent null route", async () => {
  const unauthorized = jevAndConductor("complex", () => Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }, { status: 401 }));
  const rejected = await previewTask({ task: "Refactor", env, fetch: unauthorized.fetch });
  assert.equal(rejected.route, null);
  assert.match(rejected.routeError ?? "", /CONDUCTOR_API_KEY/);
  const missing = await previewTask({ task: "Refactor", env: { ORBIO_API_KEY: "fixture" }, fetch: jevAndConductor("complex", () => mcpResult(listModels())).fetch });
  assert.equal(missing.route, null);
  assert.match(missing.routeError ?? "", /CONDUCTOR_API_KEY is required/);
  const none = await previewTask({ task: "Refactor", env, fetch: jevAndConductor("complex", () => mcpResult(listModels({ claude: { configured: false }, codex: { configured: false }, cursor: { configured: false } }))).fetch });
  assert.equal(none.route, null);
  assert.match(none.routeError ?? "", /no configured/);
  const disabled = await previewTask({ task: "Refactor", env, discover: false, fetch: jevAndConductor("complex", () => mcpResult(listModels())).fetch });
  assert.match(disabled.routeError ?? "", /discovery is disabled/);
});

test("list_models outages fall back to the public OpenAPI model list with a warning", async () => {
  const { fetch } = jevAndConductor("complex", (url) => url.endsWith("/v0/openapi.json") ? Response.json(openApi) : new Response("down", { status: 503 }));
  const preview = await previewTask({ task: "Refactor", env, fetch });
  assert.equal(preview.route?.model, "gpt-6-sol");
  assert.equal(preview.availability?.source, "conductor_openapi");
  assert.match(preview.availability?.warning ?? "", /cannot say which agents/);
});

test("list_models event-stream responses are parsed", async () => {
  const payload = listModels();
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`;
  const catalog = await fetchModelCatalog({ env, maxAgeMs: 0, fetch: (async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  assert.equal(catalogConnections(catalog).length, 3);
  assert.deepEqual(parseOpenApiCatalog(openApi).map((row) => row.agent), ["claude", "codex", "cursor"]);
  assert.throws(() => parseListModels({ agents: [] }), /no agents/);
});

test("launch planning explains a missing route and keeps explicit harnesses", async () => {
  const down = () => new Response("down", { status: 503 });
  await assert.rejects(planLaunch({ task: "Refactor", env, fetch: jevAndConductor("complex", down).fetch }), /No route: Could not read available models/);
  const explicit = await planLaunch({ task: "Refactor", agent: "claude", env, fetch: jevAndConductor("complex", down).fetch });
  assert.equal(explicit.create, true);
  assert.equal(explicit.route, null);
  assert.match(explicit.routeError ?? "", /Could not read available models/);
  const routed = await planLaunch({ task: "Refactor", env, fetch: jevAndConductor("complex", () => mcpResult(listModels())).fetch });
  assert.equal(routed.route?.model, "gpt-6-sol");
});

test("a blocked gate does not read the Conductor catalog", async () => {
  const { fetch, calls } = jevAndConductor("complex", () => mcpResult(listModels()), 0.2);
  const plan = await planLaunch({ task: "Explain this", env, fetch });
  assert.equal(plan.create, false);
  assert.ok(calls.every((url) => !url.includes("conductor.build")));
});

test("the delegation prompt keeps trivial edits direct", () => {
  const question = builtinQuestions("delegation").delegation;
  assert.match(question.instructions, /Default to direct/);
  assert.match(question.instructions, /typo and spelling fixes/);
  assert.doesNotMatch(question.instructions, /including small edits that need a PR/);
  assert.match((question.criteria as Record<string, string>).direct, /typo/);
});
