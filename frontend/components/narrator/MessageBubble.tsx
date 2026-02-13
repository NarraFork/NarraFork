import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
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

	return (
		<Paper
			p="sm"
			radius="md"
			bg={isUser ? "blue.0" : "gray.0"}
			ml={isUser ? 40 : 0}
			mr={isUser ? 0 : 40}
		>
			<Stack gap={4}>
				<Group justify="space-between">
					<Text size="xs" fw={600} c="dimmed">
						{isUser ? t("you") : t("narrator")}
					</Text>
					{canFork && (
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
					)}
				</Group>
				{blocks.map((block: any, i: number) => {
					const key = block.id ?? `${block.type}-${i}`;
					if (block.type === "text") {
						return (
							<Text key={key} size="sm" style={{ whiteSpace: "pre-wrap" }}>
								{block.text}
							</Text>
						);
					}
					if (block.type === "thinking") {
						return (
							<Paper key={key} p="xs" bg="yellow.0" radius="sm">
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
						// Find matching tool call from DB if available
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
		</Paper>
	);
}
