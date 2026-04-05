import { Box, Divider, Text } from "@mantine/core";
import { BlurInOnAppear } from "./BlurInOnAppear";
import { getToolCallBlurAnimationId, getUserMessageBlurAnimationId } from "./blur-in-ids";
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
import { SubagentCard } from "./SubagentCard";
import type { ToolCallData } from "./ToolCallCard";
import { TOOL_CARD_BG, ToolCallCard } from "./ToolCallCard";

// ---------------------------------------------------------------------------
// renderToolRun — renders a tool-run segment from pre-computed ToolRunItems
// ---------------------------------------------------------------------------

export interface RenderToolRunOptions {
	expandedToolUseId?: string | null;
	highlightedId?: string | null;
	editExpandOverride?: boolean | null;
	onForkFromMessage?: (uuid: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onViewSubagentSession?: (narratorId: string) => void;
	containerStyle?: React.CSSProperties;
	containerClassName?: string;
}

export type RenderedTreeElementMeta =
	| { kind: "regular" }
	| { kind: "decorative" }
	| { kind: "tool-run"; sourceMessages: NarratorMsg[] };

const HIGHLIGHT_STYLE: React.CSSProperties = {
	animation: "highlight-blink 1.5s ease",
	borderRadius: "var(--mantine-radius-sm)",
};

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
		editExpandOverride,
		onForkFromMessage,
		onCompactBeforeMessage,
		onDeleteBlock,
		onViewSubagentSession,
		containerStyle,
		containerClassName,
	} = opts;

	if (items.length === 0) return null;

	const matchPermission = (tc: ToolCallData) =>
		resolvePendingPerm(
			tc,
			permCb.pendingPermission,
			permCb.pendingPermsMap,
			permCb.overseerReviewMap,
		);

	const taskCount = items.filter((it) => it.isSubagent).length;
	const soleSubagent = taskCount === 1;
	const wrapWithBlur = (animationId: string | null, node: React.ReactNode) =>
		animationId ? <BlurInOnAppear animationId={animationId}>{node}</BlurInOnAppear> : node;

	const renderItem = (item: ToolRunItem, idx: number, total: number) => {
		const key = item.tc.toolUseId ?? `${item.msg.id}-${idx}`;
		const hlStyle = highlightedId === item.msg.id ? HIGHLIGHT_STYLE : undefined;

		const ctxActions: MessageContextMenuActions = {};
		const msgUuid = item.msg.messageUuid;
		const msgId = item.msg.id;
		if (msgUuid && onForkFromMessage) {
			ctxActions.onForkFromMessage = () => onForkFromMessage(msgUuid);
		}
		if (msgId && onCompactBeforeMessage) {
			ctxActions.onCompactBeforeMessage = () => onCompactBeforeMessage(msgId);
		}
		if (msgId && onDeleteBlock) {
			ctxActions.onDeleteBlock = (blockIndex: number) => onDeleteBlock(msgId, blockIndex);
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
								editExpandOverride={editExpandOverride}
								onBgAgentRetry={permCb?.onBgAgentRetry}
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
							onQuestionDeny={permCb.onQuestionDeny}
							forceExpand={expandedToolUseId === item.tc.toolUseId}
							editExpandOverride={editExpandOverride}
							blockIndex={item.blockIndex}
						/>
					</div>,
				)}
			</MessageContextMenuCtx.Provider>
		);
	};

	const isMultiRun = items.length >= 2;
	return (
		<Box
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
		</Box>
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
	editExpandOverride?: boolean | null,
	showTokenUsage?: boolean,
	pruneBoundaryMessageId?: string | null,
	pruneDividerLabel?: string,
	onCompactBeforeMessage?: (messageId: string) => void,
	onDeleteBlock?: (messageId: string, blockIndex: number) => void,
	onRegenerateFromMessage?: (messageId: string) => void,
	onEditAndRegenerate?: (messageId: string, newContent: string, rollback: boolean) => void,
	lastUserMessageId?: string,
	hasChapter?: boolean,
	onViewSubagentSession?: (narratorId: string) => void,
	streamingMsg?: NarratorMsg | null,
	resolvePerm?: (tc: ToolCallData) => ReturnType<typeof resolvePendingPerm>,
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
					}
				: targetMsg;

		const content = (
			<Box
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
					(targetMsg.tokensIn != null || targetMsg.meterUsage != null) && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mb={2}>
							{targetMsg.tokensIn != null
								? `↑ ${(targetMsg.tokensIn as number).toLocaleString()}`
								: `${(targetMsg.meterUsage as number).toFixed(2)} credits`}
						</Text>
					)}
				<MessageBubble
					narratorId={narratorId}
					message={displayMsg}
					onForkFromMessage={onForkFromMessage}
					resolvePerm={
						resolvePerm ??
						((tc) =>
							resolvePendingPerm(
								tc,
								permCb.pendingPermission,
								permCb.pendingPermsMap,
								permCb.overseerReviewMap,
							))
					}
					onPermissionDecision={permCb.onPermissionDecision}
					onQuestionSubmit={permCb.onQuestionSubmit}
					onQuestionDeny={permCb.onQuestionDeny}
					onCompactBeforeMessage={onCompactBeforeMessage}
					onDeleteBlock={onDeleteBlock}
					onRegenerateFromMessage={onRegenerateFromMessage}
					onEditAndRegenerate={onEditAndRegenerate}
					isLastUserMessage={targetMsg.id === lastUserMessageId}
					hasChapter={hasChapter}
				/>
				{showTokenUsage &&
					(targetMsg.turnUsageJson != null ||
						(targetMsg.meterUsage != null && targetMsg.tokensIn == null)) && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mt={2}>
							{targetMsg.turnUsageJson != null ? (
								<>
									Σ{" "}
									{(
										(targetMsg.turnUsageJson as Record<string, number>).input_tokens ?? 0
									).toLocaleString()}{" "}
									in ·{" "}
									{(
										(targetMsg.turnUsageJson as Record<string, number>).output_tokens ?? 0
									).toLocaleString()}{" "}
									out
									{targetMsg.costUsd != null &&
										(targetMsg.costUsd as number) > 0 &&
										` · $${(targetMsg.costUsd as number).toFixed(4)}`}
								</>
							) : (
								`${(targetMsg.meterUsage as number).toFixed(2)} credits`
							)}
						</Text>
					)}
			</Box>
		);
		const userAnimationId =
			targetMsg.role === "user" ? getUserMessageBlurAnimationId(targetMsg.id) : null;
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
			editExpandOverride,
			onForkFromMessage,
			onCompactBeforeMessage,
			onDeleteBlock,
			onViewSubagentSession,
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
