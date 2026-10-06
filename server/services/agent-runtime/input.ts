import type { ImageRef } from "../../lib/uploads";
import type { CustomSubagentDef } from "../custom-subagent-service";
import type { ExecuteLoopResult } from "../narrator-executor";
import type { ProxyAbortController } from "../subagent-detach";
import { createRuntimeRecoveryState, type RuntimeRecoveryState } from "./transition";

/** Entry adapters supply data and finite capabilities, never an alternate loop. */
export interface RuntimeForegroundControl {
	parentSignal: AbortSignal;
	timeoutSignal?: AbortSignal;
	proxy: ProxyAbortController;
	turnAbort: AbortController;
	detached: boolean;
	cleanupTurnAbort?: () => void;
}

export interface SubagentRuntimeProfile {
	kind: "subagent";
	/** Durable child-run provenance retained across retries and continuation passes. */
	executionSegmentId?: string;
	parentNarratorId: string;
	parentToolUseId: string;
	subagentType: string;
	customDefinition?: CustomSubagentDef | null;
	systemPrompt: string;
	initialModel?: string;
	rebuildSystemPrompt?: (contextSummary?: string | null) => Promise<string>;
	initialHistory: unknown[];
	/** Host-prepared current packet paired with initialHistory; never raw caller text. */
	initialCurrentText?: string;
	initialTrailingToolResults?: unknown[];
	initialPrePromptBashCommand?: string;
	control?: RuntimeForegroundControl;
}

export type RuntimeProfile = { kind: "primary" } | SubagentRuntimeProfile;

export type RuntimeInput =
	| { kind: "current"; text: string; images?: ImageRef[] }
	| { kind: "history-replay" }
	| { kind: "tool-results-replay" }
	| { kind: "inbox"; deliveryId: string; epoch: string }
	| { kind: "continuation"; source: string };

/** One mutable run state shared across retries, compacts and user-control resumes. */
export interface RuntimeRunState {
	input: Extract<RuntimeInput, { kind: "current" }>;
	recovery: RuntimeRecoveryState;
	lastPass?: ExecuteLoopResult;
	firstPass: boolean;
	initialSettingsApplied: boolean;
	pendingPrePromptBashCommand?: string;
	hadError: boolean;
	wasInterrupted: boolean;
	finalText: string;
	hitMaxTurns: boolean;
	totalTokens: number;
}

export function createRuntimeRunState(
	input: Extract<RuntimeInput, { kind: "current" }>,
	profile: RuntimeProfile,
): RuntimeRunState {
	return {
		input,
		recovery: createRuntimeRecoveryState(),
		firstPass: true,
		initialSettingsApplied: false,
		pendingPrePromptBashCommand:
			profile.kind === "subagent" ? profile.initialPrePromptBashCommand : undefined,
		hadError: false,
		wasInterrupted: false,
		finalText: "",
		hitMaxTurns: false,
		totalTokens: 0,
	};
}

export interface RuntimeRunOutcome {
	started: boolean;
	allowInboxWake?: boolean;
	finalText?: string;
	hasError?: boolean;
	aborted?: boolean;
	contextLengthExceeded?: boolean;
	lastPass?: ExecuteLoopResult;
}
