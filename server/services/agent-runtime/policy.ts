import { BASH_TOOL_NAME } from "@server/lib/agent/tool-name";
import type { RuntimePolicyTrait } from "@server/lib/runtime-policy-trait";

/**
 * Server-resolved capability ceiling for one narrator. It is derived from traits
 * (see `runtime-policy-trait.ts`) and never names a narrator role: two narrators
 * with the same traits behave the same, however they were created.
 */
export interface RuntimePolicy {
	/** Search tools may only call the selected provider directly, never the channel router. */
	readonly searchOnly: boolean;
	/** Shell may only run the constrained local read-only Git policy. */
	readonly readOnlyGitShell: boolean;
	readonly continuation: {
		readonly promoteTodo: boolean;
		/** Null is unbounded. Each declaring layer may only lower a finite limit. */
		readonly maxPasses: number | null;
	};
	readonly tools: {
		readonly builtin: "all" | readonly string[];
		readonly mcp: "none" | "readOnly" | "nonDenied";
		readonly mcpNames: "all" | readonly string[];
		readonly readOnly: boolean;
	};
	readonly capabilities: {
		readonly spawnAgent: boolean;
		readonly awaitAgent: boolean;
		readonly askUserQuestion: "sync-or-async" | "disabled";
		/** Waiting on an existing own question does not grant permission to create one. */
		readonly awaitOwnQuestion: boolean;
		readonly planApproval: boolean;
		readonly stopHooks: boolean;
		readonly switchWorkingDirectory: boolean;
	};
}

const READ_TOOLS = Object.freeze([
	"Read",
	"Glob",
	"Grep",
	"StructView",
	"WebSearch",
	"WebFetch",
	BASH_TOOL_NAME,
	"TeamStatus",
	"Await",
	"Stop",
	"Question",
	"ContextAsk",
	"Send",
	// Only show passes a read-only execution policy; create remains gated.
	"GenUI",
]);
const GENERAL_TOOLS = Object.freeze([...READ_TOOLS, "Write", "Edit", "Skill"]);
const SEARCH_TOOLS = Object.freeze([
	"WebSearch",
	"WebFetch",
	"TeamStatus",
	"Await",
	"Question",
	"ContextAsk",
	"Send",
]);

/** Delegated work coordinates through its delegator; it never orchestrates or asks the user. */
const DELEGATED_DENY: NonNullable<RuntimePolicyTrait["deny"]> = [
	"spawnAgent",
	"awaitAgent",
	"askUserQuestion",
	"planApproval",
	"stopHooks",
	"switchWorkingDirectory",
];

/**
 * A bot's ceiling, stored on it at creation. Nobody reads a bot's transcript, so
 * nothing may wait there for a person: a question or a plan up for approval would
 * stall it in front of people who can't see either. It asks through Send instead.
 */
export const BOT_RUNTIME_CEILING: RuntimePolicyTrait = {
	version: 1,
	deny: ["askUserQuestion", "planApproval"],
};

/** Template names with a built-in ceiling; any other name is a custom definition. */
export const BUILTIN_DELEGATION_TEMPLATES: ReadonlySet<string> = new Set([
	"general",
	"explore",
	"plan",
	"review",
	"search",
]);

export interface DelegationTemplateInput {
	template: string;
	customDefinition?: {
		toolAccess: "readOnly" | "general" | "custom";
		customTools: readonly string[];
	} | null;
}

/**
 * Compile a delegation template into an ordinary capability ceiling. This is the
 * only place template names mean anything; the result is stored in the created
 * narrator's traits. Missing/invalid custom definitions fail closed to read-only.
 */
export function compileDelegationPolicy(input: DelegationTemplateInput): RuntimePolicyTrait {
	const base = {
		version: 1 as const,
		deny: [...DELEGATED_DENY],
		continuation: { promoteTodo: false, maxPasses: 6 },
	};
	switch (input.template) {
		case "general":
			return { ...base, tools: [...GENERAL_TOOLS], mcp: "nonDenied" };
		case "search":
			return { ...base, tools: [...SEARCH_TOOLS], mcp: "none", readOnly: true, searchOnly: true };
		case "review":
			// Review may inspect Git synchronously, never control running tasks.
			return {
				...base,
				tools: READ_TOOLS.filter((name) => name !== "Stop"),
				mcp: "readOnly",
				readOnly: true,
				readOnlyGitShell: true,
			};
		case "explore":
		case "plan":
			return { ...base, tools: [...READ_TOOLS], mcp: "readOnly", readOnly: true };
	}
	const custom = input.customDefinition;
	if (custom?.toolAccess === "general")
		return { ...base, tools: [...GENERAL_TOOLS], mcp: "nonDenied" };
	if (custom?.toolAccess === "custom")
		return {
			...base,
			tools: [...custom.customTools],
			mcpNames: [...custom.customTools],
			mcp: "nonDenied",
		};
	return { ...base, tools: [...READ_TOOLS], mcp: "readOnly", readOnly: true };
}

const MCP_RANK = { none: 0, readOnly: 1, nonDenied: 2 } as const;

function intersect(current: "all" | string[], declared: readonly string[] | undefined) {
	if (!declared) return current;
	return current === "all" ? [...declared] : current.filter((name) => declared.includes(name));
}

/**
 * Merge ceiling declarations from any number of layers. Every field only narrows,
 * so order does not matter. Read-only from any layer also narrows built-ins to the
 * read tools and MCP to read-only.
 */
export function resolveRuntimePolicy(declarations: readonly RuntimePolicyTrait[]): RuntimePolicy {
	let builtin: "all" | string[] = "all";
	let mcpNames: "all" | string[] = "all";
	let mcp: RuntimePolicy["tools"]["mcp"] = "nonDenied";
	let readOnly = false;
	let searchOnly = false;
	let readOnlyGitShell = false;
	let promoteTodo = true;
	let maxPasses: number | null = null;
	const denied = new Set<string>();
	for (const trait of declarations) {
		builtin = intersect(builtin, trait.tools);
		mcpNames = intersect(mcpNames, trait.mcpNames);
		if (trait.mcp && MCP_RANK[trait.mcp] < MCP_RANK[mcp]) mcp = trait.mcp;
		readOnly ||= trait.readOnly === true;
		searchOnly ||= trait.searchOnly === true;
		readOnlyGitShell ||= trait.readOnlyGitShell === true;
		promoteTodo &&= trait.continuation?.promoteTodo !== false;
		const declaredPasses = trait.continuation?.maxPasses;
		if (declaredPasses !== undefined) maxPasses = Math.min(maxPasses ?? Infinity, declaredPasses);
		for (const key of trait.deny ?? []) denied.add(key);
	}
	if (readOnly) {
		builtin = intersect(builtin, READ_TOOLS);
		if (mcp === "nonDenied") mcp = "readOnly";
	}
	const allowed = (key: string) => !denied.has(key);
	return Object.freeze({
		searchOnly,
		readOnlyGitShell,
		continuation: Object.freeze({ promoteTodo, maxPasses }),
		tools: Object.freeze({
			builtin: builtin === "all" ? builtin : Object.freeze(builtin),
			mcp,
			mcpNames: mcpNames === "all" ? mcpNames : Object.freeze(mcpNames),
			readOnly,
		}),
		capabilities: Object.freeze({
			spawnAgent: allowed("spawnAgent"),
			awaitAgent: allowed("awaitAgent"),
			askUserQuestion: allowed("askUserQuestion") ? "sync-or-async" : "disabled",
			awaitOwnQuestion: true,
			planApproval: allowed("planApproval"),
			stopHooks: allowed("stopHooks"),
			switchWorkingDirectory: allowed("switchWorkingDirectory"),
		}),
	});
}

/** The ceiling of a narrator that declares nothing: every capability. */
export const UNRESTRICTED_RUNTIME_POLICY: RuntimePolicy = resolveRuntimePolicy([]);

/**
 * Capability ceiling attached by server runtime assembly. A context without one
 * was not assembled by the runtime (tests, internal probes) and gets the
 * unrestricted ceiling; execution permission gates still apply.
 */
export function runtimePolicyForContext(context?: {
	runtimePolicy?: RuntimePolicy;
}): RuntimePolicy {
	return context?.runtimePolicy ?? UNRESTRICTED_RUNTIME_POLICY;
}

/** Shared by model schema consumers, the permission gate and the executing service. */
export function assertRuntimeCanAskQuestion(policy: RuntimePolicy): void {
	if (policy.capabilities.askUserQuestion === "disabled") {
		throw new Error("AskUserQuestion is not available under this runtime policy.");
	}
}

/** Visibility is an upper bound; the execution permission/ACL gates remain mandatory. */
export function isRuntimeToolAllowed(
	policy: RuntimePolicy,
	toolName: string,
	mcpBehavior?: string | null,
): boolean {
	const caps = policy.capabilities;
	if (toolName === "Question") return caps.awaitOwnQuestion;
	if (toolName === "AskUserQuestion" && caps.askUserQuestion === "disabled") return false;
	if (["Agent", "Task", "ContinueTask", "ForkNarrator"].includes(toolName) && !caps.spawnAgent)
		return false;
	if (["EnterPlanMode", "ExitPlanMode"].includes(toolName) && !caps.planApproval) return false;
	if (toolName === "SwitchWorkingDirectory" && !caps.switchWorkingDirectory) return false;
	if (toolName.startsWith("mcp__")) {
		if (policy.tools.mcp === "none" || mcpBehavior === "deny") return false;
		if (policy.tools.mcpNames !== "all" && !policy.tools.mcpNames.includes(toolName)) return false;
		return policy.tools.mcp !== "readOnly" || mcpBehavior === "readOnly";
	}
	return policy.tools.builtin === "all" || policy.tools.builtin.includes(toolName);
}

export type RuntimeAwaitTarget = "agent" | "bash" | "transfer" | "question";
export function runtimeAwaitTargets(policy: RuntimePolicy): RuntimeAwaitTarget[] {
	return [
		...(policy.capabilities.awaitAgent ? ["agent" as const] : []),
		"bash",
		"transfer",
		...(policy.capabilities.awaitOwnQuestion ? ["question" as const] : []),
	];
}

/** Interaction instructions are a projection of the same finite capability policy. */
export function runtimeInteractionHint(policy: RuntimePolicy, locale: string): string {
	const lines: string[] = [];
	if (!policy.capabilities.awaitAgent)
		lines.push(
			locale === "zh-CN"
				? "不得使用 Await(agent) 等待其他代理。"
				: "Do not use Await(agent) to wait for other agents.",
		);
	if (policy.capabilities.askUserQuestion === "disabled")
		lines.push(
			locale === "zh-CN"
				? "当前不可调用 AskUserQuestion 发起问题；Await(question) 仅可等待本会话已有的问题，不代表获得提问权限。"
				: "AskUserQuestion is unavailable; Await(question) may only wait on this session's existing questions and does not grant permission to ask new ones.",
		);
	return lines.join("\n");
}
