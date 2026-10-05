import {
	IconEye,
	IconHandStop,
	IconPencilCheck,
	IconShield,
	IconShieldOff,
} from "@tabler/icons-react";
import { createElement } from "react";
import type {
	ApiEntity,
	BaseContentBlock,
	ToolCallRecord,
	ToolUseContentBlock,
	TreeMessage,
} from "../../lib/api";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../../lib/responsive";
import type { Question } from "./question/ask-user-question-utils";

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
		@keyframes perm-btn-pulse {
			0%, 100% { outline-color: transparent }
			50% { outline-color: var(--perm-pulse-color, currentColor) }
		}
		.perm-btn-pulse {
			outline: 2px solid transparent;
			outline-offset: 1px;
			animation: perm-btn-pulse 1.5s ease-in-out infinite;
		}
		@media ${MOBILE_VIEWPORT_MEDIA_QUERY} {
			.context-ring { width: 14px !important; height: 14px !important; display: flex !important; align-items: center; justify-content: center; }
			.context-ring svg { width: 14px; height: 14px; display: block; }
		}`;
		document.head.appendChild(style);
	}
}

export type MessagesPage = {
	messages: NarratorMsg[];
	hasMore: boolean;
	nextCursor: string | null;
	hasMoreAfter?: boolean;
	prevCursor?: string | null;
};

export type NarratorMsg = TreeMessage;
export type ContentBlock = BaseContentBlock;
export type ToolCallRow = ToolCallRecord;
export type ToolUseBlock = ToolUseContentBlock;

import type { PendingPermission } from "@frontend/types/narrator";

export type { PendingPermission } from "@frontend/types/narrator";

/**
 * Everything needed to mount an answer form for ONE open asynchronous question.
 *
 * A prepared slot rather than the raw record: the mounting layer (the vlist bridge)
 * must not know how an answer is submitted, and the owner of the mutations
 * (NarratorPanel) already does. This also keeps the banner's required `Question` shape
 * conversion in one place.
 */
export interface AsyncQuestionSlot {
	id: string;
	/** Local draft identity; distinct from the async API record id. */
	draftId?: string;
	questions: Question[];
	busy?: boolean;
	denyLabel?: string;
	/** The agent is blocked on this question via `Await` — render it as urgent. */
	awaited?: boolean;
	/** Copy for the awaited notice, resolved by the owner (the bridge has no i18n). */
	awaitedLabel?: string;
	onSubmit: (questionId: string, answers: Record<string, string>) => void;
	onDismiss: (questionId: string) => void;
}

export interface PermissionCallbacks {
	pendingPermission: PendingPermission | null;
	/** Complete concurrent permission list, including multiple requests under one parent subagent. */
	pendingPermissions: PendingPermission[];
	onPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit: (requestId: string, answers: Record<string, string>) => void;
	onQuestionReflect: (requestId: string) => Promise<void> | void;
	onQuestionDeny: (requestId: string) => void;
	/** Release the blocked loop and move the question to the async inbox. */
	onQuestionDefer?: (requestId: string) => Promise<void> | void;
	/**
	 * Open ASYNCHRONOUS questions, keyed by the tool_use id that asked them.
	 *
	 * Carried alongside the pending permissions rather than as a separate prop because
	 * consumers need both to decide what a row's interaction area hosts, and a second
	 * channel would let the two arrive out of step. It stays a DISTINCT field, though:
	 * everything that means "the session is blocked" reads `pendingPermissions`, and an
	 * async question must never register there.
	 */
	asyncQuestions?: ReadonlyMap<string, AsyncQuestionSlot>;
}

export interface NarratorPanelSnapshot {
	id: string;
	chapterId?: string | null;
	title?: string | null;
	model: string | null;
	status: string;
	totalCostUsd: number | null;
	permissionMode: string | null;
	traits?: string[] | null;
	planMode?: boolean;
	errorMessage?: string | null;
	errorCode?: string | null;
	substatus?: string[] | string | null;
	reasoningEffort?: string | null;
	fastMode?: boolean;
	fastModeOverride?: "inherit" | "on" | "off";
	turnStartedAt?: string | null;
}

export interface NarratorDetailsViewerInfo {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

/** Props that NarratorPanel exposes for the external details sidebar panel */
export interface NarratorDetailsPanelExternalProps {
	narratorId: string;
	narrator: ApiEntity;
	viewers: NarratorDetailsViewerInfo[];
	defaultModelValue?: string;
	planReflectionAutoApproveGlobal?: boolean;
	dangerReflectionGlobal?: boolean;
	dangerReflectionGlobalLevel?: "off" | "light" | "standard" | "strict";
}

export interface NarratorPanelProps {
	narratorId: string;
	narrator?: NarratorPanelSnapshot;
	onForkFromMessage?: (messageId: string) => void;
	highlightMessageId?: string;
	/** Re-arm a message jump without remounting the session. */
	highlightRequestId?: string;
	onSendToTerminal?: (text: string) => void;
	appendInputRef?: React.MutableRefObject<((text: string) => void) | null>;
	terminalOpen?: boolean;
	onToggleTerminal?: () => void;
	/** Force compact (mobile-style) toolbar layout regardless of viewport width */
	compact?: boolean;
	/** Own the physical left/right safe areas for an edge-to-edge fullscreen mobile view. */
	ownsHorizontalSafeArea?: boolean;
	/** When provided, replaces the back arrow with a minimize button (e.g. return to narraflow) */
	onMinimize?: () => void;
	/** Custom back navigation handler (e.g. subagent → parent narrator) */
	onBack?: () => void;
	/** Open this embedded narrator as a standalone route. */
	onOpenStandalonePage?: () => void;
	/**
	 * Delegate child-session opening to the current desktop/mobile host.
	 *
	 * `messageId` asks the opened session to scroll to and flash that message; hosts
	 * that cannot jump may ignore it. Callers that only know which child to open omit
	 * it, which opens the session at its tail.
	 */
	onViewSubagentSession?: (narratorId: string, messageId?: string) => void;
	/** Called on pointerdown on the header bar — allows parent to initiate drag */
	onHeaderPointerDown?: (e: React.PointerEvent) => void;
	/** Close this panel (used in workspace multi-panel mode) */
	onClose?: () => void;
	/** Open a terminal panel next to this narrator (workspace mode) */
	onOpenTerminalPanel?: () => void;
	/** Minimal chrome for workspace secondary preview panels */
	workspacePreview?: boolean;
	/** Skip auto-focusing the main input when a preview is promoted to primary */
	suppressAutoFocusOnPromote?: boolean;
	/** Whether the details panel is open (desktop sidebar mode) */
	detailsPanelOpen?: boolean;
	/** Toggle the details panel (desktop sidebar mode) */
	onToggleDetailsPanel?: () => void;
	/** Callback that NarratorPanel calls when details props change, so the parent can render the sidebar */
	onDetailsPropsChange?: (props: NarratorDetailsPanelExternalProps) => void;
	/** Whether the spec panel is open (desktop sidebar mode) */
	specPanelOpen?: boolean;
	/** Toggle the spec panel (desktop sidebar mode) */
	onToggleSpecPanel?: () => void;
}

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_IMAGE_LONG_EDGE = 1568;
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Downscale an image File so its longest edge fits within `maxEdge`, keeping
 * aspect ratio. PNG stays PNG, other formats become JPEG. Returns the original
 * file when it is already small enough or when canvas processing is unavailable.
 */
export function resizeImageIfNeeded(file: File, maxEdge: number): Promise<File> {
	return new Promise((resolve, reject) => {
		const img = document.createElement("img");
		const url = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(url);
			const { naturalWidth: w, naturalHeight: h } = img;
			if (Math.max(w, h) <= maxEdge) {
				resolve(file);
				return;
			}
			const scale = maxEdge / Math.max(w, h);
			const nw = Math.round(w * scale);
			const nh = Math.round(h * scale);
			const canvas = document.createElement("canvas");
			canvas.width = nw;
			canvas.height = nh;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve(file);
				return;
			}
			ctx.drawImage(img, 0, 0, nw, nh);
			// Use the real content type for output (PNG stays PNG, others become JPEG)
			const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
			canvas.toBlob(
				(blob) => {
					if (!blob) {
						resolve(file);
						return;
					}
					resolve(new File([blob], file.name, { type: outputType }));
				},
				outputType,
				0.85,
			);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Failed to load image"));
		};
		img.src = url;
	});
}

export const MAX_TEXT_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export { formatFileSize, isTextFile } from "@shared/text-file-types";

export const STREAMING_CHUNKS_MSG_ID = "__streaming_tool_chunks__";

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return block.type === "tool_use" && typeof block.id === "string";
}

export function isStreamingChunksMessage(msg: NarratorMsg | null | undefined): boolean {
	return !!msg && msg.id === STREAMING_CHUNKS_MSG_ID;
}

export const PERM_MODES = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"readOnly",
	"dontAsk",
] as const;

export const PERM_MODE_ICONS: Record<string, React.ReactNode> = {
	default: createElement(IconShield, { size: 14 }),
	acceptEdits: createElement(IconPencilCheck, { size: 14 }),
	bypassPermissions: createElement(IconShieldOff, { size: 14 }),
	readOnly: createElement(IconEye, { size: 14 }),
	dontAsk: createElement(IconHandStop, { size: 14 }),
};
