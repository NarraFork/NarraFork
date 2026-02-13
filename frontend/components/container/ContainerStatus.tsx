import { ActionIcon, Badge, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { useContainers, useStartContainers, useStopContainers, usePauseContainers, useUnpauseContainers } from "../../hooks/useContainers";
import { CONTAINER_STATUS_COLORS } from "../../lib/constants";

interface ContainerStatusProps {
	chapterId: string;
}

export function ContainerStatus({ chapterId }: ContainerStatusProps) {
	const { data: containers, isLoading } = useContainers(chapterId);
	const start = useStartContainers();
	const stop = useStopContainers();
	const pause = usePauseContainers();
	const unpause = useUnpauseContainers();

	if (isLoading) return <Loader size="xs" />;
	if (!containers?.length) return null;

	return (
		<Stack gap="xs">
			<Group justify="space-between">
				<Text size="sm" fw={600}>
					Containers
				</Text>
				<Group gap={4}>
					<ActionIcon
						size="xs"
						variant="light"
						color="green"
						onClick={() => start.mutate(chapterId)}
						loading={start.isPending}
						title="Start"
					>
						&#9654;
					</ActionIcon>
					<ActionIcon
						size="xs"
						variant="light"
						color="red"
						onClick={() => stop.mutate(chapterId)}
						loading={stop.isPending}
						title="Stop"
					>
						&#9632;
					</ActionIcon>
					<ActionIcon
						size="xs"
						variant="light"
						color="yellow"
						onClick={() => pause.mutate(chapterId)}
						loading={pause.isPending}
						title="Pause"
					>
						&#10074;&#10074;
					</ActionIcon>
					<ActionIcon
						size="xs"
						variant="light"
						color="teal"
						onClick={() => unpause.mutate(chapterId)}
						loading={unpause.isPending}
						title="Resume"
					>
						&#9654;
					</ActionIcon>
				</Group>
			</Group>
			{containers.map((c: any) => (
				<Card key={c.id} padding="xs" withBorder>
					<Group justify="space-between">
						<Text size="xs" fw={500}>
							{c.serviceName}
						</Text>
						<Badge size="xs" color={CONTAINER_STATUS_COLORS[c.status] ?? "gray"}>
							{c.status}
						</Badge>
					</Group>
					{c.hostPort && c.containerPort && (
						<Text size="xs" c="dimmed">
							:{c.hostPort} &rarr; :{c.containerPort}
						</Text>
					)}
				</Card>
			))}
		</Stack>
	);
}
