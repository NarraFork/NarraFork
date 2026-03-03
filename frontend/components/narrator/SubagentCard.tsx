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
import {
	IconAlertTriangle,
	IconArrowsMinimize,
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconRobot,
	IconTrash,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToolCallDetail } from "../../hooks/useNarrator";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import {
	type MessageContextMenuActions,
	MessageContextMenuCtx,
	useMessageContextMenu,
} from "./MessageContextMenuCtx";
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
	}: SubagentCardProps) {
		const { t } = useTranslation("narrator");
		const navigate = useNavigate();
		const input = toolCall.inputJson ?? {};
		const isBackground = !!input.run_in_background;
		const agentType = input.subagent_type ?? "agent";
		const isBgWarning = isBackground && !/^explore$/i.test(agentType);
		const dismissed =
			(toolCall.toolUseId && permCb?.bgRetryDismissedIds?.has(toolCall.toolUseId)) ?? false;
		const showBgWarning = isBgWarning && !dismissed && !!onBgAgentRetry;
		const isTerminal = /^(success|completed|denied|error|fail)$/.test(toolCall.status);
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
		const resolvedModel = childMessages[0]?.subagentModel ?? input.model;
		const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";

		// Clamp card height to 80% of the nearest scroll container (chat viewport).
		// Read once after mount via DOM traversal — works regardless of render timing.
		const cardRef = useRef<HTMLDivElement>(null);
		const scrollBoxRef = useRef<HTMLDivElement>(null);
		const [vpHeight, setVpHeight] = useState<number | undefined>();
		useEffect(() => {
			const node = cardRef.current;
			if (!node || vpHeight) return;
			let el: HTMLElement | null = node.parentElement;
			while (el) {
				const ov = getComputedStyle(el).overflowY;
				if (ov === "scroll" || ov === "auto") {
					setVpHeight(el.clientHeight * 0.7);
					return;
				}
				el = el.parentElement;
			}
		});
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
			const out = toolCall.outputJson;
			if (!out) return "";
			if (typeof out === "string") return out;
			// Handle truncated output from backend
			if (out._truncated && typeof out.preview === "string") return out.preview;
			if (Array.isArray(out)) {
				return out
					.filter((b: ContentBlock) => b.text)
					.map((b: ContentBlock) => b.text)
					.join("\n");
			}
			return "";
		}, [toolCall.outputJson]);
		const fullResultText = useMemo(() => {
			if (!fullTc?.outputJson) return undefined;
			const out = fullTc.outputJson;
			if (typeof out === "string") return out;
			if (Array.isArray(out)) {
				return out
					.filter((b: ContentBlock) => b.text)
					.map((b: ContentBlock) => b.text)
					.join("\n");
			}
			return undefined;
		}, [fullTc?.outputJson]);

		// Determine if this subagent type should render results as markdown
		const useMarkdown = /^explore$/i.test(agentType);
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

		const totalMs = toolCall.durationMs ?? 0;

		// Check if the Task tool call itself has a pending permission (e.g. custom workdir)
		const selfPerm = resolvePendingPerm(
			toolCall,
			permCb?.pendingPermission,
			permCb?.pendingPermsMap,
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
				}, 300);
				return () => clearTimeout(t);
			}
		}, [permChildId]);

		// Auto-expand when the Task tool itself needs permission (e.g. custom workdir)
		useEffect(() => {
			if (selfPerm) setExpanded(true);
		}, [selfPerm]);

		// When subagent finishes: collapse tool calls list
		useEffect(() => {
			if (isTerminal) {
				setShowCalls(false);
			}
		}, [isTerminal]);

		// --- Swipe / context-menu for SubagentCard itself ---
		const parentMsgCtx = useMessageContextMenu();
		const hasCardActions = !!(parentMsgCtx.onDeleteMessage || parentMsgCtx.onCompactBeforeMessage);

		const swipe = useSwipeMenu({ enabled: hasCardActions });

		// Resolve the subagent's own narratorId from child messages
		const subagentNarratorId = useMemo(() => {
			for (const cm of childMessages) {
				if (cm.narratorId && cm.narratorId !== narratorId) return cm.narratorId;
			}
			return null;
		}, [childMessages, narratorId]);

		const handleViewSession = useCallback(() => {
			if (subagentNarratorId) {
				navigate({ to: "/narrators/$narratorId", params: { narratorId: subagentNarratorId } });
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
		}, [subagentNarratorId, swipe.closeSwipe, navigate]);

		const cardMenuItems = (
			<>
				<Menu.Item leftSection={<IconEye size={14} />} onClick={handleViewSession}>
					{t("viewSubagentSession")}
				</Menu.Item>
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
				{parentMsgCtx.onDeleteMessage && (
					<Menu.Item
						color="red"
						leftSection={<IconTrash size={14} />}
						onClick={() => {
							parentMsgCtx.onDeleteMessage?.();
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
			<MessageContextMenuCtx.Provider value={emptyCtx}>
				<Box ref={cardRef}>
					{/* Header: two-line collapsed view */}
					<UnstyledButton onClick={() => setExpanded((o) => !o)} w="100%" p="xs">
						{/* Line 1: icon | type | model | calls | status | duration | chevron */}
						<Group gap={6} wrap="nowrap">
							<ThemeIcon size={18} variant="light" color="indigo" radius="sm">
								<IconRobot size={12} />
							</ThemeIcon>
							<Badge size="xs" variant="light" color="indigo">
								{agentType}
							</Badge>
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
							ml={24}
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
								ml={24}
								lineClamp={1}
								style={{
									opacity: 0,
									position: "absolute",
									pointerEvents: "none",
									maxWidth: "calc(100% - 24px)",
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
							{/* Result — shown directly when expanded */}
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
							{/* Prompt — 单行可放进标题时不再折叠显示 */}
							{prompt && !promptShownInHeader && (
								<Box px="xs" pb={4}>
									<UnstyledButton onClick={() => setShowPrompt((o) => !o)}>
										<Group gap={4}>
											{showPrompt ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
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
							{/* Child tool calls — collapsed by default */}
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
													const isSub = (subCh && subCh.length > 0) || item.tc.toolName === "Task";
													if (isSub) {
														els.push(
															<div
																key={item.toolUseId ?? item.tc.toolName}
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
																/>
															</div>,
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
														if ((nxCh && nxCh.length > 0) || nx.tc.toolName === "Task") break;
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
																	);
																	return (
																		<div
																			key={r.toolUseId ?? r.tc.toolName}
																			id={
																				r.toolUseId ? `tool-use-${r.toolUseId}` : `msg-${r.msgId}`
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
														);
														els.push(
															<div
																key={r.toolUseId ?? r.tc.toolName}
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
															</div>,
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
						</LazyCollapse>
					</Box>
					{inRun && !isLast && <Divider color="var(--mantine-color-default-border)" size={1} />}
				</Box>
			</MessageContextMenuCtx.Provider>
		);

		const swipeMenu =
			hasCardActions &&
			(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
			(() => {
				const menuEl = swipe.swipeMenuRef.current;
				const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
				return (
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
					</Box>
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

		if (inRun) {
			return (
				<>
					<Box
						ref={swipe.swipeBoxRef}
						onContextMenu={swipe.handleContextMenu}
						style={swipe.swipeStyle}
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
					style={swipe.swipeStyle}
				>
					<Paper
						withBorder={!inRun}
						radius={inRun ? 0 : "sm"}
						style={{
							overflow: "hidden",
							...(selfPerm ? { borderColor: "var(--mantine-color-yellow-6)" } : {}),
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
		prev.permCb?.pendingPermsMap === next.permCb?.pendingPermsMap &&
		prev.permCb?.bgRetryDismissedIds === next.permCb?.bgRetryDismissedIds,
);
