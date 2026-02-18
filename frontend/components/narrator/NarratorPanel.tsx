import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Center,
	CloseButton,
	Divider,
	Group,
	Image,
	Loader,
	Menu,
	Modal,
	NativeSelect,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconAlertTriangle,
	IconArchive,
	IconArrowDown,
	IconArrowLeft,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCode,
	IconCodeOff,
	IconHandStop,
	IconPaperclip,
	IconPencilCheck,
	IconRobot,
	IconShield,
	IconShieldOff,
	IconSparkles,
	IconTerminal,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	memo,
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	useArchiveNarrator,
	useInterruptNarrator,
	useNarrator,
	useNarratorMessages,
	useUpdateModel,
	useUpdatePermissionMode,
} from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api, getToken } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { SelectionPopover } from "../common/SelectionPopover";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import { MessageBubble } from "./MessageBubble";
import {
	findMsgByToolUseIdInTree,
	insertChildIntoCache,
	type MessageIndex,
	mergeToolCallFieldsInTree,
	updateToolCallByIndex,
	updateToolUseIndex,
} from "./message-tree-utils";
import { PermissionBanner } from "./PermissionBanner";
import type { PendingPermission, ToolCallData } from "./ToolCallCard";
import { STATUS_COLORS, StatusIcon, ToolCallCard } from "./ToolCallCard";

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
		}`;
		document.head.appendChild(style);
	}
}

interface TodoItem {
	content?: string;
	status?: string;
	activeForm?: string;
}

interface MessagesPage {
	messages: NarratorMsg[];
	hasMore?: boolean;
	nextCursor?: string | null;
}

interface MessagesQueryData {
	pages: MessagesPage[];
	pageParams: unknown[];
}

// --- Message-level types ---

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	input?: Record<string, unknown>;
	[key: string]: unknown;
}

interface ToolCallRow {
	toolUseId: string;
	toolName: string;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	errorMessage?: string;
}

interface NarratorMsg {
	id: string;
	role: string;
	contentJson?: ContentBlock[] | unknown;
	contentText?: string;
	toolCalls?: ToolCallRow[];
	children?: NarratorMsg[];
	createdAt?: string;
	[key: string]: unknown;
}

// --- Message-level helpers ---

function isToolOnlyMessage(msg: NarratorMsg): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return (
		msg.role === "assistant" &&
		blocks.length > 0 &&
		blocks.every(
			(b: ContentBlock) => b.type === "tool_use" || (b.type === "text" && !b.text?.trim()),
		)
	);
}

function resolveToolCallFromMsg(msg: NarratorMsg): ToolCallData | null {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const block = blocks.find((b: ContentBlock) => b.type === "tool_use");
	if (!block) return null;
	const tc = msg.toolCalls?.find((t: ToolCallRow) => t.toolUseId === block.id);
	return {
		toolName: block.name,
		toolUseId: block.id,
		// Prefer tc.inputJson (from DB) — it includes merged answers for AskUserQuestion
		inputJson: tc?.inputJson ?? block.input,
		outputJson: tc?.outputJson,
		status: tc?.status ?? "running",
		durationMs: tc?.durationMs,
		errorMessage: tc?.errorMessage,
	};
}

// --- SubagentCard: renders a Task tool call with its child messages (pre-nested from backend) ---

interface SubagentCardProps {
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

const SubagentCard = memo(
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
		const input = toolCall.inputJson ?? {};
		const isBackground = !!input.run_in_background;
		const agentType = input.subagent_type ?? "agent";
		const isBgWarning = isBackground && !/^explore$/i.test(agentType);
		const dismissed =
			(toolCall.toolUseId && permCb?.bgRetryDismissedIds?.has(toolCall.toolUseId)) ?? false;
		const showBgWarning = isBgWarning && !dismissed && !!onBgAgentRetry;
		const soleAndRunning = !!isSoleInRun && !/^(completed|denied|error)$/.test(toolCall.status);
		const [expanded, setExpanded] = useState(showBgWarning || !!isSoleInRun);
		const [showPrompt, setShowPrompt] = useState(false);
		const isTerminal = /^(completed|denied|error)$/.test(toolCall.status);
		const [showCalls, setShowCalls] = useState(soleAndRunning);
		const description = input.description ?? input.prompt?.slice(0, 80) ?? "Subagent";
		const prompt = input.prompt ?? "";
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
					setVpHeight(el.clientHeight * 0.8);
					return;
				}
				el = el.parentElement;
			}
		});
		const prevChildCount = useRef(childMessages.length);
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
		const resultText = useMemo(() => {
			const out = toolCall.outputJson;
			if (!out) return "";
			if (typeof out === "string") return out;
			if (Array.isArray(out)) {
				return out
					.filter((b: ContentBlock) => b.text)
					.map((b: ContentBlock) => b.text)
					.join("\n");
			}
			return "";
		}, [toolCall.outputJson]);

		// Determine if this subagent type should render results as markdown
		const useMarkdown = /^explore$/i.test(agentType);
		const childToolCalls: {
			tc: ToolCallData;
			toolUseId: string | null;
			msgId: string;
			childMsg: NarratorMsg;
		}[] = [];
		for (const cm of childMessages) {
			if (!isToolOnlyMessage(cm)) continue;
			const tc = resolveToolCallFromMsg(cm);
			if (tc)
				childToolCalls.push({ tc, toolUseId: tc.toolUseId ?? null, msgId: cm.id, childMsg: cm });
		}

		const totalMs =
			childToolCalls.reduce((sum, c) => sum + (c.tc.durationMs ?? 0), 0) +
			(toolCall.durationMs ?? 0);

		// Find the child tool call that has a pending permission (if any)
		const permChild = permCb?.pendingPermission?.toolUseId
			? childToolCalls.find((c) => c.tc.toolUseId === permCb.pendingPermission?.toolUseId)
			: null;

		// Auto-expand the subagent card when a child needs permission
		useEffect(() => {
			if (permChild) setExpanded(true);
		}, [permChild]);

		// When sole-in-run subagent finishes: collapse calls, keep card expanded for result
		useEffect(() => {
			if (isSoleInRun && isTerminal) {
				setShowCalls(false);
				setExpanded(true);
			}
		}, [isSoleInRun, isTerminal]);

		const content = (
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
						{input.model && (
							<Badge size="xs" variant="light" color="violet">
								{input.model}
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
							{totalMs > 0 && (
								<Text size="xs" c="dimmed">
									{(totalMs / 1000).toFixed(1)}s
								</Text>
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
				</UnstyledButton>
				<Box>
					<LazyCollapse in={expanded}>
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
						{/* Prompt — collapsed by default */}
						{prompt && (
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
						{/* Permission-pending child — shown standalone outside the collapsed tool calls list */}
						{permChild && permCb?.pendingPermission && (
							<Box px="xs" pb="xs">
								<ToolCallCard
									toolCall={permChild.tc}
									narratorId={narratorId}
									pendingPermission={permCb.pendingPermission}
									onPermissionDecision={permCb.onPermissionDecision}
									onQuestionSubmit={permCb.onQuestionSubmit}
									onQuestionDeny={permCb.onQuestionDeny}
									editExpandOverride={editExpandOverride}
								/>
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
										pl="md"
										mt={4}
										style={{
											borderLeft: "2px solid var(--mantine-color-indigo-3)",
											overflow: "hidden auto",
											maxHeight: vpHeight,
										}}
									>
										{(() => {
											const els: React.ReactNode[] = [];
											let ci = 0;
											while (ci < childToolCalls.length) {
												const item = childToolCalls[ci];
												const subCh = item.childMsg?.children;
												const isSub = (subCh && subCh.length > 0) || item.tc.toolName === "Task";
												if (isSub) {
													els.push(
														<div key={item.toolUseId ?? item.tc.toolName} id={`msg-${item.msgId}`}>
															<SubagentCard
																toolCall={item.tc}
																childMessages={subCh}
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
													const nxCh = nx.childMsg?.children;
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
																const mp =
																	permCb?.pendingPermission &&
																	r.tc.toolUseId &&
																	r.tc.toolUseId === permCb.pendingPermission.toolUseId
																		? permCb.pendingPermission
																		: null;
																return (
																	<div key={r.toolUseId ?? r.tc.toolName} id={`msg-${r.msgId}`}>
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
													const mp =
														permCb?.pendingPermission &&
														r.tc.toolUseId &&
														r.tc.toolUseId === permCb.pendingPermission.toolUseId
															? permCb.pendingPermission
															: null;
													els.push(
														<div key={r.toolUseId ?? r.tc.toolName} id={`msg-${r.msgId}`}>
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
				{inRun && !isLast && <Divider />}
			</Box>
		);

		if (inRun) return content;

		return (
			<Paper withBorder radius="sm" style={{ overflow: "hidden" }}>
				{content}
			</Paper>
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
		prev.permCb?.pendingPermission?.toolUseId === next.permCb?.pendingPermission?.toolUseId &&
		prev.permCb?.bgRetryDismissedIds === next.permCb?.bgRetryDismissedIds,
);

interface PermissionCallbacks {
	pendingPermission: PendingPermission | null;
	onPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
	) => void;
	onQuestionSubmit: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny: (requestId: string) => void;
	onBgAgentRetry?: (toolUseId: string) => void;
	bgRetryDismissedIds?: Set<string>;
}

function renderToolRun(
	run: NarratorMsg[],
	narratorId: string,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
	highlightedId?: string | null,
	editExpandOverride?: boolean | null,
) {
	const matchPermission = (tc: ToolCallData) =>
		permCb.pendingPermission && tc.toolUseId && tc.toolUseId === permCb.pendingPermission.toolUseId
			? permCb.pendingPermission
			: null;

	// Count Task (subagent) tool calls in this run
	const taskCount = run.filter((m: NarratorMsg) => {
		const tc = resolveToolCallFromMsg(m);
		return tc && (tc.toolName === "Task" || (m.children && m.children.length > 0));
	}).length;
	const soleSubagent = taskCount === 1;

	if (run.length >= 2) {
		return (
			<Box
				key={`tool-run-${run[0].id}`}
				style={{
					border: "1px solid var(--mantine-color-default-border)",
					borderRadius: "var(--mantine-radius-sm)",
					overflow: "hidden",
				}}
			>
				{run.map((m: NarratorMsg, idx: number) => {
					const children = m.children;
					const tc = resolveToolCallFromMsg(m);
					if (!tc) return null;
					if ((children && children.length > 0) || tc.toolName === "Task") {
						return (
							<div
								key={m.id}
								id={`msg-${m.id}`}
								style={
									highlightedId === m.id
										? {
												animation: "highlight-blink 1.5s ease",
												borderRadius: "var(--mantine-radius-sm)",
											}
										: undefined
								}
							>
								<SubagentCard
									toolCall={tc}
									childMessages={children ?? []}
									narratorId={narratorId}
									inRun
									isLast={idx === run.length - 1}
									isSoleInRun={soleSubagent}
									permCb={permCb}
									editExpandOverride={editExpandOverride}
									onBgAgentRetry={permCb?.onBgAgentRetry}
								/>
							</div>
						);
					}
					return (
						<div
							key={m.id}
							id={`msg-${m.id}`}
							style={
								highlightedId === m.id
									? {
											animation: "highlight-blink 1.5s ease",
											borderRadius: "var(--mantine-radius-sm)",
										}
									: undefined
							}
						>
							<ToolCallCard
								toolCall={tc}
								narratorId={narratorId}
								inRun
								isLast={idx === run.length - 1}
								pendingPermission={matchPermission(tc)}
								onPermissionDecision={permCb.onPermissionDecision}
								onQuestionSubmit={permCb.onQuestionSubmit}
								onQuestionDeny={permCb.onQuestionDeny}
								forceExpand={expandedToolUseId === tc.toolUseId}
								editExpandOverride={editExpandOverride}
							/>
						</div>
					);
				})}
			</Box>
		);
	}
	// Single tool message
	const msg = run[0];
	const children = msg.children;
	const tc = resolveToolCallFromMsg(msg);
	if (!tc) return null;
	if ((children && children.length > 0) || tc.toolName === "Task") {
		return (
			<div
				key={msg.id}
				id={`msg-${msg.id}`}
				style={
					highlightedId === msg.id
						? { animation: "highlight-blink 1.5s ease", borderRadius: "var(--mantine-radius-sm)" }
						: undefined
				}
			>
				<SubagentCard
					toolCall={tc}
					childMessages={children ?? []}
					narratorId={narratorId}
					isSoleInRun={soleSubagent}
					permCb={permCb}
					editExpandOverride={editExpandOverride}
					onBgAgentRetry={permCb?.onBgAgentRetry}
				/>
			</div>
		);
	}
	return (
		<div
			key={msg.id}
			id={`msg-${msg.id}`}
			style={
				highlightedId === msg.id
					? { animation: "highlight-blink 1.5s ease", borderRadius: "var(--mantine-radius-sm)" }
					: undefined
			}
		>
			<ToolCallCard
				toolCall={tc}
				narratorId={narratorId}
				pendingPermission={matchPermission(tc)}
				onPermissionDecision={permCb.onPermissionDecision}
				onQuestionSubmit={permCb.onQuestionSubmit}
				onQuestionDeny={permCb.onQuestionDeny}
				forceExpand={expandedToolUseId === tc.toolUseId}
				editExpandOverride={editExpandOverride}
			/>
		</div>
	);
}

function renderTreeMessages(
	messages: NarratorMsg[],
	narratorId: string,
	onForkFromMessage: ((uuid: string) => void) | undefined,
	highlightedId: string | null,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
	editExpandOverride?: boolean | null,
	showTokenUsage?: boolean,
): { elements: React.ReactNode[] } {
	// Messages are already tree-structured from the backend (children nested).
	// We only need to group consecutive tool-only messages into visual "runs".
	const elements: React.ReactNode[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (isToolOnlyMessage(msg)) {
			const run: NarratorMsg[] = [msg];
			let j = i + 1;
			while (j < messages.length && isToolOnlyMessage(messages[j])) {
				run.push(messages[j]);
				j++;
			}
			const el = renderToolRun(
				run,
				narratorId,
				permCb,
				expandedToolUseId,
				highlightedId,
				editExpandOverride,
			);
			if (el) elements.push(el);
			i = j;
		} else {
			elements.push(
				<Box
					key={msg.id}
					id={`msg-${msg.id}`}
					style={{
						borderRadius: "var(--mantine-radius-md)",
						animation: highlightedId === msg.id ? "highlight-blink 1.5s ease" : undefined,
					}}
				>
					{showTokenUsage && msg.role === "assistant" && msg.tokensIn != null && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mb={2}>
							↑ {(msg.tokensIn as number).toLocaleString()}
						</Text>
					)}
					<MessageBubble
						narratorId={narratorId}
						message={msg}
						onForkFromMessage={onForkFromMessage}
					/>
					{showTokenUsage && msg.turnUsageJson != null && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mt={2}>
							Σ {((msg.turnUsageJson as any).input_tokens ?? 0).toLocaleString()} in ·{" "}
							{((msg.turnUsageJson as any).output_tokens ?? 0).toLocaleString()} out
							{msg.costUsd != null &&
								(msg.costUsd as number) > 0 &&
								` · $${(msg.costUsd as number).toFixed(4)}`}
						</Text>
					)}
				</Box>,
			);
			i++;
		}
	}

	return { elements };
}

// --- MemoizedPageElements: per-page memoized rendering to avoid re-rendering all pages on WS updates ---

interface PageElementsProps {
	page: { messages: NarratorMsg[] };
	narratorId: string;
	onForkFromMessage: ((uuid: string) => void) | undefined;
	highlightedId: string | null;
	permCb: PermissionCallbacks;
	expandedToolUseId?: string | null;
	editExpandOverride?: boolean | null;
	showTokenUsage?: boolean;
	/** When set, only render the last N messages of this page (for progressive rendering). */
	maxMessages?: number;
}

const MemoizedPageElements = memo(
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
	}: PageElementsProps) {
		const msgs =
			maxMessages != null && maxMessages < page.messages.length
				? page.messages.slice(page.messages.length - maxMessages)
				: page.messages;
		const { elements } = renderTreeMessages(
			msgs,
			narratorId,
			onForkFromMessage,
			highlightedId,
			permCb,
			expandedToolUseId,
			editExpandOverride,
			showTokenUsage,
		);
		return <>{elements}</>;
	},
	(prev, next) =>
		prev.page === next.page &&
		prev.narratorId === next.narratorId &&
		prev.onForkFromMessage === next.onForkFromMessage &&
		prev.permCb.pendingPermission === next.permCb.pendingPermission &&
		prev.permCb.bgRetryDismissedIds === next.permCb.bgRetryDismissedIds &&
		prev.expandedToolUseId === next.expandedToolUseId &&
		prev.editExpandOverride === next.editExpandOverride &&
		prev.showTokenUsage === next.showTokenUsage &&
		prev.maxMessages === next.maxMessages,
);

// --- useProgressiveMessageCount: render messages in batches to avoid blocking the main thread ---
// Works on the total message count rather than page-element count, so progressive
// rendering is effective even when all messages fit in a single page.

function useProgressiveMessageCount(
	totalMessages: number,
	batchSize: number,
	skip: boolean,
	resetKey: string,
	viewportRef: React.RefObject<HTMLDivElement | null>,
): { visibleCount: number; done: boolean } {
	const [count, setCount] = useState(batchSize);
	const prevTotalRef = useRef(totalMessages);
	const prevResetKeyRef = useRef(resetKey);
	const needsSnapRef = useRef(false);

	let effectiveCount = count;
	if (prevResetKeyRef.current !== resetKey) {
		// Narrator switch — force progressive re-render from scratch
		prevResetKeyRef.current = resetKey;
		prevTotalRef.current = totalMessages;
		setCount(batchSize);
		effectiveCount = batchSize;
		needsSnapRef.current = true;
	} else if (prevTotalRef.current !== totalMessages) {
		const prevTotal = prevTotalRef.current;
		prevTotalRef.current = totalMessages;
		if (count > totalMessages) {
			// Fewer messages than before (e.g. switched context) — reset
			setCount(batchSize);
			effectiveCount = batchSize;
		} else if (prevTotal === 0 && totalMessages > batchSize) {
			// Initial data load (was empty, now has messages) — start progressive
			setCount(batchSize);
			effectiveCount = batchSize;
			needsSnapRef.current = true;
		} else if (totalMessages > count) {
			// Both loadOlder (large batch) and WS append (small) — render immediately.
			// overflow-anchor handles scroll compensation for prepended content;
			// the useLayoutEffect scrollTop=1 hack prevents anchor latching to top.
			setCount(totalMessages);
			effectiveCount = totalMessages;
		}
	}

	useEffect(() => {
		if (skip || count >= totalMessages) return;
		const id = setTimeout(() => {
			setCount((c) => Math.min(c + batchSize, totalMessages));
		}, 50);
		return () => clearTimeout(id);
	}, [skip, count, totalMessages, batchSize]);

	// After each batch renders to DOM (useLayoutEffect = before browser paint):
	// 1. Snap to bottom on initial load / narrator switch (needsSnapRef).
	// 2. Otherwise, ensure scrollTop > 0 so overflow-anchor doesn't latch onto
	//    the top edge — which would cause the viewport to stick to the top
	//    instead of compensating for prepended content.
	//    Done here (not in the timer callback) to avoid racing with the
	//    browser's anchor recalculation between frames.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only needs to run when count changes
	useLayoutEffect(() => {
		const vp = viewportRef.current;
		if (!vp) return;
		if (needsSnapRef.current) {
			if (count < batchSize) return;
			needsSnapRef.current = false;
			vp.scrollTop = vp.scrollHeight;
			return;
		}
		if (vp.scrollTop === 0) {
			vp.scrollTop = 1;
		}
	}, [count]);

	if (skip || totalMessages <= effectiveCount) return { visibleCount: totalMessages, done: true };
	return { visibleCount: effectiveCount, done: false };
}

function RenderProgress({ value, indeterminate }: { value?: number; indeterminate?: boolean }) {
	const pct = value != null ? Math.round(Math.min(value, 1) * 100) : 0;
	return (
		<div
			style={{
				height: 3,
				width: "100%",
				backgroundColor: "var(--mantine-color-default-border)",
				overflow: "hidden",
			}}
		>
			<div
				style={
					indeterminate
						? {
								height: "100%",
								width: "30%",
								backgroundColor: "var(--mantine-color-indigo-filled)",
								animation: "indeterminate-slide 1.2s ease-in-out infinite",
							}
						: {
								height: "100%",
								width: `${pct}%`,
								backgroundColor: "var(--mantine-color-indigo-filled)",
								transition: "width 80ms linear",
							}
				}
			/>
		</div>
	);
}

// --- StreamingBubble: isolated component to avoid re-rendering the entire panel on every text delta ---

function StreamingBubble({
	narratorId,
	streamingRef,
	version,
}: {
	narratorId: string;
	streamingRef: React.RefObject<string>;
	version: number;
}) {
	const [text, setText] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: version triggers re-read of streamingRef.current on each streaming tick
	useEffect(() => {
		setText(streamingRef.current);
	}, [version, streamingRef]);

	// Auto-scroll is handled by the ResizeObserver on the content container —
	// as this bubble grows, the observer fires and scrolls if user is at bottom.

	if (!text) return null;

	return (
		<MessageBubble
			narratorId={narratorId}
			message={{
				role: "assistant",
				contentJson: [{ type: "text", text }],
			}}
		/>
	);
}

const PERM_MODE_ICONS: Record<string, React.ReactNode> = {
	default: <IconShield size={14} />,
	acceptEdits: <IconPencilCheck size={14} />,
	bypassPermissions: <IconShieldOff size={14} />,
	dontAsk: <IconHandStop size={14} />,
};

interface NarratorPanelProps {
	narratorId: string;
	narrator?: {
		id: string;
		chapterId?: string | null;
		title?: string | null;
		model: string | null;
		status: string;
		totalCostUsd: number | null;
		permissionMode: string | null;
		sdkPlanMode?: boolean | null;
		todosJson?: TodoItem[] | null;
		todosToolUseId?: string | null;
	};
	onForkFromMessage?: (sdkMessageUuid: string) => void;
	highlightMessageId?: string;
	/** Write selected chat text to the paired terminal panel. Provided by the session layout when a terminal is open. */
	onSendToTerminal?: (text: string) => void;
	/** Ref callback exposed to the parent so the terminal panel can append text into the chat input. */
	appendInputRef?: React.MutableRefObject<((text: string) => void) | null>;
	/** Whether the terminal panel is currently visible. Controls the toggle button state. */
	terminalOpen?: boolean;
	/** Callback to toggle terminal panel visibility. When provided, shows the terminal toggle button. */
	onToggleTerminal?: () => void;
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function NarratorPanel({
	narratorId,
	narrator: narratorProp,
	onForkFromMessage,
	highlightMessageId,
	onSendToTerminal,
	appendInputRef,
	terminalOpen,
	onToggleTerminal,
}: NarratorPanelProps) {
	const navigate = useNavigate();
	const { data: fetchedNarrator } = useNarrator(narratorId);
	const narrator = narratorProp ?? fetchedNarrator;
	const {
		data: messagesData,
		isLoading: messagesLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorMessages(narratorId, highlightMessageId);
	const interruptMutation = useInterruptNarrator();
	const archiveMutation = useArchiveNarrator();
	const permModeMutation = useUpdatePermissionMode();
	const modelMutation = useUpdateModel();
	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const allModels = useMemo(() => {
		const builtIn = [
			{ value: "claude-haiku", label: "Haiku" },
			{ value: "claude-sonnet", label: "Sonnet" },
			{ value: "claude-opus", label: "Opus" },
		];
		const custom = settingsData?.agent?.customModels ?? [];
		return [...builtIn, ...custom];
	}, [settingsData]);
	const { data: userPrefs } = useUserPreferences();
	const autoLoadEnabled = userPrefs?.autoLoadOlderMessages ?? true;
	const qc = useQueryClient();
	const messagesQueryKey = useMemo(
		() => ["narrators", narratorId, "messages", { around: highlightMessageId }],
		[narratorId, highlightMessageId],
	);

	const [input, setInput] = useState(
		() => sessionStorage.getItem(`narrafork_draft_${narratorId}`) ?? "",
	);
	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	sendingRef.current = sending;

	// Persist draft to sessionStorage
	useEffect(() => {
		if (input) {
			sessionStorage.setItem(`narrafork_draft_${narratorId}`, input);
		} else {
			sessionStorage.removeItem(`narrafork_draft_${narratorId}`);
		}
	}, [input, narratorId]);

	// Expose appendToInput to parent via ref
	useEffect(() => {
		if (appendInputRef) {
			appendInputRef.current = (text: string) =>
				setInput((prev) => (prev ? `${prev}\n${text}` : text));
		}
		return () => {
			if (appendInputRef) appendInputRef.current = null;
		};
	}, [appendInputRef]);
	const streamingRef = useRef("");
	const [streamingVersion, setStreamingVersion] = useState(0);
	const [attachedImages, setAttachedImages] = useState<File[]>([]);
	const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
	const [bufferedText, setBufferedText] = useState<string | null>(null);
	const [isCompacting, setIsCompacting] = useState(false);
	const [currentTodos, setCurrentTodos] = useState<TodoItem[] | null>(narrator?.todosJson ?? null);
	const [archiveConfirmOpened, { open: openArchiveConfirm, close: closeArchiveConfirm }] =
		useDisclosure(false);
	const [todosToolUseId, setTodosToolUseId] = useState<string | null>(
		narrator?.todosToolUseId ?? null,
	);
	const [expandedToolUseId, setExpandedToolUseId] = useState<string | null>(null);
	const [editExpandOverride, setEditExpandOverride] = useState<boolean | null>(null);

	// Sync todos from props when narrator data refreshes (e.g. page reload)
	useEffect(() => {
		if (narrator?.todosJson) setCurrentTodos(narrator.todosJson);
	}, [narrator?.todosJson]);

	// Clear expandedToolUseId after the card has expanded
	useEffect(() => {
		if (!expandedToolUseId) return;
		const timer = setTimeout(() => setExpandedToolUseId(null), 500);
		return () => clearTimeout(timer);
	}, [expandedToolUseId]);

	const activeTodo = useMemo(() => {
		if (!currentTodos?.length) return null;
		return currentTodos.find((t: TodoItem) => t.status === "in_progress") ?? null;
	}, [currentTodos]);

	// Long-press interrupt: hold 600ms to trigger, with progress overlay
	const [interruptProgress, setInterruptProgress] = useState(0);
	const interruptTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const interruptFiredRef = useRef(false);
	const clearInterruptTimer = useCallback(() => {
		if (interruptTimerRef.current) {
			clearInterval(interruptTimerRef.current);
			interruptTimerRef.current = null;
		}
		setInterruptProgress(0);
		interruptFiredRef.current = false;
	}, []);
	const startInterruptPress = useCallback(() => {
		interruptFiredRef.current = false;
		const start = Date.now();
		const duration = 600;
		interruptTimerRef.current = setInterval(() => {
			const elapsed = Date.now() - start;
			const pct = Math.min(elapsed / duration, 1);
			setInterruptProgress(pct);
			if (pct >= 1 && !interruptFiredRef.current) {
				interruptFiredRef.current = true;
				if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
				interruptTimerRef.current = null;
				interruptMutation.mutate(narratorId);
			}
		}, 16);
	}, [interruptMutation, narratorId]);
	useEffect(() => clearInterruptTimer, [clearInterruptTimer]);

	const isWorking = sending || narrator?.status === "thinking";
	const isWaiting = narrator?.status === "waiting";
	const isPlanning = narrator?.sdkPlanMode && narrator?.status === "thinking";
	const showWorkIndicator = !!(activeTodo || isWorking || isWaiting || isCompacting);

	// Memoize blob URLs to avoid creating new ones on every render
	const imagePreviewUrls = useMemo(
		() => attachedImages.map((f) => URL.createObjectURL(f)),
		[attachedImages],
	);
	// Revoke old blob URLs when attachedImages changes
	useEffect(() => {
		return () => {
			for (const url of imagePreviewUrls) URL.revokeObjectURL(url);
		};
	}, [imagePreviewUrls]);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleValue, setTitleValue] = useState("");
	const [generatingTitle, setGeneratingTitle] = useState(false);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [unreadCount, setUnreadCount] = useState(0);
	const viewportRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const highlightScrolledRef = useRef(false);
	const initialScrollDoneRef = useRef(false);
	const [initialScrollDone, setInitialScrollDone] = useState(false);
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { t: tt } = useTranslation("terminal");

	// Defer heavy message rendering until after the first paint so the shell
	// (header + input) appears instantly when entering a session.
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => {
			startTransition(() => setHydrated(true));
		});
		return () => cancelAnimationFrame(id);
	}, []);

	// Flatten infinite query pages into a single chronological array (incremental)
	const prevPagesRef = useRef<unknown[]>([]);
	const cachedFlatRef = useRef<NarratorMsg[]>([]);
	const messages = useMemo(() => {
		if (!hydrated || !messagesData?.pages) return [];
		const pages = messagesData.pages;
		const prev = prevPagesRef.current;
		// Fast path: same page count, only first page (newest) changed
		if (
			pages.length === prev.length &&
			pages.length > 0 &&
			pages.every((p, i) => i === 0 || p === prev[i])
		) {
			const cached = cachedFlatRef.current;
			const oldFirstLen = prev[0]?.messages?.length ?? 0;
			const result = [...cached.slice(0, cached.length - oldFirstLen), ...pages[0].messages];
			prevPagesRef.current = pages;
			cachedFlatRef.current = result;
			return result;
		}
		// Full rebuild (new page loaded, or multiple pages changed)
		const reversed = [...pages].reverse();
		const result = reversed.flatMap((page) => page.messages);
		prevPagesRef.current = pages;
		cachedFlatRef.current = result;
		return result;
	}, [hydrated, messagesData]);

	// Derive isCompacting from persisted messages on initial load / data refresh
	useEffect(() => {
		if (!messages.length) return;
		const last = messages[messages.length - 1];
		const blocks = Array.isArray(last.contentJson) ? last.contentJson : [];
		const compactBlock = blocks.find((b: any) => b.type === "compact");
		if (compactBlock) {
			setIsCompacting(compactBlock.status === "compacting");
		}
	}, [messages]);

	// Build toolUseId → path index for O(1) lookups in WS callbacks (incremental)
	const prevPagesForIndexRef = useRef<unknown[]>([]);
	const toolUseIndexRef = useRef<MessageIndex>(new Map());
	const toolUseIndex = useMemo(() => {
		if (!hydrated || !messagesData?.pages) return new Map();
		const result = updateToolUseIndex(
			toolUseIndexRef.current,
			prevPagesForIndexRef.current,
			messagesData.pages,
		);
		prevPagesForIndexRef.current = messagesData.pages;
		return result;
	}, [hydrated, messagesData]);
	toolUseIndexRef.current = toolUseIndex;

	// Permission decision handlers — use a ref so they can be defined before useNarratorWS
	const sendPermissionDecisionRef = useRef<
		| ((
				requestId: string,
				decision: "allow" | "deny",
				message?: string,
				answers?: Record<string, string>,
				feedbackText?: string,
		  ) => void)
		| null
	>(null);
	const sendBufferMessageRef = useRef<((targetNarratorId: string, text: string) => void) | null>(
		null,
	);

	const handlePermissionDecision = useCallback(
		(requestId: string, decision: "allow" | "deny", feedbackText?: string) => {
			sendPermissionDecisionRef.current?.(requestId, decision, undefined, undefined, feedbackText);
			setPendingPermission(null);
		},
		[],
	);

	// Use ref for pendingPermission so handleQuestionSubmit doesn't depend on it
	const pendingPermRef = useRef(pendingPermission);
	pendingPermRef.current = pendingPermission;

	const handleQuestionSubmit = useCallback(
		(requestId: string, answers: Record<string, string>) => {
			sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
			// Merge answers into the cached toolCalls[].inputJson so AskDetail can display them
			const perm = pendingPermRef.current;
			if (perm?.toolUseId) {
				const mergedInput = { ...perm.inputJson, answers };
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					let anyChanged = false;
					const pages = old.pages.map((page: MessagesPage) => {
						const { messages, changed } = mergeToolCallFieldsInTree(page.messages, perm.toolUseId, {
							inputJson: mergedInput,
						});
						if (changed) anyChanged = true;
						return changed ? { ...page, messages } : page;
					});
					return anyChanged ? { ...old, pages } : old;
				});
			}
			setPendingPermission(null);
		},
		[qc, messagesQueryKey],
	);

	const handleQuestionDeny = useCallback((requestId: string) => {
		sendPermissionDecisionRef.current?.(requestId, "deny", "User skipped the question");
		setPendingPermission(null);
	}, []);

	const [bgRetryDismissedIds, setBgRetryDismissedIds] = useState<Set<string>>(() => new Set());

	const handleBgAgentRetry = useCallback(
		(toolUseId: string) => {
			setBgRetryDismissedIds((prev) => new Set(prev).add(toolUseId));
			sendBufferMessageRef.current?.(narratorId, t("bgAgentRetryPrompt"));
			interruptMutation.mutate(narratorId);
		},
		[narratorId, interruptMutation, t],
	);

	// Stable permission callbacks via ref — avoids rebuilding the entire message tree
	// when callback identities change. Only pendingPermission and bgRetryDismissedIds
	// (which affect rendered UI) remain as useMemo deps.
	const permCbRef = useRef<PermissionCallbacks | null>(null);
	permCbRef.current = {
		pendingPermission,
		onPermissionDecision: handlePermissionDecision,
		onQuestionSubmit: handleQuestionSubmit,
		onQuestionDeny: handleQuestionDeny,
		onBgAgentRetry: handleBgAgentRetry,
		bgRetryDismissedIds,
	};
	const stablePermCb = useMemo<PermissionCallbacks>(
		() => ({
			pendingPermission: null, // overridden per-render below
			onPermissionDecision: (...args) => permCbRef.current.onPermissionDecision(...args),
			onQuestionSubmit: (...args) => permCbRef.current.onQuestionSubmit(...args),
			onQuestionDeny: (...args) => permCbRef.current.onQuestionDeny(...args),
			onBgAgentRetry: (...args) => permCbRef.current.onBgAgentRetry?.(...args),
			bgRetryDismissedIds: new Set(),
		}),
		[],
	);

	// Per-page memoized rendering — only changed pages re-render on WS updates.
	// highlightedId is intentionally excluded from deps to avoid rebuilding
	// the entire message tree on every highlight change.
	// pendingPermission IS included because it changes rarely (only on permission
	// request/resolve) and must trigger a re-render so the inline permission UI
	// appears correctly — especially on page reload when loaded via API.
	const forkHandler = narrator?.chapterId ? onForkFromMessage : undefined;
	const renderPermCb = useMemo(
		() => ({ ...stablePermCb, pendingPermission, bgRetryDismissedIds }),
		[stablePermCb, pendingPermission, bgRetryDismissedIds],
	);

	// Progressive rendering: render bottom messages first, then fill upward in batches.
	// Also used for loadOlder — large prepends trigger progressive rendering with
	// per-batch scroll compensation instead of rendering all 50 messages at once.
	// Reset when switching narrator
	const prevNarratorIdRef = useRef(narratorId);
	if (prevNarratorIdRef.current !== narratorId) {
		prevNarratorIdRef.current = narratorId;
		if (initialScrollDoneRef.current) {
			initialScrollDoneRef.current = false;
			setInitialScrollDone(false);
		}
	}
	const skipProgressive = !!highlightMessageId;
	const { visibleCount, done: renderDone } = useProgressiveMessageCount(
		messages.length,
		10,
		skipProgressive,
		narratorId,
		viewportRef,
	);

	// Trim message cache on unmount / narrator switch: keep only the newest
	// pages totalling ~200 messages to avoid heavy progressive re-renders.
	// Capture the key inside the effect so cleanup trims the *old* narrator's
	// cache (not the new one — refs would already point to the new key).
	useEffect(() => {
		const keyToTrim = messagesQueryKey;
		return () => {
			const MAX_CACHED_MESSAGES = 200;
			qc.setQueryData(keyToTrim, (old: any) => {
				if (!old?.pages?.length || old.pages.length <= 1) return old;
				let total = 0;
				let keepCount = 0;
				for (const page of old.pages) {
					total += page.messages?.length ?? 0;
					keepCount++;
					if (total >= MAX_CACHED_MESSAGES) break;
				}
				if (keepCount >= old.pages.length) return old;
				return {
					...old,
					pages: old.pages.slice(0, keepCount),
					pageParams: old.pageParams.slice(0, keepCount),
				};
			});
		};
	}, [messagesQueryKey, qc]);

	// Build visible page elements based on visibleCount (message-level progressive rendering).
	const showTokenUsage = userPrefs?.showTokenUsage ?? false;

	// Pages are stored newest-first in messagesData.pages; we reverse to display oldest-first.
	// We walk from the bottom (newest page) upward, allocating visibleCount messages across pages.
	const visibleElements = useMemo(() => {
		if (!messagesData?.pages || visibleCount === 0) return [];
		const pages = messagesData.pages;
		const reversed = [...pages].reverse(); // oldest-first for display
		if (visibleCount >= messages.length) {
			// All messages visible — render all pages without maxMessages constraint
			return reversed.map((page, i) => (
				<MemoizedPageElements
					key={`page-${pages.length - 1 - i}`}
					page={page}
					narratorId={narratorId}
					onForkFromMessage={forkHandler}
					highlightedId={highlightedId}
					permCb={renderPermCb}
					expandedToolUseId={expandedToolUseId}
					editExpandOverride={editExpandOverride}
					showTokenUsage={showTokenUsage}
				/>
			));
		}
		// Partial rendering: walk from newest page (end of reversed) backward
		const result: React.ReactNode[] = [];
		let remaining = visibleCount;
		for (let i = reversed.length - 1; i >= 0 && remaining > 0; i--) {
			const page = reversed[i];
			const pageLen = page.messages.length;
			const maxMsg = Math.min(remaining, pageLen);
			result.unshift(
				<MemoizedPageElements
					key={`page-${pages.length - 1 - i}`}
					page={page}
					narratorId={narratorId}
					onForkFromMessage={forkHandler}
					highlightedId={highlightedId}
					permCb={renderPermCb}
					expandedToolUseId={expandedToolUseId}
					editExpandOverride={editExpandOverride}
					showTokenUsage={showTokenUsage}
					maxMessages={maxMsg < pageLen ? maxMsg : undefined}
				/>,
			);
			remaining -= maxMsg;
		}
		return result;
	}, [
		messagesData,
		messages.length,
		visibleCount,
		narratorId,
		forkHandler,
		renderPermCb,
		expandedToolUseId,
		editExpandOverride,
		highlightedId,
		showTokenUsage,
	]);

	const handleLoadOlder = useCallback(() => {
		if (isFetchingNextPage) return;
		fetchNextPage();
	}, [fetchNextPage, isFetchingNextPage]);

	// Auto-load older messages: scrollTop-based detection.
	// Trigger loadOlder when scrollTop > 0 && scrollTop < viewportHeight (user is
	// near the top). scrollTop === 0 is never used as a trigger — it's reserved for
	// the overflow-anchor hack in useProgressiveMessageCount.
	// The effect tears down when isFetchingNextPage becomes true (preventing
	// re-trigger during fetch) and re-attaches when the fetch completes.
	const handleLoadOlderRef = useRef(handleLoadOlder);
	handleLoadOlderRef.current = handleLoadOlder;
	useEffect(() => {
		if (!autoLoadEnabled || !hasNextPage || !initialScrollDone || !renderDone || isFetchingNextPage)
			return;
		const vp = viewportRef.current;
		if (!vp) return;
		const check = () => {
			const st = vp.scrollTop;
			// Don't fetch at scrollTop 0 (anchor hack territory) or when content
			// doesn't fill the viewport (scrollHeight <= clientHeight).
			if (st > 0 && st < vp.clientHeight * 2 && vp.scrollHeight > vp.clientHeight) {
				handleLoadOlderRef.current();
			}
		};
		// Check immediately — user may already be near the top
		check();
		vp.addEventListener("scroll", check, { passive: true });
		return () => vp.removeEventListener("scroll", check);
	}, [autoLoadEnabled, hasNextPage, initialScrollDone, renderDone, isFetchingNextPage]);

	// --- Scroll state: user-input driven ---
	// isAtBottom is only set to false by user input events (wheel/touch/scrollbar).
	// Programmatic scrolls (ResizeObserver, scrollToBottom) don't flip it.
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;

	// Smooth-follow refs — declared early so the callback ref closure can read them.
	const followRafRef = useRef(0);
	const followingRef = useRef(false);

	// Callback ref to bind user-input listeners as soon as viewport mounts.
	const lastTouchYRef = useRef(0);
	const cleanupRef = useRef<(() => void) | null>(null);
	const viewportCallbackRef = useCallback((node: HTMLDivElement | null) => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		(viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		if (!node) return;

		const checkAtBottom = () => {
			const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 30;
			if (atBottom && !isAtBottomRef.current) {
				isAtBottomRef.current = true;
				setIsAtBottom(true);
				setUnreadCount(0);
			}
		};
		const detachFromBottom = () => {
			if (isAtBottomRef.current) {
				isAtBottomRef.current = false;
				setIsAtBottom(false);
			}
		};

		const onWheel = (e: WheelEvent) => {
			if (e.deltaY < 0) detachFromBottom();
			// checkAtBottom handled by scrollend for inertia correctness
		};
		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length > 0) lastTouchYRef.current = e.touches[0].clientY;
		};
		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length === 0) return;
			const cur = e.touches[0].clientY;
			const delta = lastTouchYRef.current - cur;
			lastTouchYRef.current = cur;
			if (delta < 0) detachFromBottom();
			// checkAtBottom handled by scrollend for inertia correctness
		};

		// Generic scroll direction tracking — covers middle-click autoscroll,
		// Mantine custom scrollbar drag, keyboard scroll, and any other source.
		// Detach on upward scroll unless the lerp follow loop is driving it.
		let lastScrollTop = node.scrollTop;

		const onScroll = () => {
			const cur = node.scrollTop;
			if (!followingRef.current && cur < lastScrollTop) {
				detachFromBottom();
			}
			lastScrollTop = cur;
		};

		// scrollend fires after ALL scroll types finish (inertia, autoscroll,
		// scrollbar drag, programmatic). We run checkAtBottom here so that
		// inertia/middle-click/scrollbar-drag reaching the bottom is detected.
		const onScrollEnd = () => {
			// Skip if the lerp follow loop is driving the scroll — that loop
			// sets isAtBottom itself when it finishes.
			if (followingRef.current) return;
			checkAtBottom();
		};

		node.addEventListener("wheel", onWheel, { passive: true });
		node.addEventListener("touchstart", onTouchStart, { passive: true });
		node.addEventListener("touchmove", onTouchMove, { passive: true });
		node.addEventListener("scroll", onScroll, { passive: true });
		node.addEventListener("scrollend", onScrollEnd, { passive: true });
		cleanupRef.current = () => {
			node.removeEventListener("wheel", onWheel);
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("scroll", onScroll);
			node.removeEventListener("scrollend", onScrollEnd);
		};
	}, []);

	// Smooth-follow animation: lerp towards latest scrollHeight each frame.
	// Shared by ResizeObserver (auto-follow) and scrollToBottom button.

	const startFollowing = useCallback(() => {
		const step = () => {
			const vp = viewportRef.current;
			if (!vp) {
				followingRef.current = false;
				return;
			}
			const target = vp.scrollHeight - vp.clientHeight;
			const gap = target - vp.scrollTop;
			if (gap < 1) {
				vp.scrollTop = target;
				followingRef.current = false;
				if (!isAtBottomRef.current) {
					isAtBottomRef.current = true;
					setIsAtBottom(true);
					setUnreadCount(0);
				}
				return;
			}
			vp.scrollTop += Math.max(gap * 0.25, 1);
			followRafRef.current = requestAnimationFrame(step);
		};
		// Always (re)start — cancel any existing animation first
		followingRef.current = true;
		cancelAnimationFrame(followRafRef.current);
		followRafRef.current = requestAnimationFrame(step);
	}, []);

	const stopFollowing = useCallback(() => {
		followingRef.current = false;
		cancelAnimationFrame(followRafRef.current);
	}, []);

	const scrollToBottom = useCallback(
		(instant?: boolean) => {
			const vp = viewportRef.current;
			if (!vp) return;
			// Ensure isAtBottom is true so ResizeObserver keeps following
			if (!isAtBottomRef.current) {
				isAtBottomRef.current = true;
				setIsAtBottom(true);
			}
			setUnreadCount(0);
			if (instant) {
				vp.scrollTop = vp.scrollHeight;
			} else {
				startFollowing();
			}
		},
		[startFollowing],
	);

	// Initial scroll to bottom — wait for progressive render to finish,
	// then instant-scroll and mark done. The ref is set synchronously so
	// ResizeObserver starts working immediately.
	// Skip if the user has already scrolled up during progressive rendering.

	useEffect(() => {
		if (
			!initialScrollDoneRef.current &&
			messages.length > 0 &&
			renderDone &&
			!highlightMessageId &&
			isAtBottomRef.current
		) {
			initialScrollDoneRef.current = true;
			setInitialScrollDone(true);
			scrollToBottom(true);
		}
		// If user scrolled away before progressive render finished, still mark
		// initial scroll as done so loadOlder detection can activate.
		if (
			!initialScrollDoneRef.current &&
			messages.length > 0 &&
			renderDone &&
			!isAtBottomRef.current
		) {
			initialScrollDoneRef.current = true;
			setInitialScrollDone(true);
		}
	}, [messages, renderDone, scrollToBottom, highlightMessageId]);

	// Auto-scroll via ResizeObserver: when content grows and user is at bottom,
	// start the lerp follow loop. It chases the latest scrollHeight each frame.
	// initialScrollDone is a trigger dep: contentRef.current is null on first mount,
	// so we need the effect to re-run once initialScrollDone flips to true (at which
	// point the DOM is ready) to actually observe the content element.
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialScrollDone is a trigger dep, not read inside
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;

		const contentObserver = new ResizeObserver(() => {
			if (!initialScrollDoneRef.current) return;
			if (isAtBottomRef.current && !highlightMessageId) {
				startFollowing();
			} else if (!isAtBottomRef.current && !highlightMessageId) {
				// Passive recovery: re-check if we're actually at bottom.
				const vp = viewportRef.current;
				if (vp && vp.scrollHeight - vp.scrollTop - vp.clientHeight < 30) {
					isAtBottomRef.current = true;
					setIsAtBottom(true);
				}
			}
		});
		contentObserver.observe(content);

		// Viewport resize (e.g. input area appearing after SPA refresh) must
		// trigger lerp even during progressive render — not gated by initialScrollDone.
		const vp = viewportRef.current;
		const vpObserver = new ResizeObserver(() => {
			if (isAtBottomRef.current && !highlightMessageId) {
				startFollowing();
			}
		});
		if (vp) vpObserver.observe(vp);

		return () => {
			contentObserver.disconnect();
			vpObserver.disconnect();
			stopFollowing();
		};
	}, [highlightMessageId, startFollowing, stopFollowing, initialScrollDone]);

	// Scroll to highlighted message from search — only once on initial load
	useEffect(() => {
		if (!highlightMessageId || !messages.length || highlightScrolledRef.current) return;
		const el = document.getElementById(`msg-${highlightMessageId}`);
		if (!el) return;
		highlightScrolledRef.current = true;
		requestAnimationFrame(() => {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			setTimeout(() => {
				setHighlightedId(highlightMessageId);
				setTimeout(() => setHighlightedId(null), 1600);
			}, 400);
		});
	}, [highlightMessageId, messages]);

	// WebSocket for real-time events
	const { connected, disconnected, sendPermissionDecision, sendBufferMessage, cancelBuffer } =
		useNarratorWS(narratorId, {
			onStreamEvent: (wsData: Record<string, unknown>) => {
				// When not actively sending from this tab (i.e. SSE reader is not running),
				// accumulate streaming deltas from WebSocket so the user sees partial content
				// even after navigating away and back during an active response.
				if (!sendingRef.current) {
					const ev = wsData.event;
					if (
						ev?.type === "content_block_delta" &&
						ev.delta?.type === "text_delta" &&
						ev.delta.text
					) {
						streamingRef.current += ev.delta.text;
						setStreamingVersion((v) => v + 1);
					}
				}
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				// Derive compacting state from system compact messages
				const blocks = Array.isArray(wsData.message?.contentJson) ? wsData.message.contentJson : [];
				const compactBlock = blocks.find((b: any) => b.type === "compact");
				if (compactBlock) {
					setIsCompacting(compactBlock.status === "compacting");
				} else {
					setIsCompacting(false);
				}
				// Clear streaming buffer when a full assistant message arrives via WS
				if (wsData.message?.role === "assistant" && streamingRef.current) {
					streamingRef.current = "";
					setStreamingVersion((v) => v + 1);
				}
				if (wsData.message?.id && wsData.message?.createdAt) {
					const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };

					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;

						// Child message: insert into parent's children array in the tree
						if (newMsg.parentToolUseId) {
							return insertChildIntoCache(old, newMsg);
						}

						// Top-level message: append to first page
						const pages = [...old.pages];
						const firstPage = { ...pages[0] };
						if (firstPage.messages.some((m: NarratorMsg) => m.id === newMsg.id)) {
							return old;
						}

						// Track unread count when user is scrolled up
						if (!isAtBottomRef.current && newMsg.role === "assistant") {
							setUnreadCount((c) => c + 1);
						}

						// Replace optimistic user message if one exists — revoke blob URLs
						const optimistic = firstPage.messages.filter(
							(m: NarratorMsg) => String(m.id).startsWith("optimistic-") && m.role === newMsg.role,
						);
						for (const om of optimistic) {
							if (Array.isArray(om.contentJson)) {
								for (const block of om.contentJson) {
									if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
								}
							}
						}
						const withoutOptimistic = firstPage.messages.filter(
							(m: NarratorMsg) => !String(m.id).startsWith("optimistic-") || m.role !== newMsg.role,
						);
						firstPage.messages = [...withoutOptimistic, newMsg];
						pages[0] = firstPage;
						return { ...old, pages };
					});
				} else {
					qc.invalidateQueries({ queryKey: messagesQueryKey });
				}
			},
			onUserMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				if (!wsData.message?.id || !wsData.message?.createdAt) return;
				const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };

				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) {
						return {
							pages: [{ messages: [newMsg], hasMore: false, nextCursor: null }],
							pageParams: [undefined],
						};
					}
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };

					// Skip if already present
					if (firstPage.messages.some((m: NarratorMsg) => m.id === newMsg.id)) {
						return old;
					}

					// Replace optimistic user message if one exists — revoke blob URLs
					const optimistic = firstPage.messages.filter(
						(m: NarratorMsg) => String(m.id).startsWith("optimistic-") && m.role === "user",
					);
					for (const om of optimistic) {
						if (Array.isArray(om.contentJson)) {
							for (const block of om.contentJson) {
								if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
							}
						}
					}
					const withoutOptimistic = firstPage.messages.filter(
						(m: NarratorMsg) => !String(m.id).startsWith("optimistic-") || m.role !== "user",
					);
					firstPage.messages = [...withoutOptimistic, newMsg];
					pages[0] = firstPage;
					return { ...old, pages };
				});
			},
			onToolCompleted: (toolUseId: string, status: string, output?: unknown) => {
				// Update tool call status using indexed lookup (O(1) instead of full tree traversal)
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return updateToolCallByIndex(old, toolUseId, status, output, toolUseIndexRef.current);
				});
			},
			onPermissionRequest: (request) => {
				setPendingPermission(request);
			},
			onPermissionResolved: () => {
				setPendingPermission(null);
			},
			onStatusChange: () => {
				setIsCompacting(false);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			},
			onTitleUpdated: () => {
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			},
			onTodosUpdated: (todos, toolUseId) => {
				setCurrentTodos(todos);
				if (toolUseId) setTodosToolUseId(toolUseId);
			},
			onBufferSet: (text) => {
				setBufferedText(text);
			},
			onBufferCleared: () => {
				setBufferedText(null);
			},
			onSdkPlanModeChanged: (sdkPlanMode) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, sdkPlanMode } : old,
				);
			},
			onCompacting: () => {
				setIsCompacting(true);
			},
			onCompactDone: () => {
				setIsCompacting(false);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			},
		});

	// Keep ref in sync so early-defined callbacks can use sendPermissionDecision
	sendPermissionDecisionRef.current = sendPermissionDecision;
	sendBufferMessageRef.current = sendBufferMessage;

	// Load any existing pending permission on mount/reconnect
	const prevConnectedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch on mount and reconnect
	useEffect(() => {
		// Only fetch when connected transitions to true (not on disconnect)
		if (!connected && prevConnectedRef.current) {
			prevConnectedRef.current = false;
			return;
		}
		if (connected) prevConnectedRef.current = true;
		// Always fetch on mount (connected may still be false initially)
		api
			.getPendingPermissions(narratorId)
			.then((perms) => {
				if (perms.length > 0) {
					setPendingPermission(perms[0]);
					// Messages use staleTime: Infinity and are only updated via WS.
					// If the user was away when the permission request arrived, the
					// cached messages won't contain the assistant message / tool call
					// that the permission references, so the inline permission UI
					// would never render. Invalidate to fetch the latest messages.
					qc.invalidateQueries({ queryKey: messagesQueryKey });
				}
			})
			.catch(() => {});
		// Hydrate buffered message state for multi-device sync
		api
			.getBufferedMessage(narratorId)
			.then((buf) => setBufferedText(buf?.text ?? null))
			.catch(() => {});
	}, [narratorId, connected]);

	// Mark "done" narrator as read (→ idle) when user enters the panel
	useEffect(() => {
		if (narrator?.status === "done") {
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [narratorId, narrator?.status]);

	// Title editing
	const startEditingTitle = () => {
		setTitleValue(narrator?.title || "");
		setEditingTitle(true);
	};

	useEffect(() => {
		if (editingTitle) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		}
	}, [editingTitle]);

	const saveTitle = async () => {
		if (generatingTitle) return; // Don't save stale value while AI is generating
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== narrator?.title) {
			await api.updateNarratorTitle(narratorId, trimmed);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		}
		setEditingTitle(false);
	};

	const handleGenerateTitle = async () => {
		setGeneratingTitle(true);
		try {
			const { title } = await api.generateNarratorTitle(narratorId);
			setTitleValue(title);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		} finally {
			setGeneratingTitle(false);
		}
	};

	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			saveTitle();
		} else if (e.key === "Escape") {
			setEditingTitle(false);
		}
	};

	// Send message via SSE, or buffer it if a session is already active
	const handleSend = async () => {
		const msg = input.trim();
		if (!msg) return;

		// If a session is active, buffer the message instead of sending directly
		if (sending) {
			sendBufferMessage(narratorId, msg);
			setBufferedText(msg);
			setInput("");
			scrollToBottom(true);
			return;
		}

		const images = [...attachedImages];
		setInput("");
		setAttachedImages([]);
		setSending(true);
		streamingRef.current = "";
		setStreamingVersion(0);

		// Optimistic: show user message immediately (with image previews)
		const optimisticBlocks: ContentBlock[] = [
			...images.map((f) => ({
				type: "image",
				filename: f.name,
				mediaType: f.type,
				previewUrl: URL.createObjectURL(f),
			})),
			{ type: "text", text: msg },
		];
		const optimisticMsg = {
			id: `optimistic-${Date.now()}`,
			role: "user",
			contentJson: optimisticBlocks,
			contentText: msg,
		};
		qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
			if (!old?.pages?.length) {
				return {
					pages: [{ messages: [optimisticMsg], hasMore: false, nextCursor: null }],
					pageParams: [undefined],
				};
			}
			const pages = [...old.pages];
			const firstPage = { ...pages[0] };
			firstPage.messages = [...firstPage.messages, optimisticMsg];
			pages[0] = firstPage;
			return { ...old, pages };
		});

		// User just sent a message — always snap to bottom
		scrollToBottom(true);

		try {
			const endpoint = `/api/narrators/${narratorId}/messages`;
			const headers: Record<string, string> = {};
			const token = getToken();
			if (token) headers.Authorization = `Bearer ${token}`;

			let body: BodyInit;
			if (images.length > 0) {
				const formData = new FormData();
				formData.append("message", msg);
				for (const img of images) {
					formData.append("images", img);
				}
				body = formData;
			} else {
				headers["Content-Type"] = "application/json";
				body = JSON.stringify({ message: msg });
			}

			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				body,
			});

			if (!response.ok || !response.body) {
				throw new Error("Failed to send message");
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let currentEventType = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("event:")) {
						currentEventType = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						try {
							const data = JSON.parse(line.slice(5).trim());
							// Accumulate streaming text for display
							if (data?.type === "content_block_delta") {
								const delta = data.delta;
								if (delta?.type === "text_delta" && delta.text) {
									streamingRef.current += delta.text;
									setStreamingVersion((v) => v + 1);
								}
							}
							// Reset streaming text when a full assistant message is persisted,
							// so the next turn starts fresh instead of accumulating all turns.
							if (currentEventType === "assistant_message") {
								streamingRef.current = "";
								setStreamingVersion((v) => v + 1);
							}
						} catch {
							// ignore parse errors in SSE data
						}
						currentEventType = "";
					}
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to send message";
			notifications.show({
				title: "Error",
				message,
				color: "red",
			});
		} finally {
			setSending(false);
			streamingRef.current = "";
			setStreamingVersion((v) => v + 1);
			qc.invalidateQueries({ queryKey: messagesQueryKey });
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		}
	};

	const handleCancelBuffer = () => {
		if (bufferedText) {
			cancelBuffer(narratorId);
			setInput(bufferedText); // Restore text to input for re-editing
			setBufferedText(null);
		}
	};

	const addImages = (files: File[]) => {
		const valid = files.filter((f) => {
			if (!ACCEPTED_TYPES.includes(f.type)) return false;
			if (f.size > MAX_IMAGE_SIZE) return false;
			return true;
		});
		if (valid.length > 0) {
			setAttachedImages((prev) => [...prev, ...valid]);
		}
	};

	const handlePaste = (e: React.ClipboardEvent) => {
		const items = e.clipboardData.items;
		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			addImages(imageFiles);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	if (!narrator || messagesLoading)
		return (
			<Center h="100%">
				<Loader />
			</Center>
		);

	return (
		<Stack h="100%" gap={0} style={{ overflow: "hidden" }}>
			{/* Header */}
			<Group
				justify="space-between"
				py="xs"
				px="md"
				style={{ borderBottom: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
			>
				<Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						onClick={() => navigate({ to: ".." })}
					>
						<IconArrowLeft size={16} />
					</ActionIcon>
					{editingTitle ? (
						<TextInput
							ref={titleInputRef}
							value={titleValue}
							onChange={(e) => setTitleValue(e.currentTarget.value)}
							onKeyDown={handleTitleKeyDown}
							onBlur={saveTitle}
							size="xs"
							style={{ flex: 1, maxWidth: 250 }}
							rightSection={
								<ActionIcon
									size="xs"
									variant="subtle"
									onMouseDown={(e: React.MouseEvent) => {
										e.preventDefault();
									}}
									onClick={handleGenerateTitle}
									loading={generatingTitle}
									title={t("generateTitle")}
								>
									<IconSparkles size={12} />
								</ActionIcon>
							}
						/>
					) : (
						<Text
							size="sm"
							fw={500}
							onDoubleClick={startEditingTitle}
							style={{
								cursor: "pointer",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								maxWidth: 250,
							}}
							title={narrator.title || t("untitled")}
						>
							{narrator.title || t("untitled")}
						</Text>
					)}
					{disconnected && (
						<Badge size="xs" variant="dot" color="red">
							{t("disconnected")}
						</Badge>
					)}
				</Group>
				<Group gap="xs">
					<Tooltip
						label={
							editExpandOverride === false
								? t("expandEdits", "Expand edits")
								: t("collapseEdits", "Collapse edits")
						}
					>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							onClick={() =>
								setEditExpandOverride((prev) =>
									prev === null ? false : prev === false ? true : null,
								)
							}
						>
							{editExpandOverride === false ? <IconCode size={16} /> : <IconCodeOff size={16} />}
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("archiveNarrator")}>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="orange"
							loading={archiveMutation.isPending}
							onClick={() => {
								openArchiveConfirm();
							}}
						>
							<IconArchive size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			<Modal
				opened={archiveConfirmOpened}
				onClose={closeArchiveConfirm}
				title={t("archiveConfirmTitle")}
				centered
			>
				<Stack>
					<Text size="sm">{t("archiveActiveWarning")}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={closeArchiveConfirm}>
							{t("cancel")}
						</Button>
						<Button
							color="orange"
							onClick={async () => {
								if (sending || narrator.status === "thinking" || narrator.status === "waiting") {
									await interruptMutation.mutateAsync(narratorId);
								}
								archiveMutation.mutate(narratorId);
								closeArchiveConfirm();
							}}
						>
							{t("confirmArchive")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Fallback permission banner — only shown when permission can't be matched to a tool call */}
			{pendingPermission && !pendingPermission.toolUseId && (
				<Box py="xs" px="md">
					{pendingPermission.toolName === "AskUserQuestion" &&
					pendingPermission.inputJson?.questions ? (
						<AskUserQuestionBanner
							requestId={pendingPermission.id}
							questions={pendingPermission.inputJson.questions}
							onSubmit={handleQuestionSubmit}
							onDeny={handleQuestionDeny}
						/>
					) : (
						<PermissionBanner request={pendingPermission} onDecision={handlePermissionDecision} />
					)}
				</Box>
			)}

			{/* Messages */}
			<Box pos="relative" style={{ flex: 1, minHeight: 0 }}>
				{(isFetchingNextPage || !renderDone) && (
					<Box pos="absolute" top={0} left={0} right={0} style={{ zIndex: 1 }}>
						<RenderProgress
							indeterminate={isFetchingNextPage}
							value={
								!isFetchingNextPage && messages.length > 0
									? visibleCount / messages.length
									: undefined
							}
						/>
					</Box>
				)}
				<ScrollArea
					h="100%"
					type="always"
					viewportRef={viewportCallbackRef}
					py="sm"
					px="md"
					scrollbars="y"
					styles={{
						viewport: { overscrollBehavior: "contain", overflowAnchor: "auto" },
						scrollbar: renderDone
							? undefined
							: { pointerEvents: "none", opacity: 0, transition: "opacity 150ms ease" },
					}}
				>
					<Stack gap="sm" ref={contentRef}>
						{visibleElements}
						<StreamingBubble
							narratorId={narratorId}
							streamingRef={streamingRef}
							version={streamingVersion}
						/>
					</Stack>
				</ScrollArea>

				{onSendToTerminal && (
					<SelectionPopover
						containerRef={contentRef}
						onAction={onSendToTerminal}
						label={tt("sendToTerminal")}
					/>
				)}

				{/* Scroll to bottom button */}
				<Box
					style={{
						position: "absolute",
						bottom: 12,
						right: 24,
						zIndex: 10,
						transform: isAtBottom ? "translateY(80px)" : "translateY(0)",
						opacity: isAtBottom ? 0 : 1,
						transition: "transform 200ms ease, opacity 200ms ease",
						pointerEvents: isAtBottom ? "none" : "auto",
					}}
				>
					{unreadCount > 0 && (
						<Badge
							size="sm"
							circle
							color="indigo"
							style={{
								position: "absolute",
								top: -6,
								right: -6,
								zIndex: 1,
								pointerEvents: "none",
							}}
						>
							{unreadCount > 99 ? "99+" : unreadCount}
						</Badge>
					)}
					<ActionIcon
						variant="filled"
						color="gray"
						radius="xl"
						size="lg"
						onClick={() => scrollToBottom()}
						title={
							unreadCount > 0
								? t("scrollToBottomWithCount", { count: unreadCount })
								: t("scrollToBottom")
						}
					>
						<IconArrowDown size={18} />
					</ActionIcon>
				</Box>
			</Box>

			{/* Image previews */}
			{attachedImages.length > 0 && (
				<Group
					pt="xs"
					px="md"
					pb={0}
					gap="xs"
					style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
				>
					{attachedImages.map((file, i) => (
						<Box key={`${file.name}-${i}`} pos="relative" style={{ display: "inline-block" }}>
							<Image
								src={imagePreviewUrls[i]}
								alt={file.name}
								radius="sm"
								h={60}
								w={60}
								fit="cover"
							/>
							<CloseButton
								size="xs"
								radius="xl"
								variant="filled"
								color="dark"
								style={{ position: "absolute", top: -6, right: -6 }}
								onClick={() => setAttachedImages((prev) => prev.filter((_, j) => j !== i))}
								title={t("removeImage")}
							/>
						</Box>
					))}
				</Group>
			)}

			{/* Buffered message indicator */}
			{bufferedText && (
				<Group
					px="md"
					py={4}
					gap="xs"
					style={{
						borderTop:
							attachedImages.length > 0
								? undefined
								: "1px solid var(--mantine-color-default-border)",
						backgroundColor: "var(--mantine-color-blue-light)",
						flexShrink: 0,
					}}
				>
					<Loader size={14} color="blue" />
					<Text size="xs" c="blue" truncate style={{ flex: 1 }}>
						{t("bufferedMessage")}: {bufferedText}
					</Text>
					<CloseButton size="xs" onClick={handleCancelBuffer} title={t("cancelBuffer")} />
				</Group>
			)}

			{/* Status bar — always visible */}
			<Group
				px="md"
				pt="xs"
				pb="xs"
				gap="xs"
				justify="space-between"
				wrap="nowrap"
				style={{
					borderTop:
						attachedImages.length > 0 || bufferedText
							? undefined
							: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
				}}
			>
				{/* Status indicator — doubles as work indicator when active */}
				{showWorkIndicator ? (
					<UnstyledButton
						disabled={!activeTodo}
						onClick={async () => {
							if (!activeTodo || !todosToolUseId) return;
							let msg = findMsgByToolUseIdInTree(messages, todosToolUseId);
							if (!msg) {
								try {
									await qc.refetchQueries({ queryKey: messagesQueryKey });
									const freshData = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
									const freshMessages =
										freshData?.pages?.flatMap((p: MessagesPage) => p.messages) ?? [];
									msg = findMsgByToolUseIdInTree(freshMessages, todosToolUseId);
								} catch {
									return;
								}
							}
							if (!msg) return;
							setExpandedToolUseId(todosToolUseId);
							const el = document.getElementById(`msg-${msg.id}`);
							if (el) {
								el.scrollIntoView({ behavior: "smooth", block: "center" });
								setTimeout(() => {
									setHighlightedId(msg.id);
									setTimeout(() => setHighlightedId(null), 1600);
								}, 400);
							}
						}}
						style={{ minWidth: 0, flex: 1 }}
					>
						<Group gap={6} wrap="nowrap">
							<Loader
								size={14}
								color={
									isCompacting ? "orange" : isWaiting ? "yellow" : isPlanning ? "green" : "blue"
								}
								style={{ flexShrink: 0 }}
							/>
							<Text
								size="xs"
								c={isCompacting ? "orange" : isWaiting ? "yellow" : isPlanning ? "green" : "blue"}
								truncate
							>
								{isCompacting
									? t("compacting")
									: activeTodo
										? activeTodo.content || activeTodo.activeForm
										: isWaiting
											? t("status_waiting")
											: isPlanning
												? t("planning")
												: t("thinking")}
							</Text>
						</Group>
					</UnstyledButton>
				) : (
					<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
						<Box
							w={8}
							h={8}
							style={{
								borderRadius: "50%",
								backgroundColor: `var(--mantine-color-${
									NARRATOR_STATUS_COLORS[narrator.status] ?? "gray"
								}-filled)`,
								flexShrink: 0,
							}}
						/>
						<Text size="xs" c="dimmed">
							{t(`status_${narrator.status}`)}
						</Text>
					</Group>
				)}
				{/* Model & Permission selectors */}
				<Group gap="xs" wrap="nowrap" style={{ flexShrink: 1, minWidth: 0 }}>
					{/* Desktop selects */}
					<Group gap={6} wrap="nowrap" visibleFrom="sm">
						<Menu position="top-end">
							<Menu.Target>
								<NativeSelect
									size="xs"
									data={allModels}
									value={narrator.model ?? ""}
									onChange={() => {}}
									onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
									style={{ pointerEvents: "auto" }}
								/>
							</Menu.Target>
							<Menu.Dropdown>
								{narrator.totalCostUsd != null && narrator.totalCostUsd > 0 && (
									<>
										<Menu.Label ta="right">${narrator.totalCostUsd.toFixed(4)}</Menu.Label>
										<Menu.Divider />
									</>
								)}
								{allModels.map((m) => {
									const val = typeof m === "string" ? m : m.value;
									const label = typeof m === "string" ? m : m.label;
									const selected = narrator.model === val;
									return (
										<Menu.Item
											key={val}
											onClick={() => modelMutation.mutate({ id: narratorId, model: val })}
											rightSection={selected ? <IconCheck size={14} /> : null}
											fw={selected ? 600 : 400}
										>
											{label}
										</Menu.Item>
									);
								})}
							</Menu.Dropdown>
						</Menu>
						<Menu position="top-end">
							<Menu.Target>
								<NativeSelect
									size="xs"
									leftSection={
										PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
											<IconShield size={14} />
										)
									}
									data={[
										{ value: "default", label: t("perm_default") },
										{ value: "acceptEdits", label: t("perm_acceptEdits") },
										{ value: "bypassPermissions", label: t("perm_bypassPermissions") },
										{ value: "dontAsk", label: t("perm_dontAsk") },
									]}
									value={narrator.permissionMode ?? "default"}
									onChange={() => {}}
									onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
									style={{ pointerEvents: "auto" }}
								/>
							</Menu.Target>
							<Menu.Dropdown>
								{(["default", "acceptEdits", "bypassPermissions", "dontAsk"] as const).map(
									(mode) => {
										const selected =
											narrator.permissionMode === mode ||
											(!narrator.permissionMode && mode === "default");
										return (
											<Menu.Item
												key={mode}
												leftSection={PERM_MODE_ICONS[mode]}
												onClick={() =>
													permModeMutation.mutate({ id: narratorId, permissionMode: mode })
												}
												rightSection={selected ? <IconCheck size={14} /> : null}
												fw={selected ? 600 : 400}
											>
												{t(`perm_${mode}`)}
											</Menu.Item>
										);
									},
								)}
							</Menu.Dropdown>
						</Menu>
					</Group>
					{/* Mobile: model & permission */}
					<Group gap={4} wrap="nowrap" hiddenFrom="sm">
						<Menu position="top-end">
							<Menu.Target>
								<ActionIcon variant="subtle" color="gray" size="sm">
									<Text size="xs" fw={600}>
										{(() => {
											const m = allModels.find(
												(x) => (typeof x === "string" ? x : x.value) === narrator.model,
											);
											const label = m ? (typeof m === "string" ? m : m.label) : narrator.model;
											return (label ?? "?")[0].toUpperCase();
										})()}
									</Text>
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								{narrator.totalCostUsd != null && narrator.totalCostUsd > 0 && (
									<>
										<Menu.Label ta="right">${narrator.totalCostUsd.toFixed(4)}</Menu.Label>
										<Menu.Divider />
									</>
								)}
								<Menu.Label>{t("modelTooltip")}</Menu.Label>
								{allModels.map((m) => {
									const val = typeof m === "string" ? m : m.value;
									const label = typeof m === "string" ? m : m.label;
									const selected = narrator.model === val;
									return (
										<Menu.Item
											key={val}
											onClick={() => modelMutation.mutate({ id: narratorId, model: val })}
											rightSection={selected ? <IconCheck size={14} /> : null}
											fw={selected ? 600 : 400}
										>
											{label}
										</Menu.Item>
									);
								})}
							</Menu.Dropdown>
						</Menu>
						<Menu position="top-end">
							<Menu.Target>
								<ActionIcon variant="subtle" color="gray" size="sm">
									{PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
										<IconShield size={16} />
									)}
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Label>{t("permissionMode")}</Menu.Label>
								{(["default", "acceptEdits", "bypassPermissions", "dontAsk"] as const).map(
									(mode) => {
										const selected =
											narrator.permissionMode === mode ||
											(!narrator.permissionMode && mode === "default");
										return (
											<Menu.Item
												key={mode}
												leftSection={PERM_MODE_ICONS[mode]}
												onClick={() =>
													permModeMutation.mutate({ id: narratorId, permissionMode: mode })
												}
												rightSection={selected ? <IconCheck size={14} /> : null}
												fw={selected ? 600 : 400}
											>
												{t(`perm_${mode}`)}
											</Menu.Item>
										);
									},
								)}
							</Menu.Dropdown>
						</Menu>
					</Group>
					{onToggleTerminal && (
						<Tooltip label={terminalOpen ? tt("closeTerminal") : tt("openTerminal")}>
							<ActionIcon
								variant="subtle"
								color={terminalOpen ? "blue" : "gray"}
								size="sm"
								onClick={onToggleTerminal}
							>
								<IconTerminal size={16} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>

			{/* Input */}
			<Box px="md" pb="xs" style={{ flexShrink: 0 }}>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					multiple
					style={{ display: "none" }}
					onChange={(e) => {
						if (e.target.files) {
							addImages(Array.from(e.target.files));
							e.target.value = "";
						}
					}}
				/>
				{/* Main input row */}
				<Group gap="xs" align="end" wrap="nowrap">
					{/* Attach button */}
					<Tooltip label={t("attachImage")}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => fileInputRef.current?.click()}
							mb={4}
						>
							<IconPaperclip size={18} />
						</ActionIcon>
					</Tooltip>
					{/* Textarea */}
					<Textarea
						flex={1}
						placeholder={t("sendPlaceholder")}
						value={input}
						onChange={(e) => setInput(e.currentTarget.value)}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						autosize
						minRows={1}
						maxRows={6}
					/>
					{(() => {
						const isActive =
							sending || narrator.status === "thinking" || narrator.status === "waiting";
						const showInterrupt = isActive && !input.trim();
						return showInterrupt ? (
							<Button
								color="red"
								variant="light"
								onMouseDown={startInterruptPress}
								onMouseUp={clearInterruptTimer}
								onMouseLeave={clearInterruptTimer}
								onTouchStart={startInterruptPress}
								onTouchEnd={clearInterruptTimer}
								onTouchCancel={clearInterruptTimer}
								loading={interruptMutation.isPending}
								style={{ position: "relative", overflow: "hidden", userSelect: "none" }}
							>
								{interruptProgress > 0 && interruptProgress < 1 && (
									<div
										style={{
											position: "absolute",
											inset: 0,
											background: "var(--mantine-color-red-filled)",
											opacity: 0.25,
											transformOrigin: "left",
											transform: `scaleX(${interruptProgress})`,
											pointerEvents: "none",
										}}
									/>
								)}
								<span style={{ position: "relative" }}>{t("interrupt")}</span>
							</Button>
						) : (
							<Button
								onClick={handleSend}
								loading={sending && !input.trim()}
								disabled={!input.trim() || (sending && !!bufferedText)}
							>
								{sending ? t("queue") : tc("send")}
							</Button>
						);
					})()}
				</Group>
			</Box>
		</Stack>
	);
}
