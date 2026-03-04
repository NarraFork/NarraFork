import { IconHandStop, IconPencilCheck, IconShield, IconShieldOff } from "@tabler/icons-react";
import { createElement } from "react";
import type {
	BaseContentBlock,
	ToolCallRecord,
	ToolUseContentBlock,
	TreeMessage,
} from "../../lib/api";
import type { ToolCallData } from "./ToolCallCard";

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
	id?: string;
	content?: string;
	status?: string;
	activeForm?: string;
}

export type MessagesPage = {
	messages: NarratorMsg[];
	hasMore: boolean;
	nextCursor: string | null;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
};

export interface MessagesQueryData {
	pages: MessagesPage[];
	pageParams: unknown[];
}

export type NarratorMsg = TreeMessage;
export type ContentBlock = BaseContentBlock;
export type ToolCallRow = ToolCallRecord;
export type ToolUseBlock = ToolUseContentBlock;

export interface PendingPermission {
	id: string;
	toolName: string;
	toolUseId?: string;
	inputJson: unknown;
	decisionReason?: string;
	suggestions?: unknown[];
}

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

export interface NarratorPanelSnapshot {
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
	errorMessage?: string | null;
	reasoningEffort?: string | null;
}

export interface NarratorPanelProps {
	narratorId: string;
	narrator?: NarratorPanelSnapshot;
	onForkFromMessage?: (messageUuid: string) => void;
	highlightMessageId?: string;
	onSendToTerminal?: (text: string) => void;
	appendInputRef?: React.MutableRefObject<((text: string) => void) | null>;
	terminalOpen?: boolean;
	onToggleTerminal?: () => void;
}

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const STREAMING_CHUNKS_MSG_ID = "__streaming_tool_chunks__";

export const SUBAGENT_STREAMING_ID_PREFIX = "__streaming_subagent_";

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return block.type === "tool_use" && typeof block.id === "string";
}

export function isStreamingChunksMessage(msg: NarratorMsg | null | undefined): boolean {
	return !!msg && msg.id === STREAMING_CHUNKS_MSG_ID;
}

export function isSubagentStreamingMessage(msg: NarratorMsg | null | undefined): boolean {
	return !!msg && msg.id.startsWith(SUBAGENT_STREAMING_ID_PREFIX);
}

export function isNoMergeMessage(msg: NarratorMsg | null | undefined): boolean {
	return !!msg?._noMerge;
}

export const PERM_MODE_ICONS: Record<string, React.ReactNode> = {
	default: createElement(IconShield, { size: 14 }),
	acceptEdits: createElement(IconPencilCheck, { size: 14 }),
	bypassPermissions: createElement(IconShieldOff, { size: 14 }),
	dontAsk: createElement(IconHandStop, { size: 14 }),
};
