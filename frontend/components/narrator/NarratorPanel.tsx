import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	Transition,
} from "@mantine/core";
import { IconArrowDown, IconSparkles } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator, useNarratorMessages } from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { api, getToken } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { MessageBubble } from "./MessageBubble";
import { PermissionBanner } from "./PermissionBanner";

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

export function NarratorPanel({
	narratorId,
	narrator,
	onForkFromMessage,
	highlightMessageId,
}: NarratorPanelProps) {
	const { data: dbMessages, isLoading } = useNarratorMessages(narratorId);
	const interruptMutation = useInterruptNarrator();
	const qc = useQueryClient();

	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [streamingText, setStreamingText] = useState("");
	const [pendingPermission, setPendingPermission] = useState<any>(null);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleValue, setTitleValue] = useState("");
	const [generatingTitle, setGeneratingTitle] = useState(false);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const viewportRef = useRef<HTMLDivElement>(null);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const highlightScrolledRef = useRef(false);
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	// Track whether user is near the bottom of the scroll area
	const handleScroll = useCallback(() => {
		const vp = viewportRef.current;
		if (!vp) return;
		const threshold = 80;
		setIsAtBottom(vp.scrollHeight - vp.scrollTop - vp.clientHeight < threshold);
	}, []);

	const scrollToBottom = useCallback(() => {
		viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
	}, []);

	// Auto-scroll only when user is already at bottom
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message changes
	useEffect(() => {
		if (isAtBottomRef.current && !highlightMessageId) scrollToBottom();
	}, [dbMessages, streamingText, scrollToBottom, highlightMessageId]);

	// Scroll to highlighted message from search — only once on initial load
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once when messages load
	useEffect(() => {
		if (!highlightMessageId || !dbMessages?.length || highlightScrolledRef.current) return;
		const el = document.getElementById(`msg-${highlightMessageId}`);
		if (!el) return;
		highlightScrolledRef.current = true;
		requestAnimationFrame(() => {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			setHighlightedId(highlightMessageId);
			setTimeout(() => setHighlightedId(null), 2000);
		});
	}, [highlightMessageId, dbMessages]);

	// WebSocket for real-time events
	const { connected, disconnected, sendPermissionDecision } = useNarratorWS(narratorId, {
		onMessage: () => {
			// Refresh messages from DB when we get a complete message
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] });
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

		setInput("");
		setSending(true);
		setStreamingText("");

		// Optimistic: show user message immediately
		const optimisticMsg = {
			id: `optimistic-${Date.now()}`,
			role: "user",
			contentJson: [{ type: "text", text: msg }],
			contentText: msg,
		};
		qc.setQueryData(["narrators", narratorId, "messages"], (old: any[] | undefined) => [
			...(old ?? []),
			optimisticMsg,
		]);

		try {
			const endpoint = narrator.chapterId
				? `/api/narrators/${narratorId}/messages`
				: `/api/sessions/${narratorId}/messages`;
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			const token = getToken();
			if (token) headers.Authorization = `Bearer ${token}`;

			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ message: msg }),
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
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] });
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

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	if (isLoading) return <Loader />;

	const messages = dbMessages ?? [];

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
						{messages.map((msg: any) => (
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
									message={msg}
									onForkFromMessage={narrator.chapterId ? onForkFromMessage : undefined}
								/>
							</Box>
						))}
						{streamingText && (
							<MessageBubble
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
							onClick={scrollToBottom}
							title={t("scrollToBottom")}
						>
							<IconArrowDown size={18} />
						</ActionIcon>
					)}
				</Transition>
			</Box>

			{/* Input */}
			<Group
				p="xs"
				gap="xs"
				align="end"
				style={{ borderTop: "1px solid var(--mantine-color-gray-3)", flexShrink: 0 }}
			>
				<Textarea
					flex={1}
					placeholder={t("sendPlaceholder")}
					value={input}
					onChange={(e) => setInput(e.currentTarget.value)}
					onKeyDown={handleKeyDown}
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
