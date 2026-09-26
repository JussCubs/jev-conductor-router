import { assessDelegation, assessTask, type Assessment } from "./jev.js";
import { selectRoute, type Connection, type Policy } from "./router.js";
import type { RoutingEvidence } from "./learning.js";

type JevOptions = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number };
export interface PlanInput extends JevOptions {
  task: string;
  delegation?: string;
  agent?: string;
  model?: string;
  effort?: string;
  connections?: Connection[];
  policy?: Policy;
  evidence?: RoutingEvidence[];
  now?: number;
}

export function explicitDelegation() {
  return { useConductor: true, source: "explicit" as const, provider: null, reason: "Explicit user request for Conductor." };
}

export function explicitAssessment(): Assessment {
  return { level: 2, label: "explicit", source: "explicit", confidence: null, provider: null, reason: "Explicit model override." };
}

export async function planLaunch(input: PlanInput) {
  if (!input.task.trim()) throw new Error("A task is required");
  const delegationMode = input.delegation ?? "auto";
  if (!["auto", "conductor"].includes(delegationMode)) throw new Error("delegation must be auto or conductor");
  const delegation = delegationMode === "conductor" ? explicitDelegation() : await assessDelegation(input.task, input);
  if (!delegation.useConductor) return { create: false as const, delegation, assessment: null, route: null };
  const assessment = input.model ? explicitAssessment() : await assessTask(input.task, input);
  const route = input.connections && input.policy
    ? selectRoute({ policy: input.policy, connections: input.connections, evidence: input.evidence, difficulty: assessment.level,
      agent: input.agent, model: input.model, effort: input.effort, now: input.now })
    : null;
  return { create: true as const, delegation, assessment, route };
}

export async function previewTask(input: PlanInput) {
  if (!input.task.trim()) throw new Error("A task is required");
  const delegationMode = input.delegation ?? "auto";
  if (!["auto", "conductor"].includes(delegationMode)) throw new Error("delegation must be auto or conductor");
  const delegation = delegationMode === "conductor" ? explicitDelegation() : await assessDelegation(input.task, input);
  const assessment = input.model ? explicitAssessment() : await assessTask(input.task, input);
  let route = null;
  let routeError: string | null = null;
  if (delegation.useConductor && input.connections && input.policy) {
    try {
      route = selectRoute({ policy: input.policy, connections: input.connections, evidence: input.evidence, difficulty: assessment.level,
        agent: input.agent, model: input.model, effort: input.effort, now: input.now });
    } catch (error) {
      routeError = error instanceof Error ? error.message : "No route";
    }
  }
  return { launched: false as const, wouldLaunch: delegation.useConductor, delegation, assessment, route, routeError, fastMode: false as const };
}
