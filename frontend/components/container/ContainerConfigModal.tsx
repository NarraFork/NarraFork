import { useUpdateChapter } from "@frontend/hooks/useChapters";
import {
	ActionIcon,
	Button,
	Group,
	Modal,
	NumberInput,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface PortEntry {
	containerPort: number;
	serviceName: string;
}

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

export function ContainerConfigModal({
	chapterId,
	currentConfig,
	opened,
	onClose,
}: ContainerConfigModalProps) {
	const { t } = useTranslation("containers");
	const updateChapter = useUpdateChapter();

	const [composeFile, setComposeFile] = useState("");
	const [ports, setPorts] = useState<PortEntry[]>([]);
	const [envVars, setEnvVars] = useState<EnvEntry[]>([]);

	// Sync form state when modal opens or config changes
	useEffect(() => {
		if (opened && currentConfig) {
			setComposeFile(currentConfig.composeFile ?? "");
			setPorts(currentConfig.ports?.map((p: PortEntry) => ({ ...p })) ?? []);
			const env = currentConfig.env ?? {};
			setEnvVars(Object.entries(env).map(([key, value]) => ({ key, value: value as string })));
		} else if (opened) {
			setComposeFile("");
			setPorts([]);
			setEnvVars([]);
		}
	}, [opened, currentConfig]);

	function handleSave() {
		const config: Record<string, unknown> = {};
		if (composeFile.trim()) config.composeFile = composeFile.trim();
		if (ports.length > 0) {
			config.ports = ports.filter((p) => p.containerPort > 0 && p.serviceName.trim());
		}
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

	function handleRemoveConfig() {
		updateChapter.mutate(
			{ id: chapterId, data: { containerConfig: null } },
			{ onSuccess: onClose },
		);
	}

	return (
		<Modal opened={opened} onClose={onClose} title={t("configModal.title")} size="lg">
			<Stack gap="md">
				{/* Compose file path */}
				<TextInput
					label={t("configModal.composeFile")}
					placeholder={t("configModal.composeFilePlaceholder")}
					value={composeFile}
					onChange={(e) => setComposeFile(e.currentTarget.value)}
				/>

				{/* Port mappings */}
				<div>
					<Group justify="space-between" mb={4}>
						<Text size="sm" fw={500}>
							{t("configModal.ports")}
						</Text>
						<ActionIcon
							size="xs"
							variant="light"
							onClick={() => setPorts([...ports, { containerPort: 0, serviceName: "" }])}
						>
							<IconPlus size={14} />
						</ActionIcon>
					</Group>
					<Stack gap={4}>
						{ports.map((port, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: stable list with add/remove
							<Group key={i} gap="xs" wrap="nowrap">
								<NumberInput
									size="xs"
									placeholder={t("configModal.containerPort")}
									value={port.containerPort || ""}
									onChange={(val) => {
										const next = [...ports];
										next[i] = { ...next[i], containerPort: Number(val) || 0 };
										setPorts(next);
									}}
									min={1}
									max={65535}
									style={{ flex: 1 }}
								/>
								<TextInput
									size="xs"
									placeholder={t("configModal.serviceName")}
									value={port.serviceName}
									onChange={(e) => {
										const next = [...ports];
										next[i] = { ...next[i], serviceName: e.currentTarget.value };
										setPorts(next);
									}}
									style={{ flex: 1 }}
								/>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="red"
									onClick={() => setPorts(ports.filter((_, j) => j !== i))}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						))}
					</Stack>
				</div>

				{/* Environment variables */}
				<div>
					<Group justify="space-between" mb={4}>
						<Text size="sm" fw={500}>
							{t("configModal.env")}
						</Text>
						<ActionIcon
							size="xs"
							variant="light"
							onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
						>
							<IconPlus size={14} />
						</ActionIcon>
					</Group>
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
				</div>

				{/* Actions */}
				<Group justify="space-between">
					{currentConfig ? (
						<Button
							size="xs"
							variant="subtle"
							color="red"
							onClick={handleRemoveConfig}
							loading={updateChapter.isPending}
						>
							{t("configModal.removeConfig")}
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
