import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "./reasoning-effort";

export const SUBAGENT_POOL_TYPES = ["explore", "plan", "search", "review", "general"] as const;
export type SubagentPoolType = (typeof SUBAGENT_POOL_TYPES)[number];

export interface SubagentModelUse {
	model: string;
	purpose?: string;
	/** A fixed configuration tier for newly created subagents; absent means inherit. */
	reasoningEffort?: ReasoningEffort;
}

export type SubagentModelPools = Record<string, SubagentModelUse[]>;
export type SubagentAllowedModels = Pick<
	Record<SubagentPoolType, string[]>,
	"explore" | "plan" | "general"
> &
	Partial<Pick<Record<SubagentPoolType, string[]>, "search" | "review">>;
export type SubagentModelReasoningEfforts = Partial<
	Record<SubagentPoolType, Record<string, ReasoningEffort>>
>;

export const MAX_SUBAGENT_MODEL_REFERENCE_LENGTH = 200;
export const MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL = 50;

/** Tolerant reads must not turn corrupt optional metadata into a model restriction. */
export function isSubagentReasoningEffort(value: unknown): value is ReasoningEffort {
	return (
		typeof value === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
	);
}
