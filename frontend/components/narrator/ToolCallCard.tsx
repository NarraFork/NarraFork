import { Badge, Code, Collapse, Group, Paper, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";

const TOOL_STATUS_COLORS: Record<string, string> = {
	pending: "yellow",
	approved: "teal",
	denied: "red",
	running: "blue",
	completed: "green",
	failed: "red",
};

interface ToolCallCardProps {
	toolCall: {
		toolName: string;
		inputJson: any;
		outputJson?: any;
		status: string;
		durationMs?: number;
	};
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
	const [opened, setOpened] = useState(false);

	return (
		<Paper withBorder radius="sm" p="xs" my={4}>
			<UnstyledButton onClick={() => setOpened((o) => !o)} w="100%">
				<Group justify="space-between">
					<Group gap="xs">
						<Text size="xs" fw={600} ff="monospace">
							{toolCall.toolName}
						</Text>
						<Badge size="xs" color={TOOL_STATUS_COLORS[toolCall.status] ?? "gray"}>
							{toolCall.status}
						</Badge>
					</Group>
					{toolCall.durationMs != null && (
						<Text size="xs" c="dimmed">
							{(toolCall.durationMs / 1000).toFixed(1)}s
						</Text>
					)}
				</Group>
			</UnstyledButton>
			<Collapse in={opened}>
				<Text size="xs" fw={500} mt="xs" mb={2}>
					Input
				</Text>
				<Code block style={{ fontSize: 11, maxHeight: 200, overflow: "auto" }}>
					{JSON.stringify(toolCall.inputJson, null, 2)}
				</Code>
				{toolCall.outputJson && (
					<>
						<Text size="xs" fw={500} mt="xs" mb={2}>
							Output
						</Text>
						<Code block style={{ fontSize: 11, maxHeight: 200, overflow: "auto" }}>
							{typeof toolCall.outputJson === "string"
								? toolCall.outputJson
								: JSON.stringify(toolCall.outputJson, null, 2)}
						</Code>
					</>
				)}
			</Collapse>
		</Paper>
	);
}
