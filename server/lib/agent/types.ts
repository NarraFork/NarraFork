import type { z } from "zod/v4";

// === Tool system ===

export interface ToolContext {
	narratorId: string;
	cwd: string;
	signal: AbortSignal;
	/** Locale for i18n of tool outputs */
	locale: string;
	/** Request permission from the user. Returns true if allowed. */
	requestPermission: (
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
	) => Promise<PermissionResult>;
	/** Emit progress updates for long-running tools */
	emitProgress?: (toolUseId: string, elapsed: number) => void;
}

export interface ToolResult {
	output: string;
	isError?: boolean;
	title?: string;
	metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: z.ZodType;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
	/** If provided, tool is only included when this returns true */
	isAvailable?: () => boolean;
}

// === Permission ===

export type PermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown> }
	| { behavior: "deny"; message?: string };

// === Agent events (yielded by the loop) ===

export type AgentEvent =
	| {
			type: "assistant_message";
			text: string;
			toolUses: AgentToolUse[];
			messageId?: string;
	  }
	| { type: "stream_text"; text: string }
	| { type: "tool_call"; toolUseId: string; toolName: string; input: Record<string, unknown> }
	| {
			type: "tool_result";
			toolUseId: string;
			toolName: string;
			output: string;
			isError: boolean;
			durationMs: number;
	  }
	| { type: "tool_progress"; toolUseId: string; elapsed: number }
	| { type: "turn_complete"; turnIndex: number }
	| { type: "error"; message: string }
	| { type: "stream_reasoning"; text: string }
	| { type: "context_usage"; percentage: number }
	| { type: "metering"; unit: string; unitPlural: string; usage: number }
	| { type: "invalid_state"; reason: string; message: string }
	| { type: "done" };

export interface AgentToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
}

// === Plan mode constants ===

/** Tools allowed during plan mode. Everything else is auto-denied or description-overridden. */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"EnterPlanMode",
	"ExitPlanMode",
	"Bash",
]);

// === Agent config ===

export interface AgentConfig {
	narratorId: string;
	conversationId: string;
	model: string;
	provider: string;
	cwd: string;
	systemPrompt?: string;
	locale?: string;
	signal: AbortSignal;
	maxTurns?: number;
	planMode?: boolean;
	permissionHandler: (
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
	) => Promise<PermissionResult>;
	onEvent?: (event: AgentEvent) => void;
}
