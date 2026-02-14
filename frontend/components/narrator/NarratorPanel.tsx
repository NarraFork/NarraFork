import {
	ActionIcon,
	Badge,
	Box,
	Button,
	CloseButton,
	Divider,
	Group,
	Image,
	Loader,
	Modal,
	Paper,
	ScrollArea,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
	ThemeIcon,
	Tooltip,
	Transition,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArchive,
	IconArrowDown,
	IconChevronDown,
	IconChevronRight,
	IconCode,
	IconCodeOff,
	IconHandStop,
	IconListCheck,
	IconPaperclip,
	IconPencilCheck,
	IconRobot,
	IconShield,
	IconShieldOff,
	IconSparkles,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useArchiveNarrator,
	useInterruptNarrator,
	useNarratorMessages,
	useUpdateModel,
	useUpdatePermissionMode,
} from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api, getToken } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { CodeBlockWithActions } from "./CodeBlockWithActions";
import { LazyCollapse } from "./LazyCollapse";
import { MessageBubble } from "./MessageBubble";
import { findMsgByToolUseIdInTree, insertChildIntoCache, updateToolCallInTree } from "./message-tree-utils";
import { PermissionBanner } from "./PermissionBanner";
import type { PendingPermission, ToolCallData } from "./ToolCallCard";
import { isEditTool, STATUS_COLORS, StatusIcon, ToolCallCard } from "./ToolCallCard";

// Inject highlight blink animation
if (typeof document !== "undefined") {
	const id = "narrator-highlight-blink";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `@keyframes highlight-blink {
			0%, 100% { background-color: transparent }
			25%, 75% { background-color: var(--mantine-color-yellow-light) }
		}`;
		document.head.appendChild(style);
	}
}

// --- Message-level helpers ---

function isToolOnlyMessage(msg: any): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return (
		msg.role === "assistant" && blocks.length > 0 && blocks.every((b: any) => b.type === "tool_use")
	);
}

function resolveToolCallFromMsg(msg: any): ToolCallData | null {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const block = blocks.find((b: any) => b.type === "tool_use");
	if (!block) return null;
	const tc = msg.toolCalls?.find((t: any) => t.toolUseId === block.id);
	return {
		toolName: block.name,
		toolUseId: block.id,
		inputJson: block.input,
		outputJson: tc?.outputJson,
		status: tc?.status ?? "running",
		durationMs: tc?.durationMs,
		errorMessage: tc?.errorMessage,
	};
}

// --- SubagentCard: renders a Task tool call with its child messages (pre-nested from backend) ---

function SubagentCard({
	toolCall,
	childMessages,
	narratorId,
	inRun,
	isLast,
	permCb,
	editExpandOverride,
}: {
	toolCall: ToolCallData;
	childMessages: any[];
	narratorId: string;
	inRun?: boolean;
	isLast?: boolean;
	permCb?: PermissionCallbacks;
	editExpandOverride?: boolean | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showPrompt, setShowPrompt] = useState(false);
	const [showCalls, setShowCalls] = useState(false);
	const input = toolCall.inputJson ?? {};
	const description = input.description ?? input.prompt?.slice(0, 80) ?? "Subagent";
	const agentType = input.subagent_type ?? "agent";
	const prompt = input.prompt ?? "";
	const statusColor = STATUS_COLORS[toolCall.status] ?? "gray";

	// Extract result text from outputJson
	const resultText = useMemo(() => {
		const out = toolCall.outputJson;
		if (!out) return "";
		if (typeof out === "string") return out;
		if (Array.isArray(out)) {
			return out
				.filter((b: any) => b.text)
				.map((b: any) => b.text)
				.join("\n");
		}
		return "";
	}, [toolCall.outputJson]);

	// Collect child tool calls
	const childToolCalls: {
		tc: ToolCallData;
		toolUseId: string | null;
		msgId: string;
		childMsg: any;
	}[] = [];
	for (const cm of childMessages) {
		if (!isToolOnlyMessage(cm)) continue;
		const tc = resolveToolCallFromMsg(cm);
		if (tc) childToolCalls.push({ tc, toolUseId: tc.toolUseId, msgId: cm.id, childMsg: cm });
	}

	const totalMs =
		childToolCalls.reduce((sum, c) => sum + (c.tc.durationMs ?? 0), 0) + (toolCall.durationMs ?? 0);

	// Find the child tool call that has a pending permission (if any)
	const permChild = permCb?.pendingPermission?.toolUseId
		? childToolCalls.find((c) => c.tc.toolUseId === permCb.pendingPermission?.toolUseId)
		: null;

	// Auto-expand the subagent card when a child needs permission
	useEffect(() => {
		if (permChild) setExpanded(true);
	}, [permChild]);

	const content = (
		<Box>
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
			<LazyCollapse in={expanded}>
				{/* Result — shown directly when expanded */}
				{resultText && (
					<Box px="xs" pb={4}>
						<CodeBlockWithActions
							content={resultText}
							style={{
								fontSize: 11,
								maxHeight: 300,
								overflow: "auto",
								whiteSpace: "pre-wrap",
							}}
							title={`${agentType} — ${description}`}
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
								<CodeBlockWithActions
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
							<Box pl="md" mt={4} style={{ borderLeft: "2px solid var(--mantine-color-indigo-3)" }}>
								{childToolCalls.map(({ tc, toolUseId, msgId, childMsg }) => {
									const key = toolUseId ?? tc.toolName;
									const subChildren = childMsg?.children;
									const matchedPerm =
										permCb?.pendingPermission &&
										tc.toolUseId &&
										tc.toolUseId === permCb.pendingPermission.toolUseId
											? permCb.pendingPermission
											: null;
									if ((subChildren && subChildren.length > 0) || tc.toolName === "Task") {
										return (
											<div key={key} id={`msg-${msgId}`}>
												<SubagentCard
													toolCall={tc}
													childMessages={subChildren}
													narratorId={narratorId}
													permCb={permCb}
													editExpandOverride={editExpandOverride}
												/>
											</div>
										);
									}
									return (
										<div key={key} id={`msg-${msgId}`}>
											<ToolCallCard
												toolCall={tc}
												pendingPermission={matchedPerm}
												onPermissionDecision={permCb?.onPermissionDecision}
												onQuestionSubmit={permCb?.onQuestionSubmit}
												onQuestionDeny={permCb?.onQuestionDeny}
												editExpandOverride={editExpandOverride}
											/>
										</div>
									);
								})}
							</Box>
						</LazyCollapse>
					</Box>
				)}
			</LazyCollapse>
			{inRun && !isLast && <Divider />}
		</Box>
	);

	if (inRun) return content;

	return (
		<Paper withBorder radius="sm" style={{ overflow: "hidden" }}>
			{content}
		</Paper>
	);
}

interface PermissionCallbacks {
	pendingPermission: PendingPermission | null;
	onPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
	) => void;
	onQuestionSubmit: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny: (requestId: string) => void;
}

function renderToolRun(
	run: any[],
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
				{run.map((m: any, idx: number) => {
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
									permCb={permCb}
									editExpandOverride={editExpandOverride}
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
					permCb={permCb}
					editExpandOverride={editExpandOverride}
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
	messages: any[],
	narratorId: string,
	onForkFromMessage: ((uuid: string) => void) | undefined,
	highlightedId: string | null,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
	editExpandOverride?: boolean | null,
): { elements: React.ReactNode[] } {
	// Messages are already tree-structured from the backend (children nested).
	// We only need to group consecutive tool-only messages into visual "runs".
	const elements: React.ReactNode[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (isToolOnlyMessage(msg)) {
			const run: any[] = [msg];
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
					<MessageBubble
						narratorId={narratorId}
						message={msg}
						onForkFromMessage={onForkFromMessage}
					/>
				</Box>,
			);
			i++;
		}
	}

	return { elements };
}

const PERM_MODE_ICONS: Record<string, React.ReactNode> = {
	default: <IconShield size={14} />,
	acceptEdits: <IconPencilCheck size={14} />,
	bypassPermissions: <IconShieldOff size={14} />,
	plan: <IconListCheck size={14} />,
	dontAsk: <IconHandStop size={14} />,
};

interface NarratorPanelProps {
	narratorId: string;
	narrator: {
		id: string;
		chapterId?: string | null;
		title?: string | null;
		model: string | null;
		status: string;
		totalCostUsd: number | null;
		permissionMode: string | null;
		todosJson?: any[] | null;
		todosToolUseId?: string | null;
	};
	onForkFromMessage?: (sdkMessageUuid: string) => void;
	highlightMessageId?: string;
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function NarratorPanel({
	narratorId,
	narrator,
	onForkFromMessage,
	highlightMessageId,
}: NarratorPanelProps) {
	const {
		data: messagesData,
		isLoading,
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
	const messagesQueryKey = ["narrators", narratorId, "messages", { around: highlightMessageId }];

	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [streamingText, setStreamingText] = useState("");
	const [attachedImages, setAttachedImages] = useState<File[]>([]);
	const [pendingPermission, setPendingPermission] = useState<any>(null);
	const [bufferedText, setBufferedText] = useState<string | null>(null);
	const [currentTodos, setCurrentTodos] = useState<any[] | null>(narrator.todosJson ?? null);
	const [archiveConfirmOpened, { open: openArchiveConfirm, close: closeArchiveConfirm }] =
		useDisclosure(false);
	const [todosToolUseId, setTodosToolUseId] = useState<string | null>(
		narrator.todosToolUseId ?? null,
	);
	const [expandedToolUseId, setExpandedToolUseId] = useState<string | null>(null);
	const [editExpandOverride, setEditExpandOverride] = useState<boolean | null>(null);

	// Sync todos from props when narrator data refreshes (e.g. page reload)
	useEffect(() => {
		if (narrator.todosJson) setCurrentTodos(narrator.todosJson);
	}, [narrator.todosJson]);

	// Clear expandedToolUseId after the card has expanded
	useEffect(() => {
		if (!expandedToolUseId) return;
		const timer = setTimeout(() => setExpandedToolUseId(null), 500);
		return () => clearTimeout(timer);
	}, [expandedToolUseId]);

	const activeTodo = useMemo(() => {
		if (!currentTodos?.length) return null;
		return currentTodos.find((t: any) => t.status === "in_progress") ?? null;
	}, [currentTodos]);

	const isWorking = sending || narrator.status === "thinking";
	const isWaiting = narrator.status === "waiting";
	const showWorkIndicator = !!(activeTodo || isWorking || isWaiting);

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
	const viewportRef = useRef<HTMLDivElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const highlightScrolledRef = useRef(false);
	const prevScrollHeightRef = useRef(0);
	const loadingOlderRef = useRef(false);
	const initialScrollDoneRef = useRef(false);
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	// Flatten infinite query pages into a single chronological array
	const messages = useMemo(() => {
		if (!messagesData?.pages) return [];
		const reversed = [...messagesData.pages].reverse();
		return reversed.flatMap((page) => page.messages);
	}, [messagesData]);

	// Permission decision handlers — use a ref so they can be defined before useNarratorWS
	const sendPermissionDecisionRef = useRef<
		(
			requestId: string,
			decision: "allow" | "deny",
			message?: string,
			answers?: Record<string, string>,
			feedbackText?: string,
		) => void
	>(null!);

	const handlePermissionDecision = useCallback(
		(requestId: string, decision: "allow" | "deny", feedbackText?: string) => {
			sendPermissionDecisionRef.current?.(requestId, decision, undefined, undefined, feedbackText);
			setPendingPermission(null);
		},
		[],
	);

	const handleQuestionSubmit = useCallback((requestId: string, answers: Record<string, string>) => {
		sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
		setPendingPermission(null);
	}, []);

	const handleQuestionDeny = useCallback((requestId: string) => {
		sendPermissionDecisionRef.current?.(requestId, "deny", "User skipped the question");
		setPendingPermission(null);
	}, []);

	// Compute grouped message elements (tree already built by backend)
	const { elements: groupedElements } = useMemo(
		() =>
			renderTreeMessages(
				messages,
				narratorId,
				narrator.chapterId ? onForkFromMessage : undefined,
				highlightedId,
				{
					pendingPermission,
					onPermissionDecision: handlePermissionDecision,
					onQuestionSubmit: handleQuestionSubmit,
					onQuestionDeny: handleQuestionDeny,
				},
				expandedToolUseId,
				editExpandOverride,
			),
		[
			messages,
			narratorId,
			narrator.chapterId,
			onForkFromMessage,
			highlightedId,
			pendingPermission,
			expandedToolUseId,
			editExpandOverride,
			handlePermissionDecision,
			handleQuestionSubmit,
			handleQuestionDeny,
		],
	);

	// Load older messages with scroll position preservation
	const handleLoadOlder = useCallback(() => {
		const vp = viewportRef.current;
		if (vp) {
			prevScrollHeightRef.current = vp.scrollHeight;
			loadingOlderRef.current = true;
		}
		fetchNextPage();
	}, [fetchNextPage]);

	// Restore scroll position after older messages are prepended
	// biome-ignore lint/correctness/useExhaustiveDependencies: restore scroll after page load
	useLayoutEffect(() => {
		if (loadingOlderRef.current && viewportRef.current) {
			const vp = viewportRef.current;
			vp.scrollTop += vp.scrollHeight - prevScrollHeightRef.current;
			loadingOlderRef.current = false;
		}
	}, [messagesData]);

	// Track whether user is near the bottom of the scroll area
	// + auto-load older messages when scrolled near top
	const handleScroll = useCallback(() => {
		const vp = viewportRef.current;
		if (!vp) return;
		const threshold = 80;
		const atBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight < threshold;
		setIsAtBottom((prev) => (prev !== atBottom ? atBottom : prev));

		// Auto-load older messages when scrolled near top
		if (autoLoadEnabled && vp.scrollTop < 200 && hasNextPage && !isFetchingNextPage) {
			handleLoadOlder();
		}
	}, [autoLoadEnabled, hasNextPage, isFetchingNextPage, handleLoadOlder]);

	const scrollToBottom = useCallback((instant?: boolean) => {
		viewportRef.current?.scrollTo({
			top: viewportRef.current.scrollHeight,
			behavior: instant ? "instant" : "smooth",
		});
	}, []);

	// On initial load, jump to bottom instantly (no animation)
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once when messages first load
	useEffect(() => {
		if (!initialScrollDoneRef.current && messages.length > 0 && !highlightMessageId) {
			initialScrollDoneRef.current = true;
			requestAnimationFrame(() => scrollToBottom(true));
		}
	}, [messages, scrollToBottom, highlightMessageId]);

	// Auto-scroll only when user is already at bottom (smooth for subsequent messages)
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message changes
	useEffect(() => {
		if (initialScrollDoneRef.current && isAtBottomRef.current && !highlightMessageId) {
			scrollToBottom();
		}
	}, [messages, streamingText, scrollToBottom, highlightMessageId]);

	// Scroll to bottom when permission UI appears/disappears (Collapse animation needs time)
	useEffect(() => {
		if (!pendingPermission || !isAtBottomRef.current) return;
		// Delay to let Collapse animation finish expanding
		const timer = setTimeout(() => scrollToBottom(), 350);
		return () => clearTimeout(timer);
	}, [pendingPermission, scrollToBottom]);

	// Scroll to highlighted message from search — only once on initial load
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once when messages load
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
			onMessage: (wsData: any) => {
				if (wsData.message?.id && wsData.message?.createdAt) {
					const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };

					qc.setQueryData(messagesQueryKey, (old: any) => {
						if (!old?.pages?.length) return old;

						// Child message: insert into parent's children array in the tree
						if (newMsg.parentToolUseId) {
							return insertChildIntoCache(old, newMsg);
						}

						// Top-level message: append to first page
						const pages = [...old.pages];
						const firstPage = { ...pages[0] };
						if (firstPage.messages.some((m: any) => m.id === newMsg.id)) {
							return old;
						}
						// Replace optimistic user message if one exists — revoke blob URLs
						const optimistic = firstPage.messages.filter(
							(m: any) => String(m.id).startsWith("optimistic-") && m.role === newMsg.role,
						);
						for (const om of optimistic) {
							if (Array.isArray(om.contentJson)) {
								for (const block of om.contentJson) {
									if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
								}
							}
						}
						const withoutOptimistic = firstPage.messages.filter(
							(m: any) => !String(m.id).startsWith("optimistic-") || m.role !== newMsg.role,
						);
						firstPage.messages = [...withoutOptimistic, newMsg];
						pages[0] = firstPage;
						return { ...old, pages };
					});
				} else {
					qc.invalidateQueries({ queryKey: messagesQueryKey });
				}
			},
			onToolCompleted: (toolUseId: string, status: string, output?: unknown) => {
				// Update tool call status in cached messages (recursing into children)
				qc.setQueryData(messagesQueryKey, (old: any) => {
					if (!old?.pages?.length) return old;
					let anyChanged = false;
					const pages = old.pages.map((page: any) => {
						const { messages, changed } = updateToolCallInTree(
							page.messages,
							toolUseId,
							status,
							output,
						);
						if (changed) anyChanged = true;
						return changed ? { ...page, messages } : page;
					});
					return anyChanged ? { ...old, pages } : old;
				});
			},
			onPermissionRequest: (request) => {
				setPendingPermission(request);
			},
			onPermissionResolved: () => {
				setPendingPermission(null);
			},
			onStatusChange: () => {
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
			},
			onTitleUpdated: () => {
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
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
		});

	// Keep ref in sync so early-defined callbacks can use sendPermissionDecision
	sendPermissionDecisionRef.current = sendPermissionDecision;

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
				if (perms.length > 0) setPendingPermission(perms[0]);
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
		if (narrator.status === "done") {
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [narratorId, narrator.status]);

	// Title editing
	const startEditingTitle = () => {
		setTitleValue(narrator.title || "");
		setEditingTitle(true);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: focus on edit start
	useEffect(() => {
		if (editingTitle) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		}
	}, [editingTitle]);

	const saveTitle = async () => {
		if (generatingTitle) return; // Don't save stale value while AI is generating
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== narrator.title) {
			await api.updateNarratorTitle(narratorId, trimmed);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
		}
		setEditingTitle(false);
	};

	const handleGenerateTitle = async () => {
		setGeneratingTitle(true);
		try {
			const { title } = await api.generateNarratorTitle(narratorId);
			setTitleValue(title);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
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
			return;
		}

		const images = [...attachedImages];
		setInput("");
		setAttachedImages([]);
		setSending(true);
		setStreamingText("");

		// Optimistic: show user message immediately (with image previews)
		const optimisticBlocks: any[] = [
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
		qc.setQueryData(messagesQueryKey, (old: any) => {
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
									setStreamingText((prev) => prev + delta.text);
								}
							}
							// Reset streaming text when a full assistant message is persisted,
							// so the next turn starts fresh instead of accumulating all turns.
							if (currentEventType === "assistant_message") {
								setStreamingText("");
							}
						} catch {
							// ignore parse errors in SSE data
						}
						currentEventType = "";
					}
				}
			}
		} catch (_err) {
			// Error handling — messages will be refreshed via WS
		} finally {
			setSending(false);
			setStreamingText("");
			qc.invalidateQueries({ queryKey: messagesQueryKey });
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
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

	if (isLoading) return <Loader />;

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
					{narrator.status !== "idle" && (
						<Badge size="sm" color={NARRATOR_STATUS_COLORS[narrator.status] ?? "gray"}>
							{t(`status_${narrator.status}`)}
						</Badge>
					)}
					{disconnected && (
						<Badge size="xs" variant="dot" color="red">
							{t("disconnected")}
						</Badge>
					)}
					<Tooltip label={t("modelTooltip")}>
						<Select
							size="xs"
							w={120}
							allowDeselect={false}
							data={allModels}
							searchable
							value={narrator.model}
							onChange={(v) => {
								if (v) modelMutation.mutate({ id: narratorId, model: v });
							}}
						/>
					</Tooltip>
				</Group>
				<Group gap="xs">
					{narrator.totalCostUsd != null && narrator.totalCostUsd > 0 && (
						<Text size="xs" c="dimmed">
							${narrator.totalCostUsd.toFixed(4)}
						</Text>
					)}
					<Tooltip label={t("permissionMode")}>
						<Select
							size="xs"
							w={130}
							allowDeselect={false}
							leftSection={
								PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? <IconShield size={14} />
							}
							data={[
								{ value: "default", label: t("perm_default") },
								{ value: "acceptEdits", label: t("perm_acceptEdits") },
								{ value: "bypassPermissions", label: t("perm_bypassPermissions") },
								{ value: "plan", label: t("perm_plan") },
								{ value: "dontAsk", label: t("perm_dontAsk") },
							]}
							renderOption={({ option, checked }) => (
								<Group gap="xs" wrap="nowrap">
									{PERM_MODE_ICONS[option.value] ?? <IconShield size={14} />}
									<Text size="xs" fw={checked ? 600 : 400}>
										{option.label}
									</Text>
								</Group>
							)}
							value={narrator.permissionMode ?? "default"}
							onChange={(v) => {
								if (v) permModeMutation.mutate({ id: narratorId, permissionMode: v });
							}}
						/>
					</Tooltip>
					{(sending || narrator.status === "thinking" || narrator.status === "waiting") && (
						<Button
							size="xs"
							variant="light"
							color="red"
							onClick={() => interruptMutation.mutate(narratorId)}
						>
							{t("interrupt")}
						</Button>
					)}
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
				<ScrollArea
					h="100%"
					viewportRef={viewportRef}
					py="sm"
					px="md"
					onScrollPositionChange={handleScroll}
					styles={{ viewport: { overscrollBehavior: "contain" } }}
				>
					<Stack gap="sm">
						{hasNextPage && (
							<Group justify="center" py="xs">
								<Button
									variant="subtle"
									size="xs"
									onClick={handleLoadOlder}
									loading={isFetchingNextPage}
								>
									{t("loadOlderMessages")}
								</Button>
							</Group>
						)}
						{groupedElements}
						{streamingText && (
							<MessageBubble
								narratorId={narratorId}
								message={{
									role: "assistant",
									contentJson: [{ type: "text", text: streamingText }],
								}}
							/>
						)}
					</Stack>
				</ScrollArea>

				{/* Scroll to bottom button */}
				<Transition mounted={!isAtBottom} transition="slide-up" duration={200}>
					{(styles) => (
						<ActionIcon
							style={{
								...styles,
								position: "absolute",
								bottom: 12,
								right: 24,
								zIndex: 10,
							}}
							variant="filled"
							color="gray"
							radius="xl"
							size="lg"
							onClick={() => scrollToBottom()}
							title={t("scrollToBottom")}
						>
							<IconArrowDown size={18} />
						</ActionIcon>
					)}
				</Transition>
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

			{/* Work indicator — shows active todo or thinking status */}
			{showWorkIndicator && (
				<UnstyledButton
					w="100%"
					disabled={!activeTodo}
					onClick={async () => {
						if (!activeTodo || !todosToolUseId) return;
						// Find the message containing this tool call in loaded messages (recursive tree search)
						let msg = findMsgByToolUseIdInTree(messages, todosToolUseId);
						if (!msg) {
							// Message not loaded — refetch and search again
							try {
								await qc.refetchQueries({ queryKey: messagesQueryKey });
								// After refetch, get fresh messages from cache
								const freshData = qc.getQueryData<any>(messagesQueryKey);
								const freshMessages = freshData?.pages?.flatMap((p: any) => p.messages) ?? [];
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
							// Wait for scroll to finish, then trigger blink
							setTimeout(() => {
								setHighlightedId(msg.id);
								setTimeout(() => setHighlightedId(null), 1600);
							}, 400);
						}
					}}
				>
					<Group
						px="md"
						pt={4}
						pb={0}
						gap="xs"
						style={{
							borderTop:
								attachedImages.length > 0 ? undefined : "1px solid var(--mantine-color-default-border)",
							flexShrink: 0,
						}}
					>
						<Loader size={14} color={isWaiting ? "yellow" : "blue"} />
						<Text size="xs" c={isWaiting ? "yellow" : "blue"} truncate style={{ flex: 1 }}>
							{activeTodo
								? activeTodo.content || activeTodo.activeForm
								: isWaiting
									? t("status_waiting")
									: t("thinking")}
						</Text>
					</Group>
				</UnstyledButton>
			)}

			{/* Buffered message indicator */}
			{bufferedText && (
				<Group
					px="md"
					py={4}
					gap="xs"
					style={{
						borderTop:
							attachedImages.length > 0 || showWorkIndicator
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

			{/* Input */}
			<Group
				px="md"
				pt={showWorkIndicator || bufferedText ? 4 : "xs"}
				pb="xs"
				gap="xs"
				align="end"
				style={{
					borderTop:
						attachedImages.length > 0 || showWorkIndicator || bufferedText
							? undefined
							: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
				}}
			>
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
				<Button
					onClick={handleSend}
					loading={sending && !input.trim()}
					disabled={!input.trim() || (sending && !!bufferedText)}
				>
					{sending ? t("queue") : tc("send")}
				</Button>
			</Group>
		</Stack>
	);
}
