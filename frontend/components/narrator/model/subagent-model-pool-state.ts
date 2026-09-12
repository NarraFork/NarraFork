import type { ReasoningEffort } from "@shared/reasoning-effort";
import type {
	SubagentModelPools,
	SubagentModelReasoningEfforts,
	SubagentPoolType,
} from "@shared/subagent-model-policy";

/** Only a user's selection edit removes a declaration; untouched explicit [] survives. */
export function selectPoolModels(
	pools: SubagentModelPools,
	type: string,
	models: string[],
): SubagentModelPools {
	const next = { ...pools };
	if (models.length === 0) {
		delete next[type];
	} else {
		const existing = new Map((pools[type] ?? []).map((entry) => [entry.model, entry]));
		next[type] = models.map((model) => existing.get(model) ?? { model });
	}
	return next;
}

/** Patch one field without rebuilding other metadata or hidden pool types. */
export function updatePoolModel(
	pools: SubagentModelPools,
	type: string,
	model: string,
	patch: { purpose?: string; reasoningEffort?: ReasoningEffort },
): SubagentModelPools {
	return {
		...pools,
		[type]: (pools[type] ?? []).map((entry) => {
			if (entry.model !== model) return entry;
			const next = { ...entry, ...patch };
			if ("purpose" in patch && !patch.purpose) delete next.purpose;
			if ("reasoningEffort" in patch && patch.reasoningEffort === undefined) {
				delete next.reasoningEffort;
			}
			return next;
		}),
	};
}

export function setPoolReasoningEffort(
	efforts: SubagentModelReasoningEfforts,
	type: SubagentPoolType,
	model: string,
	effort: ReasoningEffort | undefined,
): SubagentModelReasoningEfforts {
	const entries = { ...efforts[type] };
	if (effort === undefined) delete entries[model];
	else entries[model] = effort;
	const next = { ...efforts };
	if (Object.keys(entries).length) next[type] = entries;
	else delete next[type];
	return next;
}

/** Never prune by catalog visibility: only explicit removals in this type count. */
export function removeDeselectedPoolEfforts(
	efforts: SubagentModelReasoningEfforts,
	type: SubagentPoolType,
	previous: string[],
	selected: string[],
): SubagentModelReasoningEfforts {
	const retained = new Set(selected);
	let next = efforts;
	for (const model of previous) {
		if (!retained.has(model) && Object.hasOwn(next[type] ?? {}, model)) {
			next = setPoolReasoningEffort(next, type, model, undefined);
		}
	}
	return next;
}
