import { Box, Divider, Group, Paper, Text, ThemeIcon } from "@mantine/core";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageBubble } from "./MessageBubble";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "./MessageContextMenuCtx";
import {
	flattenToolRun,
	hasToolUse,
	isToolOnlyMessage,
	resolvePendingPerm,
} from "./narrator-message-helpers";
import type {
	ContentBlock,
	FlatToolItem,
	MessagesPage,
	NarratorMsg,
	PermissionCallbacks,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import { SubagentCard } from "./SubagentCard";
import type { ToolCallData } from "./ToolCallCard";
import {
	getCategoryColor,
	getCategoryIcon,
	STATUS_COLORS,
	StatusIcon,
	ToolCallCard,
} from "./ToolCallCard";

const singleLineMdComponents: Components = {
	p: ({ children }) => <>{children}</>,
	h1: ({ children }) => <>{children}</>,
	h2: ({ children }) => <>{children}</>,
	h3: ({ children }) => <>{children}</>,
	h4: ({ children }) => <>{children}</>,
	h5: ({ children }) => <>{children}</>,
	h6: ({ children }) => <>{children}</>,
	ul: ({ children }) => <>{children}</>,
	ol: ({ children }) => <>{children}</>,
	li: ({ children }) => <>{children}</>,
	blockquote: ({ children }) => <>{children}</>,
	code: ({ children }) => <>{children}</>,
	pre: ({ children }) => <>{children}</>,
	a: ({ children }) => <>{children}</>,
	strong: ({ children }) => (
		<Text span fw={700} size="xs">
			{children}
		</Text>
	),
	em: ({ children }) => (
		<Text span fs="italic" size="xs">
			{children}
		</Text>
	),
};

// ---------------------------------------------------------------------------
// renderToolRun — renders a group of tool-bearing messages
// ---------------------------------------------------------------------------

export function renderToolRun(
	run: NarratorMsg[],
	narratorId: string,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
	highlightedId?: string | null,
	editExpandOverride?: boolean | null,
	onForkFromMessage?: (uuid: string) => void,
	onDeleteMessage?: (messageId: string) => void,
	onCompactBeforeMessage?: (messageId: string) => void,
	reasoningLabel = "Reasoning",
) {
	const matchPermission = (tc: ToolCallData) =>
		resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap);
	const items = flattenToolRun(run);
	if (items.length === 0) return null;

	const taskCount = items.filter((it) => it.kind === "tool" && it.isSubagent).length;
	const soleSubagent = taskCount === 1;

	const renderItem = (item: FlatToolItem, idx: number, total: number) => {
		const key =
			item.kind === "tool"
				? (item.tc.toolUseId ?? `${item.msg.id}-${idx}`)
				: `reasoning-${item.msg.id}-${idx}`;
		const hlStyle =
			highlightedId === item.msg.id
				? {
						animation: "highlight-blink 1.5s ease",
						borderRadius: "var(--mantine-radius-sm)",
					}
				: undefined;

		// Build context menu actions for this item's parent message
		const ctxActions: MessageContextMenuActions = {};
		const msgUuid = item.msg.messageUuid;
		const msgId = item.msg.id;
		if (msgUuid && onForkFromMessage) {
			ctxActions.onForkFromMessage = () => onForkFromMessage(msgUuid);
		}
		if (msgId && onCompactBeforeMessage) {
			ctxActions.onCompactBeforeMessage = () => onCompactBeforeMessage(msgId);
		}
		if (msgId && onDeleteMessage) {
			ctxActions.onDeleteMessage = () => onDeleteMessage(msgId);
		}

		if (item.kind === "reasoning") {
			const iconColor = getCategoryColor("plan");
			const Icon = getCategoryIcon("plan");
			const statusColor = STATUS_COLORS.success ?? "green";
			const summary = item.reasoningText.trim().replace(/\s+/g, " ");
			const header = (
				<Group gap={6} wrap="nowrap">
					<ThemeIcon size={18} variant="light" color={iconColor} radius="sm">
						<Icon size={12} />
					</ThemeIcon>
					<Text size="xs" fw={600} c="dimmed" style={{ flexShrink: 0 }}>
						{reasoningLabel}
					</Text>
					<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }} title={summary}>
						<Markdown remarkPlugins={[remarkGfm]} components={singleLineMdComponents}>
							{summary}
						</Markdown>
					</Text>
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						<Box c={statusColor}>
							<StatusIcon status="success" />
						</Box>
					</Group>
				</Group>
			);
			return (
				<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
					<div id={`msg-${item.msg.id}`} style={hlStyle}>
						{total >= 2 ? (
							<Box p="xs">{header}</Box>
						) : (
							<Box p="xs">
								<Paper withBorder radius="sm" p="xs">
									{header}
								</Paper>
							</Box>
						)}
						{total >= 2 && idx !== total - 1 && <Divider />}
					</div>
				</MessageContextMenuCtx.Provider>
			);
		}

		if (item.isSubagent) {
			return (
				<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
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
						/>
					</div>
				</MessageContextMenuCtx.Provider>
			);
		}
		return (
			<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
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
					/>
				</div>
			</MessageContextMenuCtx.Provider>
		);
	};

	if (items.length >= 2) {
		return (
			<Box
				key={`tool-run-${run[0].id}`}
				style={{
					border: "1px solid var(--mantine-color-default-border)",
					borderRadius: "var(--mantine-radius-sm)",
					overflow: "hidden",
				}}
			>
				{items.map((item, idx) => renderItem(item, idx, items.length))}
			</Box>
		);
	}

	return renderItem(items[0], 0, 1);
}

function hasReasoningBlock(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "reasoning" && !!b.text?.trim());
}

// ---------------------------------------------------------------------------
// renderTreeMessages — renders a flat message list, grouping tool runs
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
	onDeleteMessage?: (messageId: string) => void,
	pruneBoundaryMessageId?: string | null,
	pruneDividerLabel?: string,
	onCompactBeforeMessage?: (messageId: string) => void,
	reasoningLabel?: string,
): { elements: React.ReactNode[] } {
	// Messages are already tree-structured from the backend (children nested).
	// Group consecutive assistant messages with tool_use blocks into visual "runs".
	// A message with text + tool_use renders its text first, then its tool calls
	// merge forward with subsequent tool-bearing messages.
	const elements: React.ReactNode[] = [];
	let i = 0;

	const hasVisibleBlocks = (blocks: ContentBlock[]) =>
		blocks.some((b: ContentBlock) => {
			if (b.type === "text") return !!b.text?.trim();
			if (b.type === "image") return true;
			if (b.type === "reasoning") return !!b.text?.trim();
			if (b.type === "thinking") {
				const thinking = (b as { thinking?: string }).thinking;
				return typeof thinking === "string" ? thinking.trim().length > 0 : true;
			}
			return false;
		});

	const renderRegularMessage = (
		targetMsg: NarratorMsg,
		key: string,
		domId = `msg-${targetMsg.id}`,
		highlight = true,
	) => (
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
				message={targetMsg}
				onForkFromMessage={onForkFromMessage}
				resolvePerm={(tc) =>
					resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap)
				}
				onPermissionDecision={permCb.onPermissionDecision}
				onQuestionSubmit={permCb.onQuestionSubmit}
				onQuestionDeny={permCb.onQuestionDeny}
				onCompactBeforeMessage={onCompactBeforeMessage}
				onDeleteMessage={onDeleteMessage}
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

	while (i < messages.length) {
		const msg = messages[i];

		// Skip deferred streaming chunks — they are rendered after the StreamingBubble
		if (msg._noMerge && msg.id === STREAMING_CHUNKS_MSG_ID) {
			i++;
			continue;
		}

		const hasTool = hasToolUse(msg);
		const hasReasoning = hasReasoningBlock(msg);
		const toolOnly = isToolOnlyMessage(msg);
		const shouldRenderToolRun = hasTool || (hasReasoning && toolOnly);

		if (shouldRenderToolRun) {
			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			// For mixed messages, render reasoning + text/image first so the order becomes:
			// reasoning → text/image → tool calls.
			if (!toolOnly) {
				const reasoningBlocks = blocks.filter(
					(b: ContentBlock) => b.type === "reasoning" && !!b.text?.trim(),
				);
				const otherBlocks = blocks.filter(
					(b: ContentBlock) => b.type !== "tool_use" && b.type !== "reasoning",
				);
				const leadingBlocks = [...reasoningBlocks, ...otherBlocks];
				if (hasVisibleBlocks(leadingBlocks)) {
					elements.push(
						<Box
							key={`${msg.id}-leading`}
							id={`msg-${msg.id}`}
							style={{
								borderRadius: "var(--mantine-radius-md)",
								animation: highlightedId === msg.id ? "highlight-blink 1.5s ease" : undefined,
							}}
						>
							{showTokenUsage && (msg.tokensIn != null || msg.meterUsage != null) && (
								<Text size="xs" c="dimmed" ta="right" pr="sm" mb={2}>
									{msg.tokensIn != null
										? `↑ ${(msg.tokensIn as number).toLocaleString()}`
										: `${(msg.meterUsage as number).toFixed(2)} credits`}
								</Text>
							)}
							<MessageBubble
								narratorId={narratorId}
								message={{
									...msg,
									contentJson: leadingBlocks,
									toolCalls: [],
								}}
								onForkFromMessage={onForkFromMessage}
								resolvePerm={(tc) =>
									resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap)
								}
								onPermissionDecision={permCb.onPermissionDecision}
								onQuestionSubmit={permCb.onQuestionSubmit}
								onQuestionDeny={permCb.onQuestionDeny}
								onCompactBeforeMessage={onCompactBeforeMessage}
								onDeleteMessage={onDeleteMessage}
							/>
						</Box>,
					);
				}
			}

			// Collect this message and subsequent tool-bearing messages into a run.
			// Respect _noMerge flag on synthetic streaming messages — when the model
			// emitted text before these tool chunks, they should render separately.
			const runStartMsg: NarratorMsg =
				!toolOnly && hasTool
					? {
							...msg,
							contentJson: blocks.filter((b: ContentBlock) => b.type === "tool_use"),
						}
					: msg;
			const run: NarratorMsg[] = [runStartMsg];
			let trailingContentMsg: NarratorMsg | null = null;
			let j = i + 1;
			while (
				j < messages.length &&
				(hasToolUse(messages[j]) || hasReasoningBlock(messages[j])) &&
				isToolOnlyMessage(messages[j]) &&
				!messages[j]._noMerge
			) {
				run.push(messages[j]);
				j++;
			}

			// If the immediate next assistant message is reasoning + visible content (no tool_use),
			// attach its reasoning into the current run, and render only its non-reasoning content
			// as a normal message below. This keeps reasoning visually glued to the prior tool run.
			if (j < messages.length) {
				const tailMsg = messages[j];
				const tailHasTool = hasToolUse(tailMsg);
				const tailHasReasoning = hasReasoningBlock(tailMsg);
				const tailToolOnly = isToolOnlyMessage(tailMsg);
				if (!tailHasTool && tailHasReasoning && !tailToolOnly && !tailMsg._noMerge) {
					const tailBlocks = Array.isArray(tailMsg.contentJson) ? tailMsg.contentJson : [];
					const tailReasoningBlocks = tailBlocks.filter(
						(b: ContentBlock) => b.type === "reasoning" && !!b.text?.trim(),
					);
					if (tailReasoningBlocks.length > 0) {
						run.push({ ...tailMsg, contentJson: tailReasoningBlocks, toolCalls: [] });
					}
					const tailContentBlocks = tailBlocks.filter(
						(b: ContentBlock) => b.type !== "reasoning" && b.type !== "tool_use",
					);
					if (hasVisibleBlocks(tailContentBlocks)) {
						trailingContentMsg = {
							...tailMsg,
							contentJson: tailContentBlocks,
							toolCalls: [],
						};
					}
					j++;
				}
			}

			const el = renderToolRun(
				run,
				narratorId,
				permCb,
				expandedToolUseId,
				highlightedId,
				editExpandOverride,
				onForkFromMessage,
				onDeleteMessage,
				onCompactBeforeMessage,
				reasoningLabel,
			);

			if (el) elements.push(el);

			// Insert prune divider if any message in this run is the boundary, unless
			// the boundary is the attached tail message and we're about to render its content.
			if (
				pruneBoundaryMessageId &&
				run.some((m) => m.id === pruneBoundaryMessageId) &&
				!(trailingContentMsg && trailingContentMsg.id === pruneBoundaryMessageId)
			) {
				elements.push(
					<Divider
						key="prune-boundary"
						my="xs"
						label={pruneDividerLabel}
						labelPosition="center"
						color="yellow.7"
						styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
					/>,
				);
			}

			if (trailingContentMsg) {
				elements.push(
					renderRegularMessage(
						trailingContentMsg,
						`${trailingContentMsg.id}-tail-content`,
						`msg-${trailingContentMsg.id}-content`,
						false,
					),
				);
				if (pruneBoundaryMessageId && trailingContentMsg.id === pruneBoundaryMessageId) {
					elements.push(
						<Divider
							key="prune-boundary"
							my="xs"
							label={pruneDividerLabel}
							labelPosition="center"
							color="yellow.7"
							styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
						/>,
					);
				}
			}

			i = j;
			continue;
		}

		elements.push(renderRegularMessage(msg, msg.id));

		// Insert prune divider after the boundary message
		if (pruneBoundaryMessageId && msg.id === pruneBoundaryMessageId) {
			elements.push(
				<Divider
					key="prune-boundary"
					my="xs"
					label={pruneDividerLabel}
					labelPosition="center"
					color="yellow.7"
					styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
				/>,
			);
		}

		i++;
	}

	return { elements };
}

// ---------------------------------------------------------------------------
// MemoizedPageElements — per-page memoized rendering
// ---------------------------------------------------------------------------

interface PageElementsProps {
	page: MessagesPage;
	narratorId: string;
	onForkFromMessage: ((uuid: string) => void) | undefined;
	highlightedId: string | null;
	permCb: PermissionCallbacks;
	expandedToolUseId?: string | null;
	editExpandOverride?: boolean | null;
	showTokenUsage?: boolean;
	/** When set, only render the last N messages of this page (for progressive rendering). */
	maxMessages?: number;
	onDeleteMessage?: (messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	pruneBoundaryMessageId?: string | null;
}

export const MemoizedPageElements = memo(
	function PageElements({
		page,
		narratorId,
		onForkFromMessage,
		highlightedId,
		permCb,
		expandedToolUseId,
		editExpandOverride,
		showTokenUsage,
		maxMessages,
		onDeleteMessage,
		onCompactBeforeMessage,
		pruneBoundaryMessageId,
	}: PageElementsProps) {
		const msgs =
			maxMessages != null && maxMessages < page.messages.length
				? page.messages.slice(page.messages.length - maxMessages)
				: page.messages;
		const { t } = useTranslation("narrator");
		const { elements } = renderTreeMessages(
			msgs,
			narratorId,
			onForkFromMessage,
			highlightedId,
			permCb,
			expandedToolUseId,
			editExpandOverride,
			showTokenUsage,
			onDeleteMessage,
			pruneBoundaryMessageId,
			t("pruneBoundaryLabel"),
			onCompactBeforeMessage,
			t("reasoning"),
		);
		return <>{elements}</>;
	},
	(prev, next) =>
		prev.page === next.page &&
		prev.narratorId === next.narratorId &&
		prev.onForkFromMessage === next.onForkFromMessage &&
		prev.permCb.pendingPermsMap === next.permCb.pendingPermsMap &&
		prev.permCb.bgRetryDismissedIds === next.permCb.bgRetryDismissedIds &&
		prev.expandedToolUseId === next.expandedToolUseId &&
		prev.editExpandOverride === next.editExpandOverride &&
		prev.showTokenUsage === next.showTokenUsage &&
		prev.maxMessages === next.maxMessages &&
		prev.pruneBoundaryMessageId === next.pruneBoundaryMessageId,
);

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

// ---------------------------------------------------------------------------
// StreamingBubble — isolated component to avoid re-rendering the entire panel
// ---------------------------------------------------------------------------

export const StreamingBubble = memo(
	function StreamingBubble({
		narratorId,
		streamingRef,
		streamingReasoningRef,
		version,
	}: {
		narratorId: string;
		streamingRef: React.RefObject<string>;
		streamingReasoningRef?: React.RefObject<string>;
		version: number;
	}) {
		// Read ref directly during render — version change triggers re-render
		// which picks up the latest accumulated text without an extra useEffect cycle.
		void version;
		const text = streamingRef.current;
		const reasoning = streamingReasoningRef?.current;
		if (!text && !reasoning) return null;
		const blocks: { type: string; text?: string; reasoning?: string }[] = [];
		if (reasoning) blocks.push({ type: "reasoning", text: reasoning });
		if (text) blocks.push({ type: "text", text });
		return (
			<MessageBubble
				narratorId={narratorId}
				message={{
					role: "assistant",
					contentJson: blocks,
				}}
			/>
		);
	},
	(prev, next) => prev.version === next.version,
);
