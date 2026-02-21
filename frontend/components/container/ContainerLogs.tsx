import { Button, Code, Group, Loader, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useContainerLogs, useContainers } from "../../hooks/useContainers";

interface ContainerLogsProps {
	chapterId: string;
}

export function ContainerLogs({ chapterId }: ContainerLogsProps) {
	const [service, setService] = useState<string | null>(null);
	const [tail, setTail] = useState<string>("100");
	const { data: containers } = useContainers(chapterId);
	const {
		data: logData,
		isLoading,
		refetch,
	} = useContainerLogs(chapterId, {
		tail: Number.parseInt(tail, 10),
		service: service ?? undefined,
	});
	const { t } = useTranslation("containers");
	const { t: tc } = useTranslation("common");

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const serviceOptions = (containers ?? []).map((c: any) => ({
		value: c.serviceName,
		label: c.serviceName,
	}));

	return (
		<Stack gap="xs">
			<Group gap="xs">
				<Select
					size="xs"
					placeholder={t("allServices")}
					data={serviceOptions}
					value={service}
					onChange={setService}
					clearable
					style={{ flex: 1 }}
				/>
				<Select
					size="xs"
					data={[
						{ value: "50", label: t("lines50") },
						{ value: "100", label: t("lines100") },
						{ value: "500", label: t("lines500") },
					]}
					value={tail}
					onChange={(v) => setTail(v ?? "100")}
					style={{ width: 120 }}
				/>
				<Button size="xs" variant="light" onClick={() => refetch()} loading={isLoading}>
					{tc("refresh")}
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
					{t("noLogs")}
				</Text>
			)}
		</Stack>
	);
}
