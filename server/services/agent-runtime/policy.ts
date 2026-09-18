import { BASH_TOOL_NAME } from "@server/lib/agent/tool-name";

/** Server-resolved capabilities, not model-supplied authorization or lifecycle hooks. */
export interface RuntimePolicy {
	readonly variant: "primary" | "subagent";
	readonly tools: {
		readonly builtin: "all" | readonly string[];
		readonly mcp: "none" | "readOnly" | "nonDenied";
		readonly mcpNames: "all" | readonly string[];
		readonly readOnly: boolean;
	};
	readonly capabilities: {
		readonly spawnAgent: boolean;
		readonly awaitAgent: boolean;
		readonly sendAwait: boolean;
		readonly askUserQuestion: "sync-or-async" | "disabled";
		/** Waiting on an existing own question does not grant permission to create one. */
		readonly awaitOwnQuestion: boolean;
		readonly planApproval: boolean;
		readonly stopHooks: boolean;
	};
}

export interface RuntimePolicyInput {
	variant: RuntimePolicy["variant"];
	subagentType?: string;
	customDefinition?: {
		toolAccess: "readOnly" | "general" | "custom";
		customTools: readonly string[];
	} | null;
	/** An inherited restriction may narrow, never widen, the selected profile. */
	readOnly?: boolean;
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
	"ContextAsk",
	"Send",
]);
const GENERAL_TOOLS = Object.freeze([...READ_TOOLS, "Write", "Edit", "Skill"]);
const SEARCH_TOOLS = Object.freeze(["WebFetch", "TeamStatus", "Await", "ContextAsk", "Send"]);

export function resolveRuntimePolicy(input: RuntimePolicyInput): RuntimePolicy {
	const primary = input.variant === "primary";
	let builtin: RuntimePolicy["tools"]["builtin"] = primary ? "all" : READ_TOOLS;
	let mcp: RuntimePolicy["tools"]["mcp"] = primary ? "nonDenied" : "readOnly";
	let mcpNames: RuntimePolicy["tools"]["mcpNames"] = "all";
	let readOnly = !primary;
	if (!primary) {
		switch (input.subagentType) {
			case "general":
				builtin = GENERAL_TOOLS;
				mcp = "nonDenied";
				readOnly = false;
				break;
			case "search":
				builtin = SEARCH_TOOLS;
				mcp = "none";
				break;
			case "explore":
			case "plan":
			case "review":
				break;
			default:
				// Missing/invalid custom definitions fail closed to the read-only profile.
				if (input.customDefinition?.toolAccess === "general") {
					builtin = GENERAL_TOOLS;
					mcp = "nonDenied";
					readOnly = false;
				} else if (input.customDefinition?.toolAccess === "custom") {
					builtin = Object.freeze([...input.customDefinition.customTools]);
					mcpNames = builtin;
					mcp = "nonDenied";
					readOnly = false;
				}
		}
	}
	if (input.readOnly) {
		builtin = builtin === "all" ? READ_TOOLS : builtin.filter((name) => READ_TOOLS.includes(name));
		if (mcp !== "none") mcp = "readOnly";
		readOnly = true;
	}
	return Object.freeze({
		variant: input.variant,
		tools: Object.freeze({
			builtin: builtin === "all" ? builtin : Object.freeze(builtin),
			mcp,
			mcpNames,
			readOnly,
		}),
		capabilities: Object.freeze({
			spawnAgent: primary,
			awaitAgent: primary,
			sendAwait: primary,
			// Subagents cannot ask the user at all: a delegated task must proceed with
			// what it was given. The capability gate (not just the builtin list) is what
			// stops a custom definition from re-enabling the tool via customTools.
			askUserQuestion: primary ? "sync-or-async" : "disabled",
			awaitOwnQuestion: true,
			planApproval: primary,
			stopHooks: primary,
		}),
	});
}

/** Compatibility adapter for existing server-owned AgentConfig / ToolContext. */
export function runtimePolicyForContext(context?: {
	parentNarratorId?: string;
	/** Resolved by server assembly, never read from tool arguments. */
	runtimePolicy?: RuntimePolicy;
}): RuntimePolicy {
	return (
		context?.runtimePolicy ??
		resolveRuntimePolicy({ variant: context?.parentNarratorId ? "subagent" : "primary" })
	);
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
	if (toolName === "AskUserQuestion" && caps.askUserQuestion === "disabled") return false;
	if (["Agent", "Task", "ContinueTask", "ForkNarrator"].includes(toolName) && !caps.spawnAgent)
		return false;
	if (["EnterPlanMode", "ExitPlanMode"].includes(toolName) && !caps.planApproval) return false;
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
	if (!policy.capabilities.sendAwait)
		lines.push(
			locale === "zh-CN"
				? "Send 只能异步发送，不得设置 await=true。"
				: "Send must be asynchronous; do not set await=true.",
		);
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
