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
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator, useNarratorMessages } from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { MessageBubble } from "./MessageBubble";
import { PermissionBanner } from "./PermissionBanner";

interface NarratorPanelProps {
	narratorId: string;
	narrator: {
		id: string;
		chapterId?: string | null;
		model: string | null;
		status: string;
		totalCostUsd: number | null;
		permissionMode: string | null;
	};
	onForkFromMessage?: (sdkMessageUuid: string) => void;
}

export function NarratorPanel({ narratorId, narrator, onForkFromMessage }: NarratorPanelProps) {
	const { data: dbMessages, isLoading } = useNarratorMessages(narratorId);
	const interruptMutation = useInterruptNarrator();
	const qc = useQueryClient();

	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [streamingText, setStreamingText] = useState("");
	const [pendingPermission, setPendingPermission] = useState<any>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	// Auto-scroll to bottom when messages change
	const scrollToBottom = useCallback(() => {
		viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message changes
	useEffect(() => {
		scrollToBottom();
	}, [dbMessages, streamingText, scrollToBottom]);

	// WebSocket for real-time events
	const { connected, sendPermissionDecision } = useNarratorWS(narratorId, {
		onMessage: () => {
			// Refresh messages from DB when we get a complete message
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] });
		},
		onPermissionRequest: (request) => {
			setPendingPermission(request);
		},
	});
	// Send message via SSE
	const handleSend = async () => {
		const msg = input.trim();
		if (!msg || sending) return;

		setInput("");
		setSending(true);
		setStreamingText("");

		try {
			const response = await fetch(`/api/narrators/${narratorId}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
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
							if (data?.event?.type === "content_block_delta") {
								const delta = data.event.delta;
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
		} catch (err) {
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

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	if (isLoading) return <Loader />;

	const messages = dbMessages ?? [];

	return (
		<Stack h="100%" gap={0}>
			{/* Header */}
			<Group
				justify="space-between"
				p="xs"
				style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
			>
				<Group gap="xs">
					<Badge size="sm" color={narrator.status === "active" ? "green" : "gray"}>
						{narrator.status}
					</Badge>
					<Text size="xs" c="dimmed">
						{narrator.model}
					</Text>
					{connected && (
						<Badge size="xs" variant="dot" color="green">
							{t("live")}
						</Badge>
					)}
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

			{/* Permission banner */}
			{pendingPermission && (
				<Box p="xs">
					<PermissionBanner request={pendingPermission} onDecision={handlePermissionDecision} />
				</Box>
			)}

			{/* Messages */}
			<ScrollArea flex={1} viewportRef={viewportRef} p="sm">
				<Stack gap="sm">
					{messages.map((msg: any) => (
						<MessageBubble
							key={msg.id}
							message={msg}
							onForkFromMessage={narrator.chapterId ? onForkFromMessage : undefined}
						/>
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

			{/* Input */}
			<Group
				p="xs"
				gap="xs"
				align="end"
				style={{ borderTop: "1px solid var(--mantine-color-gray-3)" }}
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
