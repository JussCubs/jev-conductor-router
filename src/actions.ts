import { accountKey } from "./account.js";
import { ConductorClient, sessionPayload, transcriptQuery, workspacePayload, type WorkspaceDraft } from "./conductor.js";
import { planLaunch, previewTask, type PlanInput } from "./gate.js";
import type { RoutingEvidence } from "./learning.js";
import { loadDefaultPolicy } from "./policy.js";
import { validateConnections, validatePolicy, type Connection, type Policy } from "./router.js";
import { readRuns, updateRuns, type Run } from "./store.js";

export interface LaunchInput extends PlanInput, Omit<WorkspaceDraft, "env"> {
  envVars?: Record<string, string>;
  statePath?: string;
  account?: string;
}

/** Validates caller-supplied routing inputs. When no connections snapshot is
 * passed, the gate detects configured harnesses and models from Conductor at
 * runtime (see catalog.ts), and only after the delegation gate passes. */
export async function resolveRouting(input: { connections?: unknown; policy?: unknown }): Promise<{ connections?: Connection[]; policy?: Policy }> {
  const policy = input.policy === undefined ? undefined : validatePolicy(input.policy);
  if (input.connections === undefined) return policy ? { policy } : {};
  return { connections: validateConnections(input.connections), policy: policy ?? await loadDefaultPolicy() };
}

export async function previewRoute(input: PlanInput) {
  return previewTask(input);
}

export async function createFromPlan(plan: Awaited<ReturnType<typeof planLaunch>>, input: LaunchInput, client: ConductorClient) {
  if (!plan.create) return { launched: false as const, delegation: plan.delegation, assessment: plan.assessment };
  const agent = plan.route?.agent ?? input.agent;
  const model = plan.route?.model ?? input.model;
  const effort = plan.route ? plan.route.effort : input.effort;
  if (!agent) throw new Error(`No route${plan.routeError ? `: ${plan.routeError}` : ""}. Pass agent and model explicitly to launch anyway.`);
  const payload = workspacePayload({
    projectId: input.projectId, repositoryUrl: input.repositoryUrl, branch: input.branch, name: input.name,
    sessionName: input.sessionName, agent, model, effort, message: input.task, env: input.envVars,
  }, input.env ?? process.env);
  const result = await client.createWorkspace(payload);
  let learningSaved = false;
  if (input.statePath && result?.sessionId) {
    try {
      let account = input.account;
      if (!account) {
        const identity = await client.me();
        if (!identity.userId || !identity.organizationId) throw new Error("Conductor identity is incomplete");
        account = accountKey(identity.organizationId, identity.userId);
      }
      const run: Run = {
        account, sessionId: result.sessionId, workspaceId: result.workspaceId, createdAt: new Date().toISOString(),
        agent, model: model ?? "", effort: effort ?? "default", difficulty: input.model ? -1 : plan.assessment?.level ?? 1,
        seenWorking: false, reliability: null, reliabilityAt: null, quality: null, qualityAt: null,
        decision: { delegation: plan.delegation, assessment: plan.assessment, route: plan.route },
      };
      await updateRuns(input.statePath, (rows) => rows.some((row) => row.account === account && row.sessionId === result.sessionId) ? rows : [...rows, run]);
      learningSaved = true;
    } catch { /* An accepted launch must not be reported as a failed mutation. */ }
  }
  return { launched: true as const, workspaceId: result.workspaceId, sessionId: result.sessionId, deepLink: result.deepLink,
    initialMessage: result.initialMessage, learningSaved, delegation: plan.delegation, assessment: plan.assessment,
    ...(plan.routeError ? { routeWarning: plan.routeError } : {}),
    ...(plan.route ?? {}), agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}), fastMode: false as const };
}

export async function createConductorWorkspace(input: LaunchInput, client?: ConductorClient) {
  workspacePayload({ ...input, message: input.task, env: input.envVars }, input.env ?? process.env);
  const plan = await planLaunch(input);
  const conductor = client ?? new ConductorClient({ env: input.env, fetch: input.fetch });
  return createFromPlan(plan, input, conductor);
}

export async function evidenceForAccount(statePath: string, account: string): Promise<RoutingEvidence[]> {
  return (await readRuns(statePath)).filter((row) => row.account === account);
}

export async function saveFeedback(input: { sessionId: string; success: boolean; statePath: string; client: ConductorClient; account?: string }) {
  let account = input.account;
  if (!account) {
    const identity = await input.client.me();
    if (!identity.userId || !identity.organizationId) throw new Error("Conductor identity is incomplete");
    account = accountKey(identity.organizationId, identity.userId);
  }
  const tracked = (await readRuns(input.statePath)).find((row) => row.account === account && row.sessionId === input.sessionId);
  if (!tracked) throw new Error("No tracked session belongs to this account");
  await updateRuns(input.statePath, (rows) => rows.map((row) => row.account === account && row.sessionId === input.sessionId
    ? { ...row, quality: input.success, qualityAt: row.qualityAt ?? new Date().toISOString() } : row));
  return { saved: true, sessionId: input.sessionId };
}

export { sessionPayload, transcriptQuery };
