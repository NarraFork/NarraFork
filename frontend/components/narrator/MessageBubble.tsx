import { Paper, Stack, Text } from "@mantine/core";
import { ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
	message: {
		role: string;
		contentJson: any[];
		contentText?: string;
		toolCalls?: any[];
	};
}

export function MessageBubble({ message }: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];

	return (
		<Paper
			p="sm"
			radius="md"
			bg={isUser ? "blue.0" : "gray.0"}
			ml={isUser ? 40 : 0}
			mr={isUser ? 0 : 40}
		>
			<Stack gap={4}>
				<Text size="xs" fw={600} c="dimmed">
					{isUser ? "You" : "Narrator"}
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
					if (block.type === "thinking") {
						return (
							<Paper key={key} p="xs" bg="yellow.0" radius="sm">
								<Text size="xs" c="dimmed" fw={500} mb={2}>
									Thinking
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
