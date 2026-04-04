import {
	Alert,
	Anchor,
	Badge,
	Button,
	Code,
	Collapse,
	Divider,
	Group,
	Loader,
	ScrollArea,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconPlayerPlay,
	IconPlayerStop,
	IconScript,
	IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useContainerEvents } from "../../hooks/useContainerEvents";
import {
	useContainerLogs,
	useContainers,
	useStartContainers,
	useStopContainers,
} from "../../hooks/useContainers";
import { api } from "../../lib/api";
import { CONTAINER_STATUS_COLORS } from "../../lib/constants";
import { VolumeSnapshotPanel } from "./VolumeSnapshotPanel";

interface ContainerPanelProps {
	chapterId: string;
	onOpenConfig: () => void;
	onContainerError?: (err: Error) => void;
}

export function ContainerPanel({ chapterId, onOpenConfig, onContainerError }: ContainerPanelProps) {
	const { t } = useTranslation("containers");
	const { data: containers, isLoading } = useContainers(chapterId);
	const { data: chapter } = useQuery({
		queryKey: ["chapters", chapterId],
		queryFn: () => api.getChapter(chapterId),
		enabled: !!chapterId,
	});
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
	});
	const { data: project } = useQuery({
		queryKey: ["projects", chapter?.projectId],
		queryFn: () => api.getProject(chapter?.projectId ?? ""),
		enabled: !!chapter?.projectId,
	});
	const start = useStartContainers();
	const stop = useStopContainers();
	const { starting, logs: buildLogs, error, clearError } = useContainerEvents(chapterId);
	const [logsOpen, setLogsOpen] = useState(false);
	const [logService, setLogService] = useState<string | null>(null);
	const [logTail, setLogTail] = useState("100");

	const {
		data: logData,
		isLoading: logsLoading,
		refetch: refetchLogs,
	} = useContainerLogs(chapterId, {
		tail: Number.parseInt(logTail, 10),
		service: logService ?? undefined,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic container entity
	const running = containers?.filter((c: any) => c.status === "running") ?? [];
	const hasInstances = (containers?.length ?? 0) > 0;

	// Deduplicated service names for log filter
	// biome-ignore lint/suspicious/noExplicitAny: dynamic container entity
	const serviceNames = [...new Set((containers ?? []).map((c: any) => c.serviceName as string))];
	const proxyEnabled = settings?.containers?.proxy?.enabled ?? false;
	const projectProxyDomain =
		(project as { proxyDomain?: string | null } | undefined)?.proxyDomain ?? null;
	const hasProxyUrl = (containers ?? []).some(
		(c) => !!(c as { proxyUrl?: string | null }).proxyUrl,
	);
	const showProxyDomainHint =
		proxyEnabled && !projectProxyDomain && !!chapter?.containerConfig && !hasProxyUrl;

	return (
		<Stack gap="xs" p="xs">
			{showProxyDomainHint && (
				<Alert icon={<IconAlertTriangle size={14} />} color="yellow" variant="light">
					<Text size="xs">{t("proxyDomainMissingHint")}</Text>
				</Alert>
			)}
			{/* Service status list */}
			{isLoading ? (
				<Loader size="xs" />
			) : hasInstances ? (
				// biome-ignore lint/suspicious/noExplicitAny: dynamic container entity
				(containers ?? []).map((c: any) => (
					<Group key={c.id} gap="xs" justify="space-between">
						<Group gap="xs">
							<Text size="xs" fw={500}>
								{c.serviceName}
							</Text>
							{c.proxyUrl ? (
								<Anchor size="xs" ff="monospace" href={c.proxyUrl} target="_blank" rel="noopener">
									{c.proxyUrl}
								</Anchor>
							) : c.hostPort && c.containerPort ? (
								<Text size="xs" c="dimmed" ff="monospace">
									:{c.hostPort} → :{c.containerPort}
								</Text>
							) : null}
						</Group>
						<Badge size="xs" color={CONTAINER_STATUS_COLORS[c.status] ?? "gray"}>
							{c.status}
						</Badge>
					</Group>
				))
			) : !starting ? (
				<Text size="xs" c="dimmed">
					{t("noContainers")}
				</Text>
			) : null}

			{/* Build/startup streaming logs (shown while starting or after error) */}
			{(starting || (error && buildLogs.length > 0)) && (
				<>
					{starting && (
						<Group gap={4}>
							<Loader size={12} />
							<Text size="xs" c="dimmed">
								{t("starting")}
							</Text>
						</Group>
					)}
					{buildLogs.length > 0 && (
						<ScrollArea.Autosize mah={120} type="auto">
							<Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
								{buildLogs.join("\n")}
							</Code>
						</ScrollArea.Autosize>
					)}
				</>
			)}

			{/* Error alert after failed startup */}
			{error && (
				<Alert
					icon={<IconAlertTriangle size={14} />}
					color="red"
					variant="light"
					withCloseButton
					onClose={clearError}
				>
					<Text size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
						{error}
					</Text>
				</Alert>
			)}

			{/* Runtime logs (collapsible) */}
			{hasInstances && !starting && (
				<Collapse in={logsOpen}>
					<Stack gap="xs">
						<Group gap="xs">
							<Select
								size="xs"
								placeholder={t("allServices")}
								data={serviceNames.map((n) => ({ value: n, label: n }))}
								value={logService}
								onChange={setLogService}
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
								value={logTail}
								onChange={(v) => setLogTail(v ?? "100")}
								style={{ width: 100 }}
							/>
						</Group>
						{logsLoading ? (
							<Loader size="xs" />
						) : logData?.logs ? (
							<ScrollArea.Autosize mah={200} type="auto">
								<Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
									{logData.logs}
								</Code>
							</ScrollArea.Autosize>
						) : (
							<Text size="xs" c="dimmed">
								{t("noLogs")}
							</Text>
						)}
					</Stack>
				</Collapse>
			)}

			{/* Action bar — state-driven */}
			<Group gap="xs">
				{running.length > 0 ? (
					<>
						<Button
							size="compact-xs"
							variant="light"
							color="red"
							leftSection={<IconPlayerStop size={12} />}
							onClick={() => stop.mutate(chapterId, { onError: onContainerError })}
							loading={stop.isPending}
						>
							{t("stop")}
						</Button>
						<Button
							size="compact-xs"
							variant="light"
							leftSection={<IconScript size={12} />}
							onClick={() => {
								if (!logsOpen) refetchLogs();
								setLogsOpen(!logsOpen);
							}}
						>
							{logsOpen ? t("hideLogs") : t("showLogs")}
						</Button>
					</>
				) : (
					<Button
						size="compact-xs"
						variant="light"
						color="green"
						leftSection={<IconPlayerPlay size={12} />}
						onClick={() => start.mutate(chapterId, { onError: onContainerError })}
						loading={start.isPending}
						disabled={starting}
					>
						{t("start")}
					</Button>
				)}
				<Button
					size="compact-xs"
					variant="subtle"
					color="gray"
					leftSection={<IconSettings size={12} />}
					onClick={onOpenConfig}
				>
					{t("config")}
				</Button>
			</Group>

			{/* Volume Snapshots */}
			{chapter?.projectId && (
				<>
					<Divider />
					<VolumeSnapshotPanel
						projectId={chapter.projectId}
						chapterId={chapterId}
						serviceNames={serviceNames}
						hasRunningContainers={running.length > 0}
					/>
				</>
			)}
		</Stack>
	);
}
