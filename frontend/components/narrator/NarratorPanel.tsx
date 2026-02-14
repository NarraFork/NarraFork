import {
	ActionIcon,
	Badge,
	Box,
	Button,
	CloseButton,
	Code,
	Collapse,
	CopyButton,
	Divider,
	Group,
	Image,
	Loader,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	ThemeIcon,
	Tooltip,
	Transition,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArrowDown,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconPaperclip,
	IconRobot,
	IconSparkles,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator, useNarratorMessages } from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { api, getToken } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { MessageBubble } from "./MessageBubble";
import { PermissionBanner } from "./PermissionBanner";
import type { ToolCallData } from "./ToolCallCard";
import { STATUS_COLORS, StatusIcon, ToolCallCard } from "./ToolCallCard";

// --- Message-level grouping: merge consecutive tool-only messages + subagent nesting ---

function isToolOnlyMessage(msg: any): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return (
		msg.role === "assistant" && blocks.length > 0 && blocks.every((b: any) => b.type === "tool_use")
	);
}

function getToolUseId(msg: any): string | null {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const block = blocks.find((b: any) => b.type === "tool_use");
	return block?.id ?? null;
}

function resolveToolCallFromMsg(msg: any): ToolCallData | null {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const block = blocks.find((b: any) => b.type === "tool_use");
	if (!block) return null;
	const tc = msg.toolCalls?.find((t: any) => t.toolUseId === block.id);
	return {
		toolName: block.name,
		inputJson: block.input,
		outputJson: tc?.outputJson,
		status: tc?.status ?? "running",
		durationMs: tc?.durationMs,
		errorMessage: tc?.errorMessage,
	};
}

// --- SubagentCard: renders a Task tool call with its child tool calls nested inside ---

function SubagentCard({
	toolCall,
	childMessages,
	childrenMap,
	narratorId,
	inRun,
	isLast,
}: {
	toolCall: ToolCallData;
	childMessages: any[];
	childrenMap: Map<string, any[]>;
	narratorId: string;
	inRun?: boolean;
	isLast?: boolean;
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
	const childToolCalls: { tc: ToolCallData; toolUseId: string | null; msgId: string }[] = [];
	for (const cm of childMessages) {
		if (!isToolOnlyMessage(cm)) continue;
		const tc = resolveToolCallFromMsg(cm);
		if (tc) childToolCalls.push({ tc, toolUseId: getToolUseId(cm), msgId: cm.id });
	}

	const totalMs =
		childToolCalls.reduce((sum, c) => sum + (c.tc.durationMs ?? 0), 0) + (toolCall.durationMs ?? 0);

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
					<Box style={{ flex: 1 }} />
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						{input.model && (
							<Text size="xs" c="dimmed">
								{input.model}
							</Text>
						)}
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
			<Collapse in={expanded}>
				{/* Result — shown directly when expanded */}
				{resultText && (
					<Box px="xs" pb={4}>
						<Code
							block
							style={{
								fontSize: 11,
								maxHeight: 300,
								overflow: "auto",
								whiteSpace: "pre-wrap",
							}}
						>
							{resultText}
						</Code>
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
						<Collapse in={showPrompt}>
							<Box pos="relative" mt={4}>
								<Code
									block
									style={{
										fontSize: 11,
										maxHeight: 200,
										overflow: "auto",
										whiteSpace: "pre-wrap",
									}}
								>
									{prompt}
								</Code>
								<CopyButton value={prompt}>
									{({ copied, copy }) => (
										<Tooltip label={copied ? "Copied" : "Copy prompt"}>
											<ActionIcon
												size="xs"
												variant="subtle"
												color={copied ? "teal" : "gray"}
												onClick={copy}
												style={{ position: "absolute", top: 4, right: 4 }}
											>
												<IconCopy size={12} />
											</ActionIcon>
										</Tooltip>
									)}
								</CopyButton>
							</Box>
						</Collapse>
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
						<Collapse in={showCalls}>
							<Box pl="md" mt={4} style={{ borderLeft: "2px solid var(--mantine-color-indigo-3)" }}>
								{childToolCalls.map(({ tc, toolUseId, msgId }) => {
									const key = toolUseId ?? tc.toolName;
									const subChildren = toolUseId ? childrenMap.get(toolUseId) : undefined;
									if (subChildren && subChildren.length > 0) {
										return (
											<div key={key} id={`msg-${msgId}`}>
												<SubagentCard
													toolCall={tc}
													childMessages={subChildren}
													childrenMap={childrenMap}
													narratorId={narratorId}
												/>
											</div>
										);
									}
									return (
										<div key={key} id={`msg-${msgId}`}>
											<ToolCallCard toolCall={tc} />
										</div>
									);
								})}
							</Box>
						</Collapse>
					</Box>
				)}
			</Collapse>
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

function renderToolRun(run: any[], childrenMap: Map<string, any[]>, narratorId: string) {
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
					const toolUseId = getToolUseId(m);
					const children = toolUseId ? childrenMap.get(toolUseId) : undefined;
					if (children && children.length > 0) {
						const tc = resolveToolCallFromMsg(m);
						if (!tc) return null;
						return (
							<div key={m.id} id={`msg-${m.id}`}>
								<SubagentCard
									toolCall={tc}
									childMessages={children}
									childrenMap={childrenMap}
									narratorId={narratorId}
									inRun
									isLast={idx === run.length - 1}
								/>
							</div>
						);
					}
					const tc = resolveToolCallFromMsg(m);
					if (!tc) return null;
					return (
						<div key={m.id} id={`msg-${m.id}`}>
							<ToolCallCard toolCall={tc} inRun isLast={idx === run.length - 1} />
						</div>
					);
				})}
			</Box>
		);
	}
	// Single tool message
	const msg = run[0];
	const toolUseId = getToolUseId(msg);
	const children = toolUseId ? childrenMap.get(toolUseId) : undefined;
	if (children && children.length > 0) {
		const tc = resolveToolCallFromMsg(msg);
		if (!tc) return null;
		return (
			<div key={msg.id} id={`msg-${msg.id}`}>
				<SubagentCard
					toolCall={tc}
					childMessages={children}
					childrenMap={childrenMap}
					narratorId={narratorId}
				/>
			</div>
		);
	}
	const tc = resolveToolCallFromMsg(msg);
	if (!tc) return null;
	return (
		<div key={msg.id} id={`msg-${msg.id}`}>
			<ToolCallCard toolCall={tc} />
		</div>
	);
}

function renderGroupedMessages(
	messages: any[],
	narratorId: string,
	onForkFromMessage: ((uuid: string) => void) | undefined,
	highlightedId: string | null,
): { elements: React.ReactNode[]; orphanParentIds: string[] } {
	// Build map: toolUseId → child messages (messages with that parentToolUseId)
	const childrenMap = new Map<string, any[]>();
	const topLevel: any[] = [];

	// Collect all toolUseIds present in the loaded messages
	const loadedToolUseIds = new Set<string>();
	for (const msg of messages) {
		const tuid = getToolUseId(msg);
		if (tuid) loadedToolUseIds.add(tuid);
	}

	const orphanParentIds = new Set<string>();

	for (const msg of messages) {
		if (msg.parentToolUseId) {
			if (loadedToolUseIds.has(msg.parentToolUseId)) {
				// Parent is loaded — nest as child
				const arr = childrenMap.get(msg.parentToolUseId) ?? [];
				arr.push(msg);
				childrenMap.set(msg.parentToolUseId, arr);
			} else {
				// Parent not loaded — hide and track as orphan
				orphanParentIds.add(msg.parentToolUseId);
			}
		} else {
			topLevel.push(msg);
		}
	}

	const elements: React.ReactNode[] = [];
	let i = 0;

	while (i < topLevel.length) {
		const msg = topLevel[i];

		if (isToolOnlyMessage(msg)) {
			// Collect consecutive tool-only messages
			const run: any[] = [msg];
			let j = i + 1;
			while (j < topLevel.length && isToolOnlyMessage(topLevel[j])) {
				run.push(topLevel[j]);
				j++;
			}
			const el = renderToolRun(run, childrenMap, narratorId);
			if (el) elements.push(el);
			i = j;
		} else {
			elements.push(
				<Box
					key={msg.id}
					id={`msg-${msg.id}`}
					style={{
						borderRadius: "var(--mantine-radius-md)",
						transition: "background-color 0.5s ease",
						backgroundColor:
							highlightedId === msg.id ? "var(--mantine-color-yellow-light)" : undefined,
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

	return { elements, orphanParentIds: [...orphanParentIds] };
}

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
	const qc = useQueryClient();
	const messagesQueryKey = ["narrators", narratorId, "messages", { around: highlightMessageId }];

	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [streamingText, setStreamingText] = useState("");
	const [attachedImages, setAttachedImages] = useState<File[]>([]);
	const [pendingPermission, setPendingPermission] = useState<any>(null);

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

	// Compute grouped message elements + detect orphan subagent children
	const { elements: groupedElements, orphanParentIds } = useMemo(
		() =>
			renderGroupedMessages(
				messages,
				narratorId,
				narrator.chapterId ? onForkFromMessage : undefined,
				highlightedId,
			),
		[messages, narratorId, narrator.chapterId, onForkFromMessage, highlightedId],
	);

	// Auto-load older pages when orphan subagent children are detected
	const orphanTargetsRef = useRef(new Map<string, string>()); // toolUseId → target createdAt
	const orphanQueriedRef = useRef(new Set<string>()); // toolUseIds we've already queried
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger on orphan/page changes
	useEffect(() => {
		if (orphanParentIds.length === 0) return;

		// Step 1: query server for any new orphan parents we haven't looked up yet
		const unqueried = orphanParentIds.filter((id) => !orphanQueriedRef.current.has(id));
		if (unqueried.length > 0) {
			for (const id of unqueried) orphanQueriedRef.current.add(id);
			// Query the first unqueried orphan (batch one at a time)
			api
				.findParentMessage(narratorId, unqueried[0])
				.then((result) => {
					if (result.createdAt) {
						orphanTargetsRef.current.set(unqueried[0], result.createdAt);
						// Trigger a re-render to start loading
						fetchNextPage();
					}
				})
				.catch(() => {});
			return;
		}

		// Step 2: if we have targets and haven't loaded far enough, keep fetching
		if (!hasNextPage || isFetchingNextPage) return;
		const targets = orphanTargetsRef.current;
		if (targets.size === 0) return;

		// Find the oldest target we need to reach
		let oldestTarget: string | null = null;
		for (const ts of targets.values()) {
			if (!oldestTarget || ts < oldestTarget) oldestTarget = ts;
		}
		if (!oldestTarget) return;

		// Check if we've loaded far enough
		const pages = messagesData?.pages;
		if (!pages?.length) return;
		const lastPage = pages[pages.length - 1];
		const oldestLoaded = lastPage.messages[0]?.createdAt;
		if (oldestLoaded && oldestLoaded <= oldestTarget) {
			// We've loaded past the target — clean up resolved targets
			for (const [key, ts] of targets.entries()) {
				if (oldestLoaded <= ts) targets.delete(key);
			}
			return;
		}

		// Need to load more
		fetchNextPage();
	}, [orphanParentIds, hasNextPage, isFetchingNextPage, narratorId, messagesData, fetchNextPage]);

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
	const handleScroll = useCallback(() => {
		const vp = viewportRef.current;
		if (!vp) return;
		const threshold = 80;
		setIsAtBottom(vp.scrollHeight - vp.scrollTop - vp.clientHeight < threshold);
	}, []);

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

	// Scroll to highlighted message from search — only once on initial load
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once when messages load
	useEffect(() => {
		if (!highlightMessageId || !messages.length || highlightScrolledRef.current) return;
		const el = document.getElementById(`msg-${highlightMessageId}`);
		if (!el) return;
		highlightScrolledRef.current = true;
		requestAnimationFrame(() => {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			setHighlightedId(highlightMessageId);
			setTimeout(() => setHighlightedId(null), 2000);
		});
	}, [highlightMessageId, messages]);

	// WebSocket for real-time events
	const { connected, disconnected, sendPermissionDecision } = useNarratorWS(narratorId, {
		onMessage: (wsData: any) => {
			if (wsData.message?.id && wsData.message?.createdAt) {
				// Full persisted message from WS — append to cache directly
				qc.setQueryData(messagesQueryKey, (old: any) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					if (firstPage.messages.some((m: any) => m.id === wsData.message.id)) {
						return old;
					}
					firstPage.messages = [...firstPage.messages, wsData.message];
					pages[0] = firstPage;
					return { ...old, pages };
				});
			} else {
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			}
		},
		onPermissionRequest: (request) => {
			setPendingPermission(request);
		},
		onStatusChange: () => {
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
		},
		onTitleUpdated: () => {
			// Refresh narrator data to get new title
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
			if (!narrator.chapterId) {
				qc.invalidateQueries({ queryKey: ["sessions", narratorId] });
			}
		},
	});

	// Load any existing pending permission on mount/reconnect
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch on mount and reconnect
	useEffect(() => {
		api
			.getPendingPermissions(narratorId)
			.then((perms) => {
				if (perms.length > 0) setPendingPermission(perms[0]);
			})
			.catch(() => {});
	}, [narratorId, connected]);

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
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== narrator.title) {
			await api.updateNarratorTitle(narratorId, trimmed);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
			if (!narrator.chapterId) {
				qc.invalidateQueries({ queryKey: ["sessions", narratorId] });
			}
		}
		setEditingTitle(false);
	};

	const handleGenerateTitle = async () => {
		setGeneratingTitle(true);
		try {
			const { title } = await api.generateNarratorTitle(narratorId);
			setTitleValue(title);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
			if (!narrator.chapterId) {
				qc.invalidateQueries({ queryKey: ["sessions", narratorId] });
			}
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

	// Send message via SSE
	const handleSend = async () => {
		const msg = input.trim();
		if (!msg || sending) return;

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
			const endpoint = narrator.chapterId
				? `/api/narrators/${narratorId}/messages`
				: `/api/sessions/${narratorId}/messages`;
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

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("data:")) {
						try {
							const data = JSON.parse(line.slice(5).trim());
							// Accumulate streaming text for display
							if (data?.type === "content_block_delta") {
								const delta = data.delta;
								if (delta?.type === "text_delta" && delta.text) {
									setStreamingText((prev) => prev + delta.text);
								}
							}
						} catch {
							// ignore parse errors in SSE data
						}
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

	const handlePermissionDecision = (requestId: string, decision: "allow" | "deny") => {
		sendPermissionDecision(requestId, decision);
		setPendingPermission(null);
	};

	const handleQuestionSubmit = (requestId: string, answers: Record<string, string>) => {
		sendPermissionDecision(requestId, "allow", undefined, answers);
		setPendingPermission(null);
	};

	const handleQuestionDeny = (requestId: string) => {
		sendPermissionDecision(requestId, "deny", "User skipped the question");
		setPendingPermission(null);
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
				p="xs"
				style={{ borderBottom: "1px solid var(--mantine-color-gray-3)", flexShrink: 0 }}
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
					<Badge size="sm" color={NARRATOR_STATUS_COLORS[narrator.status] ?? "gray"}>
						{t(`status_${narrator.status}`)}
					</Badge>
					{disconnected && (
						<Badge size="xs" variant="dot" color="red">
							{t("disconnected")}
						</Badge>
					)}
					<Text size="xs" c="dimmed">
						{narrator.model}
					</Text>
				</Group>
				<Group gap="xs">
					{narrator.totalCostUsd != null && narrator.totalCostUsd > 0 && (
						<Text size="xs" c="dimmed">
							${narrator.totalCostUsd.toFixed(4)}
						</Text>
					)}
					{sending && (
						<Button
							size="xs"
							variant="light"
							color="red"
							onClick={() => interruptMutation.mutate(narratorId)}
						>
							{t("interrupt")}
						</Button>
					)}
				</Group>
			</Group>

			{/* Permission banner / AskUserQuestion */}
			{pendingPermission && (
				<Box p="xs">
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
				<ScrollArea h="100%" viewportRef={viewportRef} p="sm" onScrollPositionChange={handleScroll}>
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
						{sending && !streamingText && <Loader size="sm" />}
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
					p="xs"
					pb={0}
					gap="xs"
					style={{ borderTop: "1px solid var(--mantine-color-gray-3)", flexShrink: 0 }}
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

			{/* Input */}
			<Group
				p="xs"
				gap="xs"
				align="end"
				style={{
					borderTop:
						attachedImages.length > 0 ? undefined : "1px solid var(--mantine-color-gray-3)",
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
						disabled={sending}
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
					disabled={sending}
				/>
				<Button onClick={handleSend} loading={sending} disabled={!input.trim()}>
					{tc("send")}
				</Button>
			</Group>
		</Stack>
	);
}
