import { Button, Code, Group, Loader, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useContainerLogs, useContainers } from "../../hooks/useContainers";

interface ContainerLogsProps {
	chapterId: string;
}

export function ContainerLogs({ chapterId }: ContainerLogsProps) {
	const [service, setService] = useState<string | null>(null);
	const [tail, setTail] = useState<string>("100");
	const { data: containers } = useContainers(chapterId);
	const { data: logData, isLoading, refetch } = useContainerLogs(chapterId, {
		tail: Number.parseInt(tail, 10),
		service: service ?? undefined,
	});

	const serviceOptions = (containers ?? []).map((c: any) => ({
		value: c.serviceName,
		label: c.serviceName,
	}));

	return (
		<Stack gap="xs">
			<Group gap="xs">
				<Select
					size="xs"
					placeholder="All services"
					data={serviceOptions}
					value={service}
					onChange={setService}
					clearable
					style={{ flex: 1 }}
				/>
				<Select
					size="xs"
					data={[
						{ value: "50", label: "50 lines" },
						{ value: "100", label: "100 lines" },
						{ value: "500", label: "500 lines" },
					]}
					value={tail}
					onChange={(v) => setTail(v ?? "100")}
					style={{ width: 120 }}
				/>
				<Button size="xs" variant="light" onClick={() => refetch()} loading={isLoading}>
					Refresh
				</Button>
			</Group>
			{isLoading ? (
				<Loader size="sm" />
			) : logData?.logs ? (
				<Code
					block
					style={{
						maxHeight: 300,
						overflow: "auto",
						fontSize: 11,
						whiteSpace: "pre-wrap",
					}}
				>
					{logData.logs}
				</Code>
			) : (
				<Text size="sm" c="dimmed">
					No logs available.
				</Text>
			)}
		</Stack>
	);
}
