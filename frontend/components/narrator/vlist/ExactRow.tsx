/**
 * ExactRow.tsx — one row of the exact-layout canvas.
 *
 * Extracted from `PretextExactMessageList.tsx` unchanged. The shell owns the canvas
 * (scrolling, the mounted window, the document pipeline); this file owns what a single
 * mounted row renders and, just as importantly, WHEN it re-renders.
 *
 * Two properties are load-bearing and easy to break silently:
 *
 *  - **The memo comparator is the scroll budget.** A row that re-renders without
 *    needing to costs a whole subtree per frame while the reader scrolls, and the list
 *    mounts hundreds of them. Every prop compared below is compared for a stated
 *    reason; adding a prop without adding a term makes the row keep STALE content
 *    (the frozen-live-tail failure mode), and adding a term that always differs
 *    silently disables the memo.
 *  - **Chrome injection is height-neutral.** The functions called at the top of the
 *    component fill in labels, headers and handlers that the measure pass already
 *    reserved space for. Anything injected here that CHANGES a height would put the
 *    render layer in disagreement with the committed geometry (CONTRACT.md §0 rule 1).
 */

import { narratorsApi } from "@frontend/lib/api/narrators";
import { notifications } from "@mantine/notifications";
import { memo, type ReactNode, useLayoutEffect, useRef } from "react";
import { MessageContextMenuCtx } from "../message/MessageContextMenuCtx";
import { openCommunicationRecipient } from "./communication-navigation";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import { isRunningStatus, type MeasuredToolCall } from "./measure/measure-tool-call";
import type { MeasuredTraceRow } from "./measure/measure-tool-run";
import { CaretFiller } from "./render/caret-filler";
import type { AskInPassingPendingInteraction } from "./render/RenderAskInPassing";
import type { ReviewCardActions } from "./render/RenderReviewCard";
import type {
	ErrorNoticeActions,
	InjectionGuardActions,
	SpecCarryoverActions,
} from "./render/RenderSystemText";
import type { TraceRowInteractionSlot } from "./render/RenderToolRun";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { renderLabelsForKind, type VListRenderLabels } from "./useVListLabels";
import { VListContentViewHost, type VListViewControls } from "./VListContentViewHost";
import { VListRowInteraction } from "./VListRowInteraction";
import type { VListCompactRowActions } from "./vlist-compact-bridge";
import {
	resolvePrimaryViewTarget,
	resolveSubagentViewTargets,
	resolveToolDetailViewTargets,
} from "./vlist-content-view-target";
import { resolveVListEditorWidth } from "./vlist-edit-target";
import {
	ownerRequestKey,
	type RowInteraction,
	type RowToggles,
	resolveItemViewTargets,
	resolveTraceRowCardData,
	TOGGLEABLE_CARD_KINDS,
	TRACE_KINDS,
} from "./vlist-exact-row-state";
import { type InjectionNavigation, injectInjectionBubbleChrome } from "./vlist-injection-header";
import { traceRowFoldChannel } from "./vlist-interaction-state";
import type { VListItem } from "./vlist-pipeline";
import type { VListRowToolActions } from "./vlist-row-actions";
import { resolveStreamAnimExtra } from "./vlist-stream-anim-extra";
import {
	injectUserBubbleAttachmentOpen,
	injectUserBubbleHeader,
	injectUserBubbleIsSelf,
} from "./vlist-user-bubble-header";

/**
 * Shell-runnable tools whose execution can be interrupted mid-flight.
 * "Shell" is a legacy alias retained for older stored history only.
 */
const TERMINABLE_TOOLS = new Set(["Bash", "Shell", "Execute"]);

/**
 * True when a running tool can be stopped from the header — shell commands and
 * MCP tools, mirroring the chunked InlineTerminateControl's own test.
 */
function canTerminateTool(toolName: string): boolean {
	return TERMINABLE_TOOLS.has(toolName) || toolName.startsWith("mcp__");
}

/**
 * Attach the localized chrome bundle for this element kind to the render extra.
 *
 * The adapter already supplies label-derived TEXT for kinds whose strings are
 * measured (system cards, trace headers) via `spec.opts.labels`; that value is
 * preserved when present so a per-spec override always wins. Kinds that draw
 * their own chrome (buttons, badges, placeholders, section titles) get the
 * shell's bundle here — without it they fall back to the render layer's English
 * defaults. Height-neutral: every render label sits in a fixed-height row.
 */
function injectRenderLabels(
	kind: string,
	extra: Record<string, unknown>,
	renderLabels: VListRenderLabels,
): void {
	if (extra.labels === undefined) {
		const labels = renderLabelsForKind(kind, renderLabels);
		if (labels !== undefined) extra.labels = labels;
	}
	if (kind === "plan-card" && extra.label === undefined) extra.label = renderLabels.planCard;
	if (kind === "tool-call-group") {
		if (extra.label === undefined) extra.label = renderLabels.toolCallGroup.label;
		if (extra.statusLabel === undefined) extra.statusLabel = renderLabels.toolCallGroup.statusLabel;
		// The grouped header tooltips its aggregate duration with the earliest start;
		// it reuses the tool card's timing bundle rather than owning a second copy.
		if (extra.timingLabels === undefined) extra.timingLabels = renderLabels.toolCall.timing;
	}
}

/**
 * NOTE on where a row's viewer target comes from: it is derived inside `ExactRow`
 * from the MEASURED element, not stored in the memoized `RowInteraction` map —
 * that map is keyed on the selection index and the panel handlers, while a card's
 * bodies change as it streams and expands.
 *
 * The row-level menu offers only "fullscreen"; wrap / source stay on each body's
 * own action bar, where the target is unambiguous (a card can host several bodies
 * and one menu item cannot address them all).
 */

export interface ExactRowProps {
	item: VListItem;
	top: number;
	height: number;
	/**
	 * Height of the row's outer HIT box (own height + the gap below it), so rows
	 * tile the canvas and a drag-selection never crosses a caret-less strip. See
	 * resolveRowHitHeight.
	 */
	hitHeight: number;
	/** Width of the centered content column drawn inside the full-width row. */
	contentWidth: number;
	itemId: string | undefined;
	sourceIds: readonly string[];
	/** Interaction signature for this row's key; changes force a re-render. */
	interactionSig: string;
	toggles: RowToggles;
	/** Localized chrome bundles for the render layer (stable across renders). */
	renderLabels: VListRenderLabels;
	/** Present when this row carries a single-block interaction menu. */
	interaction?: RowInteraction;
	/**
	 * Folded traces only: wraps each row INSIDE the trace in its own interaction
	 * surface. Referentially stable per key so the memo below keeps skipping.
	 */
	rowInteraction?: TraceRowInteractionSlot;
	/**
	 * Row keys inside THIS trace whose drill-down is closing right now.
	 *
	 * Handed to the render layer so a closing card keeps painting until the block has
	 * finished animating shut around it; without it React unmounts the card in the frame
	 * the fold commits and it vanishes instead of closing. Changes are visible to the memo
	 * through `interactionSig` (see `closingRowSig`).
	 */
	closingRowKeys?: ReadonlySet<string>;
	/** Panel narrator id — injected into extra so media/tool details load images. */
	narratorId: string;
	/**
	 * Open a text-file attachment in a read-only file panel. Injected into the
	 * render extra (the pure render layer owns no dock knowledge); absent → user
	 * attachments stay non-interactive. HEIGHT-NEUTRAL.
	 */
	onOpenFilePanel?: (filePath: string) => void;
	/** Localized label for a clickable attachment row (tooltip / aria). */
	openAttachmentLabel?: string;
	/** Localized "was truncated" note painted inside an injection bubble. */
	injectionNoteLabel?: string;
	/**
	 * Localized note for a review card whose markdown body was cut at the parse ceiling.
	 * HEIGHT-NEUTRAL: it sits in the card's already-reserved header row.
	 */
	reviewTruncatedLabel?: string;
	/**
	 * What this host can do when the reader clicks an injection bubble's speaker row:
	 * open a child session, a knowledge entry, a Dynamic Spec file, or a chapter.
	 *
	 * Same gating rule as `onOpenFilePanel`, applied per kind: only hosts that can
	 * actually reach a destination supply that opener, and a row whose destination has
	 * no opener stays inert rather than offering a control that does nothing.
	 * HEIGHT-NEUTRAL.
	 */
	injectionNavigation?: InjectionNavigation;
	/**
	 * The signed-in user, for deciding whether a user bubble is the reader's own turn
	 * (right + indigo) or a teammate's (left + neutral). HEIGHT-NEUTRAL: both sides
	 * measure identically, which is why this is a render-layer prop rather than
	 * adapter data that would fork the measure cache per viewer.
	 */
	currentUserId?: string | null;
	/**
	 * Live permission form node for a pending-permission tool/subagent card. When
	 * present, the row hosts a real interactive component whose height is measured
	 * after paint (see `onUnknownHeight`) instead of predicted arithmetically.
	 */
	permissionSlot?: ReactNode;
	/**
	 * Inline message editor for THIS row. When present it REPLACES the row body
	 * entirely (no zero-DOM copy, no interaction wrapper — editing has no context
	 * menu, matching the chunked path) and the row switches to the post-paint
	 * measured height like a permission form.
	 */
	editorSlot?: ReactNode;
	/**
	 * Report this row's settled real-pixel height. Provided only for rows whose
	 * height cannot be predicted (permission form / inline editor / unknown
	 * blocks); recorded as a per-key override that re-derives the canvas geometry.
	 */
	onUnknownHeight?: (height: number) => void;
	/** Interrupt the narrator, stopping a running shell / MCP tool. */
	onTerminate?: () => void;
	/**
	 * Resolve the timeout sender for a tool card's own `toolUseId`. Passed as a
	 * resolver rather than a bound callback so the row can gate on the measured
	 * card's state without the shell knowing which rows are tool cards.
	 */
	resolveUpdateTimeout?: (toolUseId: string) => (timeoutMs: number) => void;
	/**
	 * Stop a RUNNING reflection gate on this row and take the decision over. Bound
	 * per row because the request id lives in the row's reflection.
	 */
	onReflectionTakeOver?: () => void;
	/**
	 * Bind a take-over handler for an arbitrary (key, kind, requestId).
	 *
	 * `onReflectionTakeOver` above is already resolved for the ROW's own element, so
	 * it is useless to a DRILLED-IN card: the trace element is not a `tool-call`
	 * kind, so the element-level resolver returns undefined for it while the nested
	 * card may well carry a running gate of its own. This resolver lets the drill-down
	 * bind that card's gate from the card's own reflection. Memoized per cache key
	 * upstream, so binding per render allocates nothing new.
	 */
	getReflectionTakeOver?: (key: string, kind: string | undefined, requestId: string) => () => void;
	/**
	 * Toggle a drilled-in SUBAGENT card's prompt fold. The card is not its own list
	 * element, so `toggles.onTogglePrompt` (bound to the trace's key) would write
	 * the state where nothing reads it; this channels it to the card's own key
	 * (`tool-<toolUseId>`) — the same one the standalone card uses at L3+.
	 * `elementKey` is the trace, so the fold animation still captures the geometry
	 * of the element that actually resizes.
	 */
	onTogglePromptForKey?: (elementKey: string, cardKey: string) => void;
	/**
	 * Bind the card-specific actions (open session / detach / cancel) for a
	 * DRILLED-IN row's tool call. A trace element carries no per-row interaction
	 * payload, so a drilled-in subagent card resolves its own through its group's
	 * binding. The row key includes retry suffixes; a tool-use id is not unique.
	 */
	resolveRowToolActions?: (rowKey: string) => VListRowToolActions | undefined;
	/** Submit the subagent-recovery card's selection (mutation lives outside vlist/). */
	onResumeSubagentRecovery?: (messageId: string, specKey: string, mode: "notify" | "await") => void;
	/**
	 * Live handlers for a Dynamic Spec notice card's buttons (view tasks / clear
	 * tasks / reset spec). Present only on those rows; absent → the buttons render
	 * disabled instead of silently inert.
	 */
	specCarryoverActions?: SpecCarryoverActions;
	/**
	 * Live handlers for an error notice card's two controls (mark as retryable /
	 * dismiss). Present only on error rows; absent → the controls render disabled
	 * instead of silently inert.
	 */
	errorNoticeActions?: ErrorNoticeActions;
	/**
	 * Live dismiss handler for the interrupt task-guard reminder card
	 * (origin_notice, source `interrupt_task_guard`). Present only on those rows;
	 * absent → no close button is painted at all.
	 */
	injectionGuardActions?: InjectionGuardActions;
	/**
	 * Live handler for a review-feedback card's action button. Present only on review
	 * rows; absent → the button renders disabled instead of silently inert.
	 */
	reviewFeedbackActions?: ReviewCardActions;
	/**
	 * Compact-marker callbacks for THIS row (open summary / cancel a running
	 * compaction). Absent for every non-marker row; referentially stable per key so
	 * the memo below keeps skipping.
	 */
	compactActions?: VListCompactRowActions;
	/** Localized tooltip for the cancel affordance (shared by every marker row). */
	compactCancelTitle?: string;
	/** List-owned form state/actions; rendering uses the precomputed row geometry. */
	askInPassingPending?: AskInPassingPendingInteraction;
	/** RESOLVED ask-in-passing rows only: open the narrator that answered. */
	onOpenAskInPassingTarget?: () => void;
	/**
	 * Fullscreen-viewer controls (per-body wrap / source state + open modal).
	 * Referentially stable, so it never breaks the memo below.
	 */
	viewControls?: VListViewControls;
	/**
	 * Animate freshly appended text in this row (advanced animation, live row only).
	 *
	 * True for the streaming row while the narrator is active. Committed rows leave
	 * it false, otherwise scrolling one back into the mounted window would replay
	 * the fade-in on already-settled text.
	 */
	animateStreaming?: boolean;
	/**
	 * Generation of the current mount, for the fade's animation-store scope.
	 *
	 * Part of the row's memo signature by construction (it is a prop), which matters:
	 * the epoch changes exactly once per mount / narrator switch, and the frame that
	 * carries the new value is the one that must seal.
	 */
	streamAnimMountEpoch?: number;
	/**
	 * This row's Dynamic Spec task state is LIVE: it is the newest spec-task surface
	 * in the document AND the narrator is running, so its `doing` row is describing
	 * work in flight and may animate.
	 *
	 * False everywhere else, deliberately. A task status is RECORDED, so animating on
	 * the status alone set the entire scrollback spinning — see vlist-spec-task-live.
	 * Height-neutral: it only swaps a glyph inside an already-reserved lane.
	 */
	specTaskLive?: boolean;
}

/**
 * One absolutely-positioned mounted row. Memoized: during scroll (window shift)
 * only rows entering/leaving the window render; rows still in view skip React
 * work unless their item, geometry, or interaction signature changed.
 */
export const ExactRow = memo(
	function ExactRow({
		item,
		top,
		height,
		hitHeight,
		contentWidth,
		itemId,
		sourceIds,
		toggles,
		renderLabels,
		interaction,
		rowInteraction,
		closingRowKeys,
		onOpenFilePanel,
		openAttachmentLabel,
		injectionNoteLabel,
		reviewTruncatedLabel,
		injectionNavigation,
		currentUserId,
		narratorId,
		permissionSlot,
		editorSlot,
		onUnknownHeight,
		onTerminate,
		resolveUpdateTimeout,
		onReflectionTakeOver,
		getReflectionTakeOver,
		onTogglePromptForKey,
		resolveRowToolActions,
		onResumeSubagentRecovery,
		specCarryoverActions,
		errorNoticeActions,
		injectionGuardActions,
		reviewFeedbackActions,
		compactActions,
		compactCancelTitle,
		askInPassingPending,
		onOpenAskInPassingTarget,
		viewControls,
		animateStreaming,
		streamAnimMountEpoch,
		specTaskLive,
	}: ExactRowProps) {
		const extra = resolveRenderExtra(item.spec);
		const kind = item.spec.kind;
		// User bubbles: build the avatar/name/time header node from the forwarded
		// creator data (the pure render layer cannot construct it itself).
		injectUserBubbleHeader(kind, extra);
		// Which side the bubble sits on + its tint. Resolved here, not in the adapter:
		// a teammate's turn and your own are the same height, so viewer identity must
		// not reach the measured data (it would fork the cache per user).
		injectUserBubbleIsSelf(kind, extra, currentUserId);
		// Injection bubbles: speaker row + the localized trailing note, plus the
		// navigation binding for rows that point somewhere this host can reach. All
		// chrome the measure pass already reserved space for, so this only fills it in.
		injectInjectionBubbleChrome(kind, extra, injectionNoteLabel, injectionNavigation, narratorId);
		// knowledge_hint card: make its entry rows open the entry they name.
		//
		// `RenderSystemList` has always read `extra.onOpenEntry`, but nothing ever wrote
		// it, so `clickable` was permanently false and the rows were decorative — a
		// regression that only became a real loss when the chunked card (whose
		// KnowledgeHintNotice did navigate) was deleted. Reuses the SAME opener the
		// injection rows use, so a hint and an injection pointing at one entry land in
		// the same place (dock panel when there is one, route otherwise).
		//
		// Height-neutral: the rows are measured as single clamped lines either way; this
		// only decides whether they respond to a click.
		if (kind === "knowledge-hint" && injectionNavigation?.onOpenKnowledge) {
			const openKnowledge = injectionNavigation.onOpenKnowledge;
			// A hint always names GLOBAL entries: the injector matches against the
			// project's shared collections, so a personal scope here would resolve to an
			// id that does not exist.
			extra.onOpenEntry = (entryId: string) => openKnowledge(entryId, "global");
		}
		// Dynamic Spec task rows animate ONLY on the newest surface of a running
		// narrator. Both surfaces get the same flag: a framed task bubble
		// (`injection-bubble` with a spec-task payload) and a `spec://tasks.json` tool
		// card. Height-neutral, so it stays out of the measured data.
		if (specTaskLive) {
			if (kind === "injection-bubble") extra.payloadLive = true;
			if (kind === "tool-call") extra.specTasksLive = true;
		}
		// User bubbles: make a text-file attachment clickable when the host owns a
		// dockview surface. The path itself already rode along as height-neutral
		// measure data, so this only binds the handler.
		injectUserBubbleAttachmentOpen(kind, extra, onOpenFilePanel, openAttachmentLabel);
		injectRenderLabels(kind, extra, renderLabels);
		if (TOGGLEABLE_CARD_KINDS.has(kind)) {
			extra.onToggle = toggles.onToggle;
		}
		// A translated reasoning run paints a language toggle inside its expanded
		// body. Without this binding the row drew the control but nothing happened
		// on click — the render layer only draws what it is handed.
		if (kind === "reasoning") {
			extra.onToggleTranslation = toggles.onToggleTranslation;
		}
		if (kind === "system-simple") {
			const simpleBlock = item.measured.blocks[0] as { tag?: string } | undefined;
			if (simpleBlock?.tag === "compact" || simpleBlock?.tag === "segment_compact") {
				extra.compactProgressMessageId = sourceIds[0];
				extra.compactProgressIsSegment = simpleBlock.tag === "segment_compact";
			}
		}
		if (TRACE_KINDS.has(kind)) {
			extra.onToggleItems = toggles.onToggleItems;
			extra.onToggleEarlier = toggles.onToggleEarlier;
			// Route the row fold to the channel THIS kind's adapter path actually
			// reads. The render layer always reports both the index and the key, so
			// without this every trace would write a key — and `reasoning-steps`
			// (which resolves its `expandedIndices` from `ctx.expandedRows`) would
			// store the reader's fold where nothing looks for it, leaving those rows
			// silently unopenable.
			const foldByKey = traceRowFoldChannel(kind) === "key";
			const toggleRow = foldByKey
				? toggles.onToggleRow
				: (rowIndex: number) => toggles.onToggleRow(rowIndex);
			extra.onToggleRow = toggleRow;
			// Rows whose drill-down is closing right now: the render layer keeps painting
			// their card so the block can be animated shut around it (see closingRowKeys).
			// Absent for the overwhelmingly common case of no closing row, which keeps this
			// out of every trace's props while nothing is closing.
			if (closingRowKeys && closingRowKeys.size > 0) extra.closingRowKeys = closingRowKeys;
			// Folded traces: give each ROW inside the trace its own menu / selection.
			if (rowInteraction) extra.rowInteraction = rowInteraction;
			// Drill-down: a row the reader opened nests a REAL tool card, dispatched
			// through the same `renderElement` the standalone card uses so the two can
			// never drift in prop shape. Built here (in `extra`, never in `spec.opts` —
			// that feeds the measure cache key) and recreated per render, which is free:
			// it is not a prop, so the ExactRow memo is unaffected.
			extra.rowCard = (row: MeasuredTraceRow) => {
				if (!row.cardMeasured) return null;
				// Per-ROW scope: several rows of ONE trace can be open at once, each with
				// its own bodies, wrap/source state and payload request.
				const rowOwner = { specKey: item.spec.key, traceItemIndex: row.itemIndex };
				const rowKey = ownerRequestKey(rowOwner);
				// A SUBAGENT row drills into its subagent card, never the generic tool
				// card: the badge row / recent calls / prompt fold / result body are the
				// agent format the L3+ card shows, and drilling in asks for exactly that.
				if (row.cardKind === "subagent-card") {
					// The card payload comes from the FRESH spec through the module-level
					// helper (the same pattern as the activity-trace live tails): `measured`
					// can be a cache hit, while render extras must describe current data.
					// Going through the helper is also what keeps the row's spec payload out
					// of this component body, so the memo need not compare a per-frame object
					// — see resolveTraceRowCardData for why that would be wrong.
					const cardData = resolveTraceRowCardData(item, row.itemIndex);
					const subExtra: Record<string, unknown> = {
						...resolveRenderExtra({ kind: "subagent-card", data: cardData }),
						labels: renderLabels.subagent,
						narratorId,
						// The header chevron CLOSES the drill-down — not a card fold: the card
						// is measured force-open, so folding it in place would paint a
						// collapsed header inside a box reserved for the full card.
						onToggle: () => toggleRow(row.itemIndex, row.key),
					};
					// Prompt fold, keyed by the CARD's own key (`tool-<toolUseId>`, the row's
					// unitId) — the same channel the standalone card uses, so a prompt the
					// reader opened here is still open after an LOD change.
					if (onTogglePromptForKey && row.unitId) {
						const promptKey = row.unitId;
						subExtra.onTogglePrompt = () => onTogglePromptForKey(item.spec.key, promptKey);
					}
					// "Open full session": the standalone card gets this from its element
					// interaction; a trace element has none, so bind it using this row's
					// exact render key (including any retry suffix).
					const subToolActions = resolveRowToolActions?.(row.key);
					if (subToolActions?.onViewSubagentSession) {
						subExtra.onOpenSession = subToolActions.onViewSubagentSession;
					}
					if (viewControls) {
						const subData = cardData as { resultText?: unknown; agentType?: unknown };
						const description =
							typeof subExtra.description === "string" ? subExtra.description : "";
						const agentType = typeof subData.agentType === "string" ? subData.agentType : "agent";
						const subTargets = resolveSubagentViewTargets(
							rowOwner,
							row.cardMeasured as MeasuredSubagent,
							{ title: description ? `${agentType} — ${description}` : agentType },
							{ prompt: renderLabels.subagent.prompt },
						);
						if (subTargets.length > 0) {
							subExtra.viewTargets = subTargets;
							subExtra.viewControls = viewControls;
						}
					}
					return renderElement("subagent-card", row.cardMeasured, subExtra);
				}
				const card = row.cardMeasured as MeasuredToolCall;
				const cardExtra: Record<string, unknown> = {
					labels: renderLabels.toolCall,
					narratorId,
					// The card header's chevron closes the drill-down again (the row's own
					// chevron is the other half of the same toggle). It must NOT be a card
					// fold: the card is measured force-open, so folding it in place would
					// paint a collapsed header inside a box reserved for the full card.
					//
					// Goes through the SAME kind-routed dispatcher as the row's own chevron:
					// the two halves of one toggle must address the same channel, or closing
					// from the card would write an index while opening wrote a key.
					onToggle: () => toggleRow(row.itemIndex, row.key),
				};
				// ⚠️ A drilled-in card is a REAL tool card and must carry the same live
				// controls the standalone L3+ card gets. Running and streaming tools DO
				// fold into a trace (see render-units' isKeptToolItem — only a
				// permission-blocked call keeps its card), so "the reader opened a live
				// row" is the normal case rather than an edge one, and each control below
				// was drawn-but-inert or absent until the reader changed LOD.
				//
				// All three are height-neutral, which is why they can be bound here at all:
				// the terminate button and the timing/timeout area live inside the card's
				// already-measured single header line (popover + editor are portaled), and
				// the take-over button's row is reserved by measure-reflection-notice
				// whenever `hasTakeOver` is set. Nothing here can move the row, so the
				// zero-DOM height prediction is untouched.
				if (onTerminate && canTerminateTool(card.toolName)) {
					cardExtra.onTerminate = onTerminate;
				}
				if (
					resolveUpdateTimeout &&
					isRunningStatus(card.status) &&
					card.timeoutMs != null &&
					card.toolUseId
				) {
					cardExtra.onUpdateTimeout = resolveUpdateTimeout(card.toolUseId);
				}
				// Manual takeover of a RUNNING reflection gate. Resolved from the CARD's
				// own reflection (not the trace element's — the element is not a tool-call
				// kind, so the element-level resolver returns undefined for it).
				if (getReflectionTakeOver && card.reflection?.hasTakeOver && card.reflection.requestId) {
					cardExtra.onReflectionTakeOver = getReflectionTakeOver(
						rowKey,
						card.reflection.kind,
						card.reflection.requestId,
					);
				}
				if (viewControls) {
					const cardTargets = resolveToolDetailViewTargets(rowOwner, card, {
						sections: renderLabels.toolCall.sections,
					});
					if (cardTargets.length > 0) {
						cardExtra.viewTargets = cardTargets;
						cardExtra.viewControls = viewControls;
					}
				}
				return renderElement("tool-call", card, cardExtra);
			};
		}
		// The recovery card owns a checkbox list plus two submit buttons. Its rows
		// reuse the generic per-row toggle; the submit itself is a mutation living
		// outside vlist/, injected by the panel.
		if (kind === "subagent-recovery") {
			extra.onToggleRow = toggles.onToggleRow;
			// System cards carry no `-b{n}` suffix, so they never get a RowInteraction.
			// The owning message comes from the manifest source ids instead.
			const messageId = sourceIds[0];
			if (messageId && onResumeSubagentRecovery) {
				const specKey = item.spec.key;
				extra.onResume = (mode: "notify" | "await") =>
					onResumeSubagentRecovery(messageId, specKey, mode);
			}
		}
		// Dynamic Spec notice cards (fork carryover / context cleared / goal added)
		// own real buttons whose mutations live outside vlist/, so the shell injects
		// them. Without this the buttons paint but do nothing — the chunked path's
		// SpecForkCarryoverCard drives the same three actions itself.
		if (specCarryoverActions) extra.specCarryoverActions = specCarryoverActions;
		// Error notice card: the retry-rule dialog and the dismiss DELETE both live
		// outside vlist/, so the shell injects them. Without this the two controls
		// paint but do nothing — the chunked path's ErrorNotice drives them itself.
		if (errorNoticeActions) extra.errorNoticeActions = errorNoticeActions;
		// Interrupt task-guard reminder (origin_notice, source interrupt_task_guard):
		// the dismiss DELETE lives outside vlist/, so the shell injects it. Without
		// this the card shows no close button at all.
		if (injectionGuardActions) extra.injectionGuardActions = injectionGuardActions;
		// Review feedback card: the button hands the conclusion to the narrator through a
		// REST call, so the shell injects it. Without this the card would show findings the
		// reader has no way to act on — and an idle narrator is never woken by a conclusion
		// on purpose, so this button is the only path.
		if (reviewFeedbackActions) extra.reviewFeedbackActions = reviewFeedbackActions;
		if (kind === "review-card" && reviewTruncatedLabel) {
			extra.truncatedLabel = reviewTruncatedLabel;
		}
		// Compact / segment-compact markers: the row itself is the affordance — it
		// opens the summary modal, or cancels a compaction still in flight. Both live
		// outside vlist/ (modal + API), so they arrive as bound callbacks.
		if (compactActions) {
			if (compactActions.onOpenCompact) extra.onOpenCompact = compactActions.onOpenCompact;
			if (compactActions.onCancelCompact) {
				extra.onCancelCompact = compactActions.onCancelCompact;
				extra.cancelCompactTitle = compactCancelTitle;
			}
		}
		// Both kinds receive list-owned actions. Pending is a controlled, exactly
		// sized form, never a free-layout slot requiring post-paint correction.
		if (askInPassingPending !== undefined) extra.askInPassingPending = askInPassingPending;
		if (onOpenAskInPassingTarget) extra.onOpenAskInPassingTarget = onOpenAskInPassingTarget;
		// Media / tool-call details resolve images against the panel narrator.
		extra.narratorId = narratorId;
		// Per-grapheme fade-in for freshly appended text, for the LIVE row only.
		//
		// The streaming row is an ordinary document row now, so this is gated on the
		// row itself rather than on a separate render path: committed rows must never
		// animate (they would re-fade every time they re-enter the mounted window).
		// Built by resolveStreamAnimExtra, which the shell-level test calls too — the
		// key template and the scope must describe the same narrator, and a test that
		// re-implements the template only proves it agrees with itself.
		const streamAnim = resolveStreamAnimExtra({
			animateStreaming: animateStreaming === true,
			kind,
			specKey: item.spec.key,
			narratorId,
			...(streamAnimMountEpoch != null ? { mountEpoch: streamAnimMountEpoch } : {}),
		});
		if (streamAnim) Object.assign(extra, streamAnim);
		// Subagent card's in-card "open full session" button. RenderSubagent has
		// always accepted onOpenSession, but nothing supplied it — the button was
		// inert. Bind it to the same action the row menu uses.
		if (kind === "communication-bubble") {
			const open = injectionNavigation?.onOpenNarrator;
			// Registry-projected data follows the measured identity: recipient changes
			// re-key extractDataRevision, and language changes re-key labelsRevision.
			// Comparing spec.data itself would repaint every row on every rebuild.
			const labels = (extra.data as { labels?: Record<string, string> }).labels;
			if (open) {
				extra.onOpenRecipient = (id: string, deliveryMessageId?: string) => {
					void openCommunicationRecipient(
						{ id, deliveryMessageId },
						{
							locate: narratorsApi.getMessageLocation,
							open,
							notify: (reason) =>
								notifications.show({
									color: reason === "error" ? "red" : "yellow",
									message:
										reason === "legacy"
											? (labels?.communicationReceiptLegacy ??
												"This older message has no receipt link. Opened the recipient's session instead.")
											: reason === "unavailable"
												? (labels?.communicationReceiptUnavailable ??
													"The message has not been received yet or is no longer available. Please try again later.")
												: (labels?.communicationReceiptError ??
													"Could not locate the received message."),
								}),
						},
					);
				};
			}
			if (viewControls) {
				const target = resolveItemViewTargets(item, renderLabels, extra)[0];
				if (target) extra.onViewFull = () => viewControls.openFullscreen(target);
			}
		}
		if (kind === "subagent-card") {
			if (interaction?.toolActions?.onViewSubagentSession) {
				extra.onOpenSession = interaction.toolActions.onViewSubagentSession;
			}
			// Prompt fold. Same story as onOpenSession: RenderSubagent drew the
			// chevron row but nothing supplied the handler, so clicking it did
			// nothing. It is a SEPARATE channel from onToggle (which folds the whole
			// card), matching the chunked SubagentCard's own `showPrompt`.
			extra.onTogglePrompt = toggles.onTogglePrompt;
			extra.onToggleFileChanges = toggles.onToggleFileChanges;
		}
		// Long-running bash / MCP tools get the header terminate control (parity with
		// the chunked InlineTerminateControl). Only cards that can actually be stopped
		// receive the callback, so the button never appears where it would no-op.
		if (kind === "tool-call" && onTerminate) {
			const measured = item.measured as MeasuredToolCall;
			if (canTerminateTool(measured.toolName)) {
				extra.onTerminate = onTerminate;
			}
		}
		// Editable timeout: only a RUNNING card that actually has a deadline can be
		// extended, so the sender is bound just for those (mirroring the chunked
		// `canEditTimeout`). The renderer treats an absent callback as read-only.
		if (kind === "tool-call" && resolveUpdateTimeout) {
			const measured = item.measured as MeasuredToolCall;
			if (isRunningStatus(measured.status) && measured.timeoutMs != null && measured.toolUseId) {
				extra.onUpdateTimeout = resolveUpdateTimeout(measured.toolUseId);
			}
		}
		// A live permission form (pending-permission tool/subagent card) is injected
		// as a slot; the pure renderer draws it in place of the zero-DOM copy.
		if (permissionSlot !== undefined) extra.permissionSlot = permissionSlot;
		// Manual takeover of a RUNNING reflection gate. The notice itself is measured
		// + rendered on the pure path; only this action needs the app layer.
		if (kind === "tool-call" && onReflectionTakeOver) {
			const measured = item.measured as MeasuredToolCall;
			if (measured.reflection?.hasTakeOver) extra.onReflectionTakeOver = onReflectionTakeOver;
		}
		// Fullscreen viewer: derive this row's readable bodies and hand them, with
		// the shell's view controls, to the render layer. Each body then carries a
		// hover action bar (copy / wrap / source / fullscreen) — the affordances the
		// chunked path gets from ContentViewer. Purely additive: without controls the
		// render layer draws exactly what it drew before.
		// Result snapshots open in the list-owned modal, not inside an evictable row.
		if (kind === "system-simple" && viewControls) {
			extra.viewControls = viewControls;
			extra.viewOwner = { specKey: item.spec.key };
		}
		const viewTargets = viewControls
			? resolveItemViewTargets(item, renderLabels, extra)
			: undefined;
		// Cards (tool / subagent) own several bodies inside their own capped boxes,
		// so the render layer places each bar itself. A plain content row is ONE body
		// with no box of its own, so the bar is attached around the whole row below.
		const cardHostsOwnBars = kind === "tool-call" || kind === "subagent-card";
		if (viewTargets && viewTargets.length > 0 && cardHostsOwnBars) {
			extra.viewTargets = viewTargets;
			extra.viewControls = viewControls;
		}
		// Communication bubbles expose fullscreen through their own button and the
		// row menu. They do not implement inline source/wrap modes, so do not mount
		// a generic toolbar whose toggles would change state without changing paint.
		const rowViewTarget =
			kind !== "communication-bubble" && !cardHostsOwnBars && viewTargets && viewTargets.length > 0
				? viewTargets[0]
				: undefined;
		// A plain content row's own body honours the source toggle: the renderer
		// swaps the measured markdown for the raw text inside the SAME reserved
		// geometry. Only wired while the toggle is actually on, so an untouched row
		// keeps referentially identical extras and the memo below still skips it
		// during scroll.
		if (rowViewTarget?.sourceInline && viewControls?.isSourceShown(rowViewTarget)) {
			extra.showSource = true;
			extra.sourceText = rowViewTarget.text;
		}
		// The row menu's single "fullscreen" item targets the row's MAIN body (the
		// last one — tool details run header/command → output/result, so the final
		// body is the payload the reader came for).
		const menuViewTarget = viewControls ? resolvePrimaryViewTarget(viewTargets ?? []) : undefined;
		// A user bubble is painted right-aligned and shrink-wrapped, so its editor
		// must stay on that side at a comparable width. Letting it expand to the full
		// column moved the caret, the attach button and the submit pair to the far
		// left the instant the reader picked "edit" — a full column's worth of mouse
		// travel away from the bubble they were hovering. Assistant bodies are
		// left-aligned and full width already, so they resolve to null (unchanged).
		const editorWidth =
			editorSlot != null
				? resolveVListEditorWidth(kind, extra.role, item.measured.usedWidth, contentWidth)
				: null;
		const editorBody =
			editorSlot != null && editorWidth != null ? (
				<div style={{ display: "flex", justifyContent: "flex-end" }}>
					<div style={{ width: editorWidth, maxWidth: "100%" }}>{editorSlot}</div>
				</div>
			) : (
				editorSlot
			);
		// While editing, the editor REPLACES the row: no measured body, no menu /
		// selection surface. The chunked path behaves the same way (its edit branch
		// returns before ContentViewer), so the row temporarily has no
		// data-block-id — expected, and it comes back when editing ends.
		const body = editorBody ?? renderElement(kind, item.measured, extra);
		// A plain content row has no capped box of its own, so its viewer action bar
		// wraps the whole row body. Never while editing: the editor replaces the row.
		const viewableBody =
			rowViewTarget && editorSlot === undefined ? (
				<VListContentViewHost target={rowViewTarget} controls={viewControls}>
					{body}
				</VListContentViewHost>
			) : (
				body
			);
		const interactiveBody =
			interaction && editorSlot === undefined ? (
				<MessageContextMenuCtx.Provider value={interaction.actions}>
					<VListRowInteraction
						blockId={interaction.blockId}
						messageId={interaction.messageId}
						blockIndex={interaction.blockIndex}
						blockIndices={interaction.blockIndices}
						copyText={interaction.copyText}
						actions={interaction.actions}
						narratorId={narratorId}
						toolUseId={interaction.toolUseId}
						toolDetailRef={interaction.toolDetailRef}
						toolMeta={interaction.toolMeta}
						toolActions={interaction.toolActions}
						onViewOriginal={interaction.onViewOriginal}
						inspectContent={interaction.inspectContent}
						onOpenFullscreen={
							menuViewTarget && viewControls
								? () => viewControls.openFullscreen(menuViewTarget)
								: undefined
						}
					>
						{viewableBody}
					</VListRowInteraction>
				</MessageContextMenuCtx.Provider>
			) : (
				viewableBody
			);
		// Rows with a dynamic (post-paint measured) height cannot be clipped to the
		// arithmetic `height`: the real content may exceed it until onUnknownHeight
		// corrects the geometry. Such rows use `minHeight` + a ResizeObserver that
		// reports the settled height. All other rows keep the fixed-height, clipped
		// box (unchanged behaviour, zero added cost).
		const isDynamic = onUnknownHeight !== undefined;
		// Two layers, deliberately:
		//
		//  - OUTER (full width, height = hitHeight): tiles the canvas so no bare,
		//    caret-less strip is left between rows or beside the centered column.
		//    A drag-selection crossing this area resolves a real caret position
		//    instead of falling back to the container's first position (which is
		//    what made the selection snap to the top of the history mid-drag).
		//    It carries NO event handlers, so a click / right-click landing on the
		//    extended part triggers nothing — only text selection benefits.
		//  - INNER (centered column, exact arithmetic height, clipped): the real
		//    row body plus its interaction surface. Geometry, visuals and the
		//    selection outline stay bound to the measured height.
		return (
			<div
				id={itemId}
				data-message-id={sourceIds[0]}
				// LOD-independent identity of this row's content (see ElementSpec.unitId).
				// A tool call carries the same value here as the folded trace row it
				// becomes at L1/L2, so the two renderings are pairable across a level
				// change. Height-neutral (a data attribute).
				data-nf-unit={item.spec.unitId}
				// The row's spec key, so the fold transition can resolve a planned motion
				// to this node (see vlist-fold-motion). `id` cannot serve: it is the
				// MESSAGE id, which several rows of one message share. Height-neutral.
				data-nf-row-key={item.spec.key}
				style={{
					position: "absolute",
					top,
					left: 0,
					width: "100%",
					...(isDynamic ? { minHeight: hitHeight } : { height: hitHeight }),
				}}
			>
				<div
					// The row's INNER content box, addressable so the fold's `clip-path` can
					// play on it. An inset is measured from the bottom of the node it plays on,
					// and only this box is the layout's `height` tall; the outer row box is
					// `hitHeight` (own height + the gap to the next row), so clipping there
					// starts a gap's worth of pixels below the card's real bottom edge and
					// uncovers content that should still be hidden. Height-neutral (a data
					// attribute), and never threaded through spec.opts.
					data-nf-row-body={item.spec.key}
					style={{
						width: contentWidth,
						margin: "0 auto",
						...(isDynamic ? { minHeight: height } : { height, overflow: "hidden" }),
					}}
				>
					{sourceIds.slice(1).map((sourceId) => (
						<span
							key={sourceId}
							id={`msg-${sourceId}`}
							data-message-id={sourceId}
							aria-hidden
							style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
						/>
					))}
					{isDynamic ? (
						<DynamicHeightReporter onHeight={onUnknownHeight}>
							{interactiveBody}
						</DynamicHeightReporter>
					) : (
						interactiveBody
					)}
				</div>
				{/* The extended part of the hit box (the gap below this row) carries no
				    text of its own, so a drag-selection crossing it would still fail to
				    resolve a caret. Fill it with a selectable, invisible strip. */}
				{!isDynamic ? (
					<CaretFiller top={height} height={hitHeight - height} width={contentWidth} centered />
				) : null}
			</div>
		);
	},
	(prev, next) =>
		// Compare what the row actually RENDERS FROM, not the disposable wrapper.
		//
		// `item` is `{ spec, measured }`, freshly allocated by every layout build, so
		// `prev.item === next.item` was false on every rebuild — including rebuilds that
		// changed nothing this row draws. Measured: on a height-only rebuild 300/300
		// `measured` objects are byte-identical (they come from the measure cache), yet
		// every mounted row still rebuilt its absolutely positioned spans: 20 prose rows
		// = 1601 DOM nodes, 22.3ms in linkedom (no style/layout/paint, so a browser is
		// strictly slower).
		//
		// `measured` carries the geometry AND the prepared blocks the render layer walks,
		// and `spec.key`/`spec.kind` select the renderer, so this pair is the row's true
		// render identity. `spec.data` needs no comparison: it is measured INTO
		// `measured`, and the measure cache keys on a content revision, so different data
		// yields a different `measured` object (see measure-cache.extractDataRevision).
		prev.item.measured === next.item.measured &&
		prev.item.spec.key === next.item.spec.key &&
		prev.item.spec.kind === next.item.spec.kind &&
		// Painted as `data-nf-unit` (the LOD-independent row identity), so a change
		// must reach the DOM even though it affects nothing else.
		prev.item.spec.unitId === next.item.spec.unitId &&
		prev.top === next.top &&
		prev.height === next.height &&
		prev.hitHeight === next.hitHeight &&
		prev.contentWidth === next.contentWidth &&
		prev.itemId === next.itemId &&
		prev.interactionSig === next.interactionSig &&
		prev.toggles === next.toggles &&
		prev.interaction === next.interaction &&
		prev.rowInteraction === next.rowInteraction &&
		prev.narratorId === next.narratorId &&
		prev.onOpenFilePanel === next.onOpenFilePanel &&
		prev.openAttachmentLabel === next.openAttachmentLabel &&
		prev.injectionNoteLabel === next.injectionNoteLabel &&
		prev.reviewTruncatedLabel === next.reviewTruncatedLabel &&
		prev.injectionNavigation === next.injectionNavigation &&
		// Authorship decides the bubble's side; a row must repaint if the viewer changes.
		prev.currentUserId === next.currentUserId &&
		prev.permissionSlot === next.permissionSlot &&
		prev.editorSlot === next.editorSlot &&
		prev.onUnknownHeight === next.onUnknownHeight &&
		prev.onTerminate === next.onTerminate &&
		prev.resolveUpdateTimeout === next.resolveUpdateTimeout &&
		prev.onReflectionTakeOver === next.onReflectionTakeOver &&
		// The drill-down's own gate binding. Omitting it would pin a stale resolver on
		// every mounted row — silently, since the button still paints and still calls
		// SOMETHING (the previous narrator's handler).
		prev.getReflectionTakeOver === next.getReflectionTakeOver &&
		// The drilled-in subagent card's prompt fold + session actions. Same stale-
		// binding hazard as the take-over resolver above: pinned at first value, the
		// row would call the previous narrator's handlers.
		prev.onTogglePromptForKey === next.onTogglePromptForKey &&
		prev.resolveRowToolActions === next.resolveRowToolActions &&
		prev.onResumeSubagentRecovery === next.onResumeSubagentRecovery &&
		prev.specCarryoverActions === next.specCarryoverActions &&
		prev.errorNoticeActions === next.errorNoticeActions &&
		prev.injectionGuardActions === next.injectionGuardActions &&
		prev.reviewFeedbackActions === next.reviewFeedbackActions &&
		prev.compactActions === next.compactActions &&
		prev.compactCancelTitle === next.compactCancelTitle &&
		prev.askInPassingPending === next.askInPassingPending &&
		prev.onOpenAskInPassingTarget === next.onOpenAskInPassingTarget &&
		prev.viewControls === next.viewControls &&
		// The spinner gate: it flips when the narrator settles or when a newer task
		// surface arrives, and neither moves `measured` (a glyph swap is
		// height-neutral). Without this term the previous live row keeps spinning
		// after the turn ends.
		prev.specTaskLive === next.specTaskLive,
);

/**
 * Wrap a dynamic-height row body in a ResizeObserver that reports the subtree's
 * real pixel height. This is the CONTRACT's controlled DOM-measurement exception
 * (permission forms / unknown blocks) — it lives in the shell/render layer, never
 * in the pure measure path scanned by the zero-DOM guard.
 */
function DynamicHeightReporter({
	onHeight,
	children,
}: {
	onHeight: (height: number) => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const onHeightRef = useRef(onHeight);
	onHeightRef.current = onHeight;
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const report = () => {
			const h = node.offsetHeight;
			if (h > 0) onHeightRef.current(h);
		};
		report();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(report);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return <div ref={ref}>{children}</div>;
}
