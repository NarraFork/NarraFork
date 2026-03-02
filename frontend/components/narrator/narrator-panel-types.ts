import { IconHandStop, IconPencilCheck, IconShield, IconShieldOff } from "@tabler/icons-react";
import { createElement } from "react";
import type { PaginatedMessages, TreeMessage } from "../../lib/api";
import type { PendingPermission } from "./ToolCallCard";

// Inject highlight blink animation
if (typeof document !== "undefined") {
	const id = "narrator-highlight-blink";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `@keyframes highlight-blink {
			0%, 100% { background-color: transparent }
			25%, 75% { background-color: var(--mantine-color-yellow-light) }
		}
		@keyframes indeterminate-slide {
			0% { transform: translateX(-100%) }
			100% { transform: translateX(433%) }
		}
		@media (max-width: 768px) {
			.context-ring { width: 14px !important; height: 14px !important; display: flex !important; align-items: center; justify-content: center; }
			.context-ring svg { width: 14px; height: 14px; display: block; }
		}`;
		document.head.appendChild(style);
	}
}

export interface TodoItem {
	content?: string;
	status?: string;
	activeForm?: string;
}

export type MessagesPage = PaginatedMessages;

export interface MessagesQueryData {
	pages: MessagesPage[];
	pageParams: unknown[];
}

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	input?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ToolCallRow {
	id?: string;
	toolUseId: string;
	toolName: string;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	errorMessage?: string;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	createdAt?: string;
	permissionDecidedAt?: string | null;
}

export type NarratorMsg = TreeMessage;

export interface PermissionCallbacks {
	pendingPermission: PendingPermission | null;
	pendingPermsMap: Map<string, PendingPermission>;
	onPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
	) => void;
	onQuestionSubmit: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny: (requestId: string) => void;
	onBgAgentRetry?: (toolUseId: string) => void;
	bgRetryDismissedIds: Set<string>;
}

import type { ToolCallData } from "./ToolCallCard";

export type FlatToolItem =
	| {
			kind: "tool";
			tc: ToolCallData;
			msg: NarratorMsg;
			children: NarratorMsg[];
			isSubagent: boolean;
	  }
	| {
			kind: "reasoning";
			msg: NarratorMsg;
			reasoningText: string;
	  };

export interface NarratorPanelProps {
	narratorId: string;
	narrator?: {
		id: string;
		chapterId?: string | null;
		title?: string | null;
		model: string | null;
		status: string;
		totalCostUsd: number | null;
		permissionMode: string | null;
		planMode?: boolean | null;
		todosJson?: TodoItem[] | null;
		todosToolUseId?: string | null;
	};
	onForkFromMessage?: (messageUuid: string) => void;
	highlightMessageId?: string;
	/** Write selected chat text to the paired terminal panel. Provided by the session layout when a terminal is open. */
	onSendToTerminal?: (text: string) => void;
	/** Ref callback exposed to the parent so the terminal panel can append text into the chat input. */
	appendInputRef?: React.MutableRefObject<((text: string) => void) | null>;
	/** Whether the terminal panel is currently visible. Controls the toggle button state. */
	terminalOpen?: boolean;
	/** Callback to toggle terminal panel visibility. When provided, shows the terminal toggle button. */
	onToggleTerminal?: () => void;
}

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const STREAMING_CHUNKS_MSG_ID = "__streaming_tool_chunks__";

export const PERM_MODE_ICONS: Record<string, React.ReactNode> = {
	default: createElement(IconShield, { size: 14 }),
	acceptEdits: createElement(IconPencilCheck, { size: 14 }),
	bypassPermissions: createElement(IconShieldOff, { size: 14 }),
	dontAsk: createElement(IconHandStop, { size: 14 }),
};
