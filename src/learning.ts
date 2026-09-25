/** Outcome learning is a bounded tie-breaker, never a capability or quota bypass.
 * Transport completion and reviewer-confirmed task quality are separate labels. */
export interface RoutingLearningPolicy {
  enabled: boolean;
  halfLifeDays: number;
  minSamples: number;
  maxAdjustment: number;
}
export const DEFAULT_ROUTING_LEARNING: RoutingLearningPolicy = {
  enabled: true, halfLifeDays: 30, minSamples: 5, maxAdjustment: 12,
};
export interface RoutingEvidence {
  agent: string; model: string; effort: string; difficulty: number;
  reliability: boolean | null; reliabilityAt: string | null;
  quality: boolean | null; qualityAt: string | null;
}
export function learnedRouteScore(input: {
  agent: string; model: string; effort: string; difficulty: number;
  evidence: RoutingEvidence[]; policy: RoutingLearningPolicy; now?: number;
}) {
  const now = input.now ?? Date.now();
  let reliabilitySamples = 0, reliabilityWins = 0, qualitySamples = 0, qualityWins = 0;
  const weight = (at: string | null) => {
    const time = Date.parse(at ?? "");
    return Number.isFinite(time) && time <= now ? 2 ** (-(now - time) / (input.policy.halfLifeDays * 86400_000)) : 0;
  };
  for (const row of input.evidence) {
    if (row.agent !== input.agent || row.model !== input.model || row.effort !== input.effort || row.difficulty !== input.difficulty) continue;
    if (typeof row.reliability === "boolean") { const w = weight(row.reliabilityAt); reliabilitySamples += w; reliabilityWins += row.reliability ? w : 0; }
    if (typeof row.quality === "boolean") { const w = weight(row.qualityAt); qualitySamples += w; qualityWins += row.quality ? w : 0; }
  }
  // Beta(4,1) prior prevents tiny samples from dominating. Old evidence loses
  // influence, allowing provider/model improvements to recover their ranking.
  const reliability = (4 + reliabilityWins) / (5 + reliabilitySamples);
  const quality = (4 + qualityWins) / (5 + qualitySamples);
  const adjustment = !input.policy.enabled ? 0 : Math.max(-input.policy.maxAdjustment, Math.min(input.policy.maxAdjustment,
    (reliabilitySamples >= input.policy.minSamples ? (reliability - 0.8) * 15 : 0)
    + (qualitySamples >= input.policy.minSamples ? (quality - 0.8) * 30 : 0)));
  return { adjustment, reliabilitySamples, qualitySamples, reliability, quality };
}
