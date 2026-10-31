import { api } from "@frontend/lib/api";
import {
	Button,
	Divider,
	Group,
	MultiSelect,
	PasswordInput,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlatformInstanceRow } from "./PlatformInstancesModal";

/**
 * 单个平台实例的配置。
 *
 * 配置按实例存放（`agent.platformInstances[].config`），与内置平台和其它实例都不共享：
 * CommandCode 用自己的 apiKey/baseUrl，Codex 只用自己选中的凭据，TokenDance 用自己的 apiKey。
 */
export function PlatformInstanceSection({
	instance,
	onSave,
}: {
	instance: PlatformInstanceRow;
	onSave: (config: Record<string, unknown>) => void;
}) {
	const { t } = useTranslation("settings");
	// 调用方按实例 id 传 `key`，切换实例时组件重建，草稿不会带到别的实例。
	const [config, setConfig] = useState<Record<string, unknown>>(instance.config ?? {});

	const { data: codexStatus } = useQuery({
		queryKey: ["codex", "status", "platform-instance"],
		queryFn: () => api.codexStatus(),
		enabled: instance.platform === "codex",
		staleTime: 30_000,
	});
	const credentialOptions = useMemo(
		() =>
			(codexStatus?.entries ?? [])
				.filter((entry) => !entry.archivedAt)
				.map((entry) => ({
					value: entry.id,
					label: entry.displayName ?? entry.email ?? entry.id,
				})),
		[codexStatus?.entries],
	);

	const setValue = (key: string, value: unknown) =>
		setConfig((current) => ({ ...current, [key]: value }));

	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center">
				<Title order={5}>{instance.name}</Title>
				<Text size="xs" c="dimmed">
					{instance.prefix}
				</Text>
			</Group>
			<Text size="xs" c="dimmed">
				{t("platformInstanceConfigHint")}
			</Text>
			<Divider />
			{instance.platform === "CommandCode" && (
				<>
					<PasswordInput
						label={t("platformInstanceApiKey")}
						value={String(config.apiKey ?? "")}
						onChange={(event) => setValue("apiKey", event.currentTarget.value)}
					/>
					<TextInput
						label={t("platformInstanceBaseUrl")}
						value={String(config.baseUrl ?? "")}
						onChange={(event) => setValue("baseUrl", event.currentTarget.value)}
					/>
				</>
			)}
			{instance.platform === "codex" && (
				<>
					<Switch
						label={t("platformInstanceWebSocket")}
						checked={config.useWebSocket !== false}
						onChange={(event) => setValue("useWebSocket", event.currentTarget.checked)}
					/>
					<Switch
						label={t("platformInstanceWebSearch")}
						checked={config.useWebSearch !== false}
						onChange={(event) => setValue("useWebSearch", event.currentTarget.checked)}
					/>
					<Switch
						label={t("platformInstanceImageGeneration")}
						checked={config.useImageGeneration !== false}
						onChange={(event) => setValue("useImageGeneration", event.currentTarget.checked)}
					/>
					<MultiSelect
						label={t("platformInstanceCodexCredentials")}
						description={t("platformInstanceCodexCredentialsHint")}
						data={credentialOptions}
						value={(config.credentialIds as string[] | undefined) ?? []}
						onChange={(value) => setValue("credentialIds", value)}
						searchable
						clearable
					/>
				</>
			)}
			{instance.platform === "tokendance" && (
				<PasswordInput
					label={t("platformInstanceApiKey")}
					value={String(config.apiKey ?? "")}
					onChange={(event) => setValue("apiKey", event.currentTarget.value)}
				/>
			)}
			<Group justify="flex-end">
				<Button onClick={() => onSave(config)}>{t("platformInstanceSave")}</Button>
			</Group>
		</Stack>
	);
}
