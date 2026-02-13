import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
	message: {
		role: string;
		contentJson: any[];
		contentText?: string;
		toolCalls?: any[];
		sdkMessageUuid?: string;
	};
	onForkFromMessage?: (sdkMessageUuid: string) => void;
}

export function MessageBubble({ message, onForkFromMessage }: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const canFork = !isUser && message.sdkMessageUuid && onForkFromMessage;
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("chapters");

	// User messages: full-width bubble
	if (isUser) {
		return (
			<Paper p="sm" radius="md" style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}>
				<Stack gap={4}>
					<Text size="xs" fw={600} c="indigo">
						{t("you")}
					</Text>
					{blocks.map((block: any, i: number) => {
						const key = block.id ?? `${block.type}-${i}`;
						if (block.type === "text") {
							return (
								<Text key={key} size="sm" style={{ whiteSpace: "pre-wrap" }}>
									{block.text}
								</Text>
							);
						}
						return null;
					})}
				</Stack>
			</Paper>
		);
	}

	// Assistant messages: no bubble wrapper, render content directly
	return (
		<Stack gap={4}>
			{canFork && (
				<Group justify="flex-end">
					<Tooltip label={tc("forkFromMessage")}>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="gray"
							onClick={() => onForkFromMessage(message.sdkMessageUuid!)}
						>
							&#x2442;
						</ActionIcon>
					</Tooltip>
				</Group>
			)}
			{blocks.map((block: any, i: number) => {
				const key = block.id ?? `${block.type}-${i}`;
				if (block.type === "text") {
					return <MarkdownContent key={key} text={block.text} />;
				}
				if (block.type === "thinking") {
					return (
						<Paper
							key={key}
							p="xs"
							radius="sm"
							style={{ backgroundColor: "var(--mantine-color-yellow-light)" }}
						>
							<Text size="xs" c="dimmed" fw={500} mb={2}>
								{t("thinking")}
							</Text>
							<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
								{block.thinking}
							</Text>
						</Paper>
					);
				}
				if (block.type === "tool_use") {
					const tc = message.toolCalls?.find((t: any) => t.toolUseId === block.id);
					return (
						<ToolCallCard
							key={key}
							toolCall={{
								toolName: block.name,
								inputJson: block.input,
								outputJson: tc?.outputJson,
								status: tc?.status ?? "running",
								durationMs: tc?.durationMs,
							}}
						/>
					);
				}
				return null;
			})}
		</Stack>
	);
}
