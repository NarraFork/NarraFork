import { toolRegistry } from "./agent/tool-registry";
import { OPTIONAL_TOOLS, REVIEW_TOOLS } from "./agent/tools/index";
import type { ToolDefinition } from "./agent/types";
import { parseTraits } from "./narrator-utils";
import { getVisibleModels, resolveAllowedModelCandidate, settings } from "./settings";
import { expandAllowedPoolForDisplay } from "./settings/provider";

export const SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX = "custom-subagent-models:";
export const DISABLED_TOOLS_TRAIT_PREFIX = "custom-disabled-tools:";
export const BLOCKED_SKILLS_TRAIT_PREFIX = "custom-blocked-skills:";

const BUILTIN_SUBAGENT_POOL_KEYS = new Set(["explore", "plan", "search", "review", "general"]);
const MAX_MODEL_LENGTH = 200;
const MAX_PURPOSE_LENGTH = 1000;
const MAX_MODELS_PER_POOL = 50;
const MAX_BLOCKED_SKILL_NAME_LENGTH = 200;
const MAX_BLOCKED_SKILLS = 200;

export interface SubagentModelUse {
	model: string;
	purpose?: string;
}

export interface SubagentModelRestrictionTrait {
	version: 1;
	pools: Record<string, SubagentModelUse[]>;
}

export interface DisabledToolsTrait {
	version: 1;
	tools: string[];
}

export interface BlockedSkillsTrait {
	version: 1;
	/** When true, the Skill tool is hidden entirely and no skills are offered. */
	all: boolean;
	/** Specific skill names (as declared in SKILL.md) that are blocked. */
	names: string[];
}

/** Resolved blocked-skill state for enforcement (names as a Set for O(1) lookup). */
export interface BlockedSkillsState {
	all: boolean;
	names: Set<string>;
}

export interface ToolMenuItem {
	name: string;
	description: string;
	category: "core" | "optional" | "review" | "mcp";
}

export interface EffectiveSubagentModelPolicy {
	source: "custom" | "settings" | "none";
	poolKey: string;
	models: SubagentModelUse[];
	isExplicitEmpty: boolean;
}

function encodeTrait(prefix: string, payload: unknown): string {
	return `${prefix}${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")}`;
}

function decodeTrait<T>(trait: string, prefix: string): T | null {
	if (!trait.startsWith(prefix)) return null;
	try {
		const json = Buffer.from(trait.slice(prefix.length), "base64url").toString("utf-8");
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

function normalizePurpose(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, MAX_PURPOSE_LENGTH);
}

function normalizePoolKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export function normalizeSubagentModelRestriction(input: unknown): SubagentModelRestrictionTrait {
	const rawPools =
		input && typeof input === "object" && "pools" in input
			? (input as { pools?: unknown }).pools
			: input;
	const pools: Record<string, SubagentModelUse[]> = {};
	if (!rawPools || typeof rawPools !== "object" || Array.isArray(rawPools)) {
		return { version: 1, pools };
	}

	for (const [rawKey, rawValue] of Object.entries(rawPools)) {
		const key = normalizePoolKey(rawKey);
		if (!key) continue;
		if (!Array.isArray(rawValue)) {
			pools[key] = [];
			continue;
		}
		const seen = new Set<string>();
		const entries: SubagentModelUse[] = [];
		for (const item of rawValue) {
			let model = "";
			let purpose: string | undefined;
			if (typeof item === "string") {
				model = item.trim();
			} else if (item && typeof item === "object") {
				const obj = item as { model?: unknown; purpose?: unknown };
				model = typeof obj.model === "string" ? obj.model.trim() : "";
				purpose = normalizePurpose(obj.purpose);
			}
			if (!model || model.length > MAX_MODEL_LENGTH || seen.has(model)) continue;
			seen.add(model);
			entries.push(purpose ? { model, purpose } : { model });
			if (entries.length >= MAX_MODELS_PER_POOL) break;
		}
		pools[key] = entries;
	}
	return { version: 1, pools };
}

export function normalizeDisabledTools(input: unknown): DisabledToolsTrait {
	const rawTools =
		input && typeof input === "object" && "tools" in input
			? (input as { tools?: unknown }).tools
			: input;
	const knownTools = new Set(getConfigurableTools().map((tool) => tool.name));
	const seen = new Set<string>();
	const tools: string[] = [];
	if (!Array.isArray(rawTools)) return { version: 1, tools };
	for (const item of rawTools) {
		if (typeof item !== "string") continue;
		const name = item.trim();
		if (!name || seen.has(name) || !knownTools.has(name)) continue;
		seen.add(name);
		tools.push(name);
	}
	return { version: 1, tools };
}

export function normalizeBlockedSkills(input: unknown): BlockedSkillsTrait {
	const source =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as { all?: unknown; names?: unknown })
			: {};
	const all = source.all === true;
	const rawNames = Array.isArray(source.names) ? source.names : [];
	const seen = new Set<string>();
	const names: string[] = [];
	for (const item of rawNames) {
		if (typeof item !== "string") continue;
		const name = item.trim();
		if (!name || name.length > MAX_BLOCKED_SKILL_NAME_LENGTH || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
		if (names.length >= MAX_BLOCKED_SKILLS) break;
	}
	return { version: 1, all, names };
}

export function upsertEncodedTrait(traits: unknown, prefix: string, payload: unknown): string[] {
	const next = parseTraits(traits).filter((trait) => !trait.startsWith(prefix));
	next.push(encodeTrait(prefix, payload));
	return next;
}

export function removeEncodedTrait(traits: unknown, prefix: string): string[] {
	return parseTraits(traits).filter((trait) => !trait.startsWith(prefix));
}

export function parseSubagentModelRestrictionTrait(
	traits: unknown,
): SubagentModelRestrictionTrait | null {
	for (const trait of parseTraits(traits)) {
		const decoded = decodeTrait<SubagentModelRestrictionTrait>(
			trait,
			SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
		);
		if (!decoded || decoded.version !== 1) continue;
		return normalizeSubagentModelRestriction(decoded);
	}
	return null;
}

export function parseDisabledToolsTrait(traits: unknown): DisabledToolsTrait | null {
	for (const trait of parseTraits(traits)) {
		const decoded = decodeTrait<DisabledToolsTrait>(trait, DISABLED_TOOLS_TRAIT_PREFIX);
		if (!decoded || decoded.version !== 1) continue;
		return normalizeDisabledTools(decoded);
	}
	return null;
}

export function getDisabledToolSet(traits: unknown): Set<string> {
	return new Set(parseDisabledToolsTrait(traits)?.tools ?? []);
}

export function parseBlockedSkillsTrait(traits: unknown): BlockedSkillsTrait | null {
	for (const trait of parseTraits(traits)) {
		const decoded = decodeTrait<BlockedSkillsTrait>(trait, BLOCKED_SKILLS_TRAIT_PREFIX);
		if (!decoded || decoded.version !== 1) continue;
		return normalizeBlockedSkills(decoded);
	}
	return null;
}

/** Resolve blocked-skill enforcement state from a narrator's traits. */
export function getBlockedSkills(traits: unknown): BlockedSkillsState {
	const parsed = parseBlockedSkillsTrait(traits);
	return { all: parsed?.all ?? false, names: new Set(parsed?.names ?? []) };
}

/** Whether a given skill name is blocked under the resolved state. */
export function isSkillBlocked(state: BlockedSkillsState, name: string): boolean {
	return state.all || state.names.has(name);
}

/** True when the trait carries no active restriction (so it can be dropped). */
export function isBlockedSkillsEmpty(trait: BlockedSkillsTrait): boolean {
	return !trait.all && trait.names.length === 0;
}

export function getConfigurableTools(): ToolMenuItem[] {
	return toolRegistry
		.all()
		.filter(
			(tool) => tool.name && !tool.reflectionOnly && (!tool.isAvailable || tool.isAvailable()),
		)
		.map((tool) => ({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : tool.name,
			category: getToolCategory(tool),
		}))
		.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function getToolCategory(tool: ToolDefinition): ToolMenuItem["category"] {
	if (tool.name.startsWith("mcp__")) return "mcp";
	if (OPTIONAL_TOOLS.has(tool.name)) return "optional";
	if (REVIEW_TOOLS.has(tool.name)) return "review";
	return "core";
}

function getCustomPool(
	restriction: SubagentModelRestrictionTrait,
	subagentType: string,
): { poolKey: string; models: SubagentModelUse[]; isExplicitEmpty: boolean } | null {
	const directKey = normalizePoolKey(subagentType);
	if (directKey && Object.hasOwn(restriction.pools, directKey)) {
		return {
			poolKey: directKey,
			models: restriction.pools[directKey] ?? [],
			isExplicitEmpty: (restriction.pools[directKey] ?? []).length === 0,
		};
	}
	if (!BUILTIN_SUBAGENT_POOL_KEYS.has(directKey) && Object.hasOwn(restriction.pools, "general")) {
		return {
			poolKey: "general",
			models: restriction.pools.general ?? [],
			isExplicitEmpty: (restriction.pools.general ?? []).length === 0,
		};
	}
	return null;
}

export function resolveEffectiveSubagentModelPolicy(
	parentTraits: unknown,
	subagentType: string,
): EffectiveSubagentModelPolicy {
	const restriction = parseSubagentModelRestrictionTrait(parentTraits);
	const poolKey =
		subagentType === "explore" ||
		subagentType === "plan" ||
		subagentType === "search" ||
		subagentType === "review" ||
		subagentType === "general"
			? subagentType
			: "general";
	if (restriction) {
		const custom = getCustomPool(restriction, subagentType);
		if (custom) return { source: "custom", ...custom };
	}

	const settingsPool =
		settings.agent.subagentAllowedModels?.[
			poolKey as "explore" | "plan" | "search" | "review" | "general"
		] ?? [];
	if (settingsPool.length === 0) {
		return { source: "none", poolKey, models: [], isExplicitEmpty: false };
	}
	return {
		source: "settings",
		poolKey,
		models: settingsPool.map((model) => ({ model })),
		isExplicitEmpty: false,
	};
}

export function resolveSubagentModelFromPolicy(params: {
	policy: EffectiveSubagentModelPolicy;
	explicitModel?: string;
	candidates: Array<string | undefined | null>;
}): string | undefined {
	const allowedPool = params.policy.models.map((item) => item.model);
	if (params.policy.source === "none") {
		return (
			params.explicitModel ||
			params.candidates.find((candidate): candidate is string => !!candidate)
		);
	}
	if (params.policy.isExplicitEmpty) return undefined;

	if (params.explicitModel) {
		return resolveAllowedModelCandidate(params.explicitModel, allowedPool) ?? undefined;
	}

	for (const candidate of params.candidates) {
		const resolved = resolveAllowedModelCandidate(candidate, allowedPool);
		if (resolved) return resolved;
	}
	return allowedPool[0];
}

export function formatSubagentModelRestrictionDescription(traits: unknown): string | null {
	const restriction = parseSubagentModelRestrictionTrait(traits);
	if (!restriction) return null;
	const parts: string[] = [];
	const keys = Object.keys(restriction.pools).sort((a, b) => {
		const order = ["explore", "plan", "search", "review", "general"];
		return (
			(order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
			(order.indexOf(b) === -1 ? 99 : order.indexOf(b))
		);
	});
	for (const key of keys) {
		const entries = restriction.pools[key] ?? [];
		if (entries.length === 0) {
			parts.push(`${key}: (no models allowed)`);
			continue;
		}
		parts.push(
			`${key}: ${entries
				.map((entry) => {
					const models = expandAllowedPoolForDisplay([entry.model]).join(", ") || entry.model;
					return entry.purpose ? `${models} — ${entry.purpose}` : models;
				})
				.join("; ")}`,
		);
	}
	if (parts.length === 0) return null;
	return `Subagent model selection is restricted by this narrator's custom trait. Allowed models and intended uses — ${parts.join(" | ")}. Models outside the matching pool are not available.`;
}

export function getVisibleModelUses(): SubagentModelUse[] {
	return getVisibleModels().map((model) => ({ model }));
}

/** Shape returned by the narrator custom-traits API + `custom_traits_changed` WS event. */
export interface CustomTraitsResponse {
	subagentModelRestriction: SubagentModelRestrictionTrait | null;
	disabledTools: DisabledToolsTrait | null;
	blockedSkills: BlockedSkillsTrait | null;
	availableModels: SubagentModelUse[];
	availableTools: ToolMenuItem[];
}

/** Build the full custom-traits response for a narrator's traits (shared by route + WS). */
export function buildCustomTraitsResponse(traits: unknown): CustomTraitsResponse {
	return {
		subagentModelRestriction: parseSubagentModelRestrictionTrait(traits),
		disabledTools: parseDisabledToolsTrait(traits),
		blockedSkills: parseBlockedSkillsTrait(traits),
		availableModels: getVisibleModelUses(),
		availableTools: getConfigurableTools(),
	};
}
