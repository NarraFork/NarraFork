import { Box, Divider, Text } from "@mantine/core";
import type { SideCarRecord } from "../../lib/api";
import { BlurInOnAppear } from "./BlurInOnAppear";
import { getToolCallBlurAnimationId, getUserMessageBlurAnimationId } from "./blur-in-ids";
import { MessageBubble } from "./MessageBubble";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "./MessageContextMenuCtx";
import {
	collectSegmentTargetIds,
	messageHasVisibleContentBlock,
	type RenderSegment,
	segmentMessages,
	type ToolRunItem,
} from "./message-segments";
import { resolvePendingPerm } from "./narrator-message-helpers";
import type { NarratorMsg, PermissionCallbacks } from "./narrator-panel-types";
import { hasVisibleSideCars, SideCarNotice } from "./SideCarNotice";
import { SubagentCard } from "./SubagentCard";
import type { ToolCallData } from "./ToolCallCard";
import { TOOL_CARD_BG, ToolCallCard } from "./ToolCallCard";

// ---------------------------------------------------------------------------
// renderToolRun — renders a tool-run segment from pre-computed ToolRunItems
// ---------------------------------------------------------------------------

export interface RenderToolRunOptions {
	expandedToolUseId?: string | null;
	highlightedId?: string | null;
	onForkFromMessage?: (uuid: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onViewSubagentSession?: (narratorId: string) => void;
	containerStyle?: React.CSSProperties;
	containerClassName?: string;
	enableBlurIn?: boolean;
}

export type RenderedTreeElementMeta =
	| { kind: "regular" }
	| { kind: "decorative" }
	| { kind: "tool-run"; sourceMessages: NarratorMsg[] };

const HIGHLIGHT_STYLE: React.CSSProperties = {
	animation: "highlight-blink 1.5s ease",
	borderRadius: "var(--mantine-radius-sm)",
};

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPromptTokenFootprint(turnUsageJson: NarratorMsg["turnUsageJson"]): number | null {
	const tu = turnUsageJson as Record<string, unknown> | null | undefined;
	if (!tu) return null;
	const promptTokens = usageNumberOrNull(tu.prompt_tokens);
	if (promptTokens != null) return promptTokens;
	const inputTokens = usageNumberOrNull(tu.input_tokens);
	if (inputTokens == null) return null;
	return (
		inputTokens + usageNumber(tu.cached_input_tokens) + usageNumber(tu.cache_creation_input_tokens)
	);
}

function formatTurnUsageParts(turnUsageJson: NarratorMsg["turnUsageJson"]): string[] | null {
	const tu = turnUsageJson as Record<string, unknown> | null | undefined;
	if (!tu) return null;
	const inputTokens = usageNumber(tu.input_tokens);
	const outputTokens = usageNumber(tu.output_tokens);
	const promptTokens = getPromptTokenFootprint(turnUsageJson) ?? inputTokens;
	const cachedTokens = usageNumber(tu.cached_input_tokens);
	const cacheCreationTokens = usageNumber(tu.cache_creation_input_tokens);
	const cache5mTokens = usageNumber(tu.cache_creation_5m_tokens);
	const cache1hTokens = usageNumber(tu.cache_creation_1h_tokens);
	const reasoningTokens = usageNumber(tu.reasoning_tokens);

	const parts = [
		`Σ ${promptTokens.toLocaleString()} ctx`,
		`${inputTokens.toLocaleString()} in`,
		`${outputTokens.toLocaleString()} out`,
	];
	if (cachedTokens > 0) parts.push(`${cachedTokens.toLocaleString()} cache hit`);
	if (cacheCreationTokens > 0) {
		const detail =
			cache5mTokens > 0 || cache1hTokens > 0
				? ` (${cache5mTokens.toLocaleString()} 5m / ${cache1hTokens.toLocaleString()} 1h)`
				: "";
		parts.push(`${cacheCreationTokens.toLocaleString()} cache write${detail}`);
	}
	if (reasoningTokens > 0) parts.push(`${reasoningTokens.toLocaleString()} reasoning`);
	return parts;
}

export function renderToolRun(
	items: ToolRunItem[],
	runKey: string,
	narratorId: string,
	permCb: PermissionCallbacks,
	opts: RenderToolRunOptions = {},
) {
	const {
		expandedToolUseId,
		highlightedId,
		onForkFromMessage,
		onAskInPassing,
		onCompactBeforeMessage,
		onClearContextBefore,
		onManualSummarize,
		onDeleteBlock,
		onRollbackToBlock,
		onViewSubagentSession,
		containerStyle,
		containerClassName,
		enableBlurIn = true,
	} = opts;

	if (items.length === 0) return null;

	const matchPermission = (tc: ToolCallData) =>
		resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap);

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
		if (msgUuid && onForkFromMessage) {
			ctxActions.onForkFromMessage = () => onForkFromMessage(msgUuid);
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
								childMessages={item.children ?? []}
								narratorId={narratorId}
								inRun={total >= 2}
								isLast={idx === total - 1}
								isSoleInRun={soleSubagent}
								permCb={permCb}
								onViewSubagentSession={onViewSubagentSession}
								blockIndex={item.blockIndex}
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
							forceExpand={expandedToolUseId === item.tc.toolUseId}
							blockIndex={item.blockIndex}
						/>
					</div>,
				)}
			</MessageContextMenuCtx.Provider>
		);
	};

	const isMultiRun = items.length >= 2;

	// Surface user_message side-cars (bg_agent / bg_bash / group_message /
	// subagent_message / goal_update) attached to pure-tool source messages.
	// Such messages have no visible content block, so they never produce a
	// separate message segment for MessageBubble to render their side-cars.
	// Messages that also carry visible content are rendered by MessageBubble,
	// which already shows their user_message side-cars — skip them here to
	// avoid duplication. Derive the unique source messages from the run items.
	const seenSourceMsgIds = new Set<string>();
	const userSideCars: SideCarRecord[] = [];
	for (const item of items) {
		const srcMsg = item.msg;
		if (srcMsg.id && seenSourceMsgIds.has(srcMsg.id)) continue;
		if (srcMsg.id) seenSourceMsgIds.add(srcMsg.id);
		if (messageHasVisibleContentBlock(srcMsg)) continue;
		for (const sc of srcMsg.sideCars ?? []) {
			if (sc.target === "user_message") userSideCars.push(sc);
		}
	}

	return (
		<div
			key={`tool-run-${runKey}`}
			data-tool-run
			className={containerClassName}
			style={{
				...(isMultiRun
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
			{items.map((item, idx) => renderItem(item, idx, items.length))}
			{hasVisibleSideCars(userSideCars) ? (
				<div style={isMultiRun ? { padding: "var(--mantine-spacing-xs)" } : undefined}>
					<SideCarNotice sideCars={userSideCars} />
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// renderTreeMessages — renders a flat message list using pre-computed segments
// ---------------------------------------------------------------------------

export function renderTreeMessages(
	messages: NarratorMsg[],
	narratorId: string,
	onForkFromMessage: ((uuid: string) => void) | undefined,
	highlightedId: string | null,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
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
		rollback: boolean,
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
		},
	) => void,
	onEditAssistantMessage?: (messageId: string, newContent: string) => void,
	onRestoreAssistantMessage?: (messageId: string) => void,
	lastUserMessageId?: string,
	hasChapter?: boolean,
	onViewSubagentSession?: (narratorId: string) => void,
	streamingMsg?: NarratorMsg | null,
	resolvePerm?: (tc: ToolCallData) => ReturnType<typeof resolvePendingPerm>,
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void,
	enableBlurIn = true,
): { elements: React.ReactNode[]; meta: RenderedTreeElementMeta[]; segments: RenderSegment[] } {
	const segments = segmentMessages(messages, {
		pruneBoundaryMessageId,
		pruneDividerLabel,
		streamingMsg,
	});

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
		const turnUsageParts = formatTurnUsageParts(targetMsg.turnUsageJson);
		const turnUsageSummary = turnUsageParts?.join(" · ") ?? null;
		const turnUsageCost =
			targetMsg.costUsd != null && (targetMsg.costUsd as number) > 0
				? `$${(targetMsg.costUsd as number).toFixed(4)}`
				: null;
		const mobileTurnUsageLine1 = turnUsageParts?.slice(0, 3).join(" · ") ?? null;
		const mobileTurnUsageLine2Parts = [...(turnUsageParts?.slice(3) ?? [])];
		if (turnUsageCost != null) mobileTurnUsageLine2Parts.push(turnUsageCost);
		const mobileTurnUsageLine2 = mobileTurnUsageLine2Parts.join(" · ");

		const content = (
			<div
				key={key}
				id={domId}
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
								? `↑ ${promptTokenFootprint.toLocaleString()}`
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
						((tc) => resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap))
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

	for (const seg of segments) {
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
			const key = seg.visibleBlockIndices ? `${seg.msg.id}-leading` : seg.msg.id;
			const domId = `msg-${seg.msg.id}`;
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
			expandedToolUseId,
			highlightedId,
			onForkFromMessage,
			onAskInPassing,
			onCompactBeforeMessage,
			onClearContextBefore,
			onManualSummarize,
			onDeleteBlock,
			onRollbackToBlock,
			onViewSubagentSession,
			enableBlurIn,
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
