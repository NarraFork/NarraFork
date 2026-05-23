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
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useContainerEvents } from "../../hooks/useContainerEvents";
import {
	useContainerLogs,
	useContainers,
	useStartContainers,
	useStopContainers,
} from "../../hooks/useContainers";
import { useChapterContainersCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import { CONTAINER_STATUS_COLORS } from "../../lib/constants";
import { VolumeSnapshotPanel } from "./VolumeSnapshotPanel";

const MAX_RENDERED_RUNTIME_LOG_CHARS = 120_000;
const MAX_RENDERED_BUILD_LOG_CHARS = 120_000;
const CONTAINER_PANEL_QUERY_GC_TIME_MS = 60_000;

interface ContainerPanelProps {
	chapterId: string;
	onOpenConfig: () => void;
	onContainerError?: (err: Error) => void;
}

export function ContainerPanel({ chapterId, onOpenConfig, onContainerError }: ContainerPanelProps) {
	const { t } = useTranslation("containers");
	const containerCapability = useChapterContainersCapability();
	const containerCapabilityReason = containerCapability.reason ?? t("capabilityUnsupported");
	const canListContainers = containerCapability.supported && containerCapability.routes.list;
	const canStartContainers = containerCapability.supported && containerCapability.routes.start;
	const canStopContainers = containerCapability.supported && containerCapability.routes.stop;
	const canReadLogs = containerCapability.supported && containerCapability.routes.logs;
	const { data: containers, isLoading } = useContainers(canListContainers ? chapterId : "");
	const { data: chapter } = useQuery({
		queryKey: ["chapters", chapterId],
		queryFn: () => api.getChapter(chapterId),
		enabled: !!chapterId,
		gcTime: CONTAINER_PANEL_QUERY_GC_TIME_MS,
	});
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
		gcTime: CONTAINER_PANEL_QUERY_GC_TIME_MS,
	});
	const { data: project } = useQuery({
		queryKey: ["projects", chapter?.projectId],
		queryFn: () => api.getProject(chapter?.projectId ?? ""),
		enabled: !!chapter?.projectId,
		gcTime: CONTAINER_PANEL_QUERY_GC_TIME_MS,
	});
	const start = useStartContainers();
	const stop = useStopContainers();
	const { starting, logs: buildLogs, phase, error, clearError } = useContainerEvents(chapterId);
	const [logsOpen, setLogsOpen] = useState(false);
	const [logService, setLogService] = useState<string | null>(null);
	const [logTail, setLogTail] = useState("100");

	// biome-ignore lint/suspicious/noExplicitAny: dynamic container entity
	const running = containers?.filter((c: any) => c.status === "running") ?? [];
	const hasInstances = (containers?.length ?? 0) > 0;
	const runtimeLogsEnabled = canReadLogs && hasInstances && !starting && logsOpen;

	const { data: logData, isLoading: logsLoading } = useContainerLogs(
		chapterId,
		{
			tail: Number.parseInt(logTail, 10),
			service: logService ?? undefined,
		},
		{ enabled: runtimeLogsEnabled },
	);
	const displayedRuntimeLogs = useMemo(() => {
		const logs = logData?.logs;
		if (!logs || logs.length <= MAX_RENDERED_RUNTIME_LOG_CHARS) return logs;
		return `${logs.slice(-MAX_RENDERED_RUNTIME_LOG_CHARS)}\n\n${t("logsTruncated")}`;
	}, [logData?.logs, t]);
	const displayedBuildLogs = useMemo(() => {
		let output = "";
		let truncated = false;
		for (let i = buildLogs.length - 1; i >= 0; i--) {
			const line = buildLogs[i].line;
			const separator = output ? "\n" : "";
			const nextLength = line.length + separator.length + output.length;
			if (nextLength > MAX_RENDERED_BUILD_LOG_CHARS) {
				const remaining = MAX_RENDERED_BUILD_LOG_CHARS - output.length - separator.length;
				if (remaining > 0) output = `${line.slice(-remaining)}${separator}${output}`;
				truncated = true;
				break;
			}
			output = `${line}${separator}${output}`;
		}
		return truncated ? `${output}\n\n${t("logsTruncated")}` : output;
	}, [buildLogs, t]);

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
			{!canListContainers && (
				<Alert icon={<IconAlertTriangle size={14} />} color="yellow" variant="light">
					<Text size="xs">{containerCapabilityReason}</Text>
				</Alert>
			)}
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
							{phase && (
								<Badge size="xs" variant="light" color={phase === "build" ? "yellow" : "blue"}>
									{phase === "build" ? t("buildPhase") : t("startPhase")}
								</Badge>
							)}
							{!phase && (
								<Text size="xs" c="dimmed">
									{t("starting")}
								</Text>
							)}
						</Group>
					)}
					{displayedBuildLogs && (
						<ScrollArea.Autosize mah={120} type="auto">
							<Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
								{displayedBuildLogs}
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
						) : displayedRuntimeLogs ? (
							<ScrollArea.Autosize mah={200} type="auto">
								<Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
									{displayedRuntimeLogs}
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
							onClick={() =>
								canStopContainers && stop.mutate(chapterId, { onError: onContainerError })
							}
							loading={stop.isPending}
							disabled={!canStopContainers}
							title={!canStopContainers ? containerCapabilityReason : undefined}
						>
							{t("stop")}
						</Button>
						<Button
							size="compact-xs"
							variant="light"
							leftSection={<IconScript size={12} />}
							onClick={() => canReadLogs && setLogsOpen((open) => !open)}
							disabled={!canReadLogs}
							title={!canReadLogs ? containerCapabilityReason : undefined}
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
						onClick={() =>
							canStartContainers && start.mutate(chapterId, { onError: onContainerError })
						}
						loading={start.isPending}
						disabled={starting || !canStartContainers}
						title={!canStartContainers ? containerCapabilityReason : undefined}
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
