import { Box, Divider, Group, Paper, Text, ThemeIcon } from "@mantine/core";
import { IconBrain } from "@tabler/icons-react";
import { memo } from "react";
import { BlurInOnAppear } from "./BlurInOnAppear";
import {
	getReasoningBlurAnimationId,
	getToolCallBlurAnimationId,
	getUserMessageBlurAnimationId,
} from "./blur-in-ids";
import { ContentViewer } from "./ContentViewer";
import { MessageBubble, ReasoningSummary } from "./MessageBubble";
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
	NarratorMsg,
	PermissionCallbacks,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import { SubagentCard } from "./SubagentCard";
import type { ToolCallData } from "./ToolCallCard";
import { getCategoryColor, TOOL_CARD_BG, ToolCallCard } from "./ToolCallCard";

// ---------------------------------------------------------------------------
// renderToolRun — renders a group of tool-bearing messages
// ---------------------------------------------------------------------------

export interface RenderToolRunOptions {
	expandedToolUseId?: string | null;
	highlightedId?: string | null;
	editExpandOverride?: boolean | null;
	onForkFromMessage?: (uuid: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	/** Extra styles applied to the outer tool-run container (used for visual merging). */
	containerStyle?: React.CSSProperties;
	/** Extra className applied to the outer tool-run container. */
	containerClassName?: string;
	/** Additional messages whose tool items are appended after the main run's items.
	 *  Used to visually merge streaming tool chunks into an existing tool run. */
	appendMessages?: NarratorMsg[];
}

export type RenderedTreeElementMeta =
	| { kind: "regular" }
	| { kind: "decorative" }
	| { kind: "tool-run"; run: NarratorMsg[] };

export function renderToolRun(
	run: NarratorMsg[],
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
		containerStyle,
		containerClassName,
		appendMessages,
	} = opts;
	const matchPermission = (tc: ToolCallData) =>
		resolvePendingPerm(
			tc,
			permCb.pendingPermission,
			permCb.pendingPermsMap,
			permCb.overseerReviewMap,
		);
	const items = flattenToolRun(run);
	if (appendMessages?.length) {
		items.push(...flattenToolRun(appendMessages));
	}
	if (items.length === 0) return null;

	const taskCount = items.filter((it) => it.kind === "tool" && it.isSubagent).length;
	const soleSubagent = taskCount === 1;
	const wrapWithBlur = (animationId: string | null, node: React.ReactNode) =>
		animationId ? <BlurInOnAppear animationId={animationId}>{node}</BlurInOnAppear> : node;

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
		if (msgId && onDeleteBlock) {
			ctxActions.onDeleteBlock = (blockIndex: number) => onDeleteBlock(msgId, blockIndex);
		}

		if (item.kind === "reasoning") {
			const iconColor = getCategoryColor("plan");
			const reasoningAnimationId = getReasoningBlurAnimationId({
				messageId: item.msg.id,
				blockIndex: item.blockIndex,
				createdAt: item.msg.createdAt,
				fallbackKey: idx,
			});
			const header = (
				<Group gap={5} wrap="nowrap" align="flex-start">
					<ThemeIcon size={16} variant="light" color={iconColor} radius="sm" mt={1}>
						<IconBrain size={10} />
					</ThemeIcon>
					<ReasoningSummary text={item.reasoningText} translatedText={item.translatedText} />
				</Group>
			);
			return (
				<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
					{wrapWithBlur(
						reasoningAnimationId,
						<div id={`msg-${item.msg.id}`} style={hlStyle}>
							<ContentViewer
								content={item.reasoningText}
								markdown
								contentType="markdown"
								blockIndex={item.blockIndex}
							>
								{total >= 2 ? (
									<>
										<Box p="xs">{header}</Box>
										{idx !== total - 1 && (
											<Divider color="var(--mantine-color-default-border)" size={1} />
										)}
									</>
								) : (
									<Paper withBorder radius="sm" p="xs" style={{ backgroundColor: TOOL_CARD_BG }}>
										{header}
									</Paper>
								)}
							</ContentViewer>
						</div>,
					)}
				</MessageContextMenuCtx.Provider>
			);
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

	if (items.length >= 2) {
		return (
			<Box
				key={`tool-run-${run[0].id}`}
				data-tool-run
				className={containerClassName}
				style={{
					border: "1px solid var(--mantine-color-default-border)",
					borderRadius: "var(--mantine-radius-sm)",
					overflow: "hidden",
					backgroundColor: TOOL_CARD_BG,
					...containerStyle,
				}}
			>
				{items.map((item, idx) => renderItem(item, idx, items.length))}
			</Box>
		);
	}

	return (
		<div
			key={`tool-run-${run[0].id}`}
			data-tool-run
			className={containerClassName}
			style={containerStyle}
		>
			{renderItem(items[0], 0, 1)}
		</div>
	);
}

export function hasReasoningBlock(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "reasoning" && !!b.text?.trim());
}

function hasVisibleBlocks(blocks: ContentBlock[]) {
	return blocks.some((b: ContentBlock) => {
		if (b.type === "text") return !!b.text?.trim();
		if (b.type === "image") return true;
		if (b.type === "text_file") return true;
		if (b.type === "reasoning") return !!b.text?.trim();
		if (b.type === "web_search") return true;
		if (b.type === "thinking") {
			const thinking = (b as { thinking?: string }).thinking;
			return typeof thinking === "string" ? thinking.trim().length > 0 : true;
		}
		return false;
	});
}

function collectRunTargetIds(
	run: NarratorMsg[],
	excludedMessageIds: ReadonlySet<string> = new Set<string>(),
): string[] {
	const ids = new Set<string>();
	const visit = (msg: NarratorMsg) => {
		if (msg.id && !excludedMessageIds.has(msg.id)) {
			ids.add(msg.id);
		}
		for (const tc of (msg.toolCalls as Array<{ toolUseId?: string | null }> | undefined) ?? []) {
			if (tc.toolUseId) ids.add(tc.toolUseId);
		}
		for (const block of Array.isArray(msg.contentJson) ? msg.contentJson : []) {
			if (block.type === "tool_use" && typeof block.id === "string" && block.id.length > 0) {
				ids.add(block.id);
			}
		}
		for (const child of msg.children ?? []) {
			visit(child);
		}
	};
	for (const msg of run) {
		visit(msg);
	}
	return [...ids];
}

function collectRenderedTargetIds(
	messages: NarratorMsg[],
	pruneBoundaryMessageId?: string | null,
): string[][] {
	const targets: string[][] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

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
			let renderedLeading = false;
			if (!toolOnly) {
				const reasoningEntries: { block: ContentBlock; origIdx: number }[] = [];
				const otherEntries: { block: ContentBlock; origIdx: number }[] = [];
				blocks.forEach((b: ContentBlock, idx: number) => {
					if (b.type === "reasoning" && !!b.text?.trim()) {
						reasoningEntries.push({ block: b, origIdx: idx });
					} else if (b.type !== "tool_use") {
						otherEntries.push({ block: b, origIdx: idx });
					}
				});
				const leadingBlocks = [...reasoningEntries, ...otherEntries].map((entry) => entry.block);
				if (hasVisibleBlocks(leadingBlocks)) {
					renderedLeading = true;
					targets.push(msg.id ? [msg.id] : []);
				}
			}

			const run: NarratorMsg[] = [msg];
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

			if (j < messages.length) {
				const tailMsg = messages[j];
				const tailHasTool = hasToolUse(tailMsg);
				const tailHasReasoning = hasReasoningBlock(tailMsg);
				const tailToolOnly = isToolOnlyMessage(tailMsg);
				if (!tailHasTool && tailHasReasoning && !tailToolOnly && !tailMsg._noMerge) {
					const tailBlocks = Array.isArray(tailMsg.contentJson) ? tailMsg.contentJson : [];
					const tailReasoningEntries: { block: ContentBlock; origIdx: number }[] = [];
					const tailContentEntries: { block: ContentBlock; origIdx: number }[] = [];
					tailBlocks.forEach((b: ContentBlock, idx: number) => {
						if (b.type === "reasoning" && !!b.text?.trim()) {
							tailReasoningEntries.push({ block: b, origIdx: idx });
						} else if (b.type !== "tool_use") {
							tailContentEntries.push({ block: b, origIdx: idx });
						}
					});
					if (tailReasoningEntries.length > 0) {
						run.push(tailMsg);
					}
					const tailContentBlocks = tailContentEntries.map((entry) => entry.block);
					if (hasVisibleBlocks(tailContentBlocks)) {
						trailingContentMsg = tailMsg;
					}
					j++;
				}
			}

			const excludedTargetIds = new Set<string>();
			if (renderedLeading && msg.id) {
				excludedTargetIds.add(msg.id);
			}
			if (trailingContentMsg?.id) {
				excludedTargetIds.add(trailingContentMsg.id);
			}
			targets.push(collectRunTargetIds(run, excludedTargetIds));

			if (
				pruneBoundaryMessageId &&
				run.some((item) => item.id === pruneBoundaryMessageId) &&
				!(trailingContentMsg && trailingContentMsg.id === pruneBoundaryMessageId)
			) {
				targets.push([]);
			}

			if (trailingContentMsg) {
				targets.push(trailingContentMsg.id ? [trailingContentMsg.id] : []);
				if (pruneBoundaryMessageId && trailingContentMsg.id === pruneBoundaryMessageId) {
					targets.push([]);
				}
			}

			i = j;
			continue;
		}

		targets.push(msg.id ? [msg.id] : []);
		if (pruneBoundaryMessageId && msg.id === pruneBoundaryMessageId) {
			targets.push([]);
		}
		i++;
	}

	return targets;
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
	pruneBoundaryMessageId?: string | null,
	pruneDividerLabel?: string,
	onCompactBeforeMessage?: (messageId: string) => void,
	onDeleteBlock?: (messageId: string, blockIndex: number) => void,
	onRegenerateFromMessage?: (messageId: string) => void,
	onEditAndRegenerate?: (messageId: string, newContent: string, rollback: boolean) => void,
	lastUserMessageId?: string,
	hasChapter?: boolean,
): { elements: React.ReactNode[]; meta: RenderedTreeElementMeta[] } {
	// Messages are already tree-structured from the backend (children nested).
	// Group consecutive assistant messages with tool_use blocks into visual "runs".
	// A message with text + tool_use renders its text first, then its tool calls
	// merge forward with subsequent tool-bearing messages.
	const elements: React.ReactNode[] = [];
	const meta: RenderedTreeElementMeta[] = [];
	let i = 0;

	const renderRegularMessage = (
		targetMsg: NarratorMsg,
		key: string,
		domId = `msg-${targetMsg.id}`,
		highlight = true,
	) => {
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
					message={targetMsg}
					onForkFromMessage={onForkFromMessage}
					resolvePerm={(tc) =>
						resolvePendingPerm(
							tc,
							permCb.pendingPermission,
							permCb.pendingPermsMap,
							permCb.overseerReviewMap,
						)
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
				const reasoningEntries: { block: ContentBlock; origIdx: number }[] = [];
				const otherEntries: { block: ContentBlock; origIdx: number }[] = [];
				blocks.forEach((b: ContentBlock, idx: number) => {
					if (b.type === "reasoning" && !!b.text?.trim()) {
						reasoningEntries.push({ block: b, origIdx: idx });
					} else if (b.type !== "tool_use") {
						otherEntries.push({ block: b, origIdx: idx });
					}
				});
				const leadingEntries = [...reasoningEntries, ...otherEntries];
				const leadingBlocks = leadingEntries.map((e) => e.block);
				const leadingOriginalIndices = leadingEntries.map((e) => e.origIdx);
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
									_blockOriginalIndices: leadingOriginalIndices,
								}}
								onForkFromMessage={onForkFromMessage}
								resolvePerm={(tc) =>
									resolvePendingPerm(
										tc,
										permCb.pendingPermission,
										permCb.pendingPermsMap,
										permCb.overseerReviewMap,
									)
								}
								onPermissionDecision={permCb.onPermissionDecision}
								onQuestionSubmit={permCb.onQuestionSubmit}
								onQuestionDeny={permCb.onQuestionDeny}
								onCompactBeforeMessage={onCompactBeforeMessage}
								onDeleteBlock={onDeleteBlock}
								onRegenerateFromMessage={onRegenerateFromMessage}
								onEditAndRegenerate={onEditAndRegenerate}
								isLastUserMessage={msg.id === lastUserMessageId}
								hasChapter={hasChapter}
							/>
						</Box>,
					);
					meta.push({ kind: "regular" });
				}
			}

			// Collect this message and subsequent tool-bearing messages into a run.
			// Respect _noMerge flag on synthetic streaming messages — when the model
			// emitted text before these tool chunks, they should render separately.
			const runStartMsg: NarratorMsg =
				!toolOnly && hasTool
					? (() => {
							const toolEntries: { block: ContentBlock; origIdx: number }[] = [];
							blocks.forEach((b: ContentBlock, idx: number) => {
								if (b.type === "tool_use") toolEntries.push({ block: b, origIdx: idx });
							});
							return {
								...msg,
								contentJson: toolEntries.map((e) => e.block),
								_blockOriginalIndices: toolEntries.map((e) => e.origIdx),
							};
						})()
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
					const tailReasoningEntries: { block: ContentBlock; origIdx: number }[] = [];
					const tailContentEntries: { block: ContentBlock; origIdx: number }[] = [];
					tailBlocks.forEach((b: ContentBlock, idx: number) => {
						if (b.type === "reasoning" && !!b.text?.trim()) {
							tailReasoningEntries.push({ block: b, origIdx: idx });
						} else if (b.type !== "tool_use") {
							tailContentEntries.push({ block: b, origIdx: idx });
						}
					});
					if (tailReasoningEntries.length > 0) {
						run.push({
							...tailMsg,
							contentJson: tailReasoningEntries.map((e) => e.block),
							toolCalls: [],
							_blockOriginalIndices: tailReasoningEntries.map((e) => e.origIdx),
						});
					}
					const tailContentBlocks = tailContentEntries.map((e) => e.block);
					if (hasVisibleBlocks(tailContentBlocks)) {
						trailingContentMsg = {
							...tailMsg,
							contentJson: tailContentBlocks,
							toolCalls: [],
							_blockOriginalIndices: tailContentEntries.map((e) => e.origIdx),
						};
					}
					j++;
				}
			}

			const el = renderToolRun(run, narratorId, permCb, {
				expandedToolUseId,
				highlightedId,
				editExpandOverride,
				onForkFromMessage,
				onCompactBeforeMessage,
				onDeleteBlock,
			});

			if (el) {
				elements.push(el);
				meta.push({ kind: "tool-run", run });
			}

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
				meta.push({ kind: "decorative" });
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
				meta.push({ kind: "regular" });
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
					meta.push({ kind: "decorative" });
				}
			}

			i = j;
			continue;
		}

		elements.push(renderRegularMessage(msg, msg.id));
		meta.push({ kind: "regular" });

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
			meta.push({ kind: "decorative" });
		}

		i++;
	}

	return { elements, meta };
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
	const { elements, meta } = renderTreeMessages(...args);
	const keys: string[] = [];
	for (const el of elements) {
		// Extract the React key from each element
		if (el != null && typeof el === "object" && "key" in (el as React.ReactElement)) {
			keys.push(String((el as React.ReactElement).key ?? keys.length));
		} else {
			keys.push(String(keys.length));
		}
	}
	const [messages, , , , , , , , pruneBoundaryMessageId] = args;
	const targets = collectRenderedTargetIds(messages, pruneBoundaryMessageId);
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

// ---------------------------------------------------------------------------
// StreamingBubble — isolated component to avoid re-rendering the entire panel
// ---------------------------------------------------------------------------

export const StreamingBubble = memo(
	function StreamingBubble({
		narratorId,
		streamingRef,
		streamingReasoningRef,
		includeReasoning,
		webSearchRef,
		version,
	}: {
		narratorId: string;
		streamingRef: React.RefObject<string>;
		streamingReasoningRef?: React.RefObject<string>;
		includeReasoning?: boolean;
		webSearchRef?: React.RefObject<{
			id: string;
			status: "in_progress" | "searching" | "completed";
			query?: string;
		} | null>;
		version: number;
	}) {
		// Read ref directly during render — version change triggers re-render
		// which picks up the latest accumulated text without an extra useEffect cycle.
		void version;
		const text = streamingRef.current;
		const reasoning = includeReasoning ? streamingReasoningRef?.current : undefined;
		const webSearch = webSearchRef?.current;
		if (!text && !reasoning && !webSearch) return null;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic block shapes
		const blocks: any[] = [];
		if (webSearch) {
			blocks.push({
				type: "web_search",
				id: webSearch.id,
				status: webSearch.status,
				query: webSearch.query,
			});
		}
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
	(prev, next) =>
		prev.version === next.version &&
		prev.includeReasoning === next.includeReasoning &&
		prev.narratorId === next.narratorId,
);
