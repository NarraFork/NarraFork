import { Box, Divider, Text } from "@mantine/core";
import {
	formatTurnUsageCost,
	formatTurnUsageParts,
	getPromptTokenFootprint,
} from "@shared/pretext-layout/turn-usage";
import type { RevertScope } from "../../lib/api/narrators";
import { formatLocaleNumber } from "../../lib/intl-format";
import { ActivityTrace } from "./ActivityTrace";
import { BlurInOnAppear } from "./BlurInOnAppear";
import { getToolCallBlurAnimationId, getUserMessageBlurAnimationId } from "./blur-in-ids";
import type { ActivityRenderOverrides } from "./cross-chunk-activity";
import { MessageBubble } from "./MessageBubble";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "./MessageContextMenuCtx";
import {
	collectSegmentTargetIds,
	type RenderSegment,
	segmentMessages,
	type ToolRunItem,
} from "./message-segments";
import { resolvePendingPerm } from "./narrator-message-helpers";
import type { NarratorMsg, PermissionCallbacks } from "./narrator-panel-types";
import { useRenderLod } from "./RenderLodCtx";
import { groupRenderUnits, groupToolRunItemsForLod } from "./render-units";
import { recentRunSegmentMessageIds } from "./run-segments";
import { SubagentCard } from "./SubagentCard";
import type { ToolCallData } from "./ToolCallCard";
import { TOOL_CARD_BG, ToolCallCard } from "./ToolCallCard";
import { ToolRunCountLine, ToolRunSummary } from "./ToolRunSummary";
import type { TraceRowHandlers, TraceRowSubagentHandlers } from "./trace-row-menu";

// ---------------------------------------------------------------------------
// renderToolRun — renders a tool-run segment from pre-computed ToolRunItems
// ---------------------------------------------------------------------------

export interface RenderToolRunOptions {
	highlightedId?: string | null;
	onForkFromMessage?: (messageId: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onViewSubagentSession?: (narratorId: string) => void;
	/**
	 * Open a child session from a FOLDED row. Falls back to
	 * `onViewSubagentSession`; supplied separately because a standalone panel gives
	 * the rows a plain routing handler while the expanded SubagentCard keeps its own
	 * richer navigation (which carries `scrollTo`/`from`).
	 */
	onViewSubagentSessionFolded?: (narratorId: string) => void;
	/**
	 * Detach a running subagent to a background task. Only the FOLDED trace rows
	 * need this passed down: the expanded SubagentCard calls the api itself.
	 */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task (folded rows only, see above). */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/**
	 * Open a file-oriented tool's path in a read-only dock panel. Supplied by hosts
	 * that own a dockview surface; used by folded rows and the expanded tool card.
	 */
	onOpenFilePanel?: (filePath: string) => void;
	containerStyle?: React.CSSProperties;
	containerClassName?: string;
	enableBlurIn?: boolean;
	/**
	 * Ids of messages belonging to the most recent assistant run segments.
	 * Used by L5 to keep only the current + previous request's cards expanded;
	 * cards from older segments collapse to headers. Undefined → treat all as
	 * recent (no recency collapse).
	 */
	recentMessageIds?: Set<string>;
}

export type RenderedTreeElementMeta =
	| { kind: "regular" }
	| { kind: "decorative" }
	| { kind: "tool-run"; sourceMessages: NarratorMsg[] };

const HIGHLIGHT_STYLE: React.CSSProperties = {
	animation: "highlight-blink 1.5s ease",
	borderRadius: "var(--mantine-radius-sm)",
};

/**
 * Locale-aware number formatter handed to the shared usage helpers, which stay
 * pure (and therefore unit-testable) by taking the formatter as an argument.
 */
const formatUsageNumber = (value: number) => formatLocaleNumber(value);

export function renderToolRun(
	items: ToolRunItem[],
	runKey: string,
	narratorId: string,
	permCb: PermissionCallbacks,
	opts: RenderToolRunOptions = {},
) {
	const {
		highlightedId,
		onForkFromMessage,
		onAskInPassing,
		onCompactBeforeMessage,
		onClearContextBefore,
		onManualSummarize,
		onDeleteBlock,
		onRollbackToBlock,
		onViewSubagentSession,
		onViewSubagentSessionFolded,
		onDetachSubagent,
		onCancelBackgroundTask,
		onOpenFilePanel,
		containerStyle,
		containerClassName,
		enableBlurIn = true,
		recentMessageIds,
	} = opts;

	if (items.length === 0) return null;

	const matchPermission = (tc: ToolCallData) =>
		resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermissions);

	const taskCount = items.filter((it) => it.isSubagent).length;
	const soleSubagent = taskCount === 1;
	const wrapWithBlur = (animationId: string | null, node: React.ReactNode) =>
		enableBlurIn && animationId ? (
			<BlurInOnAppear animationId={animationId}>{node}</BlurInOnAppear>
		) : (
			node
		);

	const renderItem = (item: ToolRunItem, idx: number, total: number) => {
		const key = item.tc.toolUseId ?? `${item.msg.id}-${idx}`;
		const hlStyle = highlightedId === item.msg.id ? HIGHLIGHT_STYLE : undefined;

		const ctxActions: MessageContextMenuActions = { messageId: item.msg.id };
		const msgUuid = item.msg.messageUuid;
		const msgId = item.msg.id;
		if (msgId && onForkFromMessage) {
			ctxActions.onForkFromMessage = () => onForkFromMessage(msgId);
		}
		if (msgId && onAskInPassing) {
			ctxActions.onAskInPassing = () => onAskInPassing(msgUuid ?? null, msgId);
		}
		if (msgId && onCompactBeforeMessage) {
			ctxActions.onCompactBeforeMessage = () => onCompactBeforeMessage(msgId);
		}
		if (msgId && onClearContextBefore) {
			ctxActions.onClearContextBefore = () => onClearContextBefore(msgId);
		}
		if (msgId && onManualSummarize) {
			ctxActions.onManualSummarize = () => onManualSummarize(msgId);
		}
		if (msgId && onDeleteBlock) {
			ctxActions.onDeleteBlock = (blockIndex: number) => onDeleteBlock(msgId, blockIndex);
		}
		if (msgId && onRollbackToBlock) {
			ctxActions.onRollbackToBlock = (blockIndex: number) => onRollbackToBlock(msgId, blockIndex);
		}

		const toolAnimationId = getToolCallBlurAnimationId({
			toolUseId: item.tc.toolUseId,
			messageId: item.msg.id,
			fallbackKey: item.blockIndex ?? idx,
		});
		if (item.isSubagent) {
			return (
				<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
					{wrapWithBlur(
						toolAnimationId,
						<div
							id={item.tc.toolUseId ? `tool-use-${item.tc.toolUseId}` : `msg-${item.msg.id}`}
							style={hlStyle}
						>
							<SubagentCard
								toolCall={item.tc}
								narratorId={narratorId}
								inRun={total >= 2}
								isLast={idx === total - 1}
								isSoleInRun={soleSubagent}
								permCb={permCb}
								onViewSubagentSession={onViewSubagentSession}
								blockIndex={item.blockIndex}
								isRecent={recentMessageIds == null || recentMessageIds.has(item.msg.id)}
							/>
						</div>,
					)}
				</MessageContextMenuCtx.Provider>
			);
		}
		return (
			<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
				{wrapWithBlur(
					toolAnimationId,
					<div
						id={item.tc.toolUseId ? `tool-use-${item.tc.toolUseId}` : `msg-${item.msg.id}`}
						style={hlStyle}
					>
						<ToolCallCard
							toolCall={item.tc}
							narratorId={narratorId}
							inRun={total >= 2}
							isLast={idx === total - 1}
							pendingPermission={matchPermission(item.tc)}
							onPermissionDecision={permCb.onPermissionDecision}
							onQuestionSubmit={permCb.onQuestionSubmit}
							onQuestionReflect={permCb.onQuestionReflect}
							onQuestionDeny={permCb.onQuestionDeny}
							onViewSubagentSession={onViewSubagentSession}
							onOpenFilePanel={onOpenFilePanel}
							blockIndex={item.blockIndex}
							isRecent={recentMessageIds == null || recentMessageIds.has(item.msg.id)}
						/>
					</div>,
				)}
			</MessageContextMenuCtx.Provider>
		);
	};

	const isMultiRun = items.length >= 2;

	// The full per-card list (current L6 rendering). Reused as the fallback when
	// the user expands a summary, or when the run contains active tools that must
	// stay visible regardless of LOD.
	//
	// No injection hosting here any more: server-authored content now owns its own
	// message row (see `narrator-injection.ts`), so a pure-tool message no longer has
	// to act as a host for injections that had nowhere else to render.
	const fullListNode = <>{items.map((item, idx) => renderItem(item, idx, items.length))}</>;

	return (
		<ToolRunFrame
			runKey={runKey}
			isMultiRun={isMultiRun}
			containerClassName={containerClassName}
			containerStyle={containerStyle}
		>
			<ToolRunLodGate
				items={items}
				runKey={runKey}
				narratorId={narratorId}
				renderItem={renderItem}
				rowHandlers={{
					onForkFromMessage,
					onAskInPassing,
					onCompactBeforeMessage,
					onClearContextBefore,
					onManualSummarize,
					onDeleteBlock,
					onRollbackToBlock,
				}}
				subagentHandlers={{
					onViewSubagentSession: onViewSubagentSessionFolded ?? onViewSubagentSession,
					onDetachSubagent,
					onCancelBackgroundTask,
					onOpenFilePanel,
				}}
			>
				{fullListNode}
			</ToolRunLodGate>
		</ToolRunFrame>
	);
}

// ---------------------------------------------------------------------------
// ToolRunFrame — the outer container of a tool-run. In full-detail levels the
// multi-run frame (border + background) groups the cards; in folded levels
// (L3 summary / L2/L1 count line) the frame is dropped so the trace renders
// bare, matching the reasoning trace.
// ---------------------------------------------------------------------------
function ToolRunFrame({
	runKey,
	isMultiRun,
	containerClassName,
	containerStyle,
	children,
}: {
	runKey: string;
	isMultiRun: boolean;
	containerClassName?: string;
	containerStyle?: React.CSSProperties;
	children: React.ReactNode;
}) {
	const lod = useRenderLod();
	// Frame only the full multi-card list (L4+). Folded levels render bare (the
	// trace matches reasoning); any active cards kept visible at low LOD get
	// their own border via inRun=false rendering inside the gate.
	const framed = isMultiRun && lod >= 4;
	return (
		<div
			key={`tool-run-${runKey}`}
			data-tool-run
			className={containerClassName}
			style={{
				...(framed
					? {
							border: "1px solid var(--mantine-color-default-border)",
							borderRadius: "var(--mantine-radius-sm)",
							overflow: "hidden",
							backgroundColor: TOOL_CARD_BG,
						}
					: undefined),
				...containerStyle,
			}}
		>
			{children}
		</div>
	);
}

// ---------------------------------------------------------------------------
// ToolRunLodGate — decides, per render LOD, whether a tool-run renders as the
// full card list (L6/L5-recent), a summary block (L3), or a single count line
// (L2/L1).
//
// Active tools (running / pending / initializing / streaming) are exempt
// PER-ITEM, not per-run: only the in-flight cards render in full, while the
// completed ones fold into the summary / count. This avoids the whole run
// oscillating between full and folded as a stream of tools completes one by
// one (the "streaming flapping" bug). The shared isActiveToolItem lives in
// render-units.ts.
// ---------------------------------------------------------------------------

function ToolRunLodGate({
	items,
	runKey,
	narratorId,
	renderItem,
	rowHandlers,
	subagentHandlers,
	children,
}: {
	items: ToolRunItem[];
	runKey: string;
	narratorId?: string;
	/** Renders one full tool card; used to keep active tools visible at low LOD. */
	renderItem: (item: ToolRunItem, idx: number, total: number) => React.ReactNode;
	/** Panel handlers behind each folded row's message menu (L3 summary rows). */
	rowHandlers?: TraceRowHandlers;
	/** Subagent lifecycle handlers for the folded rows (open / detach / cancel). */
	subagentHandlers?: TraceRowSubagentHandlers;
	children: React.ReactNode;
}) {
	const lod = useRenderLod();

	// Full detail levels render the whole per-card list. L5's recency scoping is
	// applied per-card inside ToolCallCard (earlier segments collapse to headers
	// there), and L4 collapses every card to a header — but in both cases the
	// per-card LOD logic already keeps active cards expanded, so the run-level
	// gate only needs to act at L3 and below.
	if (lod >= 4) {
		return <>{children}</>;
	}

	// Preserve the source order while folding only completed calls. Active cards
	// stay standalone at their original positions instead of being hoisted above
	// earlier completed calls (which made the live card appear before its history).
	const groups = groupToolRunItemsForLod(items);

	if (lod === 3) {
		return (
			<>
				{groups.map((group) => {
					if (group.kind === "active") {
						// total=1 → inRun=false, so the standalone live card keeps its own border.
						return renderItem(group.item, group.index, 1);
					}
					return (
						<ToolRunSummary
							key={`folded-${group.startIndex}`}
							items={group.items}
							runKey={group.startIndex === 0 ? runKey : `${runKey}-folded-${group.startIndex}`}
							narratorId={narratorId}
							rowHandlers={rowHandlers}
							subagentHandlers={subagentHandlers}
						/>
					);
				})}
			</>
		);
	}

	// L1/L2 use count lines for each contiguous completed batch, with any live
	// cards left in their chronological positions between those batches.
	return (
		<>
			{groups.map((group) =>
				group.kind === "active" ? (
					renderItem(group.item, group.index, 1)
				) : (
					<ToolRunCountLine key={`folded-${group.startIndex}`} items={group.items} />
				),
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// renderTreeMessages — renders a flat message list using pre-computed segments
// ---------------------------------------------------------------------------

/**
 * Resolve a pending permission for a tool call. Exported as a NAMED type so
 * callers stop addressing it by positional index into `renderTreeMessages`'s
 * 27-argument signature (see ChunkedMessageList's ResolvePermFn).
 */
export type RenderTreeResolvePermFn = (tc: ToolCallData) => ReturnType<typeof resolvePendingPerm>;

export function renderTreeMessages(
	messages: NarratorMsg[],
	narratorId: string,
	onForkFromMessage: ((messageId: string) => void) | undefined,
	highlightedId: string | null,
	permCb: PermissionCallbacks,
	showTokenUsage?: boolean,
	pruneBoundaryMessageId?: string | null,
	pruneDividerLabel?: string,
	onCompactBeforeMessage?: (messageId: string) => void,
	onClearContextBefore?: (messageId: string) => void,
	onManualSummarize?: (messageId: string) => void,
	onDeleteBlock?: (messageId: string, blockIndex: number) => void,
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void,
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: { skipRevert: boolean; scope?: RevertScope },
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
		},
	) => Promise<boolean>,
	onEditAssistantMessage?: (messageId: string, newContent: string) => void,
	onRestoreAssistantMessage?: (messageId: string) => void,
	lastUserMessageId?: string,
	hasChapter?: boolean,
	onViewSubagentSession?: (narratorId: string) => void,
	streamingMsg?: NarratorMsg | null,
	resolvePerm?: (tc: ToolCallData) => ReturnType<typeof resolvePendingPerm>,
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void,
	enableBlurIn = true,
	/** Render LOD — at 1/2, reasoning + tool segments fold into one activity trace. */
	renderLod?: number,
	/** Cross-chunk owner/continuation overrides keyed by local activity ordinal. */
	activityOverrides?: ActivityRenderOverrides,
	/**
	 * Subagent handlers used ONLY by the folded trace rows (open child session /
	 * detach to background / cancel background task). Grouped into one object
	 * rather than appended as three more positional parameters — this signature is
	 * already 26 arguments long.
	 *
	 * The expanded SubagentCard deliberately does NOT read these: it calls the api
	 * itself and owns its own routing fallback (which carries `scrollTo`/`from`).
	 * `onViewSubagentSession` here therefore overrides the card-level prop for
	 * folded rows only, letting a standalone panel supply the plain routing
	 * fallback the rows need without altering the card's richer behaviour.
	 */
	foldedSubagentHandlers?: TraceRowSubagentHandlers,
): { elements: React.ReactNode[]; meta: RenderedTreeElementMeta[]; segments: RenderSegment[] } {
	const segments = segmentMessages(messages, {
		pruneBoundaryMessageId,
		pruneDividerLabel,
		streamingMsg,
	});

	// Recency window for L5: ids of messages in the last two assistant run
	// segments. Tool cards outside this window collapse to headers. When no
	// streaming message is present the window is computed over `messages`;
	// include the streaming tail so the in-flight segment counts as recent.
	const recentSource = streamingMsg != null ? [...messages, streamingMsg] : messages;
	const recentMessageIds = recentRunSegmentMessageIds(recentSource, 2);

	const elements: React.ReactNode[] = [];
	const meta: RenderedTreeElementMeta[] = [];

	const renderMessageSegment = (
		targetMsg: NarratorMsg,
		key: string,
		domId = `msg-${targetMsg.id}`,
		highlight = true,
		visibleBlockIndices?: number[],
	) => {
		const displayMsg =
			visibleBlockIndices != null
				? {
						...targetMsg,
						contentJson: visibleBlockIndices.map((bi) => targetMsg.contentJson[bi]),
						toolCalls: [],
						_blockOriginalIndices: visibleBlockIndices,
						_allContentJson: targetMsg.contentJson,
					}
				: targetMsg;
		const promptTokenFootprint =
			getPromptTokenFootprint(targetMsg.turnUsageJson) ?? targetMsg.tokensIn ?? null;
		const turnUsageParts = formatTurnUsageParts(targetMsg.turnUsageJson, formatUsageNumber);
		const turnUsageSummary = turnUsageParts?.join(" · ") ?? null;
		const turnUsageCost = formatTurnUsageCost(targetMsg.costUsd);
		const mobileTurnUsageLine1 = turnUsageParts?.slice(0, 3).join(" · ") ?? null;
		const mobileTurnUsageLine2Parts = [...(turnUsageParts?.slice(3) ?? [])];
		if (turnUsageCost != null) mobileTurnUsageLine2Parts.push(turnUsageCost);
		const mobileTurnUsageLine2 = mobileTurnUsageLine2Parts.join(" · ");

		const content = (
			<div
				key={key}
				id={domId}
				data-message-id={targetMsg.id ?? undefined}
				style={{
					borderRadius: "var(--mantine-radius-md)",
					animation:
						highlight && highlightedId === targetMsg.id ? "highlight-blink 1.5s ease" : undefined,
				}}
			>
				{showTokenUsage &&
					targetMsg.role === "assistant" &&
					(promptTokenFootprint != null || targetMsg.meterUsage != null) && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mb={2}>
							{promptTokenFootprint != null
								? `↑ ${formatLocaleNumber(promptTokenFootprint)}`
								: `${(targetMsg.meterUsage as number).toFixed(2)} credits`}
						</Text>
					)}
				<MessageBubble
					narratorId={narratorId}
					message={displayMsg}
					onForkFromMessage={onForkFromMessage}
					onAskInPassing={onAskInPassing}
					resolvePerm={
						resolvePerm ??
						((tc) => resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermissions))
					}
					onPermissionDecision={permCb.onPermissionDecision}
					onQuestionSubmit={permCb.onQuestionSubmit}
					onQuestionReflect={permCb.onQuestionReflect}
					onQuestionDeny={permCb.onQuestionDeny}
					onCompactBeforeMessage={onCompactBeforeMessage}
					onClearContextBefore={onClearContextBefore}
					onManualSummarize={onManualSummarize}
					onDeleteBlock={onDeleteBlock}
					onRollbackToBlock={onRollbackToBlock}
					onEditAndRegenerate={onEditAndRegenerate}
					onEditAssistantMessage={onEditAssistantMessage}
					onRestoreAssistantMessage={onRestoreAssistantMessage}
					onViewSubagentSession={onViewSubagentSession}
					onOpenFilePanel={foldedSubagentHandlers?.onOpenFilePanel}
					isLastUserMessage={targetMsg.id === lastUserMessageId}
					hasChapter={hasChapter}
				/>
				{showTokenUsage &&
					(turnUsageSummary != null ||
						(targetMsg.meterUsage != null && promptTokenFootprint == null)) && (
						<>
							<Text size="xs" c="dimmed" ta="right" pr="sm" mt={2} visibleFrom="sm">
								{turnUsageSummary != null
									? `${turnUsageSummary}${turnUsageCost != null ? ` · ${turnUsageCost}` : ""}`
									: `${(targetMsg.meterUsage as number).toFixed(2)} credits`}
							</Text>
							<Box hiddenFrom="sm" pr="sm" mt={2}>
								{turnUsageSummary != null ? (
									<>
										<Text size="xs" c="dimmed" ta="right" lh={1.35}>
											{mobileTurnUsageLine1}
										</Text>
										{mobileTurnUsageLine2 ? (
											<Text size="xs" c="dimmed" ta="right" lh={1.35}>
												{mobileTurnUsageLine2}
											</Text>
										) : null}
									</>
								) : (
									<Text size="xs" c="dimmed" ta="right" lh={1.35}>
										{(targetMsg.meterUsage as number).toFixed(2)} credits
									</Text>
								)}
							</Box>
						</>
					)}
			</div>
		);
		const userAnimationId =
			enableBlurIn && targetMsg.role === "user"
				? getUserMessageBlurAnimationId(targetMsg.id)
				: null;
		return userAnimationId ? (
			<BlurInOnAppear key={key} animationId={userAnimationId}>
				{content}
			</BlurInOnAppear>
		) : (
			content
		);
	};

	// L1/L2 unified fold: group adjacent reasoning-only / inactive tool segments
	// into single activity render-units. At L3+ this is the identity mapping.
	const renderUnits = groupRenderUnits(segments, renderLod != null && renderLod <= 2);
	let activityIndex = 0;
	const renderedMessageDomIds = new Set<string>();

	for (const unit of renderUnits) {
		// Unified L1/L2 activity trace: L1 collapses the whole run; L2 shows its rows.
		if (unit.kind === "activity") {
			const override = activityOverrides?.get(activityIndex);
			activityIndex++;
			if (override?.hidden) continue;
			// `replaceItems` supersedes the unit's own list when resolving the cross-chunk
			// hand-off dropped one of ITS items (see ActivityRenderOverride.replaceItems).
			const ownItems = override?.replaceItems ?? unit.items;
			const items = override?.appendItems ? [...ownItems, ...override.appendItems] : ownItems;
			const runKey = unit.sourceMessages[0]?.id ?? `activity-${elements.length}`;
			const streaming =
				streamingMsg != null && unit.sourceMessages.some((m) => m.id === "__streaming__");
			// L1 folds HISTORY behind the header but keeps the current run's rows on
			// screen, so live activity stays readable at the simplest level. The window
			// is the same one L5 uses and only moves when the user sends a new message,
			// so a run that finishes does not re-fold under the reader.
			const isRecentRun =
				streaming || items.some((item) => item.msg?.id && recentMessageIds.has(item.msg.id));
			elements.push(
				<div key={`activity-${runKey}-${elements.length}`} data-tool-run>
					<ActivityTrace
						items={items}
						runKey={runKey}
						streaming={streaming}
						collapsed={renderLod === 1 && !isRecentRun}
						narratorId={narratorId}
						rowHandlers={{
							onForkFromMessage,
							onAskInPassing,
							onCompactBeforeMessage,
							onClearContextBefore,
							onManualSummarize,
							onDeleteBlock,
							onRollbackToBlock,
						}}
						subagentHandlers={{
							onViewSubagentSession:
								foldedSubagentHandlers?.onViewSubagentSession ?? onViewSubagentSession,
							onDetachSubagent: foldedSubagentHandlers?.onDetachSubagent,
							onCancelBackgroundTask: foldedSubagentHandlers?.onCancelBackgroundTask,
							onOpenFilePanel: foldedSubagentHandlers?.onOpenFilePanel,
						}}
					/>
				</div>,
			);
			meta.push({ kind: "tool-run", sourceMessages: unit.sourceMessages });
			continue;
		}

		const seg = unit.seg;
		if (seg.kind === "prune-divider") {
			elements.push(
				<Divider
					key="prune-boundary"
					my="xs"
					label={seg.label}
					labelPosition="center"
					color="yellow.7"
					styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
				/>,
			);
			meta.push({ kind: "decorative" });
			continue;
		}

		if (seg.kind === "message") {
			const blockSuffix = seg.visibleBlockIndices?.join("-");
			const key = blockSuffix ? `${seg.msg.id}-blocks-${blockSuffix}` : seg.msg.id;
			const usesBaseDomId = !renderedMessageDomIds.has(seg.msg.id);
			renderedMessageDomIds.add(seg.msg.id);
			const domId = usesBaseDomId ? `msg-${seg.msg.id}` : `msg-${seg.msg.id}-blocks-${blockSuffix}`;
			elements.push(
				renderMessageSegment(
					seg.msg,
					key,
					domId,
					!seg.visibleBlockIndices,
					seg.visibleBlockIndices,
				),
			);
			meta.push({ kind: "regular" });
			continue;
		}

		const runKey = seg.sourceMessages[0]?.id ?? "unknown";
		const el = renderToolRun(seg.items, runKey, narratorId, permCb, {
			highlightedId,
			onForkFromMessage,
			onAskInPassing,
			onCompactBeforeMessage,
			onClearContextBefore,
			onManualSummarize,
			onDeleteBlock,
			onRollbackToBlock,
			// The expanded card keeps the panel-level handler (richer navigation);
			// the folded rows inside this run may override it.
			onViewSubagentSession,
			onViewSubagentSessionFolded: foldedSubagentHandlers?.onViewSubagentSession,
			onDetachSubagent: foldedSubagentHandlers?.onDetachSubagent,
			onCancelBackgroundTask: foldedSubagentHandlers?.onCancelBackgroundTask,
			onOpenFilePanel: foldedSubagentHandlers?.onOpenFilePanel,
			enableBlurIn,
			recentMessageIds,
		});
		if (el) {
			elements.push(el);
			meta.push({ kind: "tool-run", sourceMessages: seg.sourceMessages });
		}
	}

	return { elements, meta, segments };
}

// ---------------------------------------------------------------------------
// renderTreeMessagesWithKeys — same as renderTreeMessages but also returns
// stable string keys for each element (needed for virtualization).
// ---------------------------------------------------------------------------

export function renderTreeMessagesWithKeys(...args: Parameters<typeof renderTreeMessages>): {
	elements: React.ReactNode[];
	keys: string[];
	targets: string[][];
	meta: RenderedTreeElementMeta[];
} {
	const { elements, meta, segments } = renderTreeMessages(...args);
	const keys: string[] = [];
	for (const el of elements) {
		if (el != null && typeof el === "object" && "key" in (el as React.ReactElement)) {
			keys.push(String((el as React.ReactElement).key ?? keys.length));
		} else {
			keys.push(String(keys.length));
		}
	}

	const targets: string[][] = [];
	for (const seg of segments) {
		targets.push(collectSegmentTargetIds(seg));
	}

	return {
		elements,
		keys,
		targets: targets.length === elements.length ? targets : elements.map(() => []),
		meta: meta.length === elements.length ? meta : elements.map(() => ({ kind: "regular" })),
	};
}

// ---------------------------------------------------------------------------
// RenderProgress — thin progress bar for progressive rendering / fetch
// ---------------------------------------------------------------------------

export function RenderProgress({
	value,
	indeterminate,
}: {
	value?: number;
	indeterminate?: boolean;
}) {
	const pct = value != null ? Math.round(Math.min(value, 1) * 100) : 0;
	return (
		<div
			style={{
				height: 2,
				width: "100%",
				background: "var(--mantine-color-dark-5)",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					height: "100%",
					width: indeterminate ? "30%" : `${pct}%`,
					background: "var(--mantine-color-blue-6)",
					transition: indeterminate ? undefined : "width 80ms linear",
					animation: indeterminate ? "indeterminate-slide 1.2s ease-in-out infinite" : undefined,
				}}
			/>
		</div>
	);
}
