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
import { COMMAND_CODE_PROVIDER_BASE } from "@shared/commandcode";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlatformInstanceKind, PlatformInstanceRow } from "../../../shared/platform-instances";
import type { ProxyOverride } from "../../lib/proxy";
import { ProxyOverrideField } from "../common/ProxyOverrideField";
import { ClientFingerprintFields } from "./ClientFingerprintFields";

/** 所有平台的空白配置：新建实例一律从空白开始，不复制任何已有平台。 */
export function emptyInstanceConfig(platform: PlatformInstanceKind): Record<string, unknown> {
	switch (platform) {
		case "codex":
			return {
				useWebSocket: true,
				useWebSearch: true,
				useImageGeneration: true,
				credentialIds: [],
			};
		case "CommandCode":
			// baseUrl 预填官方地址：留空会被当成"没配置"，用户还得自己去查默认值。
			return { apiKey: "", baseUrl: COMMAND_CODE_PROVIDER_BASE };
		case "tokendance":
			return { apiKey: "" };
	}
}

/**
 * 平台实例的配置字段，添加弹窗与实例配置页共用。
 *
 * 只读写实例自己的 config：CommandCode 的 key/baseUrl/代理/指纹，Codex 的开关与凭据子集，
 * TokenDance 的 apiKey。每个实例一套，与其它实例互不共享。
 */
export function PlatformInstanceFields({
	platform,
	config,
	onChange,
}: {
	platform: PlatformInstanceKind;
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const { t } = useTranslation("settings");
	const setValue = (key: string, value: unknown) => onChange({ ...config, [key]: value });

	// Codex 实例只能是账号池的子集，这里列出池里的凭据供勾选。
	const { data: codexStatus } = useQuery({
		queryKey: ["codex", "status", "platform-instance"],
		queryFn: () => api.codexStatus(),
		enabled: platform === "codex",
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

	if (platform === "CommandCode") {
		return (
			<Stack gap="sm">
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
				<ProxyOverrideField
					value={config.proxy as ProxyOverride | undefined}
					onChange={(next) => setValue("proxy", next)}
				/>
				<ClientFingerprintFields
					value={{
						userAgentMode: config.userAgentMode as
							| "narrafork"
							| "claude-code"
							| "codex"
							| "custom"
							| undefined,
						customUserAgent: config.customUserAgent as string | undefined,
						extraHeaders: config.extraHeaders as Record<string, string> | undefined,
					}}
					onChange={(next) => onChange({ ...config, ...next })}
				/>
			</Stack>
		);
	}

	if (platform === "codex") {
		return (
			<Stack gap="sm">
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
			</Stack>
		);
	}

	return (
		<PasswordInput
			label={t("platformInstanceApiKey")}
			description={t("platformInstanceTokenDanceHint")}
			value={String(config.apiKey ?? "")}
			onChange={(event) => setValue("apiKey", event.currentTarget.value)}
		/>
	);
}

/** 单个平台实例的配置页：实例自己的配置、保存与删除。 */
export function PlatformInstanceSection({
	instance,
	cardName,
	onSave,
	onDelete,
}: {
	instance: PlatformInstanceRow;
	cardName: string;
	onSave: (config: Record<string, unknown>) => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation("settings");
	// 调用方按实例 id 传 `key`，切换实例时组件重建，草稿不会带到别的实例。
	const [config, setConfig] = useState<Record<string, unknown>>(instance.config ?? {});

	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center">
				<Title order={5}>{cardName}</Title>
				<Text size="xs" c="dimmed">
					{instance.prefix}
				</Text>
			</Group>
			<Text size="xs" c="dimmed">
				{t("platformInstanceConfigHint")}
			</Text>
			<Divider />
			<PlatformInstanceFields platform={instance.platform} config={config} onChange={setConfig} />
			<Group justify="space-between">
				<Button color="red" variant="subtle" onClick={onDelete}>
					{t("platformInstanceDelete")}
				</Button>
				<Button onClick={() => onSave(config)}>{t("platformInstanceSave")}</Button>
			</Group>
		</Stack>
	);
}
