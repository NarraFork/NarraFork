import type { MediaRef } from "@shared/media-attachments";
import type { ApiRequestDiagnostics } from "../../lib/agent/types";
import type { ImageRef } from "../../lib/uploads";
import type { ExecuteLoopResult } from "../narrator-executor";
import { createRuntimeRecoveryState, type RuntimeRecoveryState } from "./transition";

export type RuntimeInput =
	| { kind: "current"; text: string; images?: ImageRef[]; media?: MediaRef[] }
	| { kind: "history-replay" }
	| { kind: "tool-results-replay" }
	| { kind: "inbox"; deliveryId: string; epoch: string }
	| { kind: "continuation"; source: string };

/** One mutable run state shared across retries, compacts and held-run resumes. */
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
	/** Stop hooks follow the capability ceiling of the last pass. */
	stopHooks: boolean;
}

export function createRuntimeRunState(
	input: Extract<RuntimeInput, { kind: "current" }>,
	prePromptBashCommand?: string,
): RuntimeRunState {
	return {
		input,
		recovery: createRuntimeRecoveryState(),
		firstPass: true,
		initialSettingsApplied: false,
		pendingPrePromptBashCommand: prePromptBashCommand,
		hadError: false,
		wasInterrupted: false,
		finalText: "",
		hitMaxTurns: false,
		totalTokens: 0,
		stopHooks: true,
	};
}

/** Machine-readable status is distinct from the caller's display text. */
export interface RuntimeTerminalStatus {
	substatus: string[];
	errorCode?: string;
	errorMessage?: string;
	diagnostics?: ApiRequestDiagnostics;
}

export interface RuntimeRunOutcome {
	terminalStatus?: RuntimeTerminalStatus;
	started: boolean;
	allowInboxWake?: boolean;
	freshInput?: boolean;
	finalText?: string;
	hasError?: boolean;
	aborted?: boolean;
	contextLengthExceeded?: boolean;
	lastPass?: ExecuteLoopResult;
}
