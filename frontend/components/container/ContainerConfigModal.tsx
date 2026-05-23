import { useUpdateChapter } from "@frontend/hooks/useChapters";
import { useRemoveContainers } from "@frontend/hooks/useContainers";
import { useChapterContainersCapability } from "@frontend/hooks/usePlatform";
import { api } from "@frontend/lib/api";
import {
	ActionIcon,
	Badge,
	Button,
	Code,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const COMPOSE_INFO_QUERY_GC_TIME_MS = 60_000;
const MAX_RENDERED_COMPOSE_PORTS = 200;
const MAX_RENDERED_COMPOSE_ENV_CHARS = 20_000;

interface EnvEntry {
	key: string;
	value: string;
}

interface ContainerConfigModalProps {
	chapterId: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON config
	currentConfig: any;
	opened: boolean;
	onClose: () => void;
}

function buildEnvironmentPreview(environment: Record<string, unknown>): {
	text: string;
	truncated: boolean;
} {
	const parts: string[] = [];
	let remaining = MAX_RENDERED_COMPOSE_ENV_CHARS;
	let truncated = false;
	for (const [key, value] of Object.entries(environment)) {
		const line = `${key}=${value}`;
		const separator = parts.length > 0 ? "\n" : "";
		const needed = separator.length + line.length;
		if (needed > remaining) {
			if (remaining > separator.length) {
				parts.push(`${separator}${line.slice(0, remaining - separator.length)}`);
			}
			truncated = true;
			break;
		}
		parts.push(`${separator}${line}`);
		remaining -= needed;
	}
	return { text: parts.join(""), truncated };
}

export function ContainerConfigModal({
	chapterId,
	currentConfig,
	opened,
	onClose,
}: ContainerConfigModalProps) {
	const { t } = useTranslation("containers");
	const updateChapter = useUpdateChapter();
	const removeContainers = useRemoveContainers();
	const containerCapability = useChapterContainersCapability();
	const containerCapabilityReason = containerCapability.reason ?? t("capabilityUnsupported");
	const canReadComposeInfo =
		containerCapability.supported && containerCapability.routes.composeInfo;
	const canRemoveContainers = containerCapability.supported && containerCapability.routes.remove;

	const { data: composeInfo, isLoading: composeLoading } = useQuery({
		queryKey: ["composeInfo", chapterId],
		queryFn: () => api.getComposeInfo(chapterId),
		enabled: opened && canReadComposeInfo,
		gcTime: COMPOSE_INFO_QUERY_GC_TIME_MS,
	});

	const [composeFile, setComposeFile] = useState("");
	const [envVars, setEnvVars] = useState<EnvEntry[]>([]);

	useEffect(() => {
		if (opened && currentConfig) {
			setComposeFile(currentConfig.composeFile ?? "");
			const env = currentConfig.env ?? {};
			setEnvVars(Object.entries(env).map(([key, value]) => ({ key, value: value as string })));
		} else if (opened) {
			setComposeFile("");
			setEnvVars([]);
		}
	}, [opened, currentConfig]);

	function handleSave() {
		const config: Record<string, unknown> = {};
		if (composeFile.trim()) config.composeFile = composeFile.trim();
		const envObj: Record<string, string> = {};
		for (const { key, value } of envVars) {
			if (key.trim()) envObj[key.trim()] = value;
		}
		if (Object.keys(envObj).length > 0) config.env = envObj;

		updateChapter.mutate(
			{ id: chapterId, data: { containerConfig: config } },
			{ onSuccess: onClose },
		);
	}

	function handleRemoveContainers() {
		if (!canRemoveContainers) return;
		removeContainers.mutate(
			{ chapterId, deleteVolumes: false },
			{
				onSuccess: () => {
					updateChapter.mutate(
						{ id: chapterId, data: { containerConfig: null } },
						{ onSuccess: onClose },
					);
				},
			},
		);
	}

	const services = composeInfo?.services ?? [];

	return (
		<Modal opened={opened} onClose={onClose} title={t("configModal.title")} size="lg">
			<Stack gap="md">
				{/* Compose file detected info (read-only) */}
				{composeLoading ? (
					<Loader size="xs" />
				) : !canReadComposeInfo ? (
					<Text size="xs" c="dimmed">
						{containerCapabilityReason}
					</Text>
				) : services.length > 0 ? (
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							{t("configModal.composeDetected")}
						</Text>
						{services.map((svc) => {
							const displayedPorts = svc.ports.slice(0, MAX_RENDERED_COMPOSE_PORTS);
							const hiddenPorts = Math.max(0, svc.ports.length - displayedPorts.length);
							const environmentPreview = buildEnvironmentPreview(svc.environment);
							return (
								<Stack key={svc.name} gap={4} pl="xs">
									<Group gap="xs">
										<Badge size="xs" variant="light">
											{svc.name}
										</Badge>
										{svc.image && (
											<Text size="xs" c="dimmed">
												{svc.image}
											</Text>
										)}
									</Group>
									{svc.ports.length > 0 && (
										<Text size="xs" c="dimmed">
											{t("configModal.ports")}:{" "}
											{displayedPorts.map((p) => `${p.host}:${p.container}`).join(", ")}
											{hiddenPorts > 0
												? ` ${t("configModal.itemsHidden", { count: hiddenPorts })}`
												: ""}
										</Text>
									)}
									{environmentPreview.text && (
										<Code style={{ fontSize: 11 }}>
											{environmentPreview.text}
											{environmentPreview.truncated
												? `\n${t("configModal.envPreviewTruncated")}`
												: ""}
										</Code>
									)}
								</Stack>
							);
						})}
					</Stack>
				) : null}

				{/* Compose file path */}
				<TextInput
					label={t("configModal.composeFile")}
					placeholder={t("configModal.composeFilePlaceholder")}
					value={composeFile}
					onChange={(e) => setComposeFile(e.currentTarget.value)}
				/>

				{/* Extra environment variables */}
				<div>
					<Group justify="space-between" mb={4}>
						<Text size="sm" fw={500}>
							{t("configModal.extraEnv")}
						</Text>
						<ActionIcon
							size="xs"
							variant="light"
							onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
						>
							<IconPlus size={14} />
						</ActionIcon>
					</Group>
					{envVars.length > 0 ? (
						<Stack gap={4}>
							{envVars.map((env, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: stable list with add/remove
								<Group key={i} gap="xs" wrap="nowrap">
									<TextInput
										size="xs"
										placeholder={t("configModal.envKey")}
										value={env.key}
										onChange={(e) => {
											const next = [...envVars];
											next[i] = { ...next[i], key: e.currentTarget.value };
											setEnvVars(next);
										}}
										style={{ flex: 1 }}
									/>
									<TextInput
										size="xs"
										placeholder={t("configModal.envValue")}
										value={env.value}
										onChange={(e) => {
											const next = [...envVars];
											next[i] = { ...next[i], value: e.currentTarget.value };
											setEnvVars(next);
										}}
										style={{ flex: 1 }}
									/>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="red"
										onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							))}
						</Stack>
					) : (
						<Text size="xs" c="dimmed">
							{t("configModal.extraEnvHint")}
						</Text>
					)}
				</div>

				{/* Actions */}
				<Group justify="space-between">
					{currentConfig ? (
						<Button
							size="xs"
							variant="subtle"
							color="red"
							onClick={handleRemoveContainers}
							loading={removeContainers.isPending || updateChapter.isPending}
							disabled={!canRemoveContainers}
							title={!canRemoveContainers ? containerCapabilityReason : undefined}
						>
							{t("configModal.removeContainers")}
						</Button>
					) : (
						<div />
					)}
					<Button size="sm" onClick={handleSave} loading={updateChapter.isPending}>
						{t("configModal.save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
