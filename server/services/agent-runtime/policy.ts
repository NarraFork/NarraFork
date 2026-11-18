import { BASH_TOOL_NAME } from "@server/lib/agent/tool-name";
import {
	isOutlineTool,
	OUTLINE_EDIT_TOOL,
	OUTLINE_READ_TOOLS,
} from "@server/lib/agent/tools/outline-names";
import type { RuntimePolicyTrait } from "@server/lib/runtime-policy-trait";

/**
 * Server-resolved capability ceiling for one narrator. It is derived from traits
 * (see `runtime-policy-trait.ts`) and never names a narrator role: two narrators
 * with the same traits behave the same, however they were created.
 */
export interface RuntimePolicy {
	/**
	 * Delegation levels below a primary narrator: 0 for a narrator that declares none, 1 for a
	 * primary's subagent, 2 for a subagent's subagent. At {@link MAX_DELEGATION_DEPTH} the
	 * ceiling never allows spawning or awaiting agents.
	 */
	readonly delegationDepth: number;
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
		readonly watchAgent: boolean;
		readonly askUserQuestion: "sync-or-async" | "disabled";
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
	"Watch",
	"Stop",
	"Question",
	"ContextAsk",
	"Send",
	// Only show passes a read-only execution policy; create remains gated.
	"GenUI",
	...OUTLINE_READ_TOOLS,
]);
const GENERAL_TOOLS = Object.freeze([...READ_TOOLS, "Write", "Edit", "Skill", OUTLINE_EDIT_TOOL]);
/** Tools that create or continue another agent; hidden wherever spawning is not allowed. */
const SPAWN_TOOLS: readonly string[] = Object.freeze([
	"Agent",
	"Task",
	"ContinueTask",
	"ForkNarrator",
]);
/**
 * Optional tools a delegation template may preload (`enabledTools` at creation), the way a
 * knowledge steward gets its knowledge tools. Each still needs its template's ceiling to allow
 * it, and its own permission prompts and caps (`agent-resource-caps.ts`) apply as for anyone.
 */
export const TERMINAL_TOOL = "Terminal";
export const BROWSER_TOOL = "Browser";
/**
 * A worker does the `general` work, may hand parts of it to helpers it waits for, and runs
 * long-lived things itself: an interactive terminal (dev server, REPL) and a browser.
 */
const WORKER_TOOLS = Object.freeze([...GENERAL_TOOLS, "Agent", TERMINAL_TOOL, BROWSER_TOOL]);
/**
 * Optional tools a read-only ceiling may still list. Browser is one: under a read-only ceiling
 * the permission gate allows only its page-reading actions (`isBrowserReadAction`), so a
 * reviewer can look at a page but never click, type, run scripts or write files with it.
 */
const READ_ONLY_OPTIONAL_TOOLS = Object.freeze([BROWSER_TOOL]);
/** The tools a read-only ceiling narrows built-ins to. */
const READ_ONLY_CEILING_TOOLS = Object.freeze([...READ_TOOLS, ...READ_ONLY_OPTIONAL_TOOLS]);

/**
 * Browser actions that only look at a page: open or move to a web URL, read it, capture it
 * without writing a file, and close it. Clicking, typing, form filling, script evaluation,
 * tracing and memory profiles (which write files and share links) are not reads. `hover` and
 * `scroll` are kept as reads although they fire the page's own handlers (hover menus, lazy
 * loading, infinite scroll): they are how a person looks at a page, and they submit nothing.
 */
const BROWSER_READ_ACTIONS: ReadonlySet<string> = new Set([
	"launch",
	"navigate",
	"screenshot",
	"get_text",
	"get_attribute",
	"get_console",
	"get_network",
	"network_start",
	"network_stop",
	"wait",
	"scroll",
	"hover",
	"dom",
	"close",
	"set_ttl",
	"set_viewport",
	"list_sessions",
]);

/**
 * Whether a URL is a web page a read-only reader may open: http(s) only, or `about:blank`.
 * `data:` carries its own script, `file:` reads the host's files, and `chrome:`, `devtools:`,
 * `view-source:` and `javascript:` reach the browser itself; none of them is looking at a page.
 */
export function isReadOnlyBrowserUrl(url: unknown): boolean {
	if (typeof url !== "string") return false;
	if (url.trim().toLowerCase() === "about:blank") return true;
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Whether a Browser call only reads pages. A screenshot saved to a file writes; a headed
 * launch may open a tab in the person's own browser with their sign-ins; a launch or
 * navigation to anything but a web URL (`isReadOnlyBrowserUrl`) is not looking at a page.
 * `navigate` without a URL moves back or forward through pages already opened this way.
 */
export function isBrowserReadAction(input: Record<string, unknown>): boolean {
	const action = typeof input.action === "string" ? input.action : "";
	if (!BROWSER_READ_ACTIONS.has(action)) return false;
	if (action === "screenshot" && input.file_path !== undefined) return false;
	if (action === "launch" && (input.headless === false || !isReadOnlyBrowserUrl(input.url)))
		return false;
	if (action === "navigate" && input.url !== undefined && !isReadOnlyBrowserUrl(input.url))
		return false;
	return true;
}

/**
 * The optional tools a template's subagent starts with loaded. Only what its ceiling (and the
 * delegator's, `isRuntimeToolAllowed` on the merged policy) allows is kept by the caller.
 */
export function delegationPreloadTools(template: string): readonly string[] {
	switch (template) {
		case "worker":
			return [TERMINAL_TOOL, BROWSER_TOOL];
		case "review":
			return [BROWSER_TOOL];
		default:
			return [];
	}
}

/**
 * Subagents nest at most this many levels below a primary narrator: a primary's subagent
 * (level 1) may spawn and await its own helpers (level 2); a level-2 subagent never spawns.
 * Every backstop (visibility here, creation in `narrator-service`, control in
 * `narrator-control`) reads this one number.
 */
export const MAX_DELEGATION_DEPTH = 2;
const SEARCH_TOOLS = Object.freeze([
	"WebSearch",
	"WebFetch",
	"TeamStatus",
	"Watch",
	"Question",
	"ContextAsk",
	"Send",
]);

/** Delegated work coordinates through its delegator; it never orchestrates or asks the user. */
const DELEGATED_DENY: NonNullable<RuntimePolicyTrait["deny"]> = [
	"spawnAgent",
	"watchAgent",
	"askUserQuestion",
	"planApproval",
	"stopHooks",
	"switchWorkingDirectory",
];
/**
 * A worker coordinates its own helpers (spawns, waits for and stops them) but, like every
 * delegate, never asks the user, approves plans or leaves its delegator's directory.
 */
const WORKER_DENY: NonNullable<RuntimePolicyTrait["deny"]> = DELEGATED_DENY.filter(
	(key) => key !== "spawnAgent" && key !== "watchAgent" && key !== "awaitAgent",
);

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
	"worker",
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
	/**
	 * The delegating session keeps its tasks in the outline (task backend `outline`): its
	 * subagents get no outline tools by default (design §4.4, R16) — they work from a plain
	 * description and their report is filed for them. A custom template that names outline tools
	 * in its own tool list keeps them ("when needed"). Spec sessions' subagents are unchanged.
	 */
	outlineSession?: boolean;
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
	// A template's built-in list, without the outline tools for an outline session's subagent.
	const builtin = (tools: readonly string[]) =>
		input.outlineSession ? tools.filter((name) => !isOutlineTool(name)) : [...tools];
	switch (input.template) {
		case "general":
			return { ...base, tools: builtin(GENERAL_TOOLS), mcp: "nonDenied" };
		case "worker":
			// Nesting is a template grant, never a loosening of the others: only a worker may
			// spawn, and only while it sits above the deepest level (`withDelegationDepth`).
			return { ...base, deny: [...WORKER_DENY], tools: builtin(WORKER_TOOLS), mcp: "nonDenied" };
		case "search":
			return { ...base, tools: [...SEARCH_TOOLS], mcp: "none", readOnly: true, searchOnly: true };
		case "review":
			// Review may inspect Git synchronously and look at pages, never control running tasks.
			return {
				...base,
				tools: builtin([...READ_TOOLS.filter((name) => name !== "Stop"), BROWSER_TOOL]),
				mcp: "readOnly",
				readOnly: true,
				readOnlyGitShell: true,
			};
		case "explore":
		case "plan":
			return { ...base, tools: builtin(READ_TOOLS), mcp: "readOnly", readOnly: true };
	}
	const custom = input.customDefinition;
	if (custom?.toolAccess === "general")
		return { ...base, tools: builtin(GENERAL_TOOLS), mcp: "nonDenied" };
	if (custom?.toolAccess === "custom")
		return {
			...base,
			tools: [...custom.customTools],
			mcpNames: [...custom.customTools],
			mcp: "nonDenied",
		};
	return { ...base, tools: builtin(READ_TOOLS), mcp: "readOnly", readOnly: true };
}

/**
 * Stamp a compiled ceiling with the level it is created at. At the deepest level the
 * ceiling itself also removes spawning and agent waits, so the stored row says what the
 * resolved policy enforces even when read without its source chain.
 */
export function withDelegationDepth(trait: RuntimePolicyTrait, depth: number): RuntimePolicyTrait {
	const stamped: RuntimePolicyTrait = { ...trait, delegationDepth: depth };
	if (depth < MAX_DELEGATION_DEPTH) return stamped;
	const deny = new Set(trait.deny ?? []);
	deny.add("spawnAgent");
	deny.add("awaitAgent");
	return {
		...stamped,
		deny: [...deny],
		...(trait.tools ? { tools: trait.tools.filter((name) => !SPAWN_TOOLS.includes(name)) } : {}),
	};
}

const MCP_RANK = { none: 0, readOnly: 1, nonDenied: 2 } as const;

function intersect(current: "all" | string[], declared: readonly string[] | undefined) {
	if (!declared) return current;
	return current === "all" ? [...declared] : current.filter((name) => declared.includes(name));
}

/**
 * Merge ceiling declarations from any number of layers. Every field only narrows,
 * so order does not matter. Read-only from any layer also narrows built-ins to the
 * read tools (plus Browser, gated to its read actions) and MCP to read-only.
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
	let delegationDepth = 0;
	const denied = new Set<string>();
	for (const trait of declarations) {
		delegationDepth = Math.max(delegationDepth, trait.delegationDepth ?? 0);
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
		builtin = intersect(builtin, READ_ONLY_CEILING_TOOLS);
		if (mcp === "nonDenied") mcp = "readOnly";
	}
	// The deepest level never orchestrates, whatever its template or any layer allows.
	if (delegationDepth >= MAX_DELEGATION_DEPTH) {
		denied.add("spawnAgent");
		denied.add("awaitAgent");
	}
	const allowed = (key: string) => !denied.has(key);
	return Object.freeze({
		delegationDepth,
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
			// Stored v1 ceilings keep their meaning; never rewrite old allowlists.
			watchAgent: allowed("watchAgent") && allowed("awaitAgent"),
			askUserQuestion: allowed("askUserQuestion") ? "sync-or-async" : "disabled",
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
	// Frozen provider declarations and stored allowlists never revive the retired tool.
	if (toolName === "Await") return false;
	if (toolName === "Question") return true;
	if (toolName === "AskUserQuestion" && caps.askUserQuestion === "disabled") return false;
	if (
		SPAWN_TOOLS.includes(toolName) &&
		(!caps.spawnAgent || policy.delegationDepth >= MAX_DELEGATION_DEPTH)
	)
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

export type RuntimeWatchTarget = "terminal" | "bash" | "agent";
export function runtimeWatchTargets(policy: RuntimePolicy): RuntimeWatchTarget[] {
	return ["terminal", "bash", ...(policy.capabilities.watchAgent ? ["agent" as const] : [])];
}

/** Interaction instructions are a projection of the same finite capability policy. */
export function runtimeInteractionHint(policy: RuntimePolicy, locale: string): string {
	const lines: string[] = [];
	if (!policy.capabilities.watchAgent)
		lines.push(
			locale === "zh-CN"
				? "不得使用 Watch(agent) 观察其他代理；需要传递信息时使用异步 Send。"
				: "Do not use Watch(agent) to observe other agents; use asynchronous Send to deliver information.",
		);
	if (policy.capabilities.askUserQuestion === "disabled")
		lines.push(
			locale === "zh-CN"
				? "当前不可调用 AskUserQuestion 发起问题；可用 Question 查询本会话已有问题，回答会自动通知。"
				: "AskUserQuestion is unavailable; use Question to inspect this session's existing questions. Answers notify automatically.",
		);
	return lines.join("\n");
}
