import {
	isSubagentReasoningEffort,
	MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL,
	MAX_SUBAGENT_MODEL_REFERENCE_LENGTH,
	SUBAGENT_POOL_TYPES,
	type SubagentModelReasoningEfforts,
	type SubagentModelUse,
} from "@shared/subagent-model-policy";
import { z } from "zod";
import { ValidationError } from "../errors";

const reasoningEffortSchema = z.custom<NonNullable<SubagentModelUse["reasoningEffort"]>>(
	isSubagentReasoningEffort,
	"Invalid subagent reasoning effort",
);

const poolReasoningEffortsSchema = z
	.record(z.string().min(1).max(MAX_SUBAGENT_MODEL_REFERENCE_LENGTH), reasoningEffortSchema)
	.refine((pool) => Object.keys(pool).length <= MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL, {
		message: `At most ${MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL} fixed reasoning efforts per pool`,
	});

export const subagentModelReasoningEffortsSchema: z.ZodType<SubagentModelReasoningEfforts> =
	z.partialRecord(z.enum(SUBAGENT_POOL_TYPES), poolReasoningEffortsSchema);

export function validateSubagentModelReasoningEffortsInput(
	input: unknown,
): SubagentModelReasoningEfforts {
	const parsed = subagentModelReasoningEffortsSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

/** Validate only new metadata; leave legacy model/purpose normalization unchanged. */
export function validateSubagentModelRestrictionInput(input: unknown): void {
	const rawPools = input && typeof input === "object" && "pools" in input ? input.pools : input;
	if (!rawPools || typeof rawPools !== "object" || Array.isArray(rawPools)) return;
	for (const [pool, entries] of Object.entries(rawPools)) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (
				entry &&
				typeof entry === "object" &&
				"reasoningEffort" in entry &&
				!isSubagentReasoningEffort(entry.reasoningEffort)
			) {
				throw new ValidationError(`Invalid subagent reasoning effort in pool "${pool}"`);
			}
		}
	}
}
