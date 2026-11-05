import { api } from "@frontend/lib/api";
import {
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
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	instanceCardName,
	type PlatformInstanceKind,
	type PlatformInstanceRow,
} from "../../../shared/platform-instances";
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

/**
 * 单个平台实例的配置页。
 *
 * 配置受页面草稿控制（改一下就等于改了草稿），提交与放弃都由底部保存条负责，和 API key
 * 类供应商完全一致；删除入口在概览卡片的开关右侧。
 */
export function PlatformInstanceSection({
	instance,
	cardName,
	prefixError,
	onRename,
	onConfigChange,
}: {
	instance: PlatformInstanceRow;
	cardName: string;
	/** 模型前缀的校验结果；合法时为 undefined。 */
	prefixError?: string;
	onRename: (next: { suffix: string; prefix: string }) => void;
	onConfigChange: (config: Record<string, unknown>) => void;
}) {
	const { t } = useTranslation("settings");
	// 模型前缀默认等于卡片名：只改后缀时前缀跟着走；前缀被单独设过就不再联动。
	const renameSuffix = (suffix: string) => {
		const followsCardName =
			instance.prefix === instanceCardName(instance.platform, instance.suffix);
		onRename({
			suffix,
			prefix: followsCardName ? instanceCardName(instance.platform, suffix) : instance.prefix,
		});
	};

	return (
		<Stack gap="sm">
			<Title order={5}>{cardName}</Title>
			<Group grow align="flex-start">
				<TextInput
					label={t("platformInstanceSuffix")}
					description={t("platformInstanceSuffixHint")}
					value={instance.suffix}
					onChange={(event) => renameSuffix(event.currentTarget.value)}
				/>
				<TextInput
					label={t("platformInstancePrefix")}
					description={t("platformInstancePrefixHint")}
					value={instance.prefix}
					error={prefixError}
					onChange={(event) =>
						onRename({ suffix: instance.suffix, prefix: event.currentTarget.value })
					}
				/>
			</Group>
			<Text size="xs" c="dimmed">
				{t("platformInstanceConfigHint")}
			</Text>
			<Divider />
			<PlatformInstanceFields
				platform={instance.platform}
				config={instance.config ?? {}}
				onChange={onConfigChange}
			/>
		</Stack>
	);
}
