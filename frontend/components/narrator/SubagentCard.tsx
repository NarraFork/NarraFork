import {
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Menu,
	Paper,
	Text,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconAlertTriangle,
	IconArrowsMinimize,
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconMessageQuestion,
	IconRobot,
	IconTrash,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useToolCallDetail } from "../../hooks/useNarrator";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { BlurInOnAppear } from "./BlurInOnAppear";
import { getToolCallBlurAnimationId } from "./blur-in-ids";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import { ReasoningBlock } from "./MessageBubble";
import {
	type MessageContextMenuActions,
	MessageContextMenuCtx,
	useMessageContextMenu,
} from "./MessageContextMenuCtx";
import { BLOCK_ID_ATTR, NestedBlockCtx, useMessageSelection } from "./MessageSelectionCtx";
import {
	filterChildrenByToolUse,
	hasToolUse,
	resolveAllToolCallsFromMsg,
	resolvePendingPerm,
} from "./narrator-message-helpers";
import type { ContentBlock, NarratorMsg, PermissionCallbacks } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";
import {
	ElapsedTimer,
	InlinePermission,
	STATUS_COLORS,
	StatusIcon,
	ToolCallCard,
} from "./ToolCallCard";
import { useNearestScrollContainerHeight } from "./useNearestScrollContainerHeight";

const SUBAGENT_ID_RE = /<subagent_id>[^<]*<\/subagent_id>/g;
const stripSubagentId = (text: string) => text.replace(SUBAGENT_ID_RE, "").trim();

/**
 * Extract the _text value from a truncated JSON preview string.
 * The preview may look like: `{"_text":"actual content here...` (cut mid-string).
 * Falls back to the raw preview if _text is not found.
 */
function extractTextFromPreview(preview: string): string {
	// Try complete _text value first
	const complete = preview.match(/"_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (complete) {
		try {
			return JSON.parse(`"${complete[1]}"`);
		} catch {
			return complete[1];
		}
	}
	// Try truncated _text value (no closing quote — preview was cut mid-value)
	const truncated = preview.match(/"_text"\s*:\s*"((?:[^"\\]|\\.)*)/);
	if (truncated) {
		try {
			return JSON.parse(`"${truncated[1]}"`);
		} catch {
			return truncated[1];
		}
	}
	return preview;
}

/**
 * Parse outputJson into a displayable raw string.
 * Handles: plain string, truncated preview, content block array,
 * structured { _text, _metadata }, and generic object fallback.
 */
// biome-ignore lint/suspicious/noExplicitAny: outputJson is untyped
function parseOutputJson(out: any): string {
	if (!out) return "";
	if (typeof out === "string") return out;
	if (out._truncated && typeof out.preview === "string") {
		return extractTextFromPreview(out.preview);
	}
	if (Array.isArray(out)) {
		return out
			.filter((b: ContentBlock) => b.text)
			.map((b: ContentBlock) => b.text)
			.join("\n");
	}
	if (typeof out._text === "string") return out._text;
	if (typeof out === "object") return JSON.stringify(out, null, 2);
	return "";
}

export interface SubagentCardProps {
	toolCall: ToolCallData;
	childMessages: NarratorMsg[];
	narratorId: string;
	inRun?: boolean;
	isLast?: boolean;
	isSoleInRun?: boolean;
	permCb?: PermissionCallbacks;
	editExpandOverride?: boolean | null;
	onBgAgentRetry?: (toolUseId: string) => void;
	onViewSubagentSession?: (narratorId: string) => void;
	/** Block index within the parent message's contentJson array */
	blockIndex?: number;
}

export const SubagentCard = memo(
	function SubagentCard({
		toolCall,
		childMessages,
		narratorId,
		inRun,
		isLast,
		isSoleInRun,
		permCb,
		editExpandOverride,
		onBgAgentRetry,
		onViewSubagentSession,
		blockIndex,
	}: SubagentCardProps) {
		const { t } = useTranslation("narrator");
		const navigate = useNavigate();
		// biome-ignore lint/suspicious/noExplicitAny: loose search params
		const routeSearch = useSearch({ strict: false }) as any;
		const fromParam = routeSearch?.from as string | undefined;
		const input = toolCall.inputJson ?? {};
		const isBackground = !!input.background || !!input.run_in_background;
		const agentType = input.subagent_type ?? "agent";
		const isBuiltinType = ["explore", "plan", "general", "agent"].includes(agentType);
		const agentBadgeColor = isBuiltinType ? "indigo" : "teal";
		const isBgWarning = isBackground && !/^explore$/i.test(agentType);
		const dismissed =
			(toolCall.toolUseId && permCb?.bgRetryDismissedIds?.has(toolCall.toolUseId)) ?? false;
		const showBgWarning = isBgWarning && !dismissed && !!onBgAgentRetry;
		const isTerminal = /^(success|completed|denied|error|fail)$/.test(toolCall.status);
		const isInitializing = toolCall.status === "initializing";
		const soleAndRunning = !!isSoleInRun && !isTerminal;
		const [expanded, setExpanded] = useState(showBgWarning || !!isSoleInRun);
		const prompt = input.prompt ?? "";
		const promptHasLineBreak = prompt.includes("\n");
		const [promptFitsOneLine, setPromptFitsOneLine] = useState(false);
		const promptSummaryRef = useRef<HTMLParagraphElement | null>(null);
		const promptShownInHeader =
			!input.description && !!prompt && !promptHasLineBreak && promptFitsOneLine;
		const description =
			input.description ??
			(promptShownInHeader ? prompt : input.prompt?.slice(0, 80)) ??
			"Subagent";
		const [showPrompt, setShowPrompt] = useState(false);
		const [showCalls, setShowCalls] = useState(soleAndRunning);
		const resolvedModel = childMessages[0]?.subagentModel ?? toolCall._resolvedModel ?? input.model;
		const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";

		// Clamp card height to 70% of the nearest scroll container (chat viewport).
		const cardRef = useRef<HTMLDivElement>(null);
		const scrollBoxRef = useRef<HTMLDivElement>(null);
		const vpHeight = useNearestScrollContainerHeight(cardRef, 0.7);
		const prevChildCount = useRef(childMessages.length);
		useEffect(() => {
			if (!prompt || promptHasLineBreak) {
				setPromptFitsOneLine(false);
				return;
			}
			const node = promptSummaryRef.current;
			if (!node) return;
			const parent = node.offsetParent as HTMLElement | null;
			if (!parent) return;
			const evaluate = () => {
				const availableWidth = Math.max(parent.clientWidth - 24, 0);
				const isSingleLine = node.scrollWidth <= availableWidth + 1;
				setPromptFitsOneLine(isSingleLine);
			};
			evaluate();
			const resizeObserver = new ResizeObserver(evaluate);
			resizeObserver.observe(parent);
			return () => resizeObserver.disconnect();
		}, [prompt, promptHasLineBreak]);
		useEffect(() => {
			const el = scrollBoxRef.current;
			if (!el) return;
			if (childMessages.length > prevChildCount.current) {
				el.scrollTop = el.scrollHeight;
			}
			prevChildCount.current = childMessages.length;
		}, [childMessages.length]);
		// Scroll to bottom after expand animation finishes (LazyCollapse ~200ms)
		useEffect(() => {
			if (!expanded) return;
			const t = setTimeout(() => {
				const el = scrollBoxRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}, 250);
			return () => clearTimeout(t);
		}, [expanded]);

		// Extract result text from outputJson
		const isTruncatedOutput = toolCall.outputJson?._truncated === true;
		const { data: fullTc } = useToolCallDetail(
			narratorId,
			toolCall.toolUseId ?? "",
			isTruncatedOutput && expanded,
		);
		const resultText = useMemo(() => {
			return stripSubagentId(parseOutputJson(toolCall.outputJson));
		}, [toolCall.outputJson]);
		const fullResultText = useMemo(() => {
			if (!fullTc?.outputJson) return undefined;
			const stripped = stripSubagentId(parseOutputJson(fullTc.outputJson));
			return stripped || undefined;
		}, [fullTc?.outputJson]);

		// Render all subagent results as markdown
		const useMarkdown = true;
		const childToolCalls: {
			tc: ToolCallData;
			toolUseId: string | null;
			msgId: string;
			childMsg: NarratorMsg;
		}[] = [];
		for (const cm of childMessages) {
			if (!hasToolUse(cm)) continue;
			for (const tc of resolveAllToolCallsFromMsg(cm)) {
				childToolCalls.push({ tc, toolUseId: tc.toolUseId ?? null, msgId: cm.id, childMsg: cm });
			}
		}

		// Collect reasoning/thinking blocks from child messages for display
		const childReasoningBlocks = useMemo(() => {
			const blocks: { block: ContentBlock; msgId: string; blockIndex: number }[] = [];
			for (const cm of childMessages) {
				if (cm.role !== "assistant") continue;
				const content = Array.isArray(cm.contentJson) ? cm.contentJson : [];
				for (let bi = 0; bi < content.length; bi++) {
					const b = content[bi];
					if (b.type === "reasoning" || b.type === "thinking") {
						blocks.push({ block: b, msgId: cm.id, blockIndex: bi });
					}
				}
			}
			return blocks;
		}, [childMessages]);

		const totalMs = toolCall.durationMs ?? 0;

		// Check if the Task tool call itself has a pending permission (e.g. custom workdir)
		const selfPerm = resolvePendingPerm(
			toolCall,
			permCb?.pendingPermission,
			permCb?.pendingPermsMap,
			permCb?.overseerReviewMap,
		);

		// Find the child tool call that has a pending permission (if any)
		const permChild =
			childToolCalls.find((c) => c.tc.status === "pending") ??
			childToolCalls.find((c) => c.tc.toolUseId && permCb?.pendingPermsMap?.has(c.tc.toolUseId)) ??
			(permCb?.pendingPermission?.toolUseId
				? childToolCalls.find((c) => c.tc.toolUseId === permCb.pendingPermission?.toolUseId)
				: null);

		// Auto-expand the subagent card AND tool calls list when a child needs permission,
		// then scroll to bottom after LazyCollapse animation finishes
		const permChildId = permChild?.toolUseId ?? null;
		useEffect(() => {
			if (permChildId) {
				setExpanded(true);
				setShowCalls(true);
				const t = setTimeout(() => {
					const el = scrollBoxRef.current;
					if (el) el.scrollTop = el.scrollHeight;
					// Notify the outer scroll container (NarratorPanel) that this card
					// expanded due to a permission request so it should follow to bottom.
					cardRef.current?.dispatchEvent(
						new CustomEvent("subagent-auto-expand", { bubbles: true }),
					);
				}, 300);
				return () => clearTimeout(t);
			}
		}, [permChildId]);

		// Auto-expand when the Task tool itself needs permission (e.g. custom workdir)
		useEffect(() => {
			if (selfPerm) {
				setExpanded(true);
				// Notify outer scroll container after Collapse animation
				const t = setTimeout(() => {
					cardRef.current?.dispatchEvent(
						new CustomEvent("subagent-auto-expand", { bubbles: true }),
					);
				}, 300);
				return () => clearTimeout(t);
			}
		}, [selfPerm]);

		// When subagent finishes: collapse tool calls list
		useEffect(() => {
			if (isTerminal) {
				setShowCalls(false);
			}
		}, [isTerminal]);

		// --- Block ID & multi-select ---
		const saBlockId = toolCall.toolUseId ? `sa-${toolCall.toolUseId}` : undefined;
		const selection = useMessageSelection();
		const isSaSelected = !!(
			saBlockId &&
			selection.selectionMode &&
			selection.selectedBlockIds.has(saBlockId)
		);
		const handleDeselectSa = useCallback(() => {
			if (saBlockId) selection.deselectBlock(saBlockId);
		}, [selection.deselectBlock, saBlockId]);

		// --- Swipe / context-menu for SubagentCard itself ---
		const parentMsgCtx = useMessageContextMenu();
		const hasCardActions = !!(
			parentMsgCtx.onDeleteBlock ||
			parentMsgCtx.onCompactBeforeMessage ||
			parentMsgCtx.onAskInPassing
		);

		const swipe = useSwipeMenu({
			enabled: hasCardActions,
			blockId: saBlockId,
			onSwipeRight: isSaSelected ? handleDeselectSa : undefined,
		});

		// Desktop: Ctrl/Cmd+Click toggles block, Shift+Click range-selects
		const isMobileSa = useMediaQuery("(max-width: 768px)") ?? false;
		const handleSaBlockClick = useCallback(
			(e: React.MouseEvent) => {
				if (isMobileSa || !saBlockId) return;
				const isModKey = e.metaKey || e.ctrlKey;
				const isShift = e.shiftKey;
				if (!isModKey && !isShift) return;
				e.preventDefault();
				if (isShift) {
					selection.rangeSelectTo(saBlockId);
				} else {
					selection.toggleBlock(saBlockId);
				}
			},
			[isMobileSa, saBlockId, selection.toggleBlock, selection.rangeSelectTo],
		);

		// Whether the card should show a highlighted border when collapsed
		// (pending permission inside that the user can't see)
		const hasPendingPerm = !expanded && !!(selfPerm || permChild);

		// Resolve the subagent's own narratorId from child messages
		const subagentNarratorId = useMemo(() => {
			for (const cm of childMessages) {
				if (cm.narratorId && cm.narratorId !== narratorId) return cm.narratorId;
			}
			return null;
		}, [childMessages, narratorId]);

		const handleViewSession = useCallback(() => {
			if (subagentNarratorId) {
				if (onViewSubagentSession) {
					onViewSubagentSession(subagentNarratorId);
				} else {
					navigate({
						to: "/narrators/$narratorId",
						params: { narratorId: subagentNarratorId },
						search: fromParam ? { from: fromParam } : undefined,
					});
				}
				swipe.closeSwipe();
			} else {
				// Fallback: expand card inline if we can't resolve the subagent narrator
				setExpanded(true);
				setShowCalls(true);
				swipe.closeSwipe();
				setTimeout(() => {
					const el = scrollBoxRef.current;
					if (el) el.scrollTop = el.scrollHeight;
				}, 300);
			}
		}, [subagentNarratorId, onViewSubagentSession, swipe.closeSwipe, navigate, fromParam]);

		const cardMenuItems = (
			<>
				<Menu.Item leftSection={<IconEye size={14} />} onClick={handleViewSession}>
					{t("viewSubagentSession")}
				</Menu.Item>
				{parentMsgCtx.onAskInPassing && (
					<Menu.Item
						leftSection={<IconMessageQuestion size={14} />}
						onClick={() => {
							parentMsgCtx.onAskInPassing?.();
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_askInPassing")}
					</Menu.Item>
				)}
				{parentMsgCtx.onCompactBeforeMessage && (
					<Menu.Item
						leftSection={<IconArrowsMinimize size={14} />}
						onClick={() => {
							parentMsgCtx.onCompactBeforeMessage?.();
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_compactBefore")}
					</Menu.Item>
				)}
				{parentMsgCtx.onDeleteBlock && blockIndex != null && (
					<Menu.Item
						color="red"
						leftSection={<IconTrash size={14} />}
						onClick={() => {
							parentMsgCtx.onDeleteBlock?.(blockIndex);
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_delete")}
					</Menu.Item>
				)}
			</>
		);

		// Prevent child ContentViewers / ToolCallCards from inheriting
		// the parent message's swipe/context-menu actions
		const emptyCtx: MessageContextMenuActions = {};

		const content = (
			<NestedBlockCtx.Provider value={saBlockId ?? null}>
				<MessageContextMenuCtx.Provider value={emptyCtx}>
					<Box ref={cardRef} className={isInitializing ? "tool-card-shimmer" : undefined}>
						{/* Header: two-line collapsed view */}
						<UnstyledButton onClick={() => setExpanded((o) => !o)} w="100%" p="xs">
							{/* Line 1: icon | type | model | calls | status | duration | chevron */}
							<Group gap={5} wrap="nowrap">
								<ThemeIcon size={16} variant="light" color="indigo" radius="sm">
									<IconRobot size={10} />
								</ThemeIcon>
								<Badge size="xs" variant="light" color={agentBadgeColor}>
									{agentType}
								</Badge>
								{isBackground && (
									<Badge size="xs" variant="light" color="blue">
										{t("backgroundBadge")}
									</Badge>
								)}
								{resolvedModel && (
									<Badge size="xs" variant="light" color="violet">
										{resolvedModel}
									</Badge>
								)}
								<Box style={{ flex: 1 }} />
								<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
									{childToolCalls.length > 0 && (
										<Text size="xs" c="dimmed">
											{childToolCalls.length} calls
										</Text>
									)}
									<Box c={statusColor}>
										<StatusIcon status={toolCall.status} />
									</Box>
									{toolCall.startedAt != null && !isTerminal ? (
										<ElapsedTimer startedAt={toolCall.startedAt} />
									) : (
										totalMs > 0 && (
											<Text size="xs" c="dimmed" ff="monospace">
												{(totalMs / 1000).toFixed(1)}s
											</Text>
										)
									)}
									{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
								</Group>
							</Group>
							{/* Line 2: description (truncated when collapsed) */}
							<Text
								size="xs"
								c="dimmed"
								mt={2}
								ml={21}
								truncate={!expanded}
								style={expanded ? { whiteSpace: "pre-wrap" } : undefined}
							>
								{description}
							</Text>
							{prompt && !input.description && !promptHasLineBreak && (
								<Text
									ref={promptSummaryRef}
									size="xs"
									c="dimmed"
									mt={2}
									ml={21}
									lineClamp={1}
									style={{
										opacity: 0,
										position: "absolute",
										pointerEvents: "none",
										maxWidth: "calc(100% - 21px)",
									}}
								>
									{prompt}
								</Text>
							)}
						</UnstyledButton>
						<Box>
							<LazyCollapse in={expanded}>
								{/* Permission request for the Task tool itself (e.g. custom workdir) */}
								{selfPerm && (
									<Box mx="xs" mb={4}>
										<InlinePermission
											permission={selfPerm}
											narratorId={narratorId}
											onDecision={permCb?.onPermissionDecision}
											onQuestionSubmit={permCb?.onQuestionSubmit}
											onQuestionDeny={permCb?.onQuestionDeny}
										/>
									</Box>
								)}
								{/* Background agent warning */}
								{showBgWarning && (
									<Alert
										icon={<IconAlertTriangle size={16} />}
										color="orange"
										variant="light"
										mx="xs"
										mb={4}
										p="xs"
										styles={{ message: { fontSize: 12 } }}
									>
										<Group gap="xs" justify="space-between" wrap="nowrap">
											<Text size="xs">{t("bgAgentWarning")}</Text>
											<Button
												size="compact-xs"
												variant="light"
												color="orange"
												style={{ flexShrink: 0 }}
												onClick={() => onBgAgentRetry(toolCall.toolUseId ?? "")}
											>
												{t("bgAgentRetry")}
											</Button>
										</Group>
									</Alert>
								)}
								{/* Prompt — shown first when expanded */}
								{prompt && (
									<Box px="xs" pb={4}>
										<UnstyledButton onClick={() => setShowPrompt((o) => !o)}>
											<Group gap={4}>
												{showPrompt ? (
													<IconChevronDown size={12} />
												) : (
													<IconChevronRight size={12} />
												)}
												<Text size="xs" c="dimmed" fw={500}>
													Prompt
												</Text>
											</Group>
										</UnstyledButton>
										<LazyCollapse in={showPrompt}>
											<Box mt={4}>
												<ContentViewer
													content={prompt}
													style={{
														fontSize: 11,
														maxHeight: 200,
														overflow: "auto",
														whiteSpace: "pre-wrap",
													}}
													title="Prompt"
												/>
											</Box>
										</LazyCollapse>
									</Box>
								)}
								{/* Reasoning/thinking blocks from child messages */}
								{childReasoningBlocks.length > 0 && (
									<Box px="xs" pb={4}>
										{childReasoningBlocks.map((rb) => (
											<ReasoningBlock
												key={`${rb.msgId}-${rb.blockIndex}`}
												block={rb.block}
												narratorId={subagentNarratorId ?? narratorId}
												blockIndex={rb.blockIndex}
											/>
										))}
									</Box>
								)}
								{/* Child tool calls — in the middle */}
								{childToolCalls.length > 0 && (
									<Box px="xs" pb="xs">
										<UnstyledButton onClick={() => setShowCalls((o) => !o)}>
											<Group gap={4}>
												{showCalls ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
												<Text size="xs" c="dimmed">
													{childToolCalls.length} tool calls
												</Text>
											</Group>
										</UnstyledButton>
										<LazyCollapse in={showCalls}>
											<Box
												ref={scrollBoxRef}
												pl="xs"
												mt={4}
												style={{
													overflow: "hidden auto",
													maxHeight: vpHeight,
												}}
											>
												{(() => {
													const els: React.ReactNode[] = [];
													let ci = 0;
													while (ci < childToolCalls.length) {
														const item = childToolCalls[ci];
														const subCh = filterChildrenByToolUse(
															item.childMsg?.children,
															item.tc.toolUseId,
														);
														const isSub =
															(subCh && subCh.length > 0) || item.tc.toolName === "Agent";
														if (isSub) {
															const subAnimId = getToolCallBlurAnimationId({
																toolUseId: item.toolUseId,
																messageId: item.msgId,
																fallbackKey: ci,
															});
															els.push(
																<BlurInOnAppear
																	key={item.toolUseId ?? item.tc.toolName}
																	animationId={subAnimId}
																>
																	<div
																		id={
																			item.toolUseId
																				? `tool-use-${item.toolUseId}`
																				: `msg-${item.msgId}`
																		}
																	>
																		<SubagentCard
																			toolCall={item.tc}
																			childMessages={subCh ?? []}
																			narratorId={narratorId}
																			permCb={permCb}
																			editExpandOverride={editExpandOverride}
																			onBgAgentRetry={permCb?.onBgAgentRetry}
																			onViewSubagentSession={onViewSubagentSession}
																		/>
																	</div>
																</BlurInOnAppear>,
															);
															ci++;
															continue;
														}
														// Collect consecutive non-subagent calls into a run
														const run: typeof childToolCalls = [item];
														let j = ci + 1;
														while (j < childToolCalls.length) {
															const nx = childToolCalls[j];
															const nxCh = filterChildrenByToolUse(
																nx.childMsg?.children,
																nx.tc.toolUseId,
															);
															if ((nxCh && nxCh.length > 0) || nx.tc.toolName === "Agent") break;
															run.push(nx);
															j++;
														}
														if (run.length >= 2) {
															els.push(
																<Box
																	key={`crun-${run[0].msgId}`}
																	style={{
																		border: "1px solid var(--mantine-color-default-border)",
																		borderRadius: "var(--mantine-radius-sm)",
																		overflow: "hidden",
																	}}
																>
																	{run.map((r, ri) => {
																		const mp = resolvePendingPerm(
																			r.tc,
																			permCb?.pendingPermission,
																			permCb?.pendingPermsMap,
																			permCb?.overseerReviewMap,
																		);
																		const runAnimId = getToolCallBlurAnimationId({
																			toolUseId: r.toolUseId,
																			messageId: r.msgId,
																			fallbackKey: ri,
																		});
																		return (
																			<BlurInOnAppear
																				key={r.toolUseId ?? r.tc.toolName}
																				animationId={runAnimId}
																			>
																				<div
																					id={
																						r.toolUseId
																							? `tool-use-${r.toolUseId}`
																							: `msg-${r.msgId}`
																					}
																				>
																					<ToolCallCard
																						toolCall={r.tc}
																						narratorId={narratorId}
																						inRun
																						isLast={ri === run.length - 1}
																						pendingPermission={mp}
																						onPermissionDecision={permCb?.onPermissionDecision}
																						onQuestionSubmit={permCb?.onQuestionSubmit}
																						onQuestionDeny={permCb?.onQuestionDeny}
																						editExpandOverride={editExpandOverride}
																					/>
																				</div>
																			</BlurInOnAppear>
																		);
																	})}
																</Box>,
															);
														} else {
															const r = run[0];
															const mp = resolvePendingPerm(
																r.tc,
																permCb?.pendingPermission,
																permCb?.pendingPermsMap,
																permCb?.overseerReviewMap,
															);
															const singleAnimId = getToolCallBlurAnimationId({
																toolUseId: r.toolUseId,
																messageId: r.msgId,
																fallbackKey: ci,
															});
															els.push(
																<BlurInOnAppear
																	key={r.toolUseId ?? r.tc.toolName}
																	animationId={singleAnimId}
																>
																	<div
																		id={r.toolUseId ? `tool-use-${r.toolUseId}` : `msg-${r.msgId}`}
																	>
																		<ToolCallCard
																			toolCall={r.tc}
																			narratorId={narratorId}
																			pendingPermission={mp}
																			onPermissionDecision={permCb?.onPermissionDecision}
																			onQuestionSubmit={permCb?.onQuestionSubmit}
																			onQuestionDeny={permCb?.onQuestionDeny}
																			editExpandOverride={editExpandOverride}
																		/>
																	</div>
																</BlurInOnAppear>,
															);
														}
														ci = j;
													}
													return els;
												})()}
											</Box>
										</LazyCollapse>
									</Box>
								)}
								{/* Result — shown at the bottom */}
								{resultText && (
									<Box px="xs" pb={4}>
										<ContentViewer
											content={resultText}
											fullContent={fullResultText}
											style={{
												fontSize: 11,
												maxHeight: 300,
												overflow: "auto",
												whiteSpace: "pre-wrap",
											}}
											title={`${agentType} — ${description}`}
											markdown={useMarkdown}
											contentType={useMarkdown ? "markdown" : "code"}
										/>
									</Box>
								)}
							</LazyCollapse>
						</Box>
						{inRun && !isLast && <Divider color="var(--mantine-color-default-border)" size={1} />}
					</Box>
				</MessageContextMenuCtx.Provider>
			</NestedBlockCtx.Provider>
		);

		const swipeMenu =
			hasCardActions &&
			(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
			(() => {
				const menuEl = swipe.swipeMenuRef.current;
				const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
				return createPortal(
					<Box
						ref={swipe.swipeMenuRef}
						style={{
							position: "fixed",
							left: pos.left,
							top: pos.top,
							transform: "translateY(-50%)",
							zIndex: 1000,
							transition: swipe.swipeMenuTransition,
							pointerEvents: swipe.swipeClosing ? "none" : "auto",
						}}
					>
						<Menu opened withinPortal={false} position="bottom-start">
							<Menu.Dropdown style={{ position: "relative", width: 180 }}>
								{cardMenuItems}
							</Menu.Dropdown>
						</Menu>
					</Box>,
					document.body,
				);
			})();

		const ctxMenu = hasCardActions && (
			<Menu
				opened={swipe.ctxMenuOpened}
				onChange={swipe.setCtxMenuOpened}
				position="bottom-start"
				withinPortal
				styles={{
					dropdown: {
						position: "fixed",
						left: swipe.ctxMenuPos.x,
						...(swipe.ctxMenuPos.flipY
							? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
							: { top: swipe.ctxMenuPos.y }),
					},
				}}
			>
				<Menu.Target>
					<div
						style={{
							position: "fixed",
							left: swipe.ctxMenuPos.x,
							top: swipe.ctxMenuPos.y,
							pointerEvents: "none",
						}}
					/>
				</Menu.Target>
				<Menu.Dropdown>{cardMenuItems}</Menu.Dropdown>
			</Menu>
		);

		const buildSelectionStyle = (): React.CSSProperties => {
			const selOffset = isMobileSa && isSaSelected && !swipe.swipeRevealed ? 180 : 0;
			const effTransform =
				swipe.swipeOffset > 0
					? undefined
					: selOffset > 0
						? `translateX(-${selOffset}px)`
						: undefined;
			return {
				...swipe.swipeStyle,
				...(effTransform ? { transform: effTransform } : {}),
				...(isSaSelected
					? {
							outline: "2px solid var(--mantine-color-indigo-6)",
							outlineOffset: -2,
							borderRadius: 4,
						}
					: {}),
			};
		};

		if (inRun) {
			return (
				<>
					<Box
						ref={swipe.swipeBoxRef}
						onContextMenu={swipe.handleContextMenu}
						onClick={handleSaBlockClick}
						style={{
							...buildSelectionStyle(),
							...(hasPendingPerm
								? {
										outline: "1px solid var(--mantine-color-yellow-6)",
										outlineOffset: -1,
									}
								: {}),
						}}
						{...(saBlockId ? { [BLOCK_ID_ATTR]: saBlockId } : {})}
						{...(parentMsgCtx.messageId ? { "data-message-id": parentMsgCtx.messageId } : {})}
						{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
					>
						{content}
					</Box>
					{swipeMenu}
					{ctxMenu}
				</>
			);
		}

		return (
			<>
				<Box
					ref={swipe.swipeBoxRef}
					onContextMenu={swipe.handleContextMenu}
					onClick={handleSaBlockClick}
					style={buildSelectionStyle()}
					{...(saBlockId ? { [BLOCK_ID_ATTR]: saBlockId } : {})}
					{...(parentMsgCtx.messageId ? { "data-message-id": parentMsgCtx.messageId } : {})}
					{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
				>
					<Paper
						withBorder={!inRun}
						radius={inRun ? 0 : "sm"}
						style={{
							overflow: "hidden",
							...(selfPerm || hasPendingPerm
								? { borderColor: "var(--mantine-color-yellow-6)" }
								: {}),
						}}
					>
						{content}
					</Paper>
				</Box>
				{swipeMenu}
				{ctxMenu}
			</>
		);
	},
	(prev, next) =>
		prev.toolCall === next.toolCall &&
		prev.childMessages === next.childMessages &&
		prev.narratorId === next.narratorId &&
		prev.inRun === next.inRun &&
		prev.isLast === next.isLast &&
		prev.isSoleInRun === next.isSoleInRun &&
		prev.editExpandOverride === next.editExpandOverride &&
		prev.onViewSubagentSession === next.onViewSubagentSession &&
		prev.permCb?.pendingPermsMap === next.permCb?.pendingPermsMap &&
		prev.permCb?.bgRetryDismissedIds === next.permCb?.bgRetryDismissedIds,
);
