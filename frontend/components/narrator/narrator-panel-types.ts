import {
	IconEye,
	IconHandStop,
	IconNotebook,
	IconPencilCheck,
	IconShield,
	IconShieldOff,
} from "@tabler/icons-react";
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
	hasMoreAfter?: boolean;
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
	overseerStatus?: "reviewing" | "queued";
}

export interface PermissionCallbacks {
	pendingPermission: PendingPermission | null;
	pendingPermsMap: Map<string, PendingPermission>;
	onPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny: (requestId: string) => void;
	onBgAgentRetry?: (toolUseId: string) => void;
	bgRetryDismissedIds: Set<string>;
	overseerReviewMap: Map<string, "reviewing" | "queued">;
}

export type FlatToolItem =
	| {
			kind: "tool";
			tc: ToolCallData;
			msg: NarratorMsg;
			children: NarratorMsg[];
			isSubagent: boolean;
			blockIndex: number;
	  }
	| {
			kind: "reasoning";
			msg: NarratorMsg;
			reasoningText: string;
			translatedText?: string;
			blockIndex: number;
	  };

export interface NarratorPanelSnapshot {
	id: string;
	chapterId?: string | null;
	title?: string | null;
	model: string | null;
	status: string;
	totalCostUsd: number | null;
	permissionMode: string | null;
	todosJson?: TodoItem[] | null;
	todosToolUseId?: string | null;
	errorMessage?: string | null;
	reasoningEffort?: string | null;
	fastMode?: boolean;
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
	/** Force compact (mobile-style) toolbar layout regardless of viewport width */
	compact?: boolean;
	/** When provided, replaces the back arrow with a minimize button (e.g. return to narraflow) */
	onMinimize?: () => void;
	/** Custom back navigation handler (e.g. subagent → parent narrator) */
	onBack?: () => void;
	/** When true, shows a skeleton overlay instead of messages (e.g. during node resize) */
	isResizing?: boolean;
	/** Called on pointerdown on the header bar — allows parent to initiate drag */
	onHeaderPointerDown?: (e: React.PointerEvent) => void;
}

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_IMAGE_LONG_EDGE = 1568;
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export { formatFileSize, isTextFile } from "@shared/text-file-types";

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

export const PERM_MODES = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"readOnly",
	"plan",
	"dontAsk",
] as const;

export const PERM_MODE_ICONS: Record<string, React.ReactNode> = {
	default: createElement(IconShield, { size: 14 }),
	acceptEdits: createElement(IconPencilCheck, { size: 14 }),
	bypassPermissions: createElement(IconShieldOff, { size: 14 }),
	readOnly: createElement(IconEye, { size: 14 }),
	plan: createElement(IconNotebook, { size: 14 }),
	dontAsk: createElement(IconHandStop, { size: 14 }),
};
