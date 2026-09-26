import assert from "node:assert/strict";
import test from "node:test";
import { ConductorClient, transcriptQuery, workspacePayload } from "../src/conductor.js";
import { createConductorWorkspace } from "../src/actions.js";

const sleep = async () => {};

test("workspace env rejects secrets and launches always send fastMode false", () => {
  assert.throws(() => workspacePayload({ projectId: "p", agent: "cursor", message: "task", env: { OPENAI_API_KEY: "sk-test" } }, {}), /secret-like/);
  assert.throws(() => workspacePayload({ projectId: "p", message: "task", env: { NOTE: "conductor-secret" } }, { CONDUCTOR_API_KEY: "conductor-secret" }), /secret-like/);
  const body = workspacePayload({ projectId: "p", agent: "cursor", model: "composer-2.5", message: "task", env: { COLOR: "blue" } });
  assert.equal(body.fastMode, false);
  assert.equal((body.env as { COLOR: string }).COLOR, "blue");
  assert.equal("effort" in body, false);
});

test("create workspace posts the public shape and does not retry a lost create", async () => {
  const calls: { url: string; body?: any; authorization?: string }[] = [];
  await assert.rejects(createConductorWorkspace({
    task: "Implement the bounded feature", projectId: "project-1", delegation: "conductor", agent: "cursor", model: "composer-2.5",
    env: { OPENROUTER_API_KEY: "fixture", CONDUCTOR_API_KEY: "conductor-secret" },
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("authorization") ?? undefined });
      if (String(url).includes("conductor.build")) throw new Error("socket hang up");
      return Response.json({ answers: { difficulty: { type: "choice", choice: "standard", probabilities: { standard: 1 }, confidence: 0.9 } } });
    },
  }), /not retried/);
  assert.equal(calls.filter((call) => call.url.includes("conductor.build")).length, 1);
  const launch = calls.find((call) => call.url.endsWith("/v0/workspaces"));
  assert.equal(launch?.authorization, "Bearer conductor-secret");
  assert.equal(launch?.body.fastMode, false);
  assert.equal(launch?.body.projectId, "project-1");
  assert.equal(launch?.body.agent, "cursor");
  assert.equal(launch?.body.model, "composer-2.5");
  assert.equal(launch?.body.message, "Implement the bounded feature");
  assert.equal("env" in (launch?.body ?? {}), false);
});

test("rate limits honor retry-after and idempotent reads retry server errors", async () => {
  const waits: number[] = [];
  let projects = 0;
  const client = new ConductorClient({ apiKey: "conductor-secret", sleep: async (ms) => { waits.push(ms); }, fetch: async (url) => {
    if (String(url).includes("/v0/projects")) {
      projects += 1;
      if (projects === 1) return new Response("slow", { status: 429, headers: { "retry-after": "2" } });
      return Response.json({ data: [{ id: "p", name: "Demo", gitRemote: "https://github.com/example/demo" }], offset: 0, hasMore: false });
    }
    return new Response("down", { status: 503 });
  } });
  const listed = await client.listProjects({ limit: 5, offset: 0 });
  assert.equal(listed.data[0].id, "p");
  assert.deepEqual(waits, [2000]);
  let statusCalls = 0;
  const flaky = new ConductorClient({ apiKey: "conductor-secret", sleep, fetch: async () => {
    statusCalls += 1;
    if (statusCalls < 3) return new Response(JSON.stringify({ code: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    return Response.json({ workspaceId: "w", sessionId: "s", status: "working", updatedAt: "2026-09-26T00:00:00Z" });
  } });
  assert.equal((await flaky.sessionStatus("session-1")).status, "working");
  assert.equal(statusCalls, 3);
  let created = 0;
  const once = new ConductorClient({ apiKey: "conductor-secret", sleep, fetch: async () => { created += 1; return new Response(JSON.stringify({ userMessage: "unknown model" }), { status: 400, headers: { "content-type": "application/json" } }); } });
  await assert.rejects(once.createWorkspace(workspacePayload({ projectId: "p", agent: "codex", model: "gpt-6-luna", message: "task" })), /unknown model/);
  assert.equal(created, 1);
});

test("archive requires confirmation and transcripts stay on the public view", async () => {
  let archived = 0;
  const client = new ConductorClient({ apiKey: "conductor-secret", sleep, fetch: async (url, init) => {
    archived += 1;
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, undefined);
    assert.match(String(url), /\/v0\/workspaces\/ws-1\/archive$/);
    return Response.json({ workspaceId: "ws-1", status: "archived" });
  } });
  await assert.rejects(client.archiveWorkspace("ws-1", false), /confirmedByUser/);
  assert.equal(archived, 0);
  assert.equal((await client.archiveWorkspace("ws-1", true)).status, "archived");
  assert.throws(() => transcriptQuery("bad id"), /sessionId/);
  assert.throws(() => transcriptQuery(undefined, "SELECT 1; SELECT 2"), /single statement/);
  assert.throws(() => transcriptQuery(undefined, "SELECT set_config('x','y') FROM session_transcripts_view"), /set_config/);
  assert.match(transcriptQuery("session_1"), /session_transcripts_view/);
  const queryClient = new ConductorClient({ apiKey: "conductor-secret", sleep, fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { query: transcriptQuery("session_1") });
    return Response.json({ rows: [], rowCount: 0, truncated: false });
  } });
  assert.equal((await queryClient.sql(transcriptQuery("session_1"))).rowCount, 0);
});

test("session create and message bodies match the public API", async () => {
  const bodies: any[] = [];
  const client = new ConductorClient({ apiKey: "conductor-secret", sleep, fetch: async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith("/v0/sessions")) return Response.json({ id: "session-1", deepLink: "conductor://session-1" });
    return Response.json({ messageId: "m1", state: "queued", deepLink: "conductor://session-1" });
  } });
  await client.startSession({ workspaceId: "ws-1", agent: "claude", model: "fable-5-1", effort: "high", message: "continue", fastMode: false });
  await client.sendMessage("session/1", "next step");
  assert.deepEqual(bodies[0].body, { workspaceId: "ws-1", agent: "claude", fastMode: false, model: "fable-5-1", effort: "high", message: "continue" });
  assert.equal(bodies[1].url.endsWith("/v0/sessions/session%2F1/messages"), true);
  assert.deepEqual(bodies[1].body, { message: "next step" });
});
