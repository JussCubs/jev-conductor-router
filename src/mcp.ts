import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createConductorWorkspace, previewRoute, resolveRouting, saveFeedback } from "./actions.js";
import { accountKey } from "./account.js";
import { askJev, builtinQuestions, type JevQuestion } from "./jev.js";
import { ConductorClient, sessionPayload, transcriptQuery } from "./conductor.js";
import { readRuns } from "./store.js";
import { VERSION } from "./version.js";

const questionSchema = z.object({
  type: z.enum(["choice", "score", "noul"]),
  instructions: z.string().min(1),
  criteria: z.union([z.record(z.string()), z.array(z.string())]).optional(),
});

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function fail(error: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Request failed" }] };
}
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const mutating = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export function createMcpServer(env: NodeJS.ProcessEnv = process.env) {
  const server = new McpServer({ name: "jev-conductor-router", version: VERSION }, {
    instructions: "Use jev_decide or conductor_route before creating a Conductor workspace. conductor_create_workspace launches real cloud work only when Jev's conductor probability is at least 0.65, unless delegation is conductor because the user explicitly asked. Never put secrets in workspace env. Archive only when the user confirmed.",
  });
  const client = () => new ConductorClient({ env });
  const statePath = (path?: string) => path || ".jev-router-state.json";

  server.registerTool("jev_decide", {
    title: "Jev decide",
    description: "Ask Jev (choice, score, or noul) using the configured provider chain: orbio, then openrouter, then typesafe. Defaults to the delegation and difficulty questions. Does not launch a workspace.",
    inputSchema: { state: z.string().min(1), questions: z.record(questionSchema).optional() },
    annotations: readOnly,
  }, async ({ state, questions }) => {
    try {
      const asked = (questions ?? builtinQuestions()) as Record<string, JevQuestion>;
      const result = await askJev(state, asked, { env });
      if (!result) return ok({ available: false, reason: "Jev was unavailable or returned an invalid answer. No provider was silently used after an authentication error." });
      return ok({ available: true, provider: result.provider, model: result.model, answers: result.answers });
    } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_route", {
    title: "Preview a Conductor route",
    description: "Assess whether a task needs Conductor and which harness (agent), model, and effort would be used. Configured harnesses and accepted models are read from Conductor at runtime unless a connections snapshot is passed. Returns route, or routeError explaining why no route exists. This never launches a workspace.",
    inputSchema: {
      task: z.string().min(1),
      delegation: z.enum(["auto", "conductor"]).optional(),
      agent: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
      connections: z.array(z.unknown()).optional(), policy: z.unknown().optional(), statePath: z.string().optional(),
    },
    annotations: readOnly,
  }, async (input) => {
    try {
      const routing = await resolveRouting(input);
      let evidence;
      if (input.statePath && (env.CONDUCTOR_API_KEY || env.CONDUCTOR_API_TOKEN)) {
        const identity = await client().me();
        const userId = identity.userId;
        const organizationId = identity.organizationId;
        if (userId && organizationId) evidence = (await readRuns(input.statePath)).filter((row) => row.account === accountKey(organizationId, userId));
      }
      return ok(await previewRoute({ task: input.task, delegation: input.delegation, agent: input.agent, model: input.model, effort: input.effort, ...routing, evidence, env }));
    } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_create_workspace", {
    title: "Create a Conductor workspace",
    description: "Run the Jev gate first. Launch only when conductor probability is at least 0.65, or when delegation is conductor because the user explicitly asked. The harness, model and effort come from Conductor's live model catalog and the routing policy unless agent and model are passed. If difficulty classification fails, route at the standard tier. Never sends secrets in workspace env. Sends fastMode false.",
    inputSchema: {
      task: z.string().min(1),
      projectId: z.string().optional(), repositoryUrl: z.string().optional(), branch: z.string().optional(),
      name: z.string().optional(), sessionName: z.string().optional(),
      delegation: z.enum(["auto", "conductor"]).optional(),
      agent: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
      env: z.record(z.string()).optional(),
      connections: z.array(z.unknown()).optional(), policy: z.unknown().optional(), statePath: z.string().optional(),
    },
    annotations: mutating,
  }, async (input) => {
    try {
      const routing = await resolveRouting(input);
      const created = await createConductorWorkspace({
        task: input.task, projectId: input.projectId, repositoryUrl: input.repositoryUrl, branch: input.branch,
        name: input.name, sessionName: input.sessionName, delegation: input.delegation, agent: input.agent,
        model: input.model, effort: input.effort, envVars: input.env, statePath: statePath(input.statePath), env, ...routing,
      });
      return ok(created);
    } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_start_session", {
    title: "Start a Conductor session",
    description: "Start a session in an existing Conductor workspace. Sends fastMode false. Does not run the Jev gate again.",
    inputSchema: {
      workspaceId: z.string().min(1), agent: z.enum(["claude", "codex", "cursor", "acp"]),
      model: z.string().optional(), effort: z.string().optional(), message: z.string().optional(),
      name: z.string().optional(), sessionId: z.string().optional(), messageId: z.string().optional(),
    },
    annotations: mutating,
  }, async (input) => {
    try { return ok(await client().startSession(sessionPayload(input))); } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_send_message", {
    title: "Send a Conductor message",
    description: "Send a follow-up message to an existing Conductor session.",
    inputSchema: { sessionId: z.string().min(1), message: z.string().min(1), messageId: z.string().optional() },
    annotations: mutating,
  }, async ({ sessionId, message, messageId }) => {
    try { return ok(await client().sendMessage(sessionId, message, messageId)); } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_status", {
    title: "Conductor status",
    description: "Read session and/or workspace status. Operational status is not task-quality feedback.",
    inputSchema: { sessionId: z.string().optional(), workspaceId: z.string().optional() },
    annotations: readOnly,
  }, async ({ sessionId, workspaceId }) => {
    try {
      if (!sessionId && !workspaceId) throw new Error("Pass sessionId or workspaceId");
      const conductor = client();
      return ok({
        ...(sessionId ? { session: await conductor.sessionStatus(sessionId) } : {}),
        ...(workspaceId ? { workspace: await conductor.workspaceStatus(workspaceId) } : {}),
      });
    } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_transcript", {
    title: "Conductor transcript",
    description: "Read a session transcript through Conductor's read-only SQL view session_transcripts_view. Pass sessionId or a single SELECT.",
    inputSchema: { sessionId: z.string().optional(), query: z.string().optional() },
    annotations: readOnly,
  }, async ({ sessionId, query }) => {
    try { return ok(await client().sql(transcriptQuery(sessionId, query))); } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_list_projects", {
    title: "List Conductor projects",
    description: "List Conductor projects visible to the API key. Repositories must already be on the Conductor cloud machine.",
    inputSchema: { limit: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() },
    annotations: readOnly,
  }, async ({ limit, offset }) => {
    try { return ok(await client().listProjects({ limit, offset })); } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_cancel", {
    title: "Cancel or archive Conductor work",
    description: "Cancel a running session. Archiving a session or workspace is destructive and requires confirmedByUser true.",
    inputSchema: {
      sessionId: z.string().optional(), workspaceId: z.string().optional(),
      archive: z.boolean().optional(), confirmedByUser: z.boolean().optional(),
    },
    annotations: destructive,
  }, async ({ sessionId, workspaceId, archive, confirmedByUser }) => {
    try {
      const conductor = client();
      if (archive) {
        if (confirmedByUser !== true) throw new Error("Archiving requires confirmedByUser: true");
        if (workspaceId && !sessionId) return ok(await conductor.archiveWorkspace(workspaceId, true));
        if (!sessionId) throw new Error("Pass sessionId to archive a session, or workspaceId to archive a workspace");
        return ok(await conductor.archiveSession(sessionId, true));
      }
      if (!sessionId) throw new Error("Pass sessionId to cancel a session");
      return ok(await conductor.cancelSession(sessionId));
    } catch (error) { return fail(error); }
  });

  server.registerTool("conductor_feedback", {
    title: "Record task feedback",
    description: "Record an explicit human review of a tracked Conductor session. This does not infer success from the agent transcript.",
    inputSchema: { sessionId: z.string().min(1), success: z.boolean(), statePath: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ sessionId, success, statePath: path }) => {
    try { return ok(await saveFeedback({ sessionId, success, statePath: statePath(path), client: client() })); }
    catch (error) { return fail(error); }
  });

  return server;
}

export async function startMcpServer(env: NodeJS.ProcessEnv = process.env) {
  const server = createMcpServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on("end", () => { void server.close(); });
}
