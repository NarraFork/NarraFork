/**
 * segment-adapter.ts — Maps the app's message data model to vlist element specs.
 *
 * Bridges `message-segments.ts` RenderSegments + content blocks onto the
 * registry's element kinds + their measure input `data`. PretextMessageList
 * iterates segments → adapter → `measureElement(kind, data, …)` → heights.
 *
 * This mirrors the proven dispatch in MessageRenderer.tsx / message-segments.ts
 * (which lane a block belongs to, how a tool-run groups) but emits plain data
 * specs instead of React elements — keeping the mapping pure, testable, and DOM-
 * free. It intentionally does NOT import MessageRenderer/MessageBubble (that
 * would violate the isolation guard); it re-derives the classification locally.
 *
 * Scope note: this is the classification + light field-extraction layer. A few
 * kinds (tool-call detail payloads, permission option trees) carry rich data
 * that the caller enriches; the adapter marks those with the element kind + the
 * raw block/tool so the render layer can pull details lazily.
 */

import { resolveAssistantTextDisplay, type TextCitation } from "../citations";
import { isCommunicationTool, limitCommunicationPreview } from "../communication-tool";
import { type FileReference, fileReferenceDisplay } from "../file-reference";
import { normalizeFileReferenceContext } from "../file-reference-context";
import { knowledgeExcerpt } from "../knowledge-excerpt";
import {
	contextBlockViews,
	injectionBlockViews,
	isNativeModelContextBlock,
} from "../native-injection";
import { hasUsablePlanBody } from "../plan-reference";
import { isPreferOpenTool } from "../prefer-open-tool";
import { type ProgressPhase, shouldShowThinkingChars } from "../progress-phase";
import {
	escapeMarkdown,
	rawSideCarToMarkdown,
	readSideCarBody,
	type SideCarBody,
	type SideCarInboundMessage,
	sideCarBodyToMarkdown,
	verbatimOutputToMarkdown,
} from "../sidecar-body";
import { subagentResultText } from "../subagent-result-text";
import {
	type CommunicationState,
	communicationSelectors,
	communicationTargetLabel,
	deriveCommunicationState,
	resolveCommunicationTargets,
} from "./communication-state";
import type { VListElementKind } from "./element-kinds";
import type { InjectionTarget } from "./injection-target";
import type { RenderLod } from "./prepared-block";
import { type ReasoningLiveTail, resolveReasoningLiveTail } from "./reasoning-live-tail";
import {
	type ContentBlockLike,
	groupReasoningRuns,
	hasStructuredReasoning,
	parseReasoningSegments,
	type ReasoningSegment,
} from "./reasoning-segments";
import { parseStreamingReasoningTitles } from "./reasoning-segments-cache";
import {
	buildReflectionNoticeData,
	getPermissionReflectionSuggestion,
	normalizeReflectionAfterToolStatus,
	type ReflectionNoticeData,
	reflectionTitleKeyPrefix,
	reflectionTitleKeySuffix,
} from "./reflection";
import { reconcileSourceText } from "./source-text";
import {
	isLiveStreamingBlock,
	isLiveStreamingRun,
	STREAMING_MESSAGE_ID,
} from "./streaming-live-blocks";
import {
	type ClassifyToolDetailInput,
	classifyToolDetail,
	describeToolBody,
	isTruncated,
	resolveFileDiffStats,
	type ToolCappedDetail,
	toolInputFieldRange,
	toolInputFieldView,
	toolOutputValue,
} from "./tool-detail";
import { collectTruncatedLeaves, hasTruncatedLeaf, readLeafText } from "./tool-io-projection";
import { resolveTurnUsageLines, type TurnUsageJson, type UsageNumberFormatter } from "./turn-usage";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal structural mirrors of the app types (avoid importing app modules here
// so the adapter stays inside the vlist isolation boundary and unit-testable).
// The caller passes real NarratorMsg/RenderSegment values that structurally
// satisfy these.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterContentBlock {
	type: string;
	text?: string | null;
	/** Native system injection's exact model-facing projection. */
	modelText?: string | null;
	/** Immutable UI-only publication receipt, shared by SQLite and PostgreSQL. */
	publicationResult?: {
		logicalRunId: string;
		truncated: boolean;
		originalBytes: number;
		sourceResultRef: string;
	};
	thinking?: string | null;
	translatedText?: string | null;
	query?: string | null;
	queries?: string[] | null;
	status?: string | null;
	revisedPrompt?: string | null;
	result?: string | null;
	width?: number | null;
	height?: number | null;
	filename?: string | null;
	mediaType?: string | null;
	imageId?: string | null;
	previewUrl?: string | null;
	/**
	 * image_generation: the server-side file the generated image was saved to.
	 *
	 * This — NOT `result` — is the normal image source: the event handler writes the
	 * base64 payload to disk and persists only the path (`result` survives only when
	 * that write failed). Dropping it from the media payload is what left the vlist
	 * with a correctly reserved but permanently empty image box.
	 */
	savedPath?: string | null;
	/** image_generation: partial-preview file path while the image streams in. */
	partialSavedPath?: string | null;
	subtype?: string | null;
	summary?: string | null;
	/** error block: the error message (chunk reads errorBlock.message). */
	message?: string | null;
	/** spec_goal_added / spec_continuation: the task text (chunk reads block.task). */
	task?: string | null;
	/** spec_goal_added: whether the goal is newly added vs already existed. */
	added?: boolean | null;
	/** spec_*: whether the task is a protected commitment. */
	protected?: boolean | null;
	/** command block (bash_command): the shell command body. */
	command?: string | null;
	/** spec_fork_carryover / spec_context_cleared summary counts. */
	total?: number | null;
	open?: number | null;
	protectedOpen?: number | null;
	/** segment_compact_failed: the failure detail (chunk reads block.error). */
	error?: string | null;
	/** compact / segment_compact: live char count streamed while compacting. */
	outputChars?: number | null;
	/** compact / segment_compact: which live count the label features. */
	progressPhase?: ProgressPhase | null;
	/** compact / segment_compact: live thinking-channel char count. */
	thinkingChars?: number | null;
	/**
	 * compact / segment_compact: 1-based ordinal of the summary retry now in
	 * flight. Transient render-state: the vlist paints live ticks from
	 * `compact-progress-store` (not this field); the server does not re-persist
	 * it. Absent = not retrying. Still read here when composing the initial
	 * `data.text` fallback for a marker loaded mid-run.
	 */
	retryCount?: number | null;
	/** segment_compact: number of messages folded into the segment summary. */
	messageCount?: number | null;
	/** assistant text: source citations indexed against `text`. */
	citations?: TextCitation[] | null;
	/** system_injection: which producer injected this (`living_work_spec`, `bg_agent`, …). */
	source?: string | null;
	[key: string]: unknown;
}

export interface AdapterMessage {
	id?: string;
	role: string;
	contentJson: AdapterContentBlock[];
	createdAt?: string;
	/**
	 * Slash command the user typed, when this user message was produced by one.
	 *
	 * The server EXPANDS a command into its full prompt template before storing
	 * it, so `contentJson`'s text block holds the whole (often multi-thousand
	 * character) expansion while this field keeps the short `/name args` the user
	 * actually wrote. Rendering the expansion as the bubble body is what turned a
	 * one-line command into a screen-filling wall of text in the virtual list;
	 * the bubble shows this line and folds the expansion away instead.
	 */
	commandText?: string | null;
	/** Owning narrator — the upload scope fallback for a user message's images. */
	narratorId?: string | null;
	/**
	 * Synthetic live row only: index of the text/reasoning block still being written,
	 * or -1 when the model has moved on to tool calls.
	 *
	 * Stamped by the streaming accumulators, the only layer that sees the real arrival
	 * order — the row builder appends tool cards after the text lanes, so array
	 * position cannot express it. Read through `./streaming-live-blocks`, which falls
	 * back to a positional rule when this is absent.
	 */
	liveBlockIndex?: number;
	creator?: {
		id?: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	/**
	 * Who authored the content, independent of `role`. System- and AI-injected
	 * turns are stored as `role: "user"` because providers treat the trailing user
	 * message as the current turn and the continuation scheduler only resumes from
	 * user/assistant — so this is what distinguishes them. Null on rows written
	 * before the column existed, which means "user". See `@shared/message-origin`.
	 */
	origin?: string | null;
	/** Display-only source label (`sourceKey` or `sourceKey:detail`). */
	originLabel?: string | null;
	/**
	 * Per-turn usage accounting, surfaced as measured text rows around an assistant
	 * message when the reader enabled `showTokenUsage`. See `./turn-usage.ts`.
	 */
	turnUsageJson?: TurnUsageJson | null;
	tokensIn?: number | null;
	costUsd?: number | null;
	meterUsage?: number | null;
	/** Eager mailbox/outbox delivery lifecycle projected onto the canonical message. */
	deliveryId?: string | null;
	deliveryKind?: "user_input" | "agent_message" | "task_notice" | null;
	deliveryState?: "queued" | "claimed" | "materialized" | "failed" | "cancelled" | null;
}

function deliveryProjection(message?: AdapterMessage): Record<string, unknown> {
	if (!message?.deliveryId) return {};
	return {
		deliveryId: message.deliveryId,
		deliveryKind: message.deliveryKind ?? null,
		deliveryState: message.deliveryState ?? null,
	};
}

/** A tool-run item (structural subset of message-segments ToolRunItem).
 * NOTE: the real `tc` is ToolCallData — it has toolName/status/inputJson but NO
 * `summary` field (a display summary is derived downstream from inputJson). */
export interface AdapterToolItem {
	/** Already assigned by the producer to distinguish repeated tool-use occurrences. */
	dedupeSuffix?: number;
	blockIndex: number;
	isSubagent: boolean;
	/** Owning assistant message (present on real ToolRunItem). */
	msg?: AdapterMessage;
	tc: {
		/** Actual row PK, already mapped from tool_use.tcId by message-segments. */
		id?: string;
		messageId?: string;
		executionAttempt?: number;
		toolName: string;
		status?: string | null;
		inputJson?: unknown;
		outputJson?: unknown;
		toolUseId?: string;
		/** Subagent activity summary (drives recent-calls rows on subagent cards). */
		_subagentActivity?: {
			latestToolCalls?: unknown[];
			model?: string | null;
			/** Effective thinking tier, already resolved through the global default. */
			reasoningEffort?: string | null;
			/**
			 * Child narrator id. Height-bearing: the recent-calls title row only
			 * carries the "open full session" button once a child exists (the taller
			 * compact-xs row), exactly like SubagentCard gates it.
			 */
			subagentNarratorId?: string | null;
			/**
			 * Files the child changed on disk, aggregated once per page by the server.
			 * Height-affecting on the card (a row list), so it is keyed in
			 * `subagentRevision`.
			 */
			fileChanges?: unknown;
			/**
			 * The child is currently taken over by the user. Reaches the card through
			 * the reconnect catch-up snapshot (the live path writes `_takenOver` on the
			 * block instead), so both sources are consulted — see `resolveTakenOver`.
			 */
			takenOver?: boolean;
		} | null;
		/**
		 * The subagent this call is waiting on is TAKEN OVER by the user, so the call
		 * is blocked until the user releases it. Server-derived; painted as a badge in
		 * the card's already-fixed header row.
		 */
		_takenOver?: boolean;
		[key: string]: unknown;
	};
}

/** Height-neutral identity for on-demand payloads, independent of display/LOD keys. */
export interface AdapterToolDetailRef {
	toolCallId?: string;
	messageId?: string;
	executionAttempt?: number;
}

export function resolveToolDetailRef(item: AdapterToolItem): AdapterToolDetailRef {
	const messageId = item.msg?.id ?? item.tc.messageId;
	const block = item.msg?.contentJson[item.blockIndex];
	const attempt =
		item.tc.executionAttempt ??
		(block?.type === "tool_use" && block.id === item.tc.toolUseId
			? block.executionAttempt
			: undefined);
	return {
		...(item.tc.id ? { toolCallId: item.tc.id } : {}),
		...(messageId && messageId !== "__streaming__" ? { messageId } : {}),
		...(typeof attempt === "number" ? { executionAttempt: attempt } : {}),
	};
}

/**
 * Whether this call should show the "taken over by user" badge.
 *
 * Two sources, because they cover different moments and neither is redundant:
 *   - `tc._takenOver`               — message load + the live takeover patch
 *   - `_subagentActivity.takenOver` — the reconnect catch-up snapshot
 *
 * GATED ON A NON-TERMINAL STATUS, and that gate is load-bearing rather than
 * cosmetic. Takeover state is cleared inside the subagent loop at several points
 * that do NOT broadcast (see the handoff branches in narrator-session.ts), so a
 * card can hold a stale `true` after its call has already finished. A FINISHED
 * call is never blocked on anything, so its badge would be a lie about why the
 * session is stuck — and "the badge lingers on a completed card" is precisely the
 * failure that would teach users to ignore it.
 */
function resolveTakenOver(item: AdapterToolItem): boolean {
	if (isTerminalStatus(item.tc.status)) return false;
	return item.tc._takenOver === true || item.tc._subagentActivity?.takenOver === true;
}

/**
 * {@link resolveTakenOver}, exported so the live-patch tests can assert what the
 * card actually PAINTS rather than restating the OR.
 *
 * That distinction is the bug this guards: a release that writes only
 * `_takenOver: false` passes any field-level assertion while this function still
 * returns true, because the activity summary's copy of the flag is untouched.
 */
export function resolveToolItemTakenOver(item: AdapterToolItem): boolean {
	return resolveTakenOver(item);
}

/**
 * Effective `_metadata` for a tool call, including the LIVE streaming output.
 *
 * `classifyToolDetail` reads a running command's partial stdout from
 * `metadata._streamingOutput` (that is where the persisted server payload carries
 * it), but the live WS path writes it onto the tool call itself as
 * `tc._streamingOutput` — the same shape the chunked `ToolCallCard` reads directly.
 *
 * Without this bridge the exact path could never show a running command's output:
 * the field was present on the item and simply never looked at, so a long build
 * rendered an empty card until it finished. Lifting it into the metadata object is
 * what makes the streaming body measurable (and therefore renderable) here.
 *
 * A persisted `metadata._streamingOutput` still wins: once the real payload exists
 * it is the authoritative one.
 */
function resolveToolMetadata(tc: AdapterToolItem["tc"]): unknown {
	const persisted =
		(tc.outputJson as { _metadata?: unknown } | null | undefined)?._metadata ??
		(tc as { _metadata?: unknown })._metadata;
	const liveOutput = (tc as { _streamingOutput?: unknown })._streamingOutput;
	// Same bridge as the streaming output, for the same reason: the live WS path
	// writes the determinate progress measurement onto the tool call itself, while
	// the classifier reads its live inputs off the metadata object. Without this the
	// field is present on the item and never looked at, so a running transfer
	// renders with no bar.
	const liveProgress = (tc as { _structuredProgress?: unknown })._structuredProgress;
	if (liveOutput === undefined && liveProgress === undefined) return persisted;
	const base = persisted && typeof persisted === "object" ? (persisted as object) : {};
	const out: Record<string, unknown> = { ...base };
	if (
		liveOutput !== undefined &&
		(base as { _streamingOutput?: unknown })._streamingOutput === undefined
	) {
		out._streamingOutput = liveOutput;
	}
	if (
		liveProgress !== undefined &&
		(base as { _structuredProgress?: unknown })._structuredProgress === undefined
	) {
		out._structuredProgress = liveProgress;
	}
	return out;
}

/** Terminal tool statuses (subagent card gates its result preview on this). */
const TERMINAL_TOOL_STATUSES = new Set(["success", "fail", "cancelled", "error", "completed"]);

function isTerminalStatus(status?: string | null): boolean {
	return status != null && TERMINAL_TOOL_STATUSES.has(status);
}

/**
 * Header display summary for a tool call.
 *
 * Prefers the AUTHORITATIVE resolver injected by the shell (tool-display's
 * `getSummary`, the same function the chunked ToolCallCard header uses), so both
 * render paths show identical text. The local fallback is only a deterministic
 * stand-in for unit tests and callers that inject nothing.
 *
 * The fallback deliberately reads raw fields off `inputJson`, which means it
 * yields "" for a `{_truncated:true, preview, _hints}` wrapper — exactly the case
 * that made Edit/Write headers render with no target path. `getSummary` resolves
 * those through `_hints` / a preview scan, hence the injection.
 */
function toolSummary(tc: AdapterToolItem["tc"], ctx?: AdapterContext): string {
	const resolved = ctx?.resolveToolSummary?.(tc);
	if (typeof resolved === "string") return resolved;
	const input = (tc.inputJson ?? {}) as Record<string, unknown>;
	for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
		const v = input[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return "";
}

/** Narrow an unknown JSON value to a plain record (empty object otherwise). */
function asObject(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Read a non-empty string field from a record; undefined otherwise. */
function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
	const v = record[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Trim a possibly-null string; undefined when absent or blank. */
function nonEmptyTrimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

export type AdapterSegment =
	| { kind: "message"; msg: AdapterMessage; visibleBlockIndices?: number[] }
	| { kind: "tool-run"; items: AdapterToolItem[]; sourceMessages: AdapterMessage[] };

export type AdapterActivityInput =
	| {
			kind: "reasoning";
			msg?: AdapterMessage;
			blockIndex?: number;
			block?: AdapterContentBlock;
			/**
			 * Hand-off-stable key base for this reasoning RUN (an ordinal within the
			 * activity unit, assigned by the caller's `groupRenderUnits`).
			 *
			 * Row keys must not derive from `msg.id`: a LIVE run carries the synthetic
			 * `__streaming__` id and gains a real one the moment the turn persists, so an
			 * id-derived key changes at the hand-off and the row is rebuilt from scratch
			 * although only its content settled. Since low LOD now folds live content too
			 * (see render-units.ts), that rebuild would be visible as the very icon/frame
			 * jump the fold exists to remove.
			 */
			stableKeyBase?: string;
			/** This block's offset inside its run (rows of one run share the base). */
			stableKeyOffset?: number;
	  }
	| {
			kind: "tool";
			msg?: AdapterMessage;
			blockIndex?: number;
			tc?: AdapterToolItem["tc"];
			/**
			 * True for an Agent/Task/Send-style subagent call (the caller computes it
			 * from the tool name / activity summary / children). Drives the drilled-in
			 * card's KIND — see `toolTraceItem`'s `cardKind`.
			 */
			isSubagent?: boolean;
			/**
			 * Disambiguator for a REPEATED tool-use id within one activity unit.
			 *
			 * A provider retry can put the same id in two persisted messages — two real
			 * calls the reader must both see. Without a suffix their row keys collide on
			 * `tool-<id>`, and because trace rows are absolutely positioned at their
			 * measured offsets, the two rows paint on top of each other. Absent for the
			 * normal single-occurrence case, so ordinary rows keep the hand-off-stable key.
			 */
			dedupeSuffix?: number;
	  };

/**
 * The selection / menu coordinates of one folded trace row. Carried so the
 * renderer can wrap the row in an interaction surface; **height-neutral** —
 * exactly like `toolName` / `category` / `iconColor`, the measure layer only
 * passes it through and never reads it for layout.
 */
export interface AdapterTraceRowIdentity {
	/** Owning message id. */
	messageId: string;
	/**
	 * Primary block index. For a REASONING row this is its reasoning RUN's START
	 * index, not the row's own block index — the activity fold walks reasoning
	 * blocks one by one while the selection index only registers a run's start, so
	 * a row must identify itself by the start to match an existing entry.
	 */
	blockIndex: number;
	/** Every source block index this row represents (a reasoning run spans many). */
	blockIndices?: readonly number[];
	/**
	 * Tool rows: the tool-call id. The integration layer turns this into the
	 * authoritative `tc-`/`sa-` blockId by looking the entry up in the selection
	 * index (which registers both aliases), so the adapter never has to guess the
	 * prefix — it has no access to the child messages that decide it.
	 */
	toolUseId?: string;
	/** Tool rows: the raw tool name. */
	toolName?: string;
	/** Exact persisted ref for the inspector, independent of selection aliases. */
	toolDetailRef?: AdapterToolDetailRef;
}

interface AdapterTraceItem {
	title: string;
	hasIcon?: boolean;
	iconColor?: string;
	/** Tool name for the real category glyph (renderer only, height-neutral). */
	toolName?: string;
	/** Resolved tool category for the glyph (renderer only, height-neutral). */
	category?: string;
	bodyText?: string | null;
	shimmer?: boolean;
	key?: string;
	/** Resolved header summary (kept for parity/debugging; height-neutral). */
	summary?: string;
	/**
	 * Added / removed line counts for a Write or Edit row (`+12 -3`).
	 *
	 * Height-neutral — one nowrap span sharing the row's fixed line, like the status
	 * glyph and the duration beside it. But it IS painted from the cached payload,
	 * so `traceRevision` keys it: the counts can change while `key`, `status` and
	 * every height-bearing field stay put (a payload fetch resolving a truncated
	 * Edit, a live patch landing the tool's metadata), and a stale entry would keep
	 * drawing the previous numbers.
	 */
	diffStats?: { added: number; removed: number };
	/**
	 * Raw tool status. Height-neutral (a fixed 12px glyph slot inside the row's
	 * existing content lane), and part of the measure cache's `traceRevision` so a
	 * status transition on a folded row re-keys the trace.
	 */
	status?: string | null;
	/**
	 * A live reflection gate's status on this call, when it has one.
	 *
	 * Render-only and height-neutral: it selects the row's shimmer colour (purple while
	 * a gate deliberates) and nothing else. Present so a folded row cannot read its
	 * tool's `pending` as some other phase — the same disambiguation the card gets from
	 * its measured reflection notice. See `@shared/tool-shimmer`.
	 */
	reflectionStatus?: string;
	/**
	 * Lifecycle stamps for the row's timing slot (elapsed while running, final
	 * duration once finished, plus the portaled breakdown popover).
	 *
	 * Height-neutral for the same reason the tool card's header timing is: the text
	 * is a single truncation-free span in the row's fixed-height flex line and the
	 * popover is portaled.
	 */
	timing?: Record<string, number>;
	/** Selection / menu coordinates (renderer only, height-neutral). */
	identity?: AdapterTraceRowIdentity;
	/**
	 * LIVE tail of a streaming reasoning row ("1234 字符…<尾部>"), so the newest
	 * characters stay on screen instead of freezing behind a settled step title.
	 * See `./reasoning-live-tail.ts` for the rationale and the cost bound.
	 *
	 * ⚠️ Consumed at DRAW time and deliberately absent from `traceRevision`, so it
	 * cannot re-key the measurement cache on every delta. Height-neutral: the row is
	 * one fixed truncating line whatever text it carries. Because the cache is keyed
	 * without it, the renderer must read it from the freshly adapted spec rather
	 * than from a measured payload (which may be a cache hit).
	 */
	liveTail?: ReasoningLiveTail;
	/**
	 * LOD-INDEPENDENT identity of the content this row shows (renderer only,
	 * height-neutral).
	 *
	 * The same tool call is a full `tool-call` card at L3+ and a folded trace row at
	 * L1/L2, and nothing else tied those two renderings together. `unitId` is
	 * that link: both carry `tool-<toolUseId>` (reasoning uses
	 * `reason-<stableKeyBase>-<step>`), so a future animated LOD transition can pair
	 * a card with the row it becomes instead of cross-fading unrelated boxes. Emitted
	 * as a `data-nf-unit` attribute; no layer reads it for layout.
	 */
	unitId?: string;
	/**
	 * Whether this row can be drilled into (a real tool call with an id).
	 *
	 * Height-affecting indirectly: it turns the row's leading "•" into a clickable
	 * chevron, which the measure layer reads as `expandable`. The row itself stays
	 * the same fixed height while collapsed.
	 */
	canDrillDown?: boolean;
	/**
	 * The full card payload rendered INSIDE this row when the reader drilled into
	 * it. `undefined` while collapsed, deliberately: a folded trace can hold
	 * hundreds of rows, and classifying every one of their payloads up front would
	 * undo the whole point of the fold. Only an expanded row pays.
	 *
	 * Shape depends on `cardKind`: a `ToolCallData` for an ordinary tool, a
	 * `SubagentCardData` for an Agent/Task/Send row — the drill-down must paint the
	 * same card the call gets at L3+, and a subagent's card is not the generic one.
	 */
	card?: unknown;
	/**
	 * Which card `card` holds — absent means "tool-call" (the overwhelmingly common
	 * case, and what every pre-existing producer emits). Read by the measure layer
	 * to pick `measureSubagentCard` vs `measureToolCall`, and by the render shell to
	 * dispatch `renderElement` the same way.
	 */
	cardKind?: "tool-call" | "subagent-card";
}

export type AdapterRenderUnit =
	| { kind: "segment"; seg: AdapterSegment }
	| {
			kind: "activity";
			key: string;
			items: AdapterActivityInput[];
			sourceMessages: AdapterMessage[];
	  };

/** One element to measure/render: which registry kind + its measure input. */
export interface ElementSpec {
	kind: VListElementKind;
	/** Stable key for React / virtualization. */
	key: string;
	/** Measure input `data` for `measureElement(kind, data, …)`. */
	data: unknown;
	/** Per-kind measure extras (expand state / labels / viewportHeight). */
	opts?: Record<string, unknown>;
	/**
	 * True for the FIRST spec produced by a render-unit (a message segment, a
	 * whole tool-run, an activity trace, or a divider). Marks a top-level boundary
	 * so the layout can open a larger gap BEFORE this item (i.e. after the
	 * previous unit) while keeping intra-message content blocks and in-run tool
	 * cards tight. Height-neutral; consumed only by the gap resolver.
	 */
	unitStart?: boolean;
	/**
	 * LOD-INDEPENDENT identity of the content this element shows.
	 *
	 * `key` cannot serve this purpose: a folded batch mints keys like
	 * `toolrun-count-tool-<id>` from its first member, so the same tool has a
	 * different key at every level. `unitId` is the same string wherever the content
	 * appears — a `tool-call` card at L3+ and the trace row it folds into at L1/L2
	 * both carry `tool-<toolUseId>` — which is what a future animated LOD transition
	 * needs to pair the two renderings. Height-neutral; surfaced as `data-nf-unit`.
	 */
	unitId?: string;
	/**
	 * LOD-INDEPENDENT identity of the ACTIVITY GROUP this element belongs to.
	 *
	 * The morph admission window judges a group's members on the GROUP's box, because
	 * the two forms differ enormously: folded, a 12-tool group is one ~228px trace;
	 * expanded, it is 12 cards spanning ~4800px. Judged on their own boxes, the later
	 * cards fall outside the window that the folded rows all sit inside, so they pair
	 * with nothing and teleport while their neighbours ease.
	 *
	 * That box used to be derived from `unitStart`, which fails at exactly the level it
	 * is needed: at L3+ grouping is off, so every spec starts its own render unit, the
	 * flag is true for all of them, and the "group" box collapses to each element's own
	 * box. This id is instead assigned from the activity grouping that would apply at a
	 * LOW lod, computed at every level, so one group's members share it on both sides.
	 *
	 * Absent for anything outside an activity group — a markdown body, a bubble, a
	 * divider, a lone call — whose two forms are the same element and which is
	 * correctly judged on its own box. Height-neutral; assigned after the manifest,
	 * read only by the morph layer.
	 */
	morphGroupId?: string;
}

export interface AdapterContext {
	lod: RenderLod;
	/** Explicit interaction override; undefined preserves the measure's default. */
	isExpanded?: (key: string) => boolean | undefined;
	/** L3 / L4 explicit click override, separate from normal opened state. */
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	/**
	 * Row-KEY addressed expansion, resolved as `(traceKey, rowKey) => boolean`.
	 *
	 * ⚠️ The channel `activity-trace` must use — and the ONLY kind that must, because
	 * only it can gain a row ABOVE an existing one while a turn streams. The activity
	 * fold expands one live reasoning block into one row PER STEP, so the moment the
	 * model emits another `**title**` every row after it shifts down by one. An index
	 * recorded at click time then addresses a different row: the tool the reader
	 * opened silently folds shut, and the row that inherited the index opens instead
	 * — the same click producing a different card mid-stream, plus a height change
	 * with no user action behind it (the very thing CONTRACT §0 forbids).
	 *
	 * Row keys are hand-off stable by construction: a tool row is `tool-<toolUseId>`
	 * live and persisted alike, and a reasoning row keys on its run ordinal within
	 * the unit (`stableKeyBase`). So a key survives exactly the frames an index does
	 * not. Both kinds of row read this channel — a tool row to drill into its card, a
	 * reasoning-step row to expand its markdown body.
	 *
	 * `expandedRows` stays for the append-only lists, whose ordinals are already
	 * stable: a `reasoning-steps` element (step N stays row N however many steps
	 * follow) and the subagent-recovery card's checkboxes. The shell routes by kind
	 * (`traceRowFoldChannel`); an element read
	 * here must be written there, or the reader's fold lands in a channel nothing
	 * reads and the row stops opening.
	 */
	isRowExpanded?: (traceKey: string, rowKey: string) => boolean;
	/**
	 * Reader asked for the ORIGINAL text of a translated body (reasoning runs).
	 *
	 * Height-affecting, so it must be resolved during adaptation like every other
	 * interaction state: the two languages wrap differently, and the exact path
	 * paints at the predicted geometry.
	 */
	showOriginal?: (key: string) => boolean;
	/**
	 * Reader opened a subagent card's PROMPT body.
	 *
	 * A separate channel from `isExpanded`, which folds the card as a whole: the
	 * chunked SubagentCard keeps its own `showPrompt` state, and reusing one key
	 * would make opening a card also unfold its prompt. Height-affecting, so it is
	 * resolved here like every other interaction state.
	 */
	isPromptOpen?: (key: string) => boolean;
	/**
	 * Reader expanded a subagent card's FILE-CHANGE list.
	 *
	 * Independent of `isPromptOpen` for the same reason that one is independent of
	 * `isExpanded`: a reader who wants the prompt does not necessarily want 220 file
	 * rows, and sharing a key would tie the two. Height-affecting — the expanded list
	 * draws every row instead of the capped head.
	 */
	isFileChangesOpen?: (key: string) => boolean;
	/** L4 recency window. Undefined preserves the old "all recent" fallback. */
	recentMessageIds?: ReadonlySet<string>;
	/** Viewport height for isPlan tool-call cap (0.85×). */
	viewportHeight?: number;
	/** i18n labels for system cards / traces, passed through to measures. */
	labels?: Record<string, string>;
	/**
	 * Whether an error card may offer the "turn off image generation and retry"
	 * provider fix, given that card's error text.
	 *
	 * Injected by the shell because eligibility depends on the current user's role
	 * and the narrator's resolved provider — neither of which the pure adapter may
	 * read. It is consulted during ADAPTATION rather than at paint time because the
	 * fix is a labelled button on its own row and therefore changes the card's
	 * measured height.
	 */
	canOfferProviderFix?: (errorText: string) => boolean;
	/**
	 * Whether this error card may offer "test the current model", given its text.
	 *
	 * Same contract as `canOfferProviderFix`: admin-only and network-error-only, so
	 * eligibility depends on the current user and the narrator's model — facts the
	 * pure adapter may not read — and the control is a labelled button on the card's
	 * optional button row, so the answer changes the measured height.
	 */
	canOfferModelTest?: (errorText: string) => boolean;
	/** Pure resolvers injected by the shell; deterministic fallbacks keep tests simple. */
	resolveReasoningSegments?: (text: string) => ReasoningSegment[];
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	resolveToolColor?: (toolName: string, input?: unknown) => string;
	resolveToolTitle?: (tc: AdapterToolItem["tc"]) => string;
	/**
	 * Authoritative header summary (tool-display's `getSummary`), injected by the
	 * shell so the vlist header text matches the chunked ToolCallCard exactly.
	 *
	 * Without it the adapter can only read plain fields off `inputJson`, so any
	 * tool whose input was truncated server-side (`{_truncated:true, preview,
	 * _hints}`) renders a header with no target — the path/command lives in
	 * `_hints` or inside the preview JSON, which only `getSummary` decodes.
	 * Height-neutral: the header is one truncated single-line slot.
	 */
	resolveToolSummary?: (tc: AdapterToolItem["tc"]) => string;
	/**
	 * Label detail for ONE subagent recent-call row, from the tool name plus the
	 * whitelisted short input keys the server projected (`inputSummary`).
	 *
	 * A separate resolver from `resolveToolSummary` because these rows never carry a
	 * tool call: the activity query deliberately does not select `input_json` (it can
	 * hold a whole file), so all the row has is the projection. The shell injects the
	 * same formatter the chunked row uses, so the two cannot word one call
	 * differently. Height-neutral: the row title is a single truncating line.
	 */
	resolveSubagentRecentSummary?: (toolName: string, inputSummary: unknown) => string | null;
	/**
	 * True when a tool/subagent item currently has a pending permission request
	 * (injected by the shell from the live WS permission list). Forces the card
	 * expanded (lodExempt) so its permission form area is visible. The form itself
	 * is mounted by the integration layer (vlist-permission-bridge) and measured
	 * after paint; this flag only governs the expand decision + a revision string
	 * so the card re-measures when the permission appears/disappears.
	 */
	resolveHasPendingPermission?: (toolUseId: string | undefined) => boolean;
	/**
	 * The tool-use id of the MOST RECENT spec://tasks.json operation in the loaded
	 * window (the same identity the chunked path's task-board spinner keys on).
	 * That one card keeps its full expanded task board at every LOD — it never
	 * folds into a count batch and never collapses to a bare header at L3 / L4.
	 *
	 * A resolver (not a snapshot) so the identity the shell tracks can move with
	 * each rebuild without the adapter caching a stale value; the shell's closure
	 * reads the current id at adapt time. Height-affecting (the card's expanded
	 * geometry replaces a folded row's), resolved during adaptation like every
	 * other interaction state.
	 */
	resolveLatestSpecTasksToolUseId?: () => string | null;
	/**
	 * Full (un-truncated) tool input / output for a tool use, once the shell has
	 * fetched it.
	 *
	 * Large payloads arrive as `{_truncated:true, preview}` wrappers, so an expanded
	 * card could only ever show the preview — the chunked path swaps in the full
	 * body via `useToolCallDetail`. These resolvers are that swap: the shell fetches
	 * on demand and hands the result back here, and the new Map identity rebuilds
	 * the document (the measure cache keys on the body length, so the taller card is
	 * re-measured rather than served stale).
	 */
	resolveFullToolInput?: (toolUseId: string | undefined, ref?: AdapterToolDetailRef) => unknown;
	resolveFullToolOutput?: (toolUseId: string | undefined, ref?: AdapterToolDetailRef) => unknown;
	/**
	 * A LIVE pending permission's `suggestions`, which win over the tool call's
	 * persisted `permissionSuggestions` when resolving a reflection gate (same
	 * precedence as the chunked `getToolCallReflection`). Reflection state is
	 * otherwise already present in the loaded message tree, so this resolver only
	 * covers the in-flight window.
	 */
	resolvePendingPermissionSuggestions?: (toolUseId: string | undefined) => unknown[] | undefined;
	/**
	 * Plan body carried by a pending permission request, when the tool call itself
	 * has none yet.
	 *
	 * File-based ExitPlanMode plans are resolved server-side into the permission
	 * payload but never enter the streamed `tool_use` input, so `tc.inputJson.plan`
	 * stays empty until a reload rehydrates it from the DB. Without this fallback
	 * a freshly submitted file-based plan renders an empty body (the chunked card
	 * solves it the same way — see ToolCallCard's pendingPlanFallback).
	 *
	 * The shell must derive this resolver from the live pending-permission list so
	 * its identity changes when the plan text arrives; the document rebuild is what
	 * makes the new text observable.
	 */
	resolvePendingPlan?: (toolUseId: string | undefined) => string | undefined;
	/**
	 * Reader enabled "show token usage per turn". When false (the default) NO
	 * turn-usage spec is emitted at all, so the item list — and therefore every
	 * measurement cache key — is byte-identical to a build without the feature.
	 * That is why this is a plain boolean rather than a revision folded into the
	 * cache key: toggling it changes the item COUNT, which already invalidates the
	 * layout.
	 */
	showTokenUsage?: boolean;
	/**
	 * Viewport is phone-sized, which SPLITS the trailing usage summary across two
	 * lines (the chunked path does this with CSS breakpoints, which a zero-DOM
	 * height model cannot observe — so the decision is an explicit measure input).
	 */
	compactUsageLines?: boolean;
	/** Locale-aware number grouping for the usage lines; defaults to `String`. */
	formatUsageNumber?: UsageNumberFormatter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block classification (mirrors message-segments.classifyBlock content lane).
// ─────────────────────────────────────────────────────────────────────────────

/** System/message subtype → system-simple vs system-text vs plan/card kinds. */
const SYSTEM_SIMPLE_SUBTYPES = new Set([
	"compact",
	"segment_compact",
	"merge_summary",
	// spec_continuation / spec_blocked_continuation are NOT here: FRAMED_SPEC_TASK_CARDS
	// intercepts them first and the bubble draws the task row itself. Listing them here
	// would route them to the clamped single-line card the redesign removed.
	// review_feedback is NOT here either, nor in SYSTEM_TEXT_SUBTYPES: a conclusion is a
	// markdown DOCUMENT with an action, so it gets its own `review-card` element (a header
	// over a capped scroll box). A clamped line could not show the findings and a
	// plain-text card could not render them.
]);
const SYSTEM_TEXT_SUBTYPES = new Set([
	"info",
	"error",
	"bash_command",
	"tool_loaded",
	"tool_unloaded",
	"spec_goal_added",
	"spec_fork_carryover",
	"spec_context_cleared",
	// Server-authored injected content on its OWN message row (see
	// server/services/narrator-injection.ts). It replaces the side-car channel, whose
	// rows had no message of their own and had to be hosted by a neighbour.
	"system_injection",
]);
/** Extra recognized system block types beyond the simple/text sets. */
const SYSTEM_OTHER_TYPES = new Set(["knowledge_hint", "ask_in_passing", "subagent_recovery"]);
/**
 * Block types that make a role=user message render as a SYSTEM card rather than a
 * chat bubble.
 *
 * `role` is a PROTOCOL field, not an authorship one: several server-authored cards
 * are persisted as role=user precisely so the provider includes them in history.
 * MessageBubble matches all of these BEFORE it ever reaches its `isUser` branch,
 * so the role they were stored under never reaches its rendering decision. The
 * vlist adapter dispatches on role first, so it needs this explicit allow-list to
 * reach the same cards.
 *
 * Each entry carries no text block of its own, so the bubble branch paints an
 * empty indigo box with just a header:
 *   - `bash_command`, `tool_loaded`, `tool_unloaded` — `/bash` + tool load notices.
 *   - `segment_compact` — `persistSegmentCompactMarker` inserts role=user, and the
 *     block holds only `{status, messageCount, summary}`. Missing it also stripped
 *     the row of its summary-modal affordance, since the compact interaction is
 *     resolved from a `system-simple` payload (see vlist-compact-target).
 *
 * Deliberately NOT listed, even though MessageBubble also matches them ahead of
 * its `isUser` branch:
 *   - `merge_summary` / `review_feedback` — persisted via persistSystemMessage
 *     (role=sys), so they never arrive here as role=user. Listing them anyway
 *     would hijack role=user INJECTION rows that carry one as an extra block,
 *     whose leading `system_injection` block owns the row.
 *   - `ask_in_passing` — inserted as role=system.
 *   - `compact` — MessageBubble matches it INSIDE its role system/sys/disp branch,
 *     so a role=user `compact` block is not a marker.
 */
const USER_SYSTEM_CARD_TYPES = new Set([
	"bash_command",
	"tool_loaded",
	"tool_unloaded",
	"segment_compact",
]);

/** True when a block type is a recognized system-card block (used to locate the
 * meaningful block within a system message, which may not be blocks[0]). */
function isRecognizedSystemBlockType(type: string): boolean {
	return (
		SYSTEM_SIMPLE_SUBTYPES.has(type) ||
		SYSTEM_TEXT_SUBTYPES.has(type) ||
		SYSTEM_OTHER_TYPES.has(type) ||
		// Framed cards (spec_continuation, merge_summary, review_feedback) are recognized
		// here too: spec_continuation left SYSTEM_SIMPLE_SUBTYPES when the bubble began
		// drawing its row itself, but the system-block scan must still find it.
		FRAMED_SYSTEM_CARDS.has(type)
	);
}

/** Map a single content block to an element kind (content lane only). */
export function classifyContentBlock(block: AdapterContentBlock): VListElementKind | null {
	switch (block.type) {
		case "text":
			return block.text?.trim() ? "markdown" : null;
		case "image":
		case "text_file":
		case "image_generation":
			return "media";
		case "reasoning":
		case "thinking":
			return "reasoning";
		case "web_search":
			return "web-search";
		default:
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Data extraction per kind.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assistant markdown, with source citations projected into the text.
 *
 * Only reached for assistant messages (the user and system branches return
 * earlier), which is what makes the legacy-marker pass safe here: a user quoting
 * `citeturn…` keeps their text verbatim, while a historical assistant row gets
 * the marker replaced by a numbered reference without a DB migration.
 *
 * The projection emits plain Markdown links, so VList and Pixi reuse the existing
 * href measurement and click handling instead of each growing a citation renderer.
 */
function markdownData(block: AdapterContentBlock): string {
	const text = block.text ?? "";
	if (!text) return text;
	return resolveAssistantTextDisplay(text, block.citations ?? undefined).display;
}

/**
 * The CANONICAL text of one reasoning run — the single string both levels parse.
 *
 * The two levels used to disagree structurally: `adaptContentBlocks` (L3+) joins a
 * run's blocks and parses the concatenation, while the activity fold pushed blocks
 * one by one and parsed each alone. For a run whose `**title**` is split across a
 * block boundary the two see different step counts (measured: 1 step joined vs 2
 * parsed separately), so step `sN` on one side can be a different step than `sN` on
 * the other. That is why the cross-level identity was gated to single-block runs.
 *
 * Routing both sides through this function removes the disagreement at its source
 * instead of declining to animate: parse the same string, get the same steps, and
 * the gate becomes unnecessary. The separator must stay `\n\n` — a run's blocks are
 * consecutive paragraphs of one thought, and joining them with a single newline
 * would let a title absorb the following paragraph.
 */
export function canonicalReasoningRunText(blocks: readonly AdapterContentBlock[]): string {
	return joinRunText(blocks.map((block) => block.thinking ?? block.text ?? ""));
}

/** Join one run's per-block strings. Blank blocks drop out; see the separator note. */
function joinRunText(parts: readonly string[]): string {
	return parts.filter((value) => value.length > 0).join("\n\n");
}

/**
 * A run's translation, or null when it is not fully translated.
 *
 * All-or-nothing on purpose: a partially translated run would otherwise render some
 * steps in one language and some in another. The denominator counts only NON-EMPTY
 * blocks, matching what `joinRunText` keeps.
 */
function canonicalReasoningRunTranslation(blocks: readonly AdapterContentBlock[]): string | null {
	const translatedParts = blocks.map((block) => block.translatedText).filter(Boolean) as string[];
	const nonEmpty = blocks.filter((block) => (block.thinking ?? block.text ?? "").length > 0).length;
	return translatedParts.length === nonEmpty && nonEmpty > 0 ? joinRunText(translatedParts) : null;
}

/**
 * The exact string a run's STEPS are parsed from, at every level.
 *
 * A translated run displays its translation, and translation can change the step
 * structure (measured: a 2-step original whose translation parses to 3 steps). L3+
 * has always parsed `translatedText ?? text`; the fold parsed the raw original, so
 * `s1` addressed a different step on each side — a silent mis-pair that would morph
 * one step into an unrelated one. Both sides now resolve the text here.
 */
export function reasoningRunDisplayText(blocks: readonly AdapterContentBlock[]): string {
	return canonicalReasoningRunTranslation(blocks) ?? canonicalReasoningRunText(blocks);
}

function reasoningData(blocks: AdapterContentBlock[], isStreaming: boolean) {
	const text = canonicalReasoningRunText(blocks);
	const translatedText = canonicalReasoningRunTranslation(blocks);
	const displayText = translatedText ?? text;
	return {
		text,
		translatedText,
		isStreaming,
		stepCount: blocks.length,
		charCount: displayText.length,
	};
}

/** Longest title a trace row shows before `truncateTitle` clips it. */
const TITLE_MAX_CHARS = 80;

function truncateTitle(raw: string): string {
	return raw.length > TITLE_MAX_CHARS ? `${raw.slice(0, 77)}…` : raw;
}

function reasoningStepTitle(segment: ReasoningSegment): string {
	if (segment.title) return truncateTitle(segment.title);
	const firstLine = segment.body.split("\n").find((line) => line.trim().length > 0) ?? "";
	return truncateTitle(firstLine.trim());
}

/**
 * A reasoning step's revealable markdown body, or null when there is nothing to
 * reveal (an empty step, or one that is nothing but its own title).
 *
 * Null matters rather than an empty string: `isExpandable` in the measure layer
 * treats a blank body as non-expandable, so a title-only step keeps the "•" dot
 * and cannot be clicked into an empty box.
 */
function reasoningStepBody(segment: ReasoningSegment): string | null {
	if (segment.isEmpty) return null;
	const trimmed = segment.body.trim();
	if (trimmed.length === 0) return null;
	// An untitled step's title IS its first body line, so a body that is that ONE
	// line has nothing more to show — unless the title had to be truncated, in
	// which case expanding reveals the rest of it.
	if (!segment.title && !trimmed.includes("\n") && trimmed.length <= TITLE_MAX_CHARS) return null;
	return segment.body;
}

/**
 * `unitId` provenance for the steps of ONE reasoning run at L3+.
 *
 * Absent → the steps get no cross-level identity, which is the correct outcome whenever
 * the L1/L2 side could not agree on one either: a streaming message (its id changes at
 * the hand-off) or a multi-block run (the two levels parse different text — see
 * `reasoningStepUnitId`).
 */
interface ReasoningStepUnitSource {
	messageId: string;
	runStartBlockIndex: number;
}

function reasoningStepsData(
	segments: ReasoningSegment[],
	isStreaming: boolean,
	ctx: AdapterContext,
	unitSource?: ReasoningStepUnitSource,
) {
	return {
		steps: segments.map((segment, index) => ({
			title: reasoningStepTitle(segment),
			body: segment.isEmpty ? null : segment.body,
			shimmer: isStreaming && index === segments.length - 1,
			key: `seg${index}`,
			// Same string the folded row of this step carries at L1/L2, so the two
			// renderings pair across the level switch. Height-neutral passthrough.
			...(unitSource
				? {
						unitId: reasoningStepUnitId(unitSource.messageId, unitSource.runStartBlockIndex, index),
					}
				: {}),
		})),
		headerLabel: sysLabel(ctx, "reasoning"),
		headerCount: countLabel(ctx, "reasoningSteps", segments.length),
	};
}

function webSearchData(block: AdapterContentBlock, ctx: AdapterContext) {
	const isSearching = block.status && block.status !== "completed";
	const labelKey = isSearching
		? block.status === "searching"
			? "webSearching"
			: "webSearchPreparing"
		: "webSearched";
	return {
		query: block.query ?? null,
		queries: block.queries ?? null,
		status: block.status ?? null,
		label: sysLabel(ctx, labelKey),
	};
}

/**
 * Attachment payload for a user bubble's image / text_file block. `type` plus
 * the image's intrinsic `width`/`height` are height-relevant (known dimensions
 * reserve an aspect-ratio-fitted box; absent ones fall back to the fixed
 * placeholder height); the rest are render-only fields the integration layer
 * needs to resolve a blob src.
 *
 * `uploadNarratorId` falls back to the message's own narrator, matching
 * MessageBubble's `block.uploadNarratorId ?? message.narratorId ?? narratorId`.
 */
function userAttachmentData(block: AdapterContentBlock, msg: AdapterMessage) {
	if (block.type === "file_reference") {
		return fileReferenceDisplay({
			type: "file_reference",
			reference: block.reference as FileReference,
		});
	}
	const uploadNarratorId = readNonEmptyString(block, "uploadNarratorId") ?? msg.narratorId;
	return {
		type: block.type,
		imageId: block.imageId ?? null,
		previewUrl: block.previewUrl ?? null,
		filename: block.filename ?? null,
		mediaType: block.mediaType ?? null,
		size: typeof block.size === "number" ? block.size : null,
		// Intrinsic pixel size, persisted at upload time (imageRefToContentBlock).
		// HEIGHT-RELEVANT: the measure layer fits the box by aspect ratio.
		width: typeof block.width === "number" ? block.width : null,
		height: typeof block.height === "number" ? block.height : null,
		uploadNarratorId: uploadNarratorId ?? null,
		// HEIGHT-NEUTRAL: a text-file attachment's on-disk path, forwarded so the
		// render layer can open it in a file panel. It never affects the reserved
		// row height (measure keeps TEXT_FILE_HEIGHT), so adding it cannot shift
		// any predicted geometry.
		filePath: readNonEmptyString(block, "filePath") ?? null,
	};
}

/**
 * Localized header text of an image_generation block, mirroring MessageBubble's
 * `imageGenerating / imageGenerationPreparing / imageGenerated` ternary.
 *
 * MEASURED: the header line wraps together with the revised prompt, so the
 * wording belongs to the adapter (ctx.labels) rather than the render layer. A
 * persisted block carries no `status` at all (the event handler stores only the
 * saved path + size), which correctly reads as "generated".
 */
function imageGenerationStatusText(ctx: AdapterContext, status: string | null | undefined): string {
	if (!status || status === "completed") return sysLabel(ctx, "imageGenerated");
	return sysLabel(ctx, status === "generating" ? "imageGenerating" : "imageGenerationPreparing");
}

function mediaData(block: AdapterContentBlock, ctx: AdapterContext) {
	// measureMedia dispatches on `type`.
	return {
		type: block.type,
		imageId: block.imageId ?? null,
		previewUrl: block.previewUrl ?? null,
		filename: block.filename ?? null,
		mediaType: block.mediaType ?? null,
		status: block.status ?? null,
		revisedPrompt: block.revisedPrompt ?? null,
		// The image SOURCE fields. `savedPath` is the normal one (the base64 payload
		// is written to disk and only the path persisted); `result` survives only when
		// that write failed, and `partialSavedPath` is the streaming preview.
		result: block.result ?? null,
		savedPath: block.savedPath ?? null,
		partialSavedPath: block.partialSavedPath ?? null,
		width: block.width ?? null,
		height: block.height ?? null,
		...(block.type === "image_generation"
			? { statusText: imageGenerationStatusText(ctx, block.status) }
			: {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: segment → ElementSpec[]
// ─────────────────────────────────────────────────────────────────────────────

/** Render native/legacy context blocks independently while preserving physical order. */
function adaptContextBlocks(
	blocks: AdapterContentBlock[],
	idBase: string,
	msg: AdapterMessage,
	ctx: AdapterContext,
): ElementSpec[] {
	const specs: ElementSpec[] = [];
	const views = Array.from(
		new Map(
			[...contextBlockViews(blocks), ...injectionBlockViews(blocks)].map((view) => [
				view.blockIndex,
				view,
			]),
		).values(),
	).sort((a, b) => a.blockIndex - b.blockIndex);
	const owned = new Set(views.flatMap((view) => view.sourceIndices));
	for (const view of views) {
		const index = view.blockIndex;
		const modelText = view.block.modelText ?? "";
		const spoken = adaptSpokenInjection(
			view.block as AdapterContentBlock,
			idBase,
			index,
			modelText,
			msg,
			ctx,
		);
		if (spoken) {
			specs.push(...spoken);
			continue;
		}
		const framed = adaptFramedSystemCard(
			view.block as AdapterContentBlock,
			idBase,
			index,
			msg,
			modelText,
			ctx,
		);
		if (framed) {
			specs.push(framed);
			continue;
		}
		specs.push(
			adaptSystemBlock(view.block.type, view.block as AdapterContentBlock, idBase, msg, ctx, index),
		);
	}
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block || owned.has(index) || block.type !== "text" || !block.text?.trim()) continue;
		specs.push({ kind: "markdown", key: `${idBase}-b${index}`, data: block.text });
	}
	return specs;
}

/** Adapt one RenderSegment to a list of element specs (measure-ready). */
export function adaptSegment(seg: AdapterSegment, ctx: AdapterContext): ElementSpec[] {
	switch (seg.kind) {
		case "message":
			return adaptMessage(seg.msg, seg.visibleBlockIndices, ctx);
		case "tool-run":
			return adaptToolRun(seg.items, ctx);
	}
}

function adaptMessage(
	msg: AdapterMessage,
	visibleBlockIndices: number[] | undefined,
	ctx: AdapterContext,
): ElementSpec[] {
	const specs: ElementSpec[] = [];
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const indices = visibleBlockIndices ?? blocks.map((_, i) => i);
	const idBase = msg.id ?? "msg";

	// user messages: a single bubble with plain pre-wrap text (not markdown) plus
	// its attachments (images / text files), which live INSIDE the same bubble —
	// mirroring MessageBubble, which maps every block of a user message rather
	// than only the text ones. Dropping them here is what made an image the user
	// sent silently disappear in the virtual list.
	if (msg.role === "user") {
		// Self-contained native context blocks are protocol cards, not human chat bubbles.
		// Keep their physical indexes and render each block independently.
		if (blocks.some((block) => isNativeModelContextBlock(block))) {
			return adaptContextBlocks(blocks, idBase, msg, ctx);
		}
		// Some user-role messages are not chat bubbles at all: `/bash`, tool load /
		// unload notices and the segment-compact marker are persisted with role=user
		// but carry ONLY a system block and no text, so the bubble branch would paint
		// an empty indigo box. Route them to the same system card the classic
		// renderer uses (which matches these before it looks at the role at all).
		const systemCardBlock = blocks.find((b) => USER_SYSTEM_CARD_TYPES.has(b.type));
		if (systemCardBlock) {
			return [
				adaptSystemBlock(
					systemCardBlock.type,
					systemCardBlock,
					idBase,
					msg,
					ctx,
					blocks.indexOf(systemCardBlock),
				),
			];
		}
		// A concluded review. The row is `role: "user"` because the findings ARE a request
		// the model must answer, and it carries both projections of one conclusion: a `text`
		// block for the model and a `review_feedback` block for the reader.
		//
		// Matched BEFORE the origin check below, which would otherwise win (the row is
		// `origin: "system"`) and flatten the verdict, the findings and the action button
		// into a plain notice. Gated on the absence of `system_injection` so it cannot hijack
		// an injection row that merely carries a review card as an extra block; that row is
		// owned by its leading injection block.
		const reviewBlockIndex = blocks.findIndex((b) => b.type === "review_feedback");
		if (reviewBlockIndex >= 0 && !blocks.some((b) => b.type === "system_injection")) {
			const reviewBlock = blocks[reviewBlockIndex];
			if (reviewBlock) return [adaptReviewCard(reviewBlock, idBase, reviewBlockIndex, ctx)];
		}
		// Send deliveries keep role=user for the model, but their structured block owns
		// the reader-facing identity. Match it BEFORE origin erases that structure.
		// Only communication is rerouted here; reminder/permission cards keep their
		// existing paths, and an explicit human origin keeps its right-hand bubble.
		const injectionIndex = blocks.findIndex((b) => b.type === "system_injection");
		const injection = blocks[injectionIndex];
		if (msg.origin !== "user" && injection && readCommunicationInjection(injection)) {
			const modelFacingText =
				blocks
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n") ||
				(blocks[injectionIndex]?.type === "system_injection"
					? (blocks[injectionIndex]?.modelText ?? "")
					: "");
			const spoken = adaptSpokenInjection(
				injection,
				idBase,
				injectionIndex,
				modelFacingText,
				msg,
				ctx,
			);
			if (spoken) return spoken;
		}
		// Older Send rows have attribution but no structured body. Keep their COMPLETE
		// text and readable label; never recover a sender id or strip prompt prefixes
		// by guessing at the prose. Index zero is the historical user row's address.
		if (
			!injection &&
			msg.origin === "assistant" &&
			(msg.originLabel === "agentMessage" || msg.originLabel?.startsWith("agentMessage:"))
		) {
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			return [
				{
					kind: "injection-bubble",
					key: `${idBase}-b0-m-legacy`,
					data: {
						markdown: rawSideCarToMarkdown(text),
						speaker: originHeadingLabel(ctx, msg.origin, msg.originLabel),
						speakerId: null,
						speakerKind: null,
						target: null,
						isBroadcast: false,
						source: "subagent_message",
						hasHeader: true,
						modelFacing: text,
					},
				},
			];
		}
		// Turns stored as role=user for protocol/scheduling reasons that no human
		// wrote (auto-continuation, review kickoff, AI-initiated sends). Painting
		// them as user bubbles is what made authorship ambiguous, so they get the
		// low-contrast origin card instead — matching MessageBubble.
		if (msg.origin === "system" || msg.origin === "assistant") {
			const bodyText = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			return [
				{
					kind: "system-text",
					key: `${idBase}-origin`,
					data: {
						kind: "origin_notice",
						text: bodyText,
						title: originHeadingLabel(ctx, msg.origin, msg.originLabel),
						timeLabel: formatOriginNoticeTime(msg.createdAt),
						origin: msg.origin,
						originLabel: msg.originLabel ?? null,
					},
				},
			];
		}
		const visible = indices.map((i) => blocks[i]).filter((b): b is AdapterContentBlock => !!b);
		const text = visible
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
		const attachments = visible
			.filter(
				(b) =>
					b.type === "image" ||
					b.type === "text_file" ||
					(b.type === "file_reference" && b.reference),
			)
			.map((b) => userAttachmentData(b, msg));
		const key = `${idBase}-bubble`;
		const commandText =
			typeof msg.commandText === "string" && msg.commandText.length > 0 ? msg.commandText : null;
		return [
			{
				kind: "message-bubble",
				key,
				// measure reads role/text/hasHeader + the attachment list (each
				// attachment reserves a fixed box); creator/createdAt are
				// height-neutral fields the render layer uses to paint the header.
				data: {
					role: "user",
					text,
					hasHeader: true,
					creator: msg.creator ?? null,
					createdAt: msg.createdAt ?? null,
					// Height-neutral attribution: the bubble header already reserves its
					// row, so origin/originLabel only change what the header paints
					// (name / avatar / badge), never the measured height or cache key.
					// Forwarding these is what lets a plan-reflection-approved turn show
					// the "计划反思" identity instead of falling back to "you" on the right.
					origin: msg.origin ?? null,
					originLabel: msg.originLabel ?? null,
					...(msg.deliveryId ? { deliveryId: msg.deliveryId } : {}),
					...(msg.deliveryKind ? { deliveryKind: msg.deliveryKind } : {}),
					...(msg.deliveryState ? { deliveryState: msg.deliveryState } : {}),
					...(commandText ? { commandText } : {}),
					...(attachments.length > 0 ? { attachments } : {}),
				},
				// A command bubble folds its expansion away by default, so the expand
				// state must reach the measure layer (it decides whether the body's
				// wrapped height counts). Only emitted for command bubbles so plain
				// bubbles keep an empty `opts` and their existing cache keys.
				...(commandText
					? {
							opts: {
								expanded: ctx.isExpanded?.(key) ?? false,
								...(ctx.labels?.showExpandedPrompt
									? { showLabel: ctx.labels.showExpandedPrompt }
									: {}),
								...(ctx.labels?.hideExpandedPrompt
									? { hideLabel: ctx.labels.hideExpandedPrompt }
									: {}),
							},
						}
					: {}),
			},
		];
	}

	// Publication receipts are immutable display snapshots, not system prose.
	if (msg.role === "disp") {
		const snapshotIndex = blocks.findIndex((block) => {
			const meta = block.publicationResult;
			return (
				block.type === "text" &&
				typeof block.text === "string" &&
				meta != null &&
				typeof meta.logicalRunId === "string" &&
				meta.logicalRunId.length > 0 &&
				typeof meta.sourceResultRef === "string" &&
				meta.sourceResultRef.length > 0 &&
				typeof meta.truncated === "boolean" &&
				Number.isFinite(meta.originalBytes) &&
				meta.originalBytes >= 0
			);
		});
		if (snapshotIndex >= 0) {
			const snapshot = blocks[snapshotIndex];
			return [
				{
					kind: "system-simple",
					key: `${idBase}-b${snapshotIndex}`,
					data: {
						kind: "publication_result",
						text: "",
						snapshotText: snapshot.text,
						publicationResult: snapshot.publicationResult,
						messageId: msg.id,
					},
				},
			];
		}
	}

	// system messages: SCAN for the recognized system block (mirrors
	// MessageBubble's blocks.find(b => b.type === ...)). The meaningful block is
	// NOT necessarily blocks[0] — a leading text block can precede it (e.g.
	// [{text}, {knowledge_hint}]). Falls back to blocks[0] when none recognized.
	if (msg.role === "system" || msg.role === "sys" || msg.role === "disp") {
		if (blocks.some((block) => isNativeModelContextBlock(block))) {
			return adaptContextBlocks(blocks, idBase, msg, ctx);
		}
		// Track the index too: an injection is ONE block per row now, and that index is
		// the row's address for the selection system (msg-{id}-{blockIndex}).
		const sysBlockIndex = blocks.findIndex((b) => isRecognizedSystemBlockType(b.type));
		const sysBlock = (sysBlockIndex >= 0 ? blocks[sysBlockIndex] : blocks[0]) ?? { type: "info" };
		const blockIndex = sysBlockIndex >= 0 ? sysBlockIndex : 0;
		// The model-facing copy: the message's leading non-empty text block, same fallback
		// the chunk renderer uses. The context-menu inspector shows this so the reader can
		// see exactly what the agent received, which the projected bubble body strips down.
		const modelFacingText =
			blocks.find((b) => b.type === "text" && (b.text ?? "").trim().length > 0)?.text ??
			blocks.find((b) => b.type === "system_injection" && typeof b.modelText === "string")
				?.modelText ??
			"";
		const spoken = adaptSpokenInjection(sysBlock, idBase, blockIndex, modelFacingText, msg, ctx);
		if (spoken) return [...specs, ...spoken];
		// Server-authored FACTS that still have an author (a person merged a branch, the
		// platform brought a container up). Those are statements in the conversation, so
		// they get the same left bubble — but their existing card becomes the bubble's BODY
		// rather than being flattened to prose, because it carries structure and
		// affordances the reader can use (branch names, a commit sha, badges).
		const framed = adaptFramedSystemCard(sysBlock, idBase, blockIndex, msg, modelFacingText, ctx);
		if (framed) return [...specs, framed];
		specs.push(adaptSystemBlock(sysBlock.type, sysBlock, idBase, msg, ctx, blockIndex));
		return specs;
	}

	// assistant messages: dispatch each visible block, merging adjacent reasoning
	// blocks into the same run as MessageBubble/ReasoningStepsTrace does.
	//
	// `streamingMessage` says the row is the synthetic un-persisted one; it does NOT
	// say any given block is still being written. Only the message's LAST content
	// block can be (see streaming-live-blocks.ts), so per-block liveness is resolved
	// against the full `blocks` array below — `indices` may be a filtered view, and a
	// reasoning run must still count the text/tool blocks that follow it as proof
	// that it closed.
	const streamingMessage = msg.id === STREAMING_MESSAGE_ID;
	// Per-turn usage rows bracket the body (see appendTurnUsageSpecs). Resolved up
	// front so the leading row can be pushed before the first block.
	const usageLines = resolveAdapterTurnUsage(msg, ctx);
	if (usageLines?.leading) {
		specs.push({
			kind: "turn-usage",
			key: `${idBase}-usage-leading`,
			data: { placement: "leading", text: usageLines.leading },
		});
	}
	const parseReasoning = ctx.resolveReasoningSegments ?? parseReasoningSegments;
	for (let position = 0; position < indices.length; position++) {
		const bi = indices[position];
		if (bi == null) continue;
		const block = blocks[bi];
		if (!block) continue;
		const kind = classifyContentBlock(block);
		if (kind === null) continue;
		const key = `${idBase}-b${bi}`;
		if (kind === "reasoning") {
			const reasoningBlocks = [block];
			let nextPosition = position + 1;
			while (nextPosition < indices.length) {
				const nextIndex = indices[nextPosition];
				if (nextIndex == null) break;
				const next = blocks[nextIndex];
				if (!next || classifyContentBlock(next) !== "reasoning") break;
				reasoningBlocks.push(next);
				nextPosition++;
			}
			// Live only while this run holds the message's last content block. Once
			// answer text or a tool call follows it, the run is finished and must render
			// like history — collapsible, LOD-foldable, no shimmer — even though the
			// turn has not persisted yet.
			const runIndices: number[] = [bi];
			for (let p = position + 1; p < nextPosition; p++) {
				const runIndex = indices[p];
				if (runIndex != null) runIndices.push(runIndex);
			}
			const streaming = isLiveStreamingRun(streamingMessage, msg, runIndices);
			const data = reasoningData(reasoningBlocks, streaming);
			// A translated run displays its translation by default; the reader can flip
			// it back to the original. Resolved HERE (not at paint time) because the two
			// languages wrap to different heights and the exact path paints at the
			// predicted geometry.
			const hasBothTexts = !!data.translatedText && data.text.length > 0;
			const showOriginal = hasBothTexts && (ctx.showOriginal?.(key) ?? false);
			// The structured/plain choice is made on the DEFAULT text on purpose: only
			// the plain card carries the language toggle, so letting the flip change the
			// element kind could swap in a trace with no way back.
			const displayText = data.translatedText ?? data.text;
			const parsed = parseReasoning(displayText);
			if (hasStructuredReasoning(parsed)) {
				specs.push({
					kind: "reasoning-steps",
					key,
					data: reasoningStepsData(
						parsed,
						streaming,
						ctx,
						// Cross-level step identity, on the SAME condition the L1/L2 side applies:
						// a persisted message, since a streaming id changes at the hand-off and
						// would leave the identity addressing a different row.
						//
						// The single-block restriction is gone from both sides: the fold now
						// parses `canonicalReasoningRunText` for the whole run, which is the
						// string `reasoningData` built here, so the step boundaries agree for a
						// multi-block run too. `bi` is the run's first block index — the loop
						// advances `position` past the rest.
						msg.id && msg.id !== STREAMING_MESSAGE_ID
							? { messageId: msg.id, runStartBlockIndex: bi }
							: undefined,
					),
					// No LOD input: a step trace has ONE shape at every level — titles
					// visible, each step's body openable. A level that showed titles whose
					// bodies could not be opened gave the reader a list of promises.
					opts: {
						showEarlier: ctx.showEarlier?.(key) ?? false,
						expandedIndices: ctx.expandedRows?.(key) ?? [],
					},
				});
			} else {
				specs.push({
					kind,
					key,
					data,
					opts: { expanded: ctx.isExpanded?.(key), showOriginal },
				});
			}
			position = nextPosition - 1;
			continue;
		}
		switch (kind) {
			case "markdown": {
				const fileReferenceContext = normalizeFileReferenceContext(block.fileReferenceContext);
				specs.push({
					kind,
					key,
					data: markdownData(block),
					// Missing provenance retains the legacy shape. The render boundary maps
					// it to explicit null, never inheriting the live narrator's current cwd.
					...(fileReferenceContext ? { opts: { fileReferenceContext } } : {}),
				});
				break;
			}
			case "web-search":
				specs.push({ kind, key, data: webSearchData(block, ctx) });
				break;
			case "media":
				specs.push({ kind, key, data: mediaData(block, ctx) });
				break;
			default:
				break;
		}
	}
	if (usageLines?.trailing) {
		specs.push({
			kind: "turn-usage",
			key: `${idBase}-usage-trailing`,
			data: {
				placement: "trailing",
				text: usageLines.trailing,
				...(usageLines.trailingSecondary ? { secondaryText: usageLines.trailingSecondary } : {}),
			},
		});
	}
	return specs;
}

/**
 * Resolve the per-turn usage lines for a message, or null when none should be
 * drawn.
 *
 * Gated on the reader's preference FIRST so a disabled toggle costs nothing and,
 * more importantly, emits no specs — keeping the item list identical to a build
 * without the feature. The streaming placeholder is excluded because its usage
 * is not accounted until the turn is persisted; letting a row appear mid-stream
 * would grow the live tail for a reason unrelated to the arriving text.
 */
function resolveAdapterTurnUsage(msg: AdapterMessage, ctx: AdapterContext) {
	if (!ctx.showTokenUsage) return null;
	if (msg.id === "__streaming__") return null;
	return resolveTurnUsageLines(msg, {
		mobile: ctx.compactUsageLines,
		formatNumber: ctx.formatUsageNumber,
	});
}

/**
 * English fallbacks for the height-neutral chrome labels the system cards paint
 * (badges / buttons / composed body prefixes). The shell injects the localized
 * strings via `ctx.labels`; these keep the pure adapter self-contained + unit-
 * testable. Keys mirror MessageBubble's i18n keys (narrator namespace).
 */
const SYSTEM_LABEL_FALLBACKS: Record<string, string> = {
	// Body of a background-task bubble whose task produced no output. Needs a fallback
	// like every other composed string: without one, `sysLabel` returns the raw key and
	// the reader would see the literal "empty" in the bubble.
	empty: "(empty)",
	specProtectedBadge: "Protected",
	specGoalAddedBadge: "Goal added",
	specGoalExistsBadge: "Already tracked",
	specGoalViewTasks: "View tasks",
	specContinuation: "Task",
	specBlockedContinuation: "Blocked",
	segmentCompactFailed: "Compaction failed",
	segmentCompactFailedDesc: "Segment compaction failed.",
	dismiss: "Dismiss",
	unknownError: "Unknown error",
	specForkCarryover: "Fork carryover",
	specContextCleared: "Context cleared",
	// The error card's conditional provider fix. A LABELLED button, not a bare
	// icon: an icon-only control hides its meaning behind a hover tooltip, which
	// touch users never see at all.
	disableImageGen: "Turn off image generation and retry",
	// The error card's conditional model probe (admin-only, network errors only).
	// Carried over from the deleted chunked card's icon-only action; a label for the
	// same reason as above.
	testCurrentModel: "Test current model",
	specViewTasks: "View tasks",
	specClearTasks: "Clear",
	specResetTasks: "Reset",
	mergeSummaryLabel: "Merge",
	reviewFeedbackLabel: "Review",
	// The review card's verdict badge, revision marker and action row. All MEASURED:
	// the badges reserve horizontal room the body wraps around, and the button occupies
	// its own row.
	reviewVerdict_approve: "Approved",
	reviewVerdict_request_changes: "Changes Requested",
	reviewVerdict_comment_only: "Comments Only",
	reviewFeedbackRevisedBadge: "Revised",
	reviewFeedbackApply: "Handle",
	reviewFeedbackApplied: "Handled",
	// Message-origin attribution (see @shared/message-origin). The heading row of
	// an origin_notice card, and the name shown on a user bubble whose author is
	// not a NarraFork account.
	originKindSystem: "System",
	originKindAssistant: "AI",
	originSourceAutoContinuation: "Auto-continuation",
	originSourceReview: "Review",
	originSourceRebase: "Rebase",
	originSourceBatchMerge: "Batch merge",
	originSourceScheduledTask: "Scheduled task",
	originSourceForkNarrator: "Forked by AI",
	originSourceChatGroup: "Group chat",
	originSourceGateway: "IM gateway",
	originSourceOauth: "External app",
	originSourceRecovery: "Session recovery",
	originSourceAgentMessage: "Agent message",
	// Slash-command bubble fold control (a measured text row inside the bubble).
	showExpandedPrompt: "Show expanded prompt",
	hideExpandedPrompt: "Hide expanded prompt",
	// Read-only AskUserQuestion replay: these prefixes WRAP together with the
	// answer text, so they are measured (adapter labels) rather than painted by the
	// render layer.
	askAnswerPrefix: "Answer:",
	askCustomAnswerPrefix: "Custom answer:",
	// image_generation header status line (wraps with the revised prompt, so it is
	// measured and therefore an adapter label).
	imageGenerated: "Generated image",
	imageGenerating: "Generating image…",
	imageGenerationPreparing: "Preparing image generation…",
	// Trace / count-line chrome (CollapsibleTrace headers + ToolRun/Reasoning
	// count lines). Interpolated entries keep literal {count}/{reasoning}/{tools}
	// placeholders that the composers substitute with live values.
	reasoning: "Reasoning",
	reasoningSteps: "{count} steps",
	toolCalls: "Tool calls",
	toolCallsCount: "{count}",
	activityTraceLabel: "Activity",
	activityTraceCount: "{reasoning} reasoning · {tools} tools",
	reasoningCount: "{count} reasoning steps",
	toolGeneric: "Tool",
	compacting: "Compacting context…",
	compacted: "Context compacted",
	compactFailed: "Compact failed",
	compactOutputChars: "{count} chars",
	compactThinking: "thinking",
	compactThinkingChars: "{count} chars",
	compactRetrying: "retry #{count}",
	segmentCompacting: "Segment compacting…",
	segmentCompacted: "Segment compacted ({count} messages)",
	subagentRecoveryTitle: "Subagents stopped with an error",
	subagentRecoveryDescription: "{count} subagent(s) did not finish. Pick the ones to restart.",
	subagentRecoveryToBackground: "to background",
	subagentRecoveryResumeAndNotify: "Resume and notify",
	subagentRecoveryResumeAndWait: "Resume and wait",
	subagentRecoveryResolvedNotify:
		"Restarted {count} subagent(s); the narrator was told to await them.",
	subagentRecoveryResolvedWait: "Restarted {count} subagent(s) and waited for every result.",
	// Reflection notice titles: `${kind}Reflection${Status}` (see
	// reflectionTitleKeyPrefix / reflectionTitleKeySuffix). The title participates
	// in the measured height, so it must flow through the adapter, not the render
	// layer.
	dangerReflectionRunning: "Checking a risky operation…",
	dangerReflectionAwaitingUser: "Risky operation needs your decision",
	dangerReflectionConfirmed: "Risky operation approved",
	dangerReflectionCancelled: "Risky operation cancelled",
	dangerReflectionAborted: "Risk check interrupted",
	dangerReflectionResolved: "Risk check finished",
	planReflectionRunning: "Reviewing the plan…",
	planReflectionAwaitingUser: "Plan needs your decision",
	planReflectionConfirmed: "Plan approved",
	planReflectionCancelled: "Plan rejected",
	planReflectionAborted: "Plan review interrupted",
	planReflectionResolved: "Plan review finished",
	questionReflectionRunning: "Reviewing the question…",
	questionReflectionAwaitingUser: "Question needs your answer",
	questionReflectionConfirmed: "Question answered",
	questionReflectionCancelled: "Question dismissed",
	questionReflectionAborted: "Question review interrupted",
	questionReflectionResolved: "Question review finished",
	taskReflectionRunning: "Reviewing the task list…",
	taskReflectionAwaitingUser: "Task list needs your decision",
	taskReflectionConfirmed: "Task list approved",
	taskReflectionCancelled: "Task list rejected",
	taskReflectionAborted: "Task review interrupted",
	taskReflectionResolved: "Task review finished",
	reflectionNextSteps: "Next: {nextSteps}",
	// ── sidecar cards (one collapsible card per system injection) ─────────────
	// The source badge text is measured into the card's single-line header, so it
	// flows through the adapter like every other composed chrome string. Keys map
	// 1:1 onto the existing `sidecar.sources.*` narrator strings (shell injects).
	sidecarSourceSilentProgress: "Progress reminder",
	sidecarSourceTodoReminder: "TODO reminder",
	sidecarSourceRelaxedPlan: "Plan mode reminder",
	sidecarSourceKnowledgeBaseHint: "Knowledge base hint",
	sidecarSourceBgAgent: "Background agent",
	sidecarSourceBgBash: "Background command",
	sidecarSourceTeamMessage: "Team message",
	sidecarSourceBufferedUser: "Buffered user message",
	sidecarSourceSubagentMessage: "Subagent message",
	sidecarSourceSpecUpdate: "Outline update",
	sidecarSourceInterruptTaskGuard: "Interrupted-task reminder",
	sidecarSourceTutorialLesson: "Tutorial lesson",
	// Periodic task-digest subtitle: carries the cadence ("every N tool calls") so a
	// routine digest reads differently from a turn-end continuation in the header.
	cadenceEveryNTools: "every {n} tool calls",
};

/** Resolve a system-card chrome label (injected i18n → English fallback). */
function sysLabel(ctx: AdapterContext, key: string): string {
	return ctx.labels?.[key] ?? SYSTEM_LABEL_FALLBACKS[key] ?? key;
}

/** Stable compact labels carried to the renderer for fixed-height live repainting. */
function compactProgressLabels(ctx: AdapterContext): Record<string, string> {
	return {
		compacting: sysLabel(ctx, "compacting"),
		segmentCompacting: sysLabel(ctx, "segmentCompacting"),
		outputChars: sysLabel(ctx, "compactOutputChars"),
		thinking: sysLabel(ctx, "compactThinking"),
		thinkingChars: sysLabel(ctx, "compactThinkingChars"),
		retrying: sysLabel(ctx, "compactRetrying"),
	};
}

/**
 * Format an origin_notice timestamp: today → `HH:mm`, otherwise `MM/DD HH:mm`.
 *
 * Plain arithmetic rather than `Intl`, because this runs inside the pure adapter
 * (no locale imports) and the result is height-neutral chrome — it sits in a
 * fixed single-line heading row, so its width can never change a measured height.
 */
function formatOriginNoticeTime(createdAt: string | null | undefined): string {
	if (!createdAt) return "";
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	return isToday ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

/** Recognized origin sources, mirroring `@shared/message-origin`. */
const ORIGIN_SOURCE_LABEL_KEYS: Record<string, string> = {
	autoContinuation: "originSourceAutoContinuation",
	review: "originSourceReview",
	rebase: "originSourceRebase",
	batchMerge: "originSourceBatchMerge",
	scheduledTask: "originSourceScheduledTask",
	forkNarrator: "originSourceForkNarrator",
	chatGroup: "originSourceChatGroup",
	gateway: "originSourceGateway",
	oauth: "originSourceOauth",
	recovery: "originSourceRecovery",
	// A parent narrator or sibling subagent addressed this session through `Send`.
	// The label's DETAIL carries the sender's name, which `originHeadingLabel`
	// appends, so the heading reads "Agent message · explore-1" rather than naming
	// the human whose session triggered the send.
	agentMessage: "originSourceAgentMessage",
};

/**
 * Producer tag → the label key describing it to a reader.
 *
 * Reuses the `sidecarSource*` keys the side-car cards already resolve, so the two
 * cannot disagree on what to call a producer while both exist, and migrating a
 * producer needs no new copy.
 */
const INJECTION_SOURCE_LABEL_KEYS: Record<string, string> = {
	silent_progress: "sidecarSourceSilentProgress",
	living_work_spec: "sidecarSourceTodoReminder",
	relaxed_plan: "sidecarSourceRelaxedPlan",
	knowledge_base_hint: "sidecarSourceKnowledgeBaseHint",
	bg_agent: "sidecarSourceBgAgent",
	bg_bash: "sidecarSourceBgBash",
	team_message: "sidecarSourceTeamMessage",
	buffered_user: "sidecarSourceBufferedUser",
	subagent_message: "sidecarSourceSubagentMessage",
	spec_update: "sidecarSourceSpecUpdate",
	behavior_fence: "sidecarSourceBehaviorFence",
	pipeline_exit_confirmation: "sidecarSourcePipelineExit",
	interrupt_task_guard: "sidecarSourceInterruptTaskGuard",
	// The interactive tutorial's lesson boundary. Named because a reused tutorial
	// narrator shows one of these per lesson, and the generic "System" heading would
	// make the row that separates lessons the least legible thing in the transcript.
	tutorial_lesson: "sidecarSourceTutorialLesson",
};

/**
 * Heading for an injection card.
 *
 * An unmapped source falls back to the generic system label rather than showing its
 * raw tag: a producer added after this table is a naming gap, not something to leak
 * an internal identifier over.
 */
function injectionHeadingLabel(ctx: AdapterContext, source: string): string {
	const key = INJECTION_SOURCE_LABEL_KEYS[source];
	return key ? sysLabel(ctx, key) : sysLabel(ctx, "originKindSystem");
}

/**
 * Heading for an origin_notice card / the display name of a non-account author.
 *
 * Kept local rather than importing `@shared/message-origin`'s React-free helpers
 * so the label lookup stays inside the adapter's own i18n mechanism, which is
 * what makes the heading measurable.
 */
export function originHeadingLabel(
	ctx: AdapterContext,
	origin: string | null | undefined,
	originLabel: string | null | undefined,
): string {
	const raw = originLabel ?? "";
	const sep = raw.indexOf(":");
	const head = sep === -1 ? raw : raw.slice(0, sep);
	const detail = sep === -1 ? "" : raw.slice(sep + 1).trim();
	const labelKey = ORIGIN_SOURCE_LABEL_KEYS[head];
	if (labelKey) {
		const name = sysLabel(ctx, labelKey);
		return detail ? `${name} · ${detail}` : name;
	}
	if (raw) return raw;
	return sysLabel(ctx, origin === "assistant" ? "originKindAssistant" : "originKindSystem");
}

/**
 * Resolve a label carrying a single `{count}` placeholder and substitute the live
 * value. The shell injects the localized template with the placeholder kept
 * literal (see PretextExactMessageList's countPlaceholder), so pluralization is
 * resolved by i18next at injection time for the generic case while the number
 * itself stays dynamic.
 */
function countLabel(ctx: AdapterContext, key: string, count: number): string {
	return sysLabel(ctx, key).replace(/\{count\}/g, String(count));
}

/**
 * Compose the fork-carryover / context-cleared description text. Mirrors
 * MessageBubble's `t("specForkCarryoverDesc", { count, open, protectedOpen })`
 * shape without importing i18n — a plain summary line whose wrapped height the
 * measure layer then predicts. Uses the injected localized template when the
 * shell provides one (with {count}/{open}/{protectedOpen} placeholders).
 */
function carryoverDescription(ctx: AdapterContext, block: AdapterContentBlock): string {
	const total = typeof block.total === "number" ? block.total : 0;
	const open = typeof block.open === "number" ? block.open : 0;
	const protectedOpen = typeof block.protectedOpen === "number" ? block.protectedOpen : 0;
	const template = ctx.labels?.specForkCarryoverDesc;
	if (template) {
		return template
			.replace(/\{count\}/g, String(total))
			.replace(/\{open\}/g, String(open))
			.replace(/\{protectedOpen\}/g, String(protectedOpen));
	}
	// Fallback English summary line.
	return `Carried over ${total} spec task${total === 1 ? "" : "s"} (${open} open, ${protectedOpen} protected).`;
}

/**
 * A concluded review, as its own card.
 *
 * Deliberately NOT a framed bubble and NOT a `system-text` notice. The content is a
 * markdown document — verdict, then findings with file paths, inline code and fenced
 * snippets, sometimes several screens of it — so it needs a real markdown body inside a
 * scroll box, which is what `review-card` measures (see measure-review-card.ts for what
 * the earlier two shapes each failed to express).
 *
 * Everything here is height-relevant only through `text`: the badges and the action label
 * sit in a header row whose height is a constant.
 */
function adaptReviewCard(
	block: AdapterContentBlock,
	idBase: string,
	blockIndex: number,
	ctx: AdapterContext,
): ElementSpec {
	const verdict = reviewVerdict(block);
	const applied = block.applied === true;
	return {
		kind: "review-card",
		// `-b{blockIndex}` ties the row to its content block, so the selection system can
		// address it for the context menu (delete / rollback / fork).
		key: `${idBase}-b${blockIndex}-review`,
		data: {
			text: composeReviewFeedbackText(block, ctx),
			verdictLabel: sysLabel(ctx, `reviewVerdict_${verdict}`),
			color: REVIEW_VERDICT_COLORS[verdict] ?? "gray",
			...(block.revised === true
				? { revisedLabel: sysLabel(ctx, "reviewFeedbackRevisedBadge") }
				: {}),
			// Always present, so the reserved action row is never empty; `applied` only
			// changes the wording and disables it.
			actionLabel: sysLabel(ctx, applied ? "reviewFeedbackApplied" : "reviewFeedbackApply"),
			applied,
		},
	};
}

/** Verdict → Mantine colour for the review card's badge and tint. */
const REVIEW_VERDICT_COLORS: Record<string, string> = {
	approve: "green",
	request_changes: "orange",
	comment_only: "blue",
};

/** The block's verdict, defaulting to the least presumptuous of the three. */
function reviewVerdict(block: AdapterContentBlock): string {
	const verdict = typeof block.verdict === "string" ? block.verdict : "";
	return verdict in REVIEW_VERDICT_COLORS ? verdict : "comment_only";
}

/**
 * The review card's body.
 *
 * `text` is what the producer writes today, and it wins — it is the same copy the model
 * received, so the card and the conversation agree.
 *
 * The synthesis path exists for rows written BEFORE that field did. Those blocks hold
 * only `verdict` and `findings`, and the card used to fall back to the bare label
 * ("Code Review") — which is why a concluded review appeared to have said nothing at
 * all. Composing from the structured fields recovers those rows without a migration.
 *
 * The two wordings are deliberately NOT held identical: the producer's copy is
 * model-facing (emoji, `**bold**`), while this one is built from the reader's injected
 * i18n labels and therefore follows their language. Sharing one wording would mean
 * copying the reader-facing strings into the server and freezing them at write time —
 * the exact coupling `docs/INJECTION.md` §3.1 exists to avoid.
 *
 * ## The composed form is MARKDOWN
 *
 * It has to be, because the card renders its body through the markdown pipeline. An
 * earlier version joined bare lines with `\n`, which markdown folds into ONE paragraph —
 * so a historical conclusion with four findings came out as a single run-on blob with the
 * severities buried mid-sentence. The verdict becomes a heading and each finding a list
 * item, which is the same structure the server's own copy uses.
 */
function composeReviewFeedbackText(block: AdapterContentBlock, ctx: AdapterContext): string {
	const provided = typeof block.text === "string" ? block.text.trim() : "";
	if (provided) return provided;

	const verdictLabel = sysLabel(ctx, `reviewVerdict_${reviewVerdict(block)}`);
	const items: string[] = [];
	const findings = Array.isArray(block.findings) ? block.findings : [];
	for (const finding of findings) {
		if (!finding || typeof finding !== "object") continue;
		const entry = finding as Record<string, unknown>;
		const message = typeof entry.message === "string" ? entry.message.trim() : "";
		if (!message) continue;
		const severity = typeof entry.severity === "string" ? entry.severity : "";
		const file = typeof entry.file === "string" ? entry.file : "";
		const line = typeof entry.line === "number" ? `:${entry.line}` : "";
		// The location is code, so it is fenced inline rather than left as bare prose —
		// a path with dots and slashes is far easier to pick out that way.
		const location = file ? `\`${file}${line}\` — ` : "";
		items.push(`- ${severity ? `**[${severity}]** ` : ""}${location}${message}`);
	}
	// A verdict with no findings is a complete statement ("approved"), so it stands alone
	// as a plain line rather than an empty-looking heading.
	if (items.length === 0) return verdictLabel;
	// A blank line after the heading: without it the first list item is absorbed into the
	// heading's paragraph.
	return [`## ${verdictLabel}`, "", ...items].join("\n");
}

/**
 * Compose the compact / segment_compact indicator line by status, mirroring
 * MessageBubble's CompactIndicator / SegmentCompactIndicator — which ALWAYS
 * synthesize the label from status (never from block.text/summary). The compact
 * block carries no display `text`; while `compacting` it only has a live
 * `outputChars`, and once `compacted` it holds the full `summary` (which must
 * NOT be shown on the one-line indicator). Reproducing that here keeps the vlist
 * card in parity: a running compact shows "…compacting · N chars" and a finished
 * one shows the terse "compacted" / "segment compacted (N messages)" label.
 */
function composeCompactText(
	ctx: AdapterContext,
	opts: {
		isSegment: boolean;
		status: "compacting" | "compacted" | "failed";
		phase?: ProgressPhase | null;
		thinkingChars?: number | null;
		outputChars?: number | null;
		messageCount?: number | null;
		retryCount?: number | null;
	},
): string {
	if (opts.status === "compacting") {
		// A scheduled retry is the ONE thing a 0-char run must say: without it the
		// marker sits on "0 chars" for minutes while the summary model fails and
		// backs off, and the reader cannot tell a stall from a recovery.
		if (typeof opts.retryCount === "number" && opts.retryCount > 0) {
			const label = sysLabel(ctx, opts.isSegment ? "segmentCompacting" : "compacting");
			const retryLabel = sysLabel(ctx, "compactRetrying").replace(
				/\{count\}/g,
				String(opts.retryCount),
			);
			return `${label} · ${retryLabel}`;
		}
		// Thinking phase: the summary model has not produced visible output yet, so
		// feature the thinking count instead of a stuck "0 chars". A count below the
		// display threshold shows the bare label (see `@shared/progress-phase`).
		if (opts.phase === "thinking") {
			const label = sysLabel(ctx, opts.isSegment ? "segmentCompacting" : "compacting");
			const chars = typeof opts.thinkingChars === "number" ? opts.thinkingChars : 0;
			const thinkingLabel = sysLabel(ctx, "compactThinking");
			if (!shouldShowThinkingChars(chars)) return `${label} · ${thinkingLabel}`;
			const charsLabel = sysLabel(ctx, "compactThinkingChars").replace(/\{count\}/g, String(chars));
			return `${label} · ${thinkingLabel} · ${charsLabel}`;
		}
		const label = sysLabel(ctx, opts.isSegment ? "segmentCompacting" : "compacting");
		const chars = typeof opts.outputChars === "number" ? opts.outputChars : 0;
		const charsLabel = sysLabel(ctx, "compactOutputChars").replace(/\{count\}/g, String(chars));
		return `${label} · ${charsLabel}`;
	}
	if (opts.status === "failed") {
		// Only context compact reaches this composer when failed (segment failed
		// routes to the system-text card upstream).
		return sysLabel(ctx, "compactFailed");
	}
	if (opts.isSegment) {
		const count = typeof opts.messageCount === "number" ? opts.messageCount : 0;
		return sysLabel(ctx, "segmentCompacted").replace(/\{count\}/g, String(count));
	}
	return sysLabel(ctx, "compacted");
}

/**
 * A server-authored system card, wrapped in a speaker bubble.
 *
 * ## Why frame the card instead of projecting it
 *
 * These producers own structured, interactive UI: `merge_summary` names both branches
 * and carries a commit sha, `spec_continuation` shows a badge and a protected marker.
 * Flattening that into markdown would turn usable structure into prose. So the card
 * stays exactly as it is and becomes the bubble's body — the bubble only adds the frame
 * and the speaker row.
 *
 * ## Why these rows deserve a speaker at all
 *
 * The earlier cut of this design asked "does it have a subject?" and answered no for
 * platform events. That was wrong: `container_ready`'s own text says "**You can** use
 * the Browser tool to test these services" — it addresses the model, and the model
 * answers it. The real distinction is not subject-vs-no-subject but **an utterance in
 * the conversation vs a note about the conversation**. Compact markers are the
 * latter; everything here is the former.
 *
 * Interactive controls are deliberately excluded (see `FRAMED_SYSTEM_CARDS`): a
 * permission prompt or an ask-user form is something to OPERATE, not something somebody
 * finished saying, and giving both one visual language would blur reading and acting.
 */
function adaptFramedSystemCard(
	block: AdapterContentBlock,
	idBase: string,
	blockIndex: number,
	msg: AdapterMessage,
	modelFacingText: string,
	ctx: AdapterContext,
): ElementSpec | null {
	const kind = block.type;
	if (!FRAMED_SYSTEM_CARDS.has(kind)) return null;
	// The Dynamic Spec continuation is a TASK, not a card: the bubble draws its row
	// itself (status glyph + lock + wrapping text) instead of nesting the clamped
	// single-line card. See FRAMED_SPEC_TASK_CARDS for why the card is bypassed.
	if (FRAMED_SPEC_TASK_CARDS.has(kind)) {
		const blocked = kind === "spec_blocked_continuation";
		return {
			kind: "injection-bubble",
			// `-b{blockIndex}` ties the row to its single content block, so the selection
			// system can address it for the context menu (delete / rollback / fork).
			key: `${idBase}-b${blockIndex}-f-${kind}`,
			data: {
				payload: {
					kind: "spec-task",
					data: {
						// chunk reads the task off `block.task`, falling back to the row text.
						text: block.task ?? block.text ?? "",
						protected: block.protected === true,
						blocked,
					},
				},
				source: kind,
				creator: msg.creator ?? null,
				hasHeader: true,
				// The verbatim model-facing copy for the context-menu inspector.
				modelFacing: modelFacingText,
			},
		};
	}
	// Reuse the card's own data projection verbatim: the bubble must not fork it, or the
	// framed and standalone forms would drift.
	const inner = adaptSystemBlock(kind, block, idBase, msg, ctx, blockIndex);
	return {
		kind: "injection-bubble",
		key: `${idBase}-b${blockIndex}-f-${kind}`,
		data: {
			payload: { kind: innerPayloadKind(inner), data: inner.data },
			source: kind,
			// A merge is authored by whoever pressed the button, and `creator` is already
			// loaded for system rows — so the header can name a real person with a real
			// avatar instead of a placeholder.
			creator: msg.creator ?? null,
			hasHeader: true,
			// The verbatim model-facing copy for the context-menu inspector.
			modelFacing: modelFacingText,
			// Both of these rows are ABOUT another chapter, and each already carries its
			// id: a review's feedback names the review chapter it came from, a merge
			// summary names the source chapter that was merged in. Read off the raw block
			// rather than the projected card data, because the projection keeps only what
			// the card paints.
			target: framedCardTarget(kind, block),
		},
	};
}

/**
 * The chapter a framed system card refers to, when it names one.
 *
 * `merge_summary` carries `sourceChapterId` (the chapter that was merged in), written by
 * its producer today, so it needs no new field.
 *
 * Returns null when the id is absent, which is the shape of rows written before that
 * producer recorded it. An inert header is the correct outcome there; a link built on a
 * missing id would 404.
 */
function framedCardTarget(kind: string, block: AdapterContentBlock): InjectionTarget | null {
	const raw = block as unknown as Record<string, unknown>;
	const id = kind === "merge_summary" ? raw.sourceChapterId : undefined;
	return typeof id === "string" && id.trim().length > 0 ? { kind: "chapter", chapterId: id } : null;
}

/**
 * The measured element kind the inner card's spec resolved to.
 *
 * Taken from the spec `adaptSystemBlock` returned rather than re-deciding here: that
 * function already owns the simple-vs-text routing, and a second copy would drift.
 */
function innerPayloadKind(inner: ElementSpec): string {
	const data = inner.data as { kind?: unknown } | null;
	return typeof data?.kind === "string" ? data.kind : inner.kind;
}

/**
 * System cards that become speaker bubbles.
 *
 * Deliberately an allow-list. Excluded on purpose:
 *   - `compact` / `segment_compact` — notes ABOUT the conversation (history was
 *     truncated here), not utterances within it.
 *   - `ask_in_passing`, `subagent_recovery`, permission / question forms — controls to
 *     operate, not statements to read.
 *   - `bash_command`, `tool_loaded`, `tool_unloaded` — receipts for the reader's OWN
 *     action, so attributing them to another speaker would be backwards.
 */
const FRAMED_SYSTEM_CARDS = new Set([
	"merge_summary",
	// `review_feedback` was here and is not any more: framing it produced a card inside a
	// bubble — two frames around one body — while the body itself still could not render
	// markdown or scroll. It is its own `review-card` element now.
	"spec_continuation",
	"spec_blocked_continuation",
]);

/**
 * Block kinds whose framed body is a TASK ROW, not a nested card.
 *
 * The Dynamic Spec scheduler speaks these — a third party telling the model to keep
 * working. Framing them used to nest the standalone `system-simple` card inside the
 * bubble, which is the card-in-a-card the redesign removes: the simple card draws a
 * full-width tinted band, clamps the task to one line, and paints the protected lock
 * twice. `adaptFramedSystemCard` maps these to a `spec-task` payload instead, and the
 * bubble measures + draws the task row itself (status glyph + lock + wrapping text) —
 * no inner card, no band.
 */
const FRAMED_SPEC_TASK_CARDS = new Set(["spec_continuation", "spec_blocked_continuation"]);

/**
 * ⚠️ `spec_goal_added` / `spec_fork_carryover` / `spec_context_cleared` are NOT here.
 *
 * Those cards own real BUTTONS whose mutations live outside `vlist/`, so the shell wires
 * them by matching `kind === "system-text"` (`extra.specCarryoverActions`). Rerouting
 * them to `injection-bubble` silently unwires every button — they still paint, and
 * clicking does nothing. Same for the `error` card's retry / dismiss controls.
 *
 * Framing them therefore needs the action-injection seam to reach a nested payload
 * first. Until then they stay standalone cards: a dead button is a worse outcome than a
 * missing speaker row.
 */

/**
 * ⚠️ `container_ready` and `browser_session_lost` are NOT here, and it is not an
 * oversight: neither block type is recognized by `isRecognizedSystemBlockType`, so a row
 * carrying one never reaches this routing at all — it falls back to `blocks[0]`, its own
 * text block, and renders as a plain `info` card. That predates this work (the chunked
 * renderer never special-cased them either).
 *
 * Listing them here would claim support that does not exist. Framing them needs the
 * block types registered as recognized system cards FIRST, with their own data
 * projection; that is a separate change from wrapping cards that already render.
 */

/**
 * Injected content that speaks for somebody → one FRAMED bubble per speaker.
 *
 * ## Why this is not one card
 *
 * A single `subagent_message` / `team_message` delivery can carry messages from
 * SEVERAL senders (the queue caps at 20). The generic injection card flattens them
 * into one Markdown blob whose sender names survive only as sub-headings — i.e. it
 * demotes identity to typography. These messages ARE somebody talking, and the data
 * already carries who (`fromTitle` / `fromId` / `fromType` / `isBroadcast`), so each
 * one gets its own bubble with its own speaker row.
 *
 * Returns null for every other producer, which then takes the ordinary card path:
 * a routine reminder has no speaker, and giving it a bubble would let system nudges
 * carry the same visual weight as a teammate's message.
 *
 * The body is projected per message rather than for the whole delivery, so a bubble
 * measures only its own text.
 */
function adaptSpokenInjection(
	block: AdapterContentBlock,
	idBase: string,
	blockIndex: number,
	modelFacingText: string,
	msg: AdapterMessage,
	ctx: AdapterContext,
): ElementSpec[] | null {
	if (block.type !== "system_injection") return null;
	const source = typeof block.source === "string" ? block.source : "";
	// Both families qualify for a bubble; they differ only in how the delivery splits
	// (per sender vs one statement), which the branches below decide.
	if (!SPOKEN_INJECTION_SOURCES.has(source) && !PLATFORM_INJECTION_SOURCES.has(source)) {
		return null;
	}
	const body = readSideCarBody(block);
	// No structured body → the historical verbatim path, which stays a card: without a
	// body there is nothing to split and nothing to project.
	if (!body) return null;

	// Inbound messages: one bubble. Persistence now delivers ONE message per row (the
	// fan-out loop that used to split a multi-item delivery is gone — see
	// deliverPendingInjectionsInOrder), so `items` holds a single message and the key
	// needs no positional suffix.
	if (body.kind === "messages") {
		const message = Array.isArray(body.items) ? body.items[0] : undefined;
		if (!message) return null;
		const text = (message.text ?? "").trim();
		if (!text) return null;
		return [
			{
				kind: "injection-bubble",
				// Keyed by block index + SENDER: the block index ties the row to its single
				// content block so the selection system can address it; the sender keeps the
				// key stable across a same-block re-projection.
				key: `${idBase}-b${blockIndex}-m-${message.fromId ?? "anon"}`,
				data: {
					...deliveryProjection(msg),
					markdown: rawSideCarToMarkdown(text),
					speaker: spokenSpeakerLabel(message),
					// The sender's own id seeds the deterministic identicon in the header.
					// Titles cluster ("explore-1", "explore-2") so initials collide; the id
					// does not.
					speakerId: message.fromId ?? null,
					speakerKind: message.fromType ?? null,
					// The sender IS a narrator, so its session can be opened from this row.
					// Deliberately NOT derived from `speakerId`: that field seeds the identicon
					// and is set for every speaker kind (a bash task, a knowledge entry), so
					// navigating by it would make a `bg_bash` row offer to open a narrator that
					// does not exist. See `injection-target.ts`.
					target: message.fromId
						? ({
								kind: "narrator",
								narratorId: message.fromId,
								messageId: message.fromToolUseId ?? message.fromMessageId ?? null,
							} satisfies InjectionTarget)
						: null,
					isBroadcast: message.isBroadcast === true,
					source,
					hasHeader: true,
					// The verbatim model-facing copy for the context-menu inspector.
					modelFacing: modelFacingText,
				},
			},
		];
	}

	// Finished background work: one bubble per task.
	//
	// A background task is an addressable, NAMED thing — `Bash` takes an `alias`
	// precisely so a later `Await({ id })` can refer to it — so "run-tests finished,
	// here is its output" has a subject in the same way a teammate's message does.
	// An agent completion identifies a subagent, so show its current narrator title;
	// a Bash completion is instead addressed by its launch alias.
	if (body.kind === "tasksDone") {
		// One finished task per row (persistence delivers them singly now), so the key is
		// the task id alone — no positional suffix.
		const task = Array.isArray(body.items) ? body.items[0] : undefined;
		if (!task) return null;
		const preview = (task.preview ?? "").trim();
		// A bash task's preview is VERBATIM stdout/stderr, so it is fenced unconditionally
		// (`verbatimOutputToMarkdown`) rather than handed to the Markdown parser. Linter
		// and compiler output is preformatted text whose indentation and column rules ARE
		// the content: `bunx biome check` emits `! message` lines followed by
		// two-space-indented source excerpts, which Markdown reads as a heading-ish
		// paragraph followed by an INDENTED CODE block — so one diagnostic rendered as
		// prose and its own excerpt as a separate card, alignment lost. `|`-tables and
		// `#`/`>` lines in test output fail the same way.
		//
		// An agent task's preview is the subagent's own written report, which is authored
		// AS Markdown, so that flavor keeps the prose path. The distinction is the
		// producer's intent, not a guess about the bytes.
		const isVerbatim = body.flavor === "bash";
		// An empty preview still gets a bubble: "it finished, with no output" is itself
		// the result, and the status lives in the header. Dropping the row would make a
		// silent success indistinguishable from one that never ran. The empty LABEL is
		// prose either way — fencing "(empty)" would dress a localized sentence up as
		// machine output.
		const markdown = preview
			? isVerbatim
				? verbatimOutputToMarkdown(preview)
				: rawSideCarToMarkdown(preview)
			: rawSideCarToMarkdown(sysLabel(ctx, "empty"));
		return [
			{
				kind: "injection-bubble",
				key: `${idBase}-b${blockIndex}-t-${task.id}`,
				data: {
					...deliveryProjection(msg),
					markdown,
					speaker:
						body.flavor === "agent"
							? task.title?.trim() || task.alias?.trim() || task.id
							: task.alias?.trim() || task.title?.trim() || task.id,
					// A background task is addressable by id, which is what seeds its glyph.
					speakerId: task.id ?? null,
					speakerKind: task.status ?? null,
					// Only the AGENT flavour has a session: a background agent's task id IS
					// its narrator id, whereas a bash task id addresses a shell invocation
					// with no session to open. Gating on `flavor` rather than on the presence
					// of an id is what keeps a bash row from offering a dead link.
					target:
						body.flavor === "agent" && task.id
							? ({
									kind: "narrator",
									narratorId: task.id,
									messageId: task.resultMessageId ?? null,
								} satisfies InjectionTarget)
							: null,
					isBroadcast: false,
					source,
					hasHeader: true,
					// The producer already clipped the output; the reader is told so on a
					// fixed line the measure pass reserves.
					hasNote: task.truncated === true,
					// The verbatim model-facing copy for the context-menu inspector.
					modelFacing: modelFacingText,
				},
			},
		];
	}

	// Knowledge-base hits: a bubble ONLY when the entries have something to say.
	//
	// A hit is addressable and titled, so "this entry is relevant" does have a subject.
	// But `summary` is frequently empty, and the projection then emits a bullet holding
	// nothing but the title — so a bubble per hit would be a stack of empty shells whose
	// body repeats its own header, taking several times the height of the compact list
	// for strictly less information. The shape therefore follows the DATA, not the tag.
	if (body.kind === "knowledge") {
		const hits = Array.isArray(body.hits) ? body.hits : [];
		/*
		 * ⚠️ The excerpt is re-derived HERE, not read as stored.
		 *
		 * `summary` is a FLATTENED slice of the entry's Markdown body, and rows written
		 * before the server started stripping it still hold raw Markdown. Painting that as
		 * Markdown is what produced the wall of display-size heading in the report: an entry
		 * body opens with `# Title`, so the whole flattened excerpt sat behind that `#`.
		 *
		 * `knowledgeExcerpt` is idempotent, so running it over an already-clean excerpt is a
		 * no-op and the two paths agree. The `title` argument drops a leading line that
		 * merely repeats the entry title — which is exactly what this bubble's own header
		 * shows, so keeping it cost the excerpt its most useful line.
		 */
		const excerpted = hits.map((hit) => ({
			hit,
			excerpt: knowledgeExcerpt(hit?.summary ?? "", { title: hit?.title ?? undefined }),
		}));
		const substantive = excerpted.filter((e) => e.excerpt.length > 0);
		// All-or-nothing: a mixed batch stays a list rather than splitting one delivery
		// across two visual languages.
		if (substantive.length === 0 || substantive.length !== hits.length) return null;
		// ⚠️ Keyed by the entry's own identity, NOT by array position. `spec.key` is the
		// measure-cache key, the fold/selection key and the height-override key all at
		// once (CONTRACT §4.5.1), so a key that shifts when the batch composition changes
		// makes one entry inherit another's cached height and expand state. Position was
		// safe here only as long as the all-or-nothing gate above guaranteed
		// `substantive === hits`; that is an invisible coupling between a VISUAL policy
		// and key correctness, and relaxing the policy later would silently break it.
		return substantive.map(({ hit, excerpt }) => ({
			kind: "injection-bubble" as const,
			key: `${idBase}-b${blockIndex}-k-${hit.entryId}`,
			data: {
				...deliveryProjection(msg),
				// PLAIN text, escaped rather than parsed: the excerpt is prose by
				// construction now, and any `#`/`>`/`-` still in it is debris from the
				// flattening, not authored structure.
				markdown: escapeMarkdown(excerpt),
				speaker: hit.title?.trim() || hit.entryId,
				// The entry's own id seeds its glyph, so two similarly-titled entries stay
				// visually distinct.
				speakerId: hit.entryId ?? null,
				speakerKind: null,
				// The excerpt is a FLATTENED slice of the entry, so "read the rest" is the
				// natural next action — this is the one bubble kind whose body is knowingly
				// incomplete. Injected hits come from the global collections (see
				// `knowledge-injection.ts`, which ACL-filters `knowledgeService` entries), so
				// the scope is global rather than a guess.
				target: hit.entryId
					? ({ kind: "knowledge", entryId: hit.entryId, scope: "global" } satisfies InjectionTarget)
					: null,
				// Without this the row had no context-menu inspector at all.
				modelFacing: modelFacingText,
				isBroadcast: false,
				source,
				hasHeader: true,
			},
		}));
	}

	// Routine reminders the PLATFORM raises: the task digest, the behaviour fence, a
	// progress nudge, a spec save. One bubble for the whole delivery — unlike inbound
	// messages there is no per-sender split to make, because the speaker is the same
	// platform every time.
	//
	// These used to stay full-width notice cards on the theory that a routine reminder
	// must not carry a teammate's visual weight. Two things were wrong with that. The
	// scheduler pushing "you still have 3 open tasks" IS an utterance with a speaker —
	// the same speaker as `spec_continuation`, which was already a bubble, so the split
	// was internally inconsistent. And full width made the long task lines run far past a
	// comfortable measure; the bubble's width cap fixes exactly that.
	// A task DIGEST renders as task ROWS, not markdown bullets — the same rows the
	// auto-continuation uses. Before this, the periodic reminder and the continuation
	// showed the same data in two visual languages: the digest demoted `role` to a text
	// prefix ("doing: …") and `protected` to the words "· protected", while the
	// continuation had a status glyph and a lock. Same payload, one presentation now.
	if (PLATFORM_INJECTION_SOURCES.has(source) && body.kind === "tasks") {
		const variant = typeof body.variant === "string" ? body.variant : "current";
		const tasks = Array.isArray(body.tasks) ? body.tasks : [];
		// Empty / over-threshold digests have no rows to draw; they carry the same
		// localized sentence the markdown projection used as its headline.
		const emptyLabel =
			variant === "current" && tasks.length > 0
				? null
				: variant === "emptyNever"
					? sysLabel(ctx, "tasksEmptyNever")
					: variant === "emptyDone"
						? sysLabel(ctx, "tasksEmptyDone")
						: variant === "tooMany"
							? // `tasksTooMany` carries an `{n}` placeholder; sysLabel has no
								// interpolation, so substitute here (same as the markdown path).
								sysLabel(ctx, "tasksTooMany").replace("{n}", String(body.taskCount ?? 0))
							: null;
		// A periodic digest names its cadence in the header's subtitle slot, so the
		// reader can tell "this is the routine every-N-tool-calls summary" apart from
		// a turn-end continuation listing the same tasks. Height-neutral: the header
		// row is a fixed single line either way.
		const cadenceInterval =
			typeof body.cadenceInterval === "number" && body.cadenceInterval > 0
				? body.cadenceInterval
				: null;
		const speakerKind = cadenceInterval
			? sysLabel(ctx, "cadenceEveryNTools").replace("{n}", String(cadenceInterval))
			: null;
		return [
			{
				kind: "injection-bubble",
				key: `${idBase}-b${blockIndex}-p-${source}`,
				data: {
					...deliveryProjection(msg),
					payload: {
						kind: "spec-task",
						data: {
							...(emptyLabel ? { emptyLabel } : {}),
							tasks: tasks.map((task) => ({
								text: task.text ?? "",
								role: task.role,
								protected: task.protected === true,
							})),
						},
					},
					speaker: null,
					speakerKind,
					isBroadcast: false,
					source,
					hasHeader: true,
					// The verbatim model-facing copy, so the row can be inspected like any
					// other injection (this branch previously offered no inspector).
					modelFacing: modelFacingText,
				},
			},
		];
	}

	if (PLATFORM_INJECTION_SOURCES.has(source)) {
		const markdown = sideCarBodyToMarkdown(source, body, ctx.labels);
		if (!markdown.trim()) return null;
		return [
			{
				kind: "injection-bubble",
				key: `${idBase}-b${blockIndex}-p-${source}`,
				data: {
					markdown,
					// No speaker name: the integration layer resolves the shared platform
					// identity from `source` (see `isPlatformSource`). Coining one name per
					// producer would imply a cast of actors that does not exist.
					speaker: null,
					speakerKind: null,
					isBroadcast: false,
					source,
					hasHeader: true,
					// Same inspector contract as every other injection row.
					modelFacing: modelFacingText,
					// A spec-file save names the file it changed, and that file is openable in
					// the Spec panel. Only a SINGLE-file delivery gets a target: a multi-file
					// save has no one destination, and silently picking the first would take
					// the reader somewhere the row did not promise.
					target: specUpdateTarget(body),
				},
			},
		];
	}

	return null;
}

/**
 * Routine reminders raised by the platform itself.
 *
 * Separate from {@link SPOKEN_INJECTION_SOURCES} because the split differs, not because
 * the entitlement does: a message delivery fans out per sender, whereas a reminder is one
 * statement from one speaker regardless of how many tasks it lists.
 */
export const PLATFORM_INJECTION_SOURCES = new Set([
	"living_work_spec",
	"todo_reminder",
	"behavior_fence",
	"relaxed_plan",
	"silent_progress",
	"pipeline_exit_confirmation",
	"spec_update",
]);

/**
 * Producers whose payload is somebody TALKING, as opposed to a system fact.
 *
 * Deliberately a small allow-list rather than "anything with a messages body":
 * adding a producer here is a claim that its content has an author worth naming, and
 * that claim should be made explicitly at the point someone adds the producer.
 */
const COMMUNICATION_INJECTION_SOURCES = new Set([
	"subagent_message",
	"agent_message",
	"team_message",
	"group_message",
]);

/** The same structural predicate drives user-row rendering and selection ownership. */
export function readCommunicationInjection(block: {
	type: string;
	source?: unknown;
	body?: unknown;
	bodyJson?: unknown;
}): SideCarInboundMessage | null {
	if (
		block.type !== "system_injection" ||
		typeof block.source !== "string" ||
		!COMMUNICATION_INJECTION_SOURCES.has(block.source)
	)
		return null;
	const body = readSideCarBody(block);
	if (body?.kind !== "messages") return null;
	const message = body.items[0];
	return message && typeof message.text === "string" && message.text.trim() ? message : null;
}

const SPOKEN_INJECTION_SOURCES = new Set([
	// Somebody sent the reader something.
	...COMMUNICATION_INJECTION_SOURCES,
	// Work the reader started reporting its own result. `bg_bash` qualifies for the
	// same reason as `bg_agent`: an aliased background command is a named entity the
	// system already treats as addressable, not an anonymous event.
	"bg_agent",
	"bg_bash",
	// Reference material with a real excerpt. Gated on the payload as well as the tag —
	// see the `knowledge` branch above.
	"knowledge_base_hint",
]);

/**
 * The Spec file a `spec_update` row points at, when it points at exactly one.
 *
 * Returns null for every other platform producer (a task digest is about the spec but
 * is not a report of one file changing) and for a multi-file save. The multi-file case
 * is a real one — `drainSpecUpdates` batches whatever the user saved — and there is no
 * honest single destination for it, so the row stays inert rather than picking one.
 */
function specUpdateTarget(body: SideCarBody): InjectionTarget | null {
	if (body.kind !== "specUpdates") return null;
	const items = Array.isArray(body.items) ? body.items : [];
	if (items.length !== 1) return null;
	const uri = items[0]?.uri?.trim();
	return uri ? { kind: "spec", uri } : null;
}

/**
 * Display name for one inbound message's sender.
 *
 * Mirrors `senderLabel` in `@shared/sidecar-body` (title, alias, then an 8-char id prefix) so
 * the bubble header and the model-facing text name the same participant. Falls back to
 * empty, which the render layer shows as an unnamed speaker rather than inventing one.
 */
function spokenSpeakerLabel(message: SideCarInboundMessage): string {
	return (
		message.fromTitle?.trim() || message.fromLabel?.trim() || message.fromId?.slice(0, 8) || ""
	);
}

function adaptSystemBlock(
	blockType: string,
	block: AdapterContentBlock,
	idBase: string,
	msg: AdapterMessage,
	ctx: AdapterContext,
	blockIndex = 0,
): ElementSpec {
	const keyBase = `${idBase}-b${blockIndex}`;
	// The message's leading text block is the chunk renderer's `contentText`
	// fallback (goalBlock.task ?? message.contentText, etc.).
	const contentText =
		msg.contentJson.find((b) => b.type === "text" && (b.text ?? "").trim().length > 0)?.text ?? "";

	if (blockType === "compact" && block.subtype === "plan") {
		return {
			kind: "plan-card",
			key: `${idBase}-plan`,
			data: { summary: block.summary ?? block.text ?? "" },
		};
	}
	if (blockType === "knowledge_hint") {
		return {
			kind: "knowledge-hint",
			key: `${idBase}-kh`,
			data: { heading: block.summary ?? "", entries: (block.entries as unknown[]) ?? [] },
		};
	}
	if (blockType === "ask_in_passing") {
		// Mirror MessageBubble: pending iff status==="pending", otherwise resolved
		// (any non-pending status — resolved/answered/etc — renders the resolved card).
		const pending = block.status === "pending";
		// The resolved block stores the asked question in `question` (the server's
		// resolve handler writes that field; `text` is never set on it), so reading
		// only `text` measured — and painted — an empty question line.
		const question =
			typeof block.question === "string" && block.question.length > 0
				? block.question
				: (block.text ?? "");
		return {
			kind: "ask-in-passing",
			key: `${idBase}-aip`,
			data: { kind: pending ? "pending" : "resolved", question },
		};
	}
	if (blockType === "subagent_recovery") {
		// Mirror MessageBubble: pending unless the server already flipped the block
		// to resolved after the user picked a resume mode.
		const resolved = block.status === "resolved";
		const rows = Array.isArray(block.subagents) ? (block.subagents as unknown[]) : [];
		const resumedCount = typeof block.resumedCount === "number" ? block.resumedCount : rows.length;
		const key = `${idBase}-sr`;
		return {
			kind: "subagent-recovery",
			key,
			// The row toggle state reuses the generic per-row index set, which starts
			// EMPTY. The card defaults to "everything selected", so the set tracks
			// DESELECTED rows rather than selected ones.
			opts: { deselected: ctx.expandedRows?.(key) ?? [] },
			data: {
				kind: resolved ? "resolved" : "pending",
				title: sysLabel(ctx, "subagentRecoveryTitle"),
				description: countLabel(ctx, "subagentRecoveryDescription", rows.length),
				subagents: rows,
				summary: countLabel(
					ctx,
					block.mode === "await"
						? "subagentRecoveryResolvedWait"
						: "subagentRecoveryResolvedNotify",
					resumedCount,
				),
				notifyLabel: sysLabel(ctx, "subagentRecoveryResumeAndNotify"),
				waitLabel: sysLabel(ctx, "subagentRecoveryResumeAndWait"),
				backgroundBadge: sysLabel(ctx, "subagentRecoveryToBackground"),
			},
		};
	}

	// ── segment_compact: compacting/compacted → simple; failed → system-text card.
	if (blockType === "segment_compact") {
		if (block.status === "failed") {
			return {
				kind: "system-text",
				key: `${keyBase}-sys`,
				data: {
					kind: "segment_compact_failed",
					text: block.error ?? block.summary ?? sysLabel(ctx, "segmentCompactFailedDesc"),
					title: sysLabel(ctx, "segmentCompactFailed"),
					buttons: [sysLabel(ctx, "dismiss")],
					color: "red",
				},
			};
		}
		const segStatus = block.status === "compacting" ? "compacting" : "compacted";
		return {
			kind: "system-simple",
			key: `${keyBase}-sys`,
			data: {
				kind: "segment_compact",
				// The label is synthesized from status (parity with
				// SegmentCompactIndicator); block.text/summary are never shown here.
				text: composeCompactText(ctx, {
					isSegment: true,
					status: segStatus,
					phase: block.progressPhase,
					thinkingChars: block.thinkingChars,
					outputChars: block.outputChars,
					messageCount: block.messageCount,
					retryCount: block.retryCount,
				}),
				status: segStatus,
				compactLabels: compactProgressLabels(ctx),
			},
		};
	}

	if (SYSTEM_SIMPLE_SUBTYPES.has(blockType)) {
		return {
			kind: "system-simple",
			key: `${keyBase}-sys`,
			data: adaptSystemSimpleData(blockType, block, ctx),
		};
	}
	if (SYSTEM_TEXT_SUBTYPES.has(blockType)) {
		return {
			kind: "system-text",
			key: `${keyBase}-sys`,
			data: adaptSystemTextData(blockType, block, contentText, ctx, msg.createdAt),
		};
	}
	// fallback: treat as info text. `message` is checked first because that is
	// where display notices keep their body (see the `info` case below).
	return {
		kind: "system-text",
		key: `${keyBase}-sys`,
		data: { kind: "info", text: block.message ?? block.text ?? contentText },
	};
}

/** Compose the single-line system-simple card data (height-neutral chrome +
 * the clamped display line). Mirrors MessageBubble's per-subtype field reads. */
function adaptSystemSimpleData(
	blockType: string,
	block: AdapterContentBlock,
	ctx: AdapterContext,
): Record<string, unknown> {
	switch (blockType) {
		case "compact": {
			const compactStatus =
				block.status === "compacting"
					? "compacting"
					: block.status === "failed"
						? "failed"
						: "compacted";
			return {
				kind: "compact",
				// The label is synthesized from status (parity with CompactIndicator);
				// block.text/summary are never shown on the one-line indicator.
				text: composeCompactText(ctx, {
					isSegment: false,
					status: compactStatus,
					phase: block.progressPhase,
					thinkingChars: block.thinkingChars,
					outputChars: block.outputChars,
					retryCount: block.retryCount,
				}),
				status: compactStatus,
				compactLabels: compactProgressLabels(ctx),
			};
		}
		case "merge_summary":
			return {
				kind: "merge_summary",
				text: block.text ?? block.summary ?? sysLabel(ctx, "mergeSummaryLabel"),
				color: "indigo",
				hasAvatar: true,
			};
		default:
			return { kind: blockType, text: block.text ?? block.summary ?? "" };
	}
}

/** Compose the multi-line system-text card data (wrapping body drives height +
 * height-neutral chrome). Mirrors MessageBubble's per-subtype field reads. */
function adaptSystemTextData(
	blockType: string,
	block: AdapterContentBlock,
	contentText: string,
	ctx: AdapterContext,
	/** Row timestamp, for the kinds whose card carries a heading row. */
	createdAt?: string | null,
): Record<string, unknown> {
	switch (blockType) {
		// `info` carries its body in `message`, NOT `text` — persistDisplayMessage
		// writes `[{ type: "info", message: text }]` (chunk reads infoBlock.message).
		// Reading only `text` here measured and painted an empty grey box, which is
		// what made cwd-change and other display notices invisible in the vlist.
		case "info":
			return { kind: "info", text: block.message ?? block.text ?? contentText };
		case "error": {
			const errorText = block.message ?? block.text ?? sysLabel(ctx, "unknownError");
			// Both buttons are LABELLED controls on the card's one optional button row,
			// so whether that row exists changes the card's height and must be decided
			// here, during measurement — not painted in later by the render layer. The
			// predicates are injected by the shell (they depend on the user's role and
			// the narrator's resolved provider, neither of which belongs in the pure
			// adapter); the error-text match itself is a pure predicate it applies.
			//
			// `buttonIds` names each label so the render layer binds handlers by MEANING
			// rather than by position. With two conditional buttons, index-based binding
			// silently attaches the wrong handler as soon as only the second one is
			// eligible.
			const offerFix = ctx.canOfferProviderFix?.(errorText) === true;
			const offerModelTest = ctx.canOfferModelTest?.(errorText) === true;
			const buttons: string[] = [];
			const buttonIds: string[] = [];
			if (offerFix) {
				buttons.push(sysLabel(ctx, "disableImageGen"));
				buttonIds.push("disableImageGen");
			}
			if (offerModelTest) {
				buttons.push(sysLabel(ctx, "testCurrentModel"));
				buttonIds.push("testCurrentModel");
			}
			return {
				kind: "error",
				text: errorText,
				color: "red",
				actions: true,
				...(buttons.length > 0 ? { buttons, buttonIds } : {}),
			};
		}
		case "bash_command":
			return {
				kind: "bash_command",
				text: block.command ?? block.text ?? "",
				command: block.command ?? undefined,
			};
		case "tool_loaded":
		case "tool_unloaded":
			return { kind: blockType, text: block.text ?? block.summary ?? "" };
		case "system_injection": {
			// Reuses the `origin_notice` card: a heading row (what injected this, when)
			// above a wrapping body — exactly the shape an injection needs, and already
			// measured. No new element kind, no new geometry.
			//
			// The body is projected from the STRUCTURED payload, not from the message's
			// text block: the text block is the model-facing copy, complete with the
			// instruction boilerplate ("do not add IDs…") that a reader has no use for.
			// Falls back to that text only when a producer supplied no body.
			const body = readSideCarBody(block);
			const source = typeof block.source === "string" ? block.source : "";
			// Native self-contained injections keep their model-facing projection on
			// `modelText`; legacy rows may still provide a sibling `text` block.
			const modelFacingText = block.modelText ?? block.text ?? contentText;
			const markdown = body
				? sideCarBodyToMarkdown(source, body, ctx.labels)
				: rawSideCarToMarkdown(modelFacingText);
			return {
				kind: "origin_notice",
				text: markdown || rawSideCarToMarkdown(modelFacingText),
				title: injectionHeadingLabel(ctx, source),
				timeLabel: formatOriginNoticeTime(createdAt),
				origin: "system",
				originLabel: source || null,
				// The model-facing copy, verbatim: the body above is the READER's projection
				// (instruction boilerplate stripped), while this is what the agent actually
				// received. The context-menu inspector shows this so the reader can see
				// exactly what the model saw.
				modelFacing: modelFacingText,
			};
		}
		case "spec_goal_added": {
			const added = block.added !== false;
			return {
				kind: "spec_goal_added",
				// chunk: goalBlock.task ?? message.contentText
				text: block.task ?? block.text ?? contentText,
				added,
				color: "indigo",
				badges: [
					sysLabel(ctx, "specProtectedBadge"),
					sysLabel(ctx, added ? "specGoalAddedBadge" : "specGoalExistsBadge"),
				],
				buttons: [sysLabel(ctx, "specGoalViewTasks")],
			};
		}
		case "spec_fork_carryover":
		case "spec_context_cleared": {
			const isCleared = blockType === "spec_context_cleared";
			return {
				kind: blockType,
				text: carryoverDescription(ctx, block),
				color: "indigo",
				variant: isCleared ? "contextCleared" : "fork",
				badges: [sysLabel(ctx, isCleared ? "specContextCleared" : "specForkCarryover")],
				buttons: [
					sysLabel(ctx, "specViewTasks"),
					sysLabel(ctx, "specClearTasks"),
					sysLabel(ctx, "specResetTasks"),
				],
			};
		}
		default:
			return { kind: "info", text: block.message ?? block.text ?? contentText };
	}
}

// ── Within-tool-run LOD folding (mirrors render-units + MessageRenderer's
// ToolRunLodGate). Vlist-local copies of the pure helpers keep the adapter
// self-contained (no app import). Semantics locked by segment-adapter.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** True when a tool item is mid-flight (running / pending / initializing). */
export function isActiveToolItem(item: AdapterToolItem): boolean {
	const s = item.tc.status;
	return s === "running" || s === "pending" || s === "initializing" || isStreamingToolItem(item);
}

/** Synthetic tool inputs stream before their persisted status catches up. */
export function isStreamingToolItem(item: AdapterToolItem): boolean {
	const input = item.tc.inputJson;
	return (
		typeof input === "object" &&
		input !== null &&
		(input as { _streamingChars?: unknown })._streamingChars != null
	);
}

type ToolLodGroup =
	| { kind: "active"; item: AdapterToolItem; index: number }
	| { kind: "folded"; items: AdapterToolItem[]; startIndex: number };

/** True when an item is the pinned latest spec://tasks.json call (see AdapterContext). */
function isLatestSpecTasksToolItem(
	item: AdapterToolItem,
	latestSpecTasksToolUseId: string | null | undefined,
): boolean {
	return latestSpecTasksToolUseId != null && item.tc.toolUseId === latestSpecTasksToolUseId;
}

/** Split a tool run into chronological groups: active items stay standalone,
 * completed items fold in contiguous batches. Mirrors groupToolRunItemsForLod —
 * including its second argument: the latest tasks.json call keeps its full card
 * out of the fold at every LOD. Prefer-open tools (AskUserQuestion) stay
 * standalone too: their options/form is operational content, not activity noise. */
export function groupToolItemsForLod(
	items: AdapterToolItem[],
	latestSpecTasksToolUseId?: string | null,
): ToolLodGroup[] {
	const groups: ToolLodGroup[] = [];
	let pending: AdapterToolItem[] = [];
	let pendingStart = 0;
	const flush = () => {
		if (pending.length === 0) return;
		groups.push({ kind: "folded", items: pending, startIndex: pendingStart });
		pending = [];
	};
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;
		if (
			isCommunicationTool(item.tc) ||
			item.isSubagent ||
			isActiveToolItem(item) ||
			isPreferOpenTool(item.tc) ||
			isLatestSpecTasksToolItem(item, latestSpecTasksToolUseId)
		) {
			flush();
			groups.push({ kind: "active", item, index: i });
			continue;
		}
		if (pending.length === 0) pendingStart = i;
		pending.push(item);
	}
	flush();
	return groups;
}

function toolItemKey(item: AdapterToolItem): string {
	const fallback = `${item.msg?.id ?? "msg"}-${item.blockIndex}`;
	return `tool-${item.tc.toolUseId ?? fallback}`;
}

function isRecentToolItem(item: AdapterToolItem, ctx: AdapterContext): boolean {
	if (!ctx.recentMessageIds) return true;
	return item.msg?.id != null && ctx.recentMessageIds.has(item.msg.id);
}

interface ToolRunContext {
	inRun: boolean;
	isLast: boolean;
	isSoleSubagent: boolean;
}

export interface CommunicationBubbleData {
	toolUseId?: string;
	toolName: string;
	recipients: {
		label: string;
		title?: string;
		id?: string;
		deliveryMessageId?: string;
		injectionConsumedAt?: string;
	}[];
	deliveryState?: CommunicationState;
	broadcast: boolean;
	message: string;
	messageTruncated: boolean;
	messageBody?: ToolCappedDetail;
	labels?: Record<string, string>;
	awaitReply: boolean;
	status: string;
	error?: string;
	warning?: string;
	timing?: Record<string, number>;
	toolDetailRef?: AdapterToolDetailRef;
}

const COMMUNICATION_ERROR_MAX_CHARS = 2_048;

function communicationRecipients(
	input: Record<string, unknown>,
	metadata: Record<string, unknown>,
	tc: AdapterToolItem["tc"],
): CommunicationBubbleData["recipients"] {
	const selectors = communicationSelectors(input);
	// Persisted targets define the complete set; live events may cover only a prefix.
	const liveTargets = asObject(tc)._sendDeliveryTargets;
	if (Array.isArray(metadata.targets) || Array.isArray(liveTargets)) {
		return resolveCommunicationTargets(metadata, liveTargets).map((target) => {
			const { id, deliveryMessageId } = target;
			const title = target.title?.trim();
			return {
				label: communicationTargetLabel(target),
				...(title ? { title } : {}),
				...(id && id !== "parent" && id !== "main" ? { id } : {}),
				...(deliveryMessageId ? { deliveryMessageId } : {}),
				...(target.injectionConsumedAt ? { injectionConsumedAt: target.injectionConsumedAt } : {}),
			};
		});
	}
	const resolved = readNonEmptyString(tc, "_awaitAgentNarratorId");
	// The WS event resolves only a single target, never every member of a fanout.
	if (resolved && resolved !== "parent" && resolved !== "main" && selectors.length === 1) {
		return [{ label: selectors[0] ?? resolved, id: resolved }];
	}
	return selectors.map((label) => ({ label }));
}

function buildCommunicationBubbleData(
	item: AdapterToolItem,
	ctx: AdapterContext,
): CommunicationBubbleData {
	const inputJson = withFullInput(item, ctx);
	const input = toolInputFieldView(inputJson);
	const metadata = asObject(resolveToolMetadata(item.tc));
	const text = readLeafText(input.message) ?? "";
	const preview = limitCommunicationPreview(text);
	const message = preview.text;
	const messageTruncated = hasTruncatedLeaf(input.message) || preview.truncated;
	const targets = resolveCommunicationTargets(metadata, asObject(item.tc)._sendDeliveryTargets);
	const awaitReply =
		item.tc.toolName === "Send" &&
		(typeof input.await === "boolean" ? input.await : metadata.await === true);
	const deliveryState = deriveCommunicationState({
		targets,
		targetCount: metadata.targetCount ?? asObject(item.tc)._sendDeliveryTargetCount,
		selectorCount: Array.isArray(metadata.targets) ? 0 : communicationSelectors(input).length,
		awaitReply,
		status: item.tc.status,
	});
	const failedTarget = targets.find(
		(target) => target.status === "fail" || target.status === "failed" || target.status === "error",
	);
	const interruptedTarget = targets.find(
		(target) =>
			target.status === "timeout" || target.status === "aborted" || target.status === "cancelled",
	);
	const status = failedTarget
		? "error"
		: interruptedTarget
			? String(interruptedTarget.status)
			: (item.tc.status ?? "initializing");
	const error =
		readNonEmptyString(item.tc, "errorMessage") ??
		failedTarget?.error?.trim() ??
		(status === "fail" || status === "error" || status === "failed"
			? (readLeafText(item.tc.outputJson) ?? readLeafText(asObject(item.tc.outputJson)._text))
			: undefined);
	const warning =
		readNonEmptyString(metadata, "warning") ??
		(interruptedTarget
			? interruptedTarget.error?.trim() || String(interruptedTarget.status)
			: undefined);
	return {
		toolUseId: item.tc.toolUseId,
		toolName: item.tc.toolName,
		recipients: communicationRecipients(input, metadata, item.tc),
		broadcast: item.tc.toolName === "TeamStatus" && input.action === "broadcast",
		message,
		messageTruncated,
		labels: ctx.labels,
		messageBody: describeToolBody(
			{
				kind: "capped",
				id: "input.message",
				source: "input.message",
				// Viewer-only reference: inline measure/render consumes bounded `message`.
				// Keeping the source here lets an explicitly loaded payload open in full.
				text,
				format: "markdown",
				live: false,
				cap: "code",
				followTarget: { kind: "end" },
				textTruncated: hasTruncatedLeaf(input.message),
			},
			{
				...(item.dedupeSuffix ? { occurrence: item.dedupeSuffix } : {}),
				...(item.tc.toolUseId
					? { toolUseId: item.tc.toolUseId }
					: { previewId: toolItemKey(item) }),
				toolName: item.tc.toolName,
				category: "send",
				status: item.tc.status,
				inputJson,
				metadata,
				isStreaming: isStreamingToolItem(item),
			},
		),
		awaitReply,
		deliveryState,
		status,
		...(error ? { error: error.slice(0, COMMUNICATION_ERROR_MAX_CHARS) } : {}),
		...(warning ? { warning: warning.slice(0, COMMUNICATION_ERROR_MAX_CHARS) } : {}),
		timing: cardTiming(item.tc),
		toolDetailRef: resolveToolDetailRef(item),
	};
}

/** Communication is dispatched before subagent cards and ignores every LOD fold. */
function adaptCommunicationBubble(item: AdapterToolItem, ctx: AdapterContext): ElementSpec {
	const key = toolItemKey(item);
	return {
		kind: "communication-bubble",
		key,
		unitId: key,
		data: buildCommunicationBubbleData(item, ctx),
		opts: { opened: true, forceExpanded: true, inRun: false, isLast: true },
	};
}

/** Adapt a single tool item to its full card (tool-call or subagent-card). */
function adaptToolItemFull(
	item: AdapterToolItem,
	ctx: AdapterContext,
	runContext: ToolRunContext = { inRun: false, isLast: true, isSoleSubagent: false },
): ElementSpec {
	const isCommunication = isCommunicationTool(item.tc);
	const hasPendingPermission = ctx.resolveHasPendingPermission?.(item.tc.toolUseId) ?? false;
	// Approval controls only mount on a generic tool card. Once the decision lands,
	// the same tool identity becomes its conversation bubble, never a subagent card.
	if (isCommunication && !hasPendingPermission) return adaptCommunicationBubble(item, ctx);
	const key = toolItemKey(item);
	const opened = ctx.isExpanded?.(key);
	const defaultOpened =
		opened === undefined && item.isSubagent && runContext.isSoleSubagent ? true : opened;
	const lodUserOverride = ctx.isLodUserOverride?.(key) ?? false;
	// The latest tasks.json call stays expanded at every LOD (the task board is the
	// narrator's live working state). Like the permission flag it folds into the
	// card's opts, so the measure cache keys the two geometries apart.
	const isPinnedSpecTasks = isLatestSpecTasksToolItem(
		item,
		ctx.resolveLatestSpecTasksToolUseId?.(),
	);
	// Prefer-open (AskUserQuestion): default-expand at every LOD, but the reader may
	// still fold. Not `forceExpanded` — that would make the chevron dead, which is
	// exactly the L5 bug `userCollapsed` was introduced to fix. `collapsesByLod`
	// must stay false so the header toggle writes `expanded` rather than
	// `lodUserOverride` (the override channel FORCE-expands and cannot fold).
	const preferOpen = isPreferOpenTool(item.tc);
	const opts = {
		isRecent: isRecentToolItem(item, ctx),
		...(defaultOpened === undefined ? {} : { opened: defaultOpened }),
		lodUserOverride,
		viewportHeight: ctx.viewportHeight,
		inRun: runContext.inRun,
		isLast: runContext.isLast,
		// Pending-permission cards stay expanded and re-measure when the request
		// appears/disappears (the boolean folds into the measure cache key).
		...(hasPendingPermission ? { hasPendingPermission: true } : {}),
		// Same contract for the pinned tasks card: it never collapses to a header,
		// even at L3 or as an older card at L4.
		...(isPinnedSpecTasks ? { forceExpanded: true } : {}),
		...(preferOpen ? { preferOpen: true } : {}),
		collapsesByLod:
			!hasPendingPermission &&
			!preferOpen &&
			!isActiveToolItem(item) &&
			(item.isSubagent
				? ctx.lod === 1
				: ctx.lod === 3 || (ctx.lod === 4 && !isRecentToolItem(item, ctx))),
	};
	if (item.isSubagent && !isCommunication) {
		const data = buildSubagentCardData(item, ctx);
		return {
			kind: "subagent-card",
			key,
			// Pairs this card with the folded row it becomes at low LOD (ElementSpec.unitId).
			unitId: key,
			data,
			opts: {
				...opts,
				isActive: data.isActive,
				inRun: runContext.inRun,
				isLast: runContext.isLast,
			},
		};
	}
	return {
		kind: "tool-call",
		key,
		// Same value the folded trace row carries, so this card and the row it becomes
		// at low LOD are pairable across a level change (see ElementSpec.unitId).
		unitId: key,
		data: buildToolCardData(item, ctx, runContext, hasPendingPermission),
		opts,
	};
}

/**
 * The complete `SubagentCardData` payload for ONE subagent tool call.
 *
 * Extracted from `adaptToolItemFull` so a folded trace row can build the very
 * same card when the reader drills into it (see `toolTraceItem`'s `expanded`
 * path). Keeping one constructor is what guarantees the drilled-in card measures
 * and paints identically to the standalone card at high LOD — a second, parallel
 * derivation is how the two would silently diverge.
 */
function buildSubagentCardData(item: AdapterToolItem, ctx: AdapterContext) {
	// Map height-relevant SubagentCardData fields (NOT `status` — that field
	// doesn't exist on SubagentCardData; it uses isTerminal + recentCallCount).
	const key = toolItemKey(item);
	const activity = item.tc._subagentActivity;
	const recentCalls = activity?.latestToolCalls ?? [];
	// Names and timings are derived from the SAME filtered list so index i lines
	// up in both arrays — the renderer pairs them positionally per row.
	const namedRecentCalls = recentCalls
		.filter(
			(call): call is Record<string, unknown> =>
				call != null &&
				typeof call === "object" &&
				typeof (call as { toolName?: unknown }).toolName === "string" &&
				((call as { toolName: string }).toolName?.length ?? 0) > 0,
		)
		.slice(0, 3);
	const recentCallNames = namedRecentCalls.map((call) => call.toolName as string);
	const recentCallTimings = namedRecentCalls.map((call) => ({
		...(typeof call.status === "string" ? { status: call.status } : {}),
		...recentCallTiming(call),
	}));
	// Row label detail + category chip. These rows are TRACE rows now, and a trace
	// row says `Tool · summary` with a tinted category chip — the vlist copy used to
	// show the bare tool name in a grey box, so the same child call read differently
	// here than in the chunked card. Both are render-only (one truncating line, one
	// fixed 14px chip slot).
	//
	// The summary comes from the header's `inputSummary` — the whitelisted short
	// keys the server projects INSIDE SQLite — through a resolver the shell injects
	// (the pure adapter has no access to `getSummary`).
	const recentCallSummaries = namedRecentCalls.map(
		(call) =>
			ctx.resolveSubagentRecentSummary?.(call.toolName as string, call.inputSummary) ?? null,
	);
	const recentCallCategories = namedRecentCalls.map(
		(call) => ctx.resolveToolCategory?.(call.toolName as string) ?? null,
	);
	// The conclusion body, via the SHARED extraction rule. A bare `typeof === "string"`
	// check used to live here, which dropped the result entirely for the ~43% of rows
	// whose output is the runner's `{_text, _metadata}` envelope — a finished subagent
	// card with a blank conclusion. `withFullOutput` so a projected/truncated body is
	// replaced by the real one once the shell fetched it.
	const metadata = resolveToolMetadata(item.tc);
	const outputJson = toolOutputValue(withFullOutput(item, ctx), metadata);
	const resultValue = readLeafText(outputJson) ?? readLeafText(asObject(outputJson)._text);
	const resultContent = resultValue === undefined ? undefined : subagentResultText(outputJson);
	const resultText = resultContent || undefined;
	const isActive = !isTerminalStatus(item.tc.status);
	// ── Fields carried by the persisted tool call (mirrors SubagentCard.tsx
	// derivations). prompt/isBackground/agentType live on inputJson.
	// Send is conversation content and never reaches this subagent constructor.
	//
	// `withFullInput` so a prompt the server had to truncate is replaced by the
	// real body once the shell fetched it (the fetch itself is gated on the
	// reader OPENING the prompt — see the shell's promptExpandedToolUseIds).
	const inputJson = withFullInput(item, ctx);
	const input = toolInputFieldView(inputJson);
	// Preserve projected prompt previews rather than dropping wrapper values.
	const promptSource = "input.prompt";
	const prompt = readLeafText(input.prompt);
	const promptTruncated = hasTruncatedLeaf(input.prompt);
	const bodyContext: ClassifyToolDetailInput = {
		...(item.dedupeSuffix ? { occurrence: item.dedupeSuffix } : {}),
		...(item.tc.toolUseId ? { toolUseId: item.tc.toolUseId } : { previewId: key }),
		toolName: item.tc.toolName,
		category: "agent",
		status: item.tc.status,
		inputJson,
		outputJson,
		metadata,
		isStreaming: isStreamingToolItem(item),
	};
	const makeBody = (
		source: ToolCappedDetail["source"],
		text: string,
		truncated: boolean,
	): ToolCappedDetail =>
		describeToolBody(
			{
				kind: "capped",
				id: source,
				source,
				text,
				format: source === "output.main" ? "markdown" : "text",
				live: false,
				cap: source === "output.main" ? "agent-result" : "code",
				followTarget: { kind: "end" },
				textTruncated: truncated,
			},
			bodyContext,
		);
	const promptBody =
		prompt === undefined ? undefined : makeBody(promptSource, prompt, promptTruncated);
	const resultBody =
		resultContent === undefined
			? undefined
			: makeBody("output.main", resultContent, hasTruncatedLeaf(outputJson));
	const isBackground = input.background === true || input.run_in_background === true;
	const agentType = readNonEmptyString(input, "subagent_type") ?? item.tc.toolName;
	// Thinking-effort badge. Same precedence as SubagentCard.tsx minus the live
	// narrator query (which the adapter has no access to): the activity summary
	// already carries the child narrator's EFFECTIVE tier, so it wins over the
	// requested tool input. `reasoning_effort` is the canonical persisted key;
	// `reasoningEffort` covers legacy/alternate Agent callers.
	const reasoningEffort =
		nonEmptyTrimmed(activity?.reasoningEffort) ??
		readNonEmptyString(input, "reasoning_effort") ??
		readNonEmptyString(input, "reasoningEffort");
	// Description mirrors chunk's `input.description ?? (prompt-derived)`; falls
	// back to the generic tool summary when neither is present.
	const description =
		readNonEmptyString(input, "description") ??
		(prompt ? (prompt.includes("\n") ? prompt.slice(0, 80) : prompt) : toolSummary(item.tc, ctx));
	return {
		agentType,
		description,
		// Identity passthrough (height-neutral) so the shell can bind the
		// on-demand prompt fetch to this exact tool call.
		...(item.tc.toolUseId
			? { toolUseId: item.tc.toolUseId, toolDetailRef: resolveToolDetailRef(item) }
			: {}),
		model: activity?.model ?? undefined,
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		...(prompt === undefined ? {} : { prompt, promptBody }),
		// The prompt block's own fold state (independent of the card's), so the
		// measure layer reserves the body only when the reader opened it. The key is
		// the SAME `tool-<toolUseId>` the standalone card uses, so a prompt the reader
		// opened inside a drilled-in row is still open after an LOD change.
		...(prompt !== undefined && ctx.isPromptOpen?.(key) === true ? { promptOpen: true } : {}),
		// Still a preview → the shell may fetch the real body while it is open.
		...(promptTruncated ? { promptTruncated: true } : {}),
		isBackground,
		// Files the child wrote. Absent when it changed nothing, so a card with no
		// file list keeps the payload (and the height) it had before.
		...(activity?.fileChanges ? { fileChanges: activity.fileChanges } : {}),
		// The reader's own expand state for that list, keyed by the SAME
		// `tool-<toolUseId>` the prompt fold uses, so it survives an LOD change.
		...(activity?.fileChanges && ctx.isFileChangesOpen?.(key) === true
			? { fileChangesExpanded: true }
			: {}),
		recentCallCount: recentCallNames.length,
		recentCallNames,
		recentCallSummaries,
		recentCallCategories,
		// Mirrors SubagentCard: the recent-calls header offers "open full
		// session" only once the activity summary knows the child narrator.
		// Height-bearing (compact-xs button row > plain xs text row).
		hasRecentCallsButton: !!nonEmptyTrimmed(activity?.subagentNarratorId),
		isTerminal: isTerminalStatus(item.tc.status),
		isActive,
		// The user is driving this child directly, so the parent's call is parked
		// until they stop. Height-neutral (it joins the fixed badge row), but still
		// keyed in the measure cache — see `subagentRevision`.
		...(resolveTakenOver(item) ? { isTakenOver: true } : {}),
		// Raw terminal status → render-only status glyph (success/fail/cancelled).
		// Height-neutral (a single 12px header slot).
		status: item.tc.status ?? undefined,
		// ── Header timing (height-neutral; feeds the portaled popover) ────────
		// The card's own stamps, plus one entry per recent-call ROW positionally
		// aligned with `recentCallNames`. SubagentCard renders a ToolTimingArea in
		// both places (SubagentCard.tsx:623 / :684); without these the vlist copy
		// had no timing at all.
		timing: cardTiming(item.tc),
		recentCallTimings,
		resultText,
		resultBody,
		resultPreview: resultText?.slice(0, 120),
	};
}

/**
 * The complete `ToolCallData` payload for ONE tool call.
 *
 * Extracted from `adaptToolItemFull` so a folded trace row can build the very
 * same card when the reader drills into it (see `toolTraceItem`'s `expanded`
 * path). Keeping one constructor is what guarantees the drilled-in card measures
 * and paints identically to the standalone card at high LOD — a second, parallel
 * derivation is how the two would silently diverge (different summary resolver,
 * a missing timing field, a stale truncation count).
 */
function buildToolCardData(
	item: AdapterToolItem,
	ctx: AdapterContext,
	runContext: ToolRunContext,
	hasPendingPermission: boolean,
): unknown {
	// category drives measure-tool-call's default-open (→ height). Resolved
	// via the injected authoritative resolver; "generic" when absent.
	const category = ctx.resolveToolCategory?.(item.tc.toolName, item.tc.inputJson) ?? "generic";
	const isStreaming = isStreamingToolItem(item);
	const metadata = resolveToolMetadata(item.tc);
	// Truncated payloads are replaced by the full ones once the shell has fetched
	// them (same injection pattern as resolvePendingPlan), so the expanded card can
	// show the real body instead of a preview.
	const inputJson = withFullInput(item, ctx);
	const outputJson = withFullOutput(item, ctx);
	const errorMessage = readNonEmptyString(item.tc, "errorMessage");
	const denyMessage = nonEmptyTrimmed(item.tc.permissionDenyMessage);
	return {
		toolName: item.tc.toolName,
		summary: toolSummary(item.tc, ctx),
		status: item.tc.status ?? "success",
		isStreaming,
		// `+N -N` for a settled Write/Edit. Height-neutral (one nowrap span in the
		// fixed header row) but PAINTED from the cached payload, so it is keyed in
		// `extractDataRevision` — see CONTRACT.md §4.5 constraint 3.
		...toolDiffStatsFields(item, isStreaming, metadata),
		inRun: runContext.inRun,
		isLast: runContext.isLast,
		category,
		// An in-flight `Await({type:"agent"})` whose target got taken over never
		// returns (the takeover short-circuit only applies to a NEW wait), so this
		// badge is the only thing on screen explaining the stall. Height-neutral: it
		// joins the fixed header row next to the remote-target badge.
		...(resolveTakenOver(item) ? { isTakenOver: true } : {}),
		// ── Header timing / identity passthrough (all height-neutral) ──────────
		...(item.tc.toolUseId
			? { toolUseId: item.tc.toolUseId, toolDetailRef: resolveToolDetailRef(item) }
			: {}),
		...(errorMessage ? { errorMessage } : {}),
		...toolTimingFields(item.tc, category, metadata),
		// How much of this payload is STILL a preview (the full one has not been
		// fetched). Counted AFTER the substitutions above, so a fetched payload
		// reports zero — which is what makes the summary row disappear and the
		// card shrink once the user loads the full content.
		//
		// A COUNT plus a byte total rather than a boolean: field-level truncation
		// can cut several fields of one call, and the notice reports both.
		// Height-affecting (it decides whether the notice row is reserved).
		...truncatedPayloadFields(inputJson, outputJson),
		// Reflection notice (danger / plan / task / question gate). Replaces the
		// permission area, and is MEASURED — the row's height is final on first
		// paint instead of being corrected by a ResizeObserver afterwards.
		reflection: resolveToolReflection(item, ctx, hasPendingPermission),
		// Expanded detail region height model (line counts / body lines / px).
		// null when the tool call has no meaningful detail body.
		detail: classifyToolDetail({
			...(item.dedupeSuffix ? { occurrence: item.dedupeSuffix } : {}),
			...(item.tc.toolUseId ? { toolUseId: item.tc.toolUseId } : { previewId: toolItemKey(item) }),
			toolName: item.tc.toolName,
			category,
			status: item.tc.status,
			inputJson: applyPendingPlanFallback(inputJson, item, ctx),
			outputJson,
			metadata: isCommunicationTool(item.tc)
				? {
						...asObject(metadata),
						_sendDeliveryTargets: asObject(item.tc)._sendDeliveryTargets,
						targetCount:
							asObject(metadata).targetCount ?? asObject(item.tc)._sendDeliveryTargetCount,
					}
				: metadata,
			isStreaming,
			...(errorMessage ? { errorMessage } : {}),
			// The reviewer's note on the permission decision lives in a TOP-LEVEL
			// column, not in `_metadata`, so the classifier cannot reach it on its own.
			// A denied ExitPlanMode shows this text above the plan; without forwarding
			// it the vlist card dropped the user's typed reason entirely.
			//
			// Forwarded UNCONDITIONALLY, including on a successful call: the column also
			// holds approval feedback, and `status` travels alongside it (above), so the
			// classifier is the single place that decides what counts as a denial.
			...(denyMessage ? { denyMessage } : {}),
			hasPendingPermission,
			// Only MEASURED chrome strings (the ask replay's answer prefixes) —
			// render-layer chrome is injected through renderLabels instead.
			...(ctx.labels ? { labels: ctx.labels } : {}),
		}),
	};
}

/**
 * `{ diffStats }` for a Write/Edit whose line counts are known, else `{}`.
 *
 * Suppressed WHILE STREAMING: an Edit's `old_string` and `new_string` arrive
 * progressively, so a figure derived mid-stream changes with every chunk — the
 * header would show a counter racing upward and settling on a different number,
 * which reads as a bug rather than as progress. A folded trace row only ever holds
 * settled calls, so this only matters for the standalone card.
 */
function toolDiffStatsFields(
	item: AdapterToolItem,
	isStreaming: boolean,
	metadata: unknown,
): { diffStats?: { added: number; removed: number } } {
	if (isStreaming) return {};
	const stats = resolveFileDiffStats(
		item.tc.toolName,
		item.tc.inputJson,
		metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : null,
	);
	return stats ? { diffStats: stats } : {};
}

/** Chunk parity: Bash falls back to a 120s deadline (ToolCallCard.tsx:1327). */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** Chunk parity: Await falls back to a 600s deadline (ToolCallCard.tsx:1328). */
const DEFAULT_AWAIT_TIMEOUT_MS = 600_000;

/**
 * Effective header timeout, mirroring ToolCallCard's `effectiveTimeoutMs` (:1831).
 *
 * Only bash / await tools show a `/ timeout` suffix at all. An explicit value
 * always wins (`_timeoutMs` written by the `timeout_updated` WS event, else the
 * tool input). A BACKGROUND bash has no wall-clock deadline, so it deliberately
 * resolves to undefined rather than the default — showing "/ 2m" on a task that
 * will never be killed is the divergence this reproduces correctly.
 */
function effectiveTimeoutMs(tc: AdapterToolItem["tc"], category: string): number | undefined {
	if (category !== "bash" && category !== "await") return readFiniteNumber(tc._timeoutMs);
	const explicit =
		readFiniteNumber(tc._timeoutMs) ?? readFiniteNumber(asObject(tc.inputJson).timeout);
	if (explicit != null) return explicit;
	if (category === "bash" && asObject(tc.inputJson).run_in_background === true) return undefined;
	return category === "await" ? DEFAULT_AWAIT_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS;
}

/**
 * The five lifecycle stamps behind the header's timing popover, as epoch ms.
 *
 * Height-neutral by construction: they are only ever read by the popover BODY,
 * which lives in a portal. Extracted separately from `toolTimingFields` so the
 * subagent branch (whose recent-call rows carry the same shape, nested under
 * `timing`) can reuse the exact same normalization.
 */
function toolTimingStamps(source: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	const startedAt = parseEpochMs(source.startedAt);
	const streamStartedAt = parseEpochMs(source.streamStartedAt);
	const streamCompletedAt = parseEpochMs(source.streamCompletedAt);
	const permissionStartedAt = parseEpochMs(source.permissionStartedAt);
	const executionStartedAt = parseEpochMs(source.executionStartedAt);
	const completedAt = parseEpochMs(source.completedAt);
	const createdAt = parseEpochMs(source.createdAt);
	if (startedAt != null) out.startedAt = startedAt;
	if (streamStartedAt != null) out.streamStartedAt = streamStartedAt;
	if (streamCompletedAt != null) out.streamCompletedAt = streamCompletedAt;
	if (permissionStartedAt != null) out.permissionStartedAt = permissionStartedAt;
	if (executionStartedAt != null) out.executionStartedAt = executionStartedAt;
	if (completedAt != null) out.completedAt = completedAt;
	if (createdAt != null) out.createdAt = createdAt;
	return out;
}

/**
 * A subagent card's own timing record: lifecycle stamps plus the resolved final
 * duration (explicit, else derived from the start/complete pair — same fallback
 * the tool header uses).
 */
function cardTiming(tc: AdapterToolItem["tc"]): Record<string, number> {
	const stamps = toolTimingStamps(tc);
	const durationMs = readFiniteNumber(tc.durationMs) ?? deriveDuration(tc);
	return durationMs != null ? { ...stamps, durationMs } : stamps;
}

/**
 * Normalize ONE recent-call header from a subagent activity summary.
 *
 * The wire shape (`SubagentToolCallHeader`) nests the stamps under `timing` but
 * keeps `createdAt` at the top level, so flatten both into the same stamp record
 * the card header uses. `durationMs` also lives on `timing`, which is why it is
 * lifted here rather than read off the row object.
 */
function recentCallTiming(call: Record<string, unknown>): Record<string, number> {
	const timing = asObject(call.timing);
	const stamps = toolTimingStamps({ ...timing, createdAt: call.createdAt ?? timing.createdAt });
	const durationMs = readFiniteNumber(timing.durationMs) ?? readFiniteNumber(call.durationMs);
	return durationMs != null ? { ...stamps, durationMs } : stamps;
}

/**
 * Header timing fields (duration / start / timeout / lifecycle stamps). All
 * HEIGHT-NEUTRAL: the duration and timeout are painted inside the card's single
 * fixed header row, and the lifecycle stamps only feed the portaled timing
 * popover. Mirrors the chunked header's resolveToolFinalDurationMs /
 * getBashExecDurationMs / effectiveTimeoutMs.
 */
function toolTimingFields(
	tc: AdapterToolItem["tc"],
	category: string,
	metadata: unknown,
): Record<string, number | undefined> {
	const meta = asObject(metadata);
	const durationMs = readFiniteNumber(tc.durationMs) ?? deriveDuration(tc);
	const execDurationMs = readFiniteNumber(meta.execDurationMs);
	const stamps = toolTimingStamps(tc);
	// `startedAt` keeps its historical precedence (explicit → execution → created)
	// so the live elapsed counter is unaffected by the new stamp passthrough.
	const startedAt = stamps.startedAt ?? stamps.executionStartedAt ?? stamps.createdAt;
	const timeoutMs = effectiveTimeoutMs(tc, category);
	const out: Record<string, number | undefined> = { ...stamps };
	if (durationMs != null) out.durationMs = durationMs;
	if (execDurationMs != null) out.execDurationMs = execDurationMs;
	if (startedAt != null) out.startedAt = startedAt;
	if (timeoutMs != null) out.timeoutMs = timeoutMs;
	return out;
}

/** Duration from the start/complete stamps when no explicit `durationMs` exists. */
function deriveDuration(tc: AdapterToolItem["tc"]): number | undefined {
	const start = parseEpochMs(tc.startedAt) ?? parseEpochMs(tc.executionStartedAt);
	const end = parseEpochMs(tc.completedAt);
	return start != null && end != null ? Math.max(0, end - start) : undefined;
}

/** A finite number, else undefined. */
function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms from a number or an ISO string, else undefined. */
function parseEpochMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A tool's reflection-gate STATUS, or undefined when it has no gate.
 *
 * Split out from `resolveToolReflection` because a folded row needs only this one
 * field (to pick its shimmer colour) and must not pay for building a whole measurable
 * notice — a fold can hold hundreds of rows. Same live-wins precedence as the card,
 * so the two cannot disagree about whether a gate is running.
 */
function resolveToolReflectionStatus(
	item: AdapterToolItem,
	ctx: AdapterContext,
): string | undefined {
	const suggestions = item.tc.permissionSuggestions;
	const live = ctx.resolvePendingPermissionSuggestions?.(item.tc.toolUseId);
	if (!Array.isArray(live) && !Array.isArray(suggestions)) return undefined;
	const parsed = getPermissionReflectionSuggestion({
		suggestions: Array.isArray(live) ? live : null,
		permissionSuggestions: Array.isArray(suggestions) ? suggestions : null,
	});
	return parsed?.status;
}

/**
 * Resolve the reflection notice a tool card should show, mirroring the chunked
 * precedence (ToolCallCard.tsx:5419):
 *
 *   1. a reflection that is NOT awaiting_user → the notice
 *   2. otherwise (awaiting_user / none)       → the permission form path
 *
 * The gate's state ships with the message tree (`enrichToolUseBlocks` copies
 * `permissionSuggestions` onto every tool_use block), so this is a pure read —
 * the notice's height is therefore known at LAYOUT time and never corrected
 * after paint.
 */
function resolveToolReflection(
	item: AdapterToolItem,
	ctx: AdapterContext,
	hasPendingPermission: boolean,
): ReflectionNoticeData | null {
	const suggestions = item.tc.permissionSuggestions;
	const live = ctx.resolvePendingPermissionSuggestions?.(item.tc.toolUseId);
	const parsed = getPermissionReflectionSuggestion({
		suggestions: Array.isArray(live) ? live : null,
		permissionSuggestions: Array.isArray(suggestions) ? suggestions : null,
	});
	const reflection = normalizeReflectionAfterToolStatus(
		parsed,
		item.tc.status ?? undefined,
		hasPendingPermission,
	);
	// `awaiting_user` deliberately falls through: the gate handed the decision back
	// to the user, so the approve/deny form is the correct UI.
	if (!reflection || reflection.status === "awaiting_user") return null;
	const titleKey = `${reflectionTitleKeyPrefix(reflection.kind)}Reflection${reflectionTitleKeySuffix(
		reflection.status,
	)}`;
	const data = buildReflectionNoticeData(
		reflection,
		sysLabel(ctx, titleKey),
		readNonEmptyString(item.tc, "permissionDecisionReason") ??
			readNonEmptyString(item.tc, "errorMessage"),
		// Takeover target: the gate's own requestId wins; otherwise the tool-call row
		// id, exactly like the chunked notice's fallback chain.
		readNonEmptyString(item.tc, "tcId") ?? readNonEmptyString(item.tc, "id"),
	);
	// The advisory line is a template with a {nextSteps} placeholder.
	if (data.nextSteps) {
		data.nextSteps = sysLabel(ctx, "reflectionNextSteps").replace("{nextSteps}", data.nextSteps);
	}
	return data;
}

/**
 * `truncatedLeafCount` / `truncatedTotalBytes` for a tool call's payloads, or `{}`
 * when nothing is truncated (so the fields stay absent for the common case).
 */
function truncatedPayloadFields(
	inputJson: unknown,
	outputJson: unknown,
): { truncatedLeafCount?: number; truncatedTotalBytes?: number } {
	const leaves = [...collectTruncatedLeaves(inputJson), ...collectTruncatedLeaves(outputJson)];
	if (leaves.length === 0) return {};
	let totalBytes = 0;
	for (const leaf of leaves) totalBytes += leaf.fullLength;
	return { truncatedLeafCount: leaves.length, truncatedTotalBytes: totalBytes };
}

/**
 * Full (un-truncated) tool input once the shell has fetched it.
 *
 * The gate is `hasTruncatedLeaf`, NOT a root-level `isTruncated`: truncation is
 * field-level, so an object payload's root is a plain object and a root probe
 * would report "complete". That silently disabled the whole feature — the shell
 * fetched the full payload and it was never substituted, so "load full content"
 * appeared to do nothing.
 *
 * Values come from the authoritative whole payload. Edit additionally verifies
 * source-coordinate continuity while both the old preview and full field are
 * available, so a paused reader can keep the same source line after the fetch.
 */
const completedEditInputs = new WeakMap<
	object,
	WeakMap<object, { context: string; value: unknown }>
>();

function withFullInput(item: AdapterToolItem, ctx: AdapterContext): unknown {
	if (!ctx.resolveFullToolInput || !hasTruncatedLeaf(item.tc.inputJson)) return item.tc.inputJson;
	const full = ctx.resolveFullToolInput(item.tc.toolUseId, resolveToolDetailRef(item));
	if (full == null) return item.tc.inputJson;
	const original = item.tc.inputJson;
	if (
		item.tc.toolName !== "Edit" ||
		typeof full !== "object" ||
		Array.isArray(full) ||
		isTruncated(full) ||
		!original ||
		typeof original !== "object" ||
		Array.isArray(original) ||
		isTruncated(original)
	)
		return full;
	// Only memoization depends on immutable payload references. Source identities
	// are derived from call/field data below, so reconstructed objects map equally.
	const cacheContext = JSON.stringify([
		item.tc.toolUseId ?? null,
		item.tc.toolUseId ? null : toolItemKey(item),
		item.dedupeSuffix ?? null,
		isStreamingToolItem(item) && !isTerminalStatus(item.tc.status),
	]);
	let cachedInputs = completedEditInputs.get(original);
	const cached = cachedInputs?.get(full);
	if (cached?.context === cacheContext) return cached.value;
	const previous = toolInputFieldView(original);
	const complete = toolInputFieldView(full);
	const context: ClassifyToolDetailInput = {
		...(item.tc.toolUseId ? { toolUseId: item.tc.toolUseId } : { previewId: toolItemKey(item) }),
		...(item.dedupeSuffix ? { occurrence: item.dedupeSuffix } : {}),
		toolName: "Edit",
		category: "file",
		inputJson: item.tc.inputJson,
		status: item.tc.status,
		isStreaming: isStreamingToolItem(item),
	};
	const ranges = { ...asObject(asObject(full)._streamingFieldRanges) };
	for (const field of ["old_string", "new_string"] as const) {
		const before = readLeafText(previous[field]);
		const after = readLeafText(complete[field]);
		if (before === undefined || after === undefined || isTruncated(complete[field])) continue;
		const range = toolInputFieldRange(context, field);
		if (!range) continue;
		// Known heads/offsets must match exactly; unknown windows may only remap
		// when their complete observed tail matches. Neither path searches for a
		// repeated line or changes epoch just because the payload object changed.
		ranges[field] = reconcileSourceText({ text: before, range }, after, {
			epoch: range.epoch,
		}).range;
	}
	const value = { ...asObject(full), _streamingFieldRanges: ranges };
	if (!cachedInputs) {
		cachedInputs = new WeakMap();
		completedEditInputs.set(original, cachedInputs);
	}
	cachedInputs.set(full, { context: cacheContext, value });
	return value;
}

/** Full (un-truncated) tool output once the shell has fetched it. */
function withFullOutput(item: AdapterToolItem, ctx: AdapterContext): unknown {
	if (!ctx.resolveFullToolOutput || !hasTruncatedLeaf(item.tc.outputJson))
		return item.tc.outputJson;
	return (
		ctx.resolveFullToolOutput(item.tc.toolUseId, resolveToolDetailRef(item)) ?? item.tc.outputJson
	);
}

/**
 * Tool input for detail classification, with a pending permission's plan body
 * substituted when the streamed input has none (see ctx.resolvePendingPlan).
 * Returns the original reference whenever no substitution applies, so the common
 * path allocates nothing.
 */
function applyPendingPlanFallback(
	input: unknown,
	item: AdapterToolItem,
	ctx: AdapterContext,
): unknown {
	if (!ctx.resolvePendingPlan) return input;
	// A payload that IS a truncated leaf (a bare-string input) has no fields to
	// merge into — spreading a wrapper would produce `{_truncated, preview, plan}`.
	// An OBJECT payload with truncated leaves is still a normal object here.
	if (isTruncated(input)) return input;
	// `readLeafText` so a truncated `plan` still counts as present: the streamed
	// prefix is the plan, and overwriting it with the pending copy would swap real
	// content for a fallback.
	//
	// A `plan` holding our model-facing reference is the one exception, which is why
	// this asks `hasUsablePlanBody` rather than merely "is it non-blank": the
	// reference IS present but is NOT a plan body (a model echoed back the sentence
	// it saw in its stripped history), so the pending permission's server-resolved
	// body must win over it rather than yield to it.
	const existing = readLeafText(asObject(input).plan);
	if (existing !== undefined && hasUsablePlanBody(existing)) return input;
	const pendingPlan = ctx.resolvePendingPlan(item.tc.toolUseId);
	if (!pendingPlan?.trim()) return input;
	return { ...asObject(input), plan: pendingPlan };
}

/**
 * Selection / menu identity for a folded TOOL row. Streaming output has no
 * committed message, so it stays non-selectable (undefined).
 */
function toolRowIdentity(item: AdapterToolItem): AdapterTraceRowIdentity | undefined {
	const messageId = item.msg?.id;
	if (!messageId || messageId === "__streaming__") return undefined;
	if (!item.tc.toolUseId) return undefined;
	return {
		messageId,
		blockIndex: item.blockIndex,
		blockIndices: [item.blockIndex],
		toolUseId: item.tc.toolUseId,
		toolName: item.tc.toolName,
		toolDetailRef: resolveToolDetailRef(item),
	};
}

/**
 * One folded tool row.
 *
 * `expanded` is the drill-down switch: the reader clicked this row's chevron, so
 * it carries the FULL tool-card payload and the measure layer nests a real card
 * under the title line. A collapsed row builds nothing beyond its title, which is
 * what keeps a several-hundred-row fold cheap.
 *
 * The card is measured standalone (`inRun: false`, like a grouped card's child),
 * so it draws its own border inside the row's indented body box.
 */
function toolTraceItem(
	item: AdapterToolItem,
	ctx: AdapterContext,
	expanded = false,
): AdapterTraceItem {
	const summary = toolSummary(item.tc, ctx);
	const name = item.tc.toolName === "Task" ? "Agent" : item.tc.toolName;
	const rawTitle = ctx.resolveToolTitle?.(item.tc) ?? (summary ? `${name} · ${summary}` : name);
	// Only a real, identifiable tool call can be drilled into: the card's detail
	// classification and its on-demand payload fetch are both keyed by tool use id.
	const canDrillDown = !!item.tc.toolUseId;
	// The gate's own status, read with the same live-wins precedence the card uses.
	const reflectionStatus = resolveToolReflectionStatus(item, ctx);
	return {
		title: truncateTitle(rawTitle),
		hasIcon: true,
		iconColor: ctx.resolveToolColor?.(item.tc.toolName, item.tc.inputJson),
		toolName: item.tc.toolName,
		category: ctx.resolveToolCategory?.(item.tc.toolName, item.tc.inputJson),
		key: toolItemKey(item),
		summary,
		status: item.tc.status ?? null,
		// `+N -N` for a Write/Edit row. Same lane as `status` / `timing`: painted
		// inside the row's fixed line, height-neutral, and keyed in `traceRevision`.
		...toolDiffStatsFields(item, isStreamingToolItem(item), resolveToolMetadata(item.tc)),
		// A live reflection gate's status, so a folded row can show the PURPLE
		// "deliberating" shimmer instead of reading its tool's `pending` as something
		// else. Render-only and height-neutral — same lane as `status`.
		//
		// A gate normally keeps its tool out of a fold (`pending` items render as their
		// own card), so this is usually absent; it exists so the row is correct wherever
		// a gated call does end up folded, rather than silently mis-coloured.
		...(reflectionStatus ? { reflectionStatus } : {}),
		// Same stamp record a subagent card's header uses, so a folded row shows the
		// SAME duration the full card would at a higher LOD. Height-neutral.
		timing: cardTiming(item.tc),
		identity: toolRowIdentity(item),
		// Same value the standalone card carries, so the two renderings of this tool
		// are pairable across an LOD change (see AdapterTraceItem.unitId).
		unitId: toolItemKey(item),
		...(canDrillDown ? { canDrillDown: true } : {}),
		// A folded row only ever holds NON-ACTIVE tools (groupToolItemsForLod splits
		// active items out, isInactiveToolRunSegment gates the activity fold), so the
		// pending-permission flag is false by construction here — the drilled-in card
		// deliberately hosts no permission form.
		...(expanded && canDrillDown
			? item.isSubagent
				? {
						// A subagent row drills into its SUBAGENT card (badge row +
						// recent calls + prompt fold + result), not the generic tool
						// card — the same payload the L3+ card carries, from the same
						// constructor.
						card: buildSubagentCardData(item, ctx),
						cardKind: "subagent-card" as const,
					}
				: {
						card: buildToolCardData(
							item,
							ctx,
							{ inRun: false, isLast: true, isSoleSubagent: false },
							ctx.resolveHasPendingPermission?.(item.tc.toolUseId) ?? false,
						),
					}
			: {}),
	};
}

/**
 * Adapt a tool-run to element specs, LOD-aware (mirrors ToolRunLodGate):
 *   - L≥3: every item renders as a full card (per-card LOD handled by measure).
 *   - L≤2: completed batches fold into `tool-run-count`; active stay standalone.
 * (The cross-segment reasoning+tool→activity fold is applied earlier by the
 * caller's groupRenderUnits, producing an "activity" unit — see adaptActivityUnit.)
 *
 * ⚠️ The `tool-run-count` line is only ever reached by a run that did NOT go
 * through `groupRenderUnits` (which folds L1/L2 activity into NAMED trace rows).
 * A count line has no rows, so it must never become the ONLY place a call is
 * addressable — see CONTRACT.md's "every call addressable at every LOD".
 *
 * The pinned latest tasks.json call counts as "active" for the grouping: it keeps
 * its full expanded card at its original position at every LOD.
 */
function adaptToolRun(items: AdapterToolItem[], ctx: AdapterContext): ElementSpec[] {
	const isSoleSubagent =
		items.filter((item) => item.isSubagent && !isCommunicationTool(item.tc)).length === 1;
	if (ctx.lod >= 3) {
		return items.map((item, index) => {
			// A bubble breaks the surrounding tool frame as well as the low-LOD fold.
			const previous = items[index - 1];
			const next = items[index + 1];
			const previousIsTool = !!previous && !isCommunicationTool(previous.tc);
			const nextIsTool = !!next && !isCommunicationTool(next.tc);
			return adaptToolItemFull(item, ctx, {
				inRun: previousIsTool || nextIsTool,
				isLast: !nextIsTool,
				isSoleSubagent,
			});
		});
	}
	// Resolved once per run: the resolver is a shell closure over the latest id,
	// and the grouping below only ever compares against it.
	const groups = groupToolItemsForLod(items, ctx.resolveLatestSpecTasksToolUseId?.());
	const specs: ElementSpec[] = [];
	for (const group of groups) {
		if (group.kind === "active") {
			specs.push(
				adaptToolItemFull(group.item, ctx, {
					inRun: false,
					isLast: true,
					isSoleSubagent,
				}),
			);
			continue;
		}
		const first = group.items[0];
		if (!first) continue;
		const traceKey = toolItemKey(first);
		specs.push({
			kind: "tool-run-count",
			key: `toolrun-count-${traceKey}`,
			data: {
				count: group.items.length,
				headerLabel: sysLabel(ctx, "toolCalls"),
				headerCount: countLabel(ctx, "toolCallsCount", group.items.length),
			},
		});
	}
	return specs;
}

/**
 * ⚠️ Selection / menu identity for a folded REASONING row, mapped to its
 * reasoning RUN's start index.
 *
 * The activity fold pushes reasoning blocks ONE BY ONE, but the selection index
 * merges adjacent reasoning blocks with `groupReasoningRuns` and registers an
 * entry only for the run's START index (absorbed indices are skipped entirely).
 * Identifying a row by its own blockIndex would therefore mint a blockId that
 * matches no entry, and every selection action on that row would silently do
 * nothing. So resolve the owning run and use its start.
 *
 * Streaming output has no committed message → non-selectable (undefined).
 */
function reasoningRowIdentity(
	item: Extract<AdapterActivityInput, { kind: "reasoning" }>,
): AdapterTraceRowIdentity | undefined {
	const messageId = item.msg?.id;
	if (!messageId || messageId === "__streaming__") return undefined;
	const blockIndex = item.blockIndex ?? 0;
	const blocks = item.msg?.contentJson;
	if (Array.isArray(blocks) && blocks.length > 0) {
		// AdapterContentBlock allows null on text/thinking, so it is not structurally
		// assignable to ContentBlockLike; grouping only reads `type`, which matches.
		const { runs } = groupReasoningRuns(blocks as unknown as ContentBlockLike[]);
		for (const run of runs) {
			if (run.indices.includes(blockIndex)) {
				return {
					messageId,
					blockIndex: run.startIndex,
					blockIndices: run.indices,
				};
			}
		}
	}
	return { messageId, blockIndex, blockIndices: [blockIndex] };
}

/**
 * Hand-off-stable key base for one folded reasoning block.
 *
 * Prefers the run ordinal the grouper assigned (`stableKeyBase`), which is the
 * same live and persisted. Falls back to the message-derived form for inputs built
 * outside the grouper (the chunked path's cross-chunk continuation overrides).
 */
function reasoningRowKeyBase(item: Extract<AdapterActivityInput, { kind: "reasoning" }>): string {
	if (item.stableKeyBase) return `r-${item.stableKeyBase}-${item.stableKeyOffset ?? 0}`;
	return `r-${item.msg?.id ?? "msg"}-${item.blockIndex ?? 0}`;
}

/**
 * The LOD-INDEPENDENT identity of one reasoning STEP, shared by the two renderings
 * that step has: a row of the `activity-trace` at L1/L2 and a row of the
 * `reasoning-steps` trace at L3+.
 *
 * ## Why it cannot reuse the row key
 *
 * A folded row keys on `stableKeyBase` — the run's ordinal WITHIN ITS ACTIVITY UNIT
 * (`run0`), which is what keeps a row stable across the streaming hand-off. L3+ has no
 * activity unit at all, so that ordinal is not merely different there, it is
 * uncomputable. The only facts both sides hold independently are the owning message,
 * the run's FIRST block index, and the step's ordinal inside the run — so the identity
 * is built from exactly those.
 *
 * ## Why callers must gate on a single-block run
 *
 * The two levels group reasoning differently: the activity fold pushes blocks ONE BY
 * ONE and parses each on its own, while `adaptContentBlocks` joins a run's adjacent
 * blocks and parses the concatenation. For a multi-block run the step boundaries
 * therefore need not line up, and `s2` on one side can be a different step than `s2` on
 * the other. Pairing those would morph one step into an unrelated one — worse than not
 * morphing, because it looks deliberate. Both call sites emit this only for a run of
 * exactly one block, where the two parses see the same text and agree by construction.
 */
export function reasoningStepUnitId(
	messageId: string,
	runStartBlockIndex: number,
	stepIndex: number,
): string {
	return `reason-${messageId}-b${runStartBlockIndex}-s${stepIndex}`;
}

/**
 * True for a reasoning row belonging to the synthetic (un-persisted) streaming row.
 *
 * This is the PARSER question, not the "is it still being written" question. The
 * whole live message is re-adapted on every delta, so any reasoning inside it must go
 * through the incremental parser — including a run that has already finished, since
 * re-parsing its accumulated body every frame is the O(len²)-per-turn shape
 * `reasoning-segments-cache.ts` exists to remove. For the visual live state see
 * `isLiveReasoningItem`.
 */
function isStreamingReasoningItem(
	item: Extract<AdapterActivityInput, { kind: "reasoning" }>,
): boolean {
	return item.msg?.id === STREAMING_MESSAGE_ID;
}

/**
 * True when this reasoning row is the one STILL BEING WRITTEN.
 *
 * Only the live message's last content block can be (see streaming-live-blocks.ts).
 * A reasoning block followed by answer text or a tool call is finished, so it must
 * stop shimmering and stop carrying a scrolling live tail the moment that next block
 * appears — not when the turn eventually persists, which for a tool-calling turn is
 * many seconds and several executions later.
 */
function isLiveReasoningItem(item: Extract<AdapterActivityInput, { kind: "reasoning" }>): boolean {
	return isLiveStreamingBlock(isStreamingReasoningItem(item), item.msg, item.blockIndex ?? 0);
}

function adaptActivityItems(
	items: AdapterActivityInput[],
	ctx: AdapterContext,
	traceKey: string,
): {
	traceItems: AdapterTraceItem[];
	reasoningCount: number;
	toolCount: number;
	/**
	 * Indices (into `traceItems`) of the rows that ended up expanded — DERIVED from
	 * the per-key decisions taken while emitting, never resolved separately.
	 */
	expandedIndices: number[];
} {
	let reasoningCount = 0;
	let toolCount = 0;
	const traceItems: AdapterTraceItem[] = [];
	// ⚠️ Expansion is decided per ROW KEY, and the index is recorded as the row is
	// emitted. Both halves of that matter:
	//
	//  - The index numbering must be over the EMITTED ROW list, not the input
	//    `items`: one reasoning block expands into several rows, so the two drift
	//    apart as soon as a multi-step run precedes a tool. The measure layer
	//    resolves a visible row to `startIndex + vi` over this same array, so
	//    `traceItems.length` (read BEFORE the push) is the only numbering both
	//    sides agree on.
	//  - The reader's INTENT must not be stored as that index. A live reasoning run
	//    emits one row per step, so the next `**title**` shifts every following row
	//    down by one and a stored index starts addressing a different tool. See
	//    `AdapterContext.isRowExpanded`.
	const expandedIndices: number[] = [];
	// Blocks of ONE reasoning run that were already consumed by the run that started
	// at an earlier item. The fold receives a run block-by-block (the grouper pushes
	// them individually, sharing `stableKeyBase`), but the steps must come from the
	// run's WHOLE text so they match the L3+ parse of the same run — see
	// `canonicalReasoningRunText`. The first block of a run therefore emits every row
	// for it, and its followers are skipped rather than re-parsed.
	const consumedReasoningBlocks = new Set<number>();
	for (const [itemIndex, item] of items.entries()) {
		if (item.kind === "reasoning") {
			if (consumedReasoningBlocks.has(itemIndex)) continue;
			// Collect this run's remaining blocks: the grouper gives every block of one
			// run the same `stableKeyBase` with sequential offsets, so a run is a maximal
			// stretch of adjacent reasoning items sharing that base. Absent bases (older
			// callers) degrade to a single-block run, which is the previous behaviour.
			const runItems: Extract<AdapterActivityInput, { kind: "reasoning" }>[] = [item];
			if (item.stableKeyBase) {
				for (let next = itemIndex + 1; next < items.length; next++) {
					const candidate = items[next];
					if (candidate?.kind !== "reasoning") break;
					if (candidate.stableKeyBase !== item.stableKeyBase) break;
					consumedReasoningBlocks.add(next);
					runItems.push(candidate);
				}
			}
			// Resolves the translation exactly as L3+ does, so both sides parse the same
			// string and step `sN` means the same step. See reasoningRunDisplayText.
			const text = reasoningRunDisplayText(
				runItems.map((runItem) => runItem.block).filter((b): b is AdapterContentBlock => !!b),
			);
			// The LIVE row is re-adapted on every stream delta (that is the cost of
			// folding live content into the trace — see render-units.ts), and the plain
			// parser is O(len), so a long reasoning stream would be O(len²) over the
			// turn. Measured: 0.365ms/frame at 2k chars rising to 3.573ms at 200k, with
			// the parse alone ~50% of the frame. The incremental parser returns the
			// identical result while paying only for newly settled paragraphs.
			//
			// Committed rows keep the plain parser: they are parsed once and then served
			// from the measurement cache, so memoising them would only add bookkeeping —
			// and they are the rows that carry an EXPANDABLE body (below), which needs
			// the real text.
			//
			// The live row keeps `…Titles` (bodies truncated to their first line) and
			// therefore stays non-expandable: emitting whole bodies per delta would
			// rebuild a string the size of the entire reply every frame, which profiling
			// put at 97.8% of the frame on a single-title body. It costs the reader
			// nothing, because a live run already shows its newest characters through
			// `liveTail`, and the row keeps its key across the hand-off — so the instant
			// the turn persists the SAME row gains its chevron.
			const isLiveParse = isStreamingReasoningItem(item);
			const parsed = isLiveParse
				? parseStreamingReasoningTitles(`${traceKey}|${reasoningRowKeyBase(item)}`, text)
				: (ctx.resolveReasoningSegments ?? parseReasoningSegments)(text);
			const rows =
				parsed.length > 0
					? parsed
					: [{ title: null, body: text, isEmpty: text.trim().length === 0 }];
			reasoningCount += rows.length;
			const identity = reasoningRowIdentity(item);
			const keyBase = reasoningRowKeyBase(item);
			// Visual live state is per BLOCK, not per message: a reasoning run that the
			// answer text or a tool call already followed is finished, and must settle
			// immediately rather than shimmer until the turn persists.
			const streaming = isLiveReasoningItem(item);
			// The LAST row of the live run is the one still being written, so it shows a
			// scrolling tail instead of its settled title (which a never-closing step
			// would freeze on).
			//
			// Derived from the RAW accumulated `text`, never from `rows[last].body`: the
			// rows come from `parseStreamingReasoningTitles`, which truncates every body
			// to its first line, so a row body is itself a settled prefix — the exact
			// thing the tail exists to look past. The end of `text` is the end of the
			// last step, i.e. the newest characters.
			const liveTail = streaming ? resolveReasoningLiveTail(text) : null;
			for (const [index, row] of rows.entries()) {
				const isLast = index === rows.length - 1;
				const rowKey = `${keyBase}-step-${index}`;
				// A step with real content gets an expandable markdown body, so the reader
				// can open ONE step of a folded run instead of choosing between a bare
				// title list and the whole reply. Live rows carry no body (see above), and
				// an empty/placeholder step has nothing to reveal.
				const bodyText = isLiveParse ? null : reasoningStepBody(row);
				const expanded = bodyText != null && (ctx.isRowExpanded?.(traceKey, rowKey) ?? false);
				// Recorded against the EMITTED row list, read before the push — the same
				// numbering the measure layer resolves a visible row back to. See the note
				// above the loop on why the reader's intent is keyed, not indexed.
				if (expanded) expandedIndices.push(traceItems.length);
				traceItems.push({
					title: reasoningStepTitle(row),
					hasIcon: true,
					iconColor: "grape",
					key: rowKey,
					shimmer: streaming && isLast,
					identity,
					// Cross-level identity, so this folded step can morph into the
					// `reasoning-steps` row it becomes at L3+. See reasoningStepUnitId.
					//
					// No longer gated to a single-block run: the rows above are parsed from
					// `canonicalReasoningRunText(runItems)`, the same string L3+ parses for
					// this run, so `index` counts the same steps on both sides by construction.
					// Before that, a multi-block run's steps could not be paired at all —
					// which is why an interleaved run showed no animation.
					//
					// Still absent for a STREAMING message: its id changes at the hand-off, so
					// an id-derived identity would address a different row afterwards. Falls
					// back to the run-ordinal form, unique per row (painted as `data-nf-unit`)
					// but with no counterpart to pair.
					unitId: identity
						? reasoningStepUnitId(identity.messageId, identity.blockIndex, index)
						: `reason-${keyBase}-${index}`,
					...(bodyText != null ? { bodyText } : {}),
					...(liveTail && isLast ? { liveTail } : {}),
				});
			}
			continue;
		}
		toolCount++;
		if (!item.tc || typeof item.tc !== "object") {
			traceItems.push({
				title: sysLabel(ctx, "toolGeneric"),
				hasIcon: true,
				iconColor: "gray",
				key: `tool-${toolCount}`,
			});
			continue;
		}
		const toolItem = {
			...item,
			msg: item.msg,
			blockIndex: item.blockIndex ?? 0,
			// Carried in from the render-unit fold: a subagent row must drill into a
			// subagent CARD, and hard-coding `false` here is what made every folded
			// Agent call expand into the generic tool card at L1/L2.
			isSubagent: item.isSubagent === true,
			tc: item.tc,
		};
		// The row's FINAL key, resolved BEFORE the expansion lookup.
		//
		// A retry's repeated tool-use id gets a suffix so its row cannot overlap the
		// earlier one (see AdapterActivityInput.dedupeSuffix) — and that suffixed key is
		// what the renderer paints and what the shell therefore records on a click. So
		// the lookup has to use the same string; asking with the un-suffixed key would
		// never match the reader's own second attempt.
		const rowKey = item.dedupeSuffix
			? `${toolItemKey(toolItem)}#${item.dedupeSuffix}`
			: toolItemKey(toolItem);
		const expanded = ctx.isRowExpanded?.(traceKey, rowKey) ?? false;
		if (expanded) expandedIndices.push(traceItems.length);
		const toolRow = toolTraceItem(toolItem, ctx, expanded);
		// `unitId` moves with the key: two calls sharing an id are still two distinct
		// pieces of content.
		if (item.dedupeSuffix) {
			toolRow.key = rowKey;
			if (toolRow.unitId) toolRow.unitId = `${toolRow.unitId}#${item.dedupeSuffix}`;
		}
		traceItems.push(toolRow);
	}
	return { traceItems, reasoningCount, toolCount, expandedIndices };
}

/**
 * Whether an activity unit belongs to the CURRENT stretch of work, and so keeps
 * its rows visible even at L1.
 *
 * Two ways to qualify. A unit holding live output is current by definition. Any
 * other unit is judged by the L4 recency window (`recentMessageIds`, the last two
 * assistant run segments), which only moves when the user sends a new message — so
 * a run that finishes does NOT re-fold under the reader, and the "completed →
 * collapsed" self-inflicted jump never happens.
 *
 * Absent `recentMessageIds` (a caller that injected no resolver) counts as recent:
 * the conservative direction is showing rows, never hiding them mid-stream.
 */
function isRecentActivityUnit(items: AdapterActivityInput[], ctx: AdapterContext): boolean {
	if (!ctx.recentMessageIds) return true;
	for (const item of items) {
		const id = item.msg?.id;
		if (!id) continue;
		if (id === "__streaming__") return true;
		if (ctx.recentMessageIds.has(id)) return true;
	}
	return false;
}

/** Adapt a cross-segment activity unit. The input is typed so source order and
 * message ownership survive the fold, including L4 recency and stable toggles. */
export function adaptActivityUnit(
	items: AdapterActivityInput[],
	key: string,
	ctx: AdapterContext,
): ElementSpec {
	const activity = adaptActivityItems(items, ctx, key);
	return {
		kind: "activity-trace",
		key,
		data: {
			items: activity.traceItems,
			headerLabel: sysLabel(ctx, "activityTraceLabel"),
			headerCount: sysLabel(ctx, "activityTraceCount")
				.replace(/\{reasoning\}/g, String(activity.reasoningCount))
				.replace(/\{tools\}/g, String(activity.toolCount)),
		},
		opts: {
			// L1 folds history behind the header but keeps the current run's rows on
			// screen, so live activity stays readable at the simplest level.
			collapsed: ctx.lod === 1 && !isRecentActivityUnit(items, ctx),
			itemsOpened: ctx.isExpanded?.(key) ?? false,
			showEarlier: ctx.showEarlier?.(key) ?? false,
			// Derived while the rows were emitted, never resolved a second time — see
			// adaptActivityItems on why a stored index cannot survive a live run.
			expandedIndices: activity.expandedIndices,
			// A drilled-in row nests a real tool card, whose `plan` detail caps at
			// 0.85 × viewport — so the trace needs the viewport height a standalone
			// card already gets through its own opts.
			viewportHeight: ctx.viewportHeight,
		},
	};
}

/** Flag the first spec of a unit as a top-level boundary (mutates in place). */
function markUnitStart(specs: ElementSpec[], unitFirstIndex: number): void {
	const first = specs[unitFirstIndex];
	if (first) first.unitStart = true;
}

/** Adapt a whole render-unit list to a flat element-spec list. */
export function adaptRenderUnits(
	units: readonly AdapterRenderUnit[],
	ctx: AdapterContext,
): ElementSpec[] {
	const out: ElementSpec[] = [];
	for (const unit of units) {
		const unitFirstIndex = out.length;
		if (unit.kind === "activity") out.push(adaptActivityUnit(unit.items, unit.key, ctx));
		else out.push(...adaptSegment(unit.seg, ctx));
		markUnitStart(out, unitFirstIndex);
	}
	return out;
}

/** Adapt a plain segment list (used by unit tests and compatibility callers). */
export function adaptSegments(
	segments: readonly AdapterSegment[],
	ctx: AdapterContext,
): ElementSpec[] {
	const out: ElementSpec[] = [];
	for (const seg of segments) {
		const unitFirstIndex = out.length;
		out.push(...adaptSegment(seg, ctx));
		markUnitStart(out, unitFirstIndex);
	}
	return out;
}
