import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Paper,
	PasswordInput,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconRefresh, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useProviderModelRefreshCapability,
	useProviderRouteCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";
import { ModelList } from "./ModelList";
import type { CustomApiProtocol, CustomApiProviderState, OpenAIProviderState } from "./types";

type ProvidersUpdater =
	| CustomApiProviderState[]
	| ((prev: CustomApiProviderState[]) => CustomApiProviderState[]);

type ProtocolOptionConfig = {
	value: CustomApiProtocol;
	labelKey: string;
	descKey: string;
};

export const CUSTOM_API_PROTOCOL_OPTIONS: ProtocolOptionConfig[] = [
	{
		value: "anthropic-compatible",
		labelKey: "customApiProtocolAnthropicCompatible",
		descKey: "customApiProtocolAnthropicCompatibleDesc",
	},
	{
		value: "codex-native",
		labelKey: "customApiProtocolCodexNative",
		descKey: "customApiProtocolCodexNativeDesc",
	},
	{
		value: "responses-compatible",
		labelKey: "customApiProtocolResponsesCompatible",
		descKey: "customApiProtocolResponsesCompatibleDesc",
	},
	{
		value: "anthropic-official",
		labelKey: "customApiProtocolAnthropicOfficial",
		descKey: "customApiProtocolAnthropicOfficialDesc",
	},
	{
		value: "completions-compatible",
		labelKey: "customApiProtocolCompletionsCompatible",
		descKey: "customApiProtocolCompletionsCompatibleDesc",
	},
];

export const CUSTOM_API_PROTOCOL_LABEL_KEYS: Record<CustomApiProtocol, string> = {
	"anthropic-official": "customApiProtocolAnthropicOfficial",
	"anthropic-compatible": "customApiProtocolAnthropicCompatible",
	"codex-native": "customApiProtocolCodexNative",
	"responses-compatible": "customApiProtocolResponsesCompatible",
	"completions-compatible": "customApiProtocolCompletionsCompatible",
};

export function protocolFromOpenAI(apiMode?: OpenAIProviderState["apiMode"]): CustomApiProtocol {
	switch (apiMode) {
		case "codex":
			return "codex-native";
		case "completions":
			return "completions-compatible";
		default:
			return "responses-compatible";
	}
}

export function protocolFromAnthropic(officialApi?: boolean): CustomApiProtocol {
	return officialApi ? "anthropic-official" : "anthropic-compatible";
}

export function isAnthropicProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "anthropic-official" || protocol === "anthropic-compatible";
}

interface CustomApiProviderSectionProps {
	provider: CustomApiProviderState;
	onProvidersChange: (updater: ProvidersUpdater) => void;
	openAIProviderModelsMap: Record<string, ModelOption[]>;
	anthropicProviderModelsMap: Record<string, ModelOption[]>;
	hiddenModels: Set<string>;
	onToggleHidden: (modelVal: string) => void;
	onBatchToggleHidden: (modelValues: string[], hidden: boolean) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	isProviderDirty?: (providerId: string) => boolean;
	onSaveBeforeRefresh?: () => Promise<boolean>;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	getPrefixError?: (prefix: string, providerId: string) => string | undefined;
	getUniquePrefix?: (base: string, providerId: string) => string;
	onTestModel?: (model: string) => void;
}

/** Sanitize a prefix value: any text except an ASCII colon is allowed. */
function sanitizePrefix(value: string): string {
	return value.replace(/:/g, "");
}

export const CustomApiProviderSection = React.memo(function CustomApiProviderSection({
	provider,
	onProvidersChange,
	openAIProviderModelsMap,
	anthropicProviderModelsMap,
	hiddenModels,
	onToggleHidden,
	onBatchToggleHidden,
	modelContextWindows,
	onContextWindowChange,
	isProviderDirty,
	onSaveBeforeRefresh,
	customModels,
	onCustomModelsChange,
	getPrefixError,
	getUniquePrefix,
	onTestModel,
}: CustomApiProviderSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const qc = useQueryClient();
	const openaiRefreshCapability = useProviderModelRefreshCapability("openai");
	const anthropicRefreshCapability = useProviderModelRefreshCapability("anthropic");
	const openaiProviderRefreshRoute = useProviderRouteCapability(
		"openai",
		"perProviderModelsRefresh",
	);
	const anthropicProviderRefreshRoute = useProviderRouteCapability(
		"anthropic",
		"perProviderModelsRefresh",
	);
	const providerRouteUnsupportedReason = t("providerRouteUnsupported");
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

	const selectedProtocol =
		CUSTOM_API_PROTOCOL_OPTIONS.find((option) => option.value === provider.protocol) ??
		CUSTOM_API_PROTOCOL_OPTIONS[0];
	const usesAnthropic = isAnthropicProtocol(provider.protocol);
	const refreshCapability = usesAnthropic ? anthropicRefreshCapability : openaiRefreshCapability;
	const refreshRouteCapability = usesAnthropic
		? anthropicProviderRefreshRoute
		: openaiProviderRefreshRoute;
	const refreshReason = refreshCapability.reason ?? t("providerRefreshModelsUnsupported");
	const canRefreshOpenAIProviderModels =
		openaiRefreshCapability.supported && openaiProviderRefreshRoute.supported;
	const canRefreshAnthropicProviderModels =
		anthropicRefreshCapability.supported && anthropicProviderRefreshRoute.supported;
	const canRefreshProviderModels = usesAnthropic
		? canRefreshAnthropicProviderModels
		: canRefreshOpenAIProviderModels;
	const refreshUnsupportedReason = refreshCapability.supported
		? (refreshRouteCapability.reason ?? providerRouteUnsupportedReason)
		: refreshReason;
	const providerModels =
		(usesAnthropic ? anthropicProviderModelsMap : openAIProviderModelsMap)[provider.id] ?? [];
	const protocolData = useMemo(
		() =>
			CUSTOM_API_PROTOCOL_OPTIONS.map((option) => ({
				value: option.value,
				label: t(option.labelKey),
			})),
		[t],
	);

	const updateProvider = useCallback(
		<K extends keyof CustomApiProviderState>(field: K, value: CustomApiProviderState[K]) => {
			onProvidersChange((prev) =>
				prev.map((p) => (p.id === provider.id ? { ...p, [field]: value } : p)),
			);
		},
		[onProvidersChange, provider.id],
	);

	// Track whether the user has manually edited the prefix. New providers start
	// with an empty prefix → name drives the prefix until the user edits it.
	const [prefixManuallyEdited, setPrefixManuallyEdited] = useState(() => !!provider.prefix);

	const handleNameChange = useCallback(
		(name: string) => {
			onProvidersChange((prev) =>
				prev.map((p) => {
					if (p.id !== provider.id) return p;
					if (prefixManuallyEdited) return { ...p, name };
					const base = sanitizePrefix(name.trim());
					const nextPrefix = base ? (getUniquePrefix?.(base, p.id) ?? base) : "";
					return { ...p, name, prefix: nextPrefix };
				}),
			);
		},
		[onProvidersChange, provider.id, prefixManuallyEdited, getUniquePrefix],
	);

	const handlePrefixChange = useCallback(
		(value: string) => {
			const next = sanitizePrefix(value);
			setPrefixManuallyEdited(next.length > 0);
			updateProvider("prefix", next);
		},
		[updateProvider],
	);

	const handleRemoveProvider = useCallback(() => {
		onProvidersChange((prev) => prev.filter((p) => p.id !== provider.id));
	}, [onProvidersChange, provider.id]);

	const toggleProviderDisabled = useCallback(() => {
		updateProvider("disabled", !provider.disabled);
	}, [provider.disabled, updateProvider]);

	const handleProtocolChange = useCallback(
		(value: string) => {
			updateProvider("protocol", value as CustomApiProtocol);
		},
		[updateProvider],
	);

	const handleRefreshProviderModels = useCallback(async () => {
		if (!canRefreshProviderModels) return;
		if (isProviderDirty?.(provider.id)) {
			const saved = await onSaveBeforeRefresh?.();
			if (!saved) return;
		}
		setRefreshingProvider(provider.id);
		try {
			if (usesAnthropic) {
				const result = await api.anthropicRefreshProviderModels(provider.id);
				if (result.resolvedBaseUrl) {
					notifications.show({
						color: "yellow",
						title: t("anthropicRefreshModelsResolvedUrl"),
						message: result.resolvedBaseUrl,
						autoClose: 8000,
					});
				}
			} else {
				await api.openaiRefreshProviderModels(provider.id);
			}
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		} catch {
			notifications.show({ color: "red", title: t("customApiRefreshModelsError"), message: "" });
		} finally {
			setRefreshingProvider(null);
		}
	}, [
		canRefreshProviderModels,
		qc,
		t,
		isProviderDirty,
		onSaveBeforeRefresh,
		provider.id,
		usesAnthropic,
	]);

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("customApiProvidersSectionDesc")}
			</Text>

			<Stack gap="xs" style={provider.disabled ? { opacity: 0.6 } : undefined}>
				<Group justify="space-between">
					<Group gap="xs">
						<Text fw={500} size="sm">
							{provider.name || provider.prefix || t("providerTypeCustom")}
						</Text>
						<Badge size="xs" variant="light">
							{t(CUSTOM_API_PROTOCOL_LABEL_KEYS[provider.protocol])}
						</Badge>
						{provider.disabled && (
							<Badge size="xs" variant="light" color="gray">
								{t("providerDisabled")}
							</Badge>
						)}
						{!provider.disabled && providerModels.length > 0 && (
							<Badge size="xs" variant="light">
								{t("customApiModelsCount", { count: providerModels.length })}
							</Badge>
						)}
					</Group>
					<Group gap="xs">
						<Switch size="xs" checked={!provider.disabled} onChange={toggleProviderDisabled} />
						<ActionIcon color="red" variant="subtle" size="sm" onClick={handleRemoveProvider}>
							<IconTrash size={14} />
						</ActionIcon>
					</Group>
				</Group>

				<TextInput
					label={t("customApiProviderName")}
					placeholder={t("customApiProviderNamePlaceholder")}
					value={provider.name}
					size="xs"
					onChange={(e) => handleNameChange(e.currentTarget.value)}
				/>
				<TextInput
					label={t("customApiProviderPrefix")}
					description={t("customApiProviderPrefixDesc")}
					placeholder={t("customApiProviderPrefixPlaceholder")}
					value={provider.prefix}
					size="xs"
					error={getPrefixError?.(provider.prefix, provider.id)}
					onChange={(e) => handlePrefixChange(e.currentTarget.value)}
				/>
				<PasswordInput
					label={t("customApiKey")}
					placeholder={t("customApiKeyPlaceholder")}
					value={provider.apiKey}
					size="xs"
					autoComplete="off"
					onChange={(e) => updateProvider("apiKey", e.currentTarget.value)}
				/>
				<TextInput
					label={t("customApiBaseUrl")}
					placeholder={t("customApiBaseUrlPlaceholder")}
					value={provider.baseUrl}
					size="xs"
					onChange={(e) => updateProvider("baseUrl", e.currentTarget.value)}
				/>

				<Stack gap={4}>
					<Text size="sm" fw={500}>
						{t("customApiProtocol")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("customApiProtocolDesc")}
					</Text>
					<Box style={{ overflowX: "auto" }}>
						<SegmentedControl
							size="xs"
							value={provider.protocol}
							onChange={handleProtocolChange}
							data={protocolData}
							style={{ minWidth: 680 }}
						/>
					</Box>
					<Paper withBorder p="xs" radius="sm">
						<Text size="xs" fw={600}>
							{t(selectedProtocol.labelKey)}
						</Text>
						<Text size="xs" c="dimmed">
							{t(selectedProtocol.descKey)}
						</Text>
					</Paper>
				</Stack>

				{provider.protocol === "codex-native" && (
					<>
						<TextInput
							label={t("openaiCodexAccountId")}
							description={t("openaiCodexAccountIdDesc")}
							placeholder={t("openaiCodexAccountIdPlaceholder")}
							value={provider.codexAccountId}
							size="xs"
							onChange={(e) => updateProvider("codexAccountId", e.currentTarget.value)}
						/>
						<Switch
							label={t("openaiCodexWebSocket")}
							description={t("openaiCodexWebSocketDesc")}
							size="xs"
							checked={!!provider.codexWebSocket}
							onChange={(e) => updateProvider("codexWebSocket", e.currentTarget.checked)}
						/>
						<Switch
							label={t("openaiCodexWebSearch")}
							description={t("openaiCodexWebSearchDesc")}
							size="xs"
							checked={provider.codexWebSearch !== false}
							onChange={(e) => updateProvider("codexWebSearch", e.currentTarget.checked)}
						/>
						<Switch
							label={t("openaiCodexImageGeneration")}
							description={t("openaiCodexImageGenerationDesc")}
							size="xs"
							checked={provider.codexImageGeneration !== false}
							onChange={(e) => updateProvider("codexImageGeneration", e.currentTarget.checked)}
						/>
					</>
				)}

				{usesAnthropic && (
					<>
						<TextInput
							label={t("anthropicProxy")}
							placeholder={t("anthropicProxyPlaceholder")}
							description={t("anthropicProxyDesc")}
							value={provider.proxy ?? ""}
							size="xs"
							onChange={(e) => updateProvider("proxy", e.currentTarget.value)}
						/>
						{provider.proxy && (
							<Switch
								label={t("anthropicTlsRejectUnauthorized")}
								description={t("anthropicTlsRejectUnauthorizedDesc")}
								size="xs"
								checked={provider.tlsRejectUnauthorized === false}
								onChange={(e) => updateProvider("tlsRejectUnauthorized", !e.currentTarget.checked)}
							/>
						)}
						<Select
							label={t("anthropicDefaultReasoningEffort")}
							description={t("anthropicDefaultReasoningEffortDesc")}
							size="xs"
							data={[
								{ value: "auto", label: tn("reasoning_auto") },
								{ value: "none", label: tn("reasoning_none") },
								{ value: "low", label: tn("reasoning_low") },
								{ value: "medium", label: tn("reasoning_medium") },
								{ value: "high", label: tn("reasoning_high") },
							]}
							value={provider.defaultReasoningEffort || "auto"}
							onChange={(v) =>
								updateProvider(
									"defaultReasoningEffort",
									v && v !== "auto"
										? (v as CustomApiProviderState["defaultReasoningEffort"])
										: null,
								)
							}
						/>
					</>
				)}

				<Divider />
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						leftSection={<IconRefresh size={14} />}
						loading={refreshingProvider === provider.id}
						disabled={!provider.apiKey || !canRefreshProviderModels}
						title={!canRefreshProviderModels ? refreshUnsupportedReason : undefined}
						onClick={handleRefreshProviderModels}
					>
						{refreshingProvider === provider.id
							? t("customApiRefreshModelsLoading")
							: t("customApiRefreshModels")}
					</Button>
					{providerModels.length > 0 && (
						<Text size="xs" c="dimmed">
							{t("customApiModelsCount", { count: providerModels.length })}
						</Text>
					)}
				</Group>
				{providerModels.length > 0 && (
					<ModelList
						models={providerModels}
						hiddenModels={hiddenModels}
						onToggleHidden={onToggleHidden}
						onBatchToggleHidden={onBatchToggleHidden}
						modelContextWindows={modelContextWindows}
						onContextWindowChange={onContextWindowChange}
						onTestModel={onTestModel}
					/>
				)}
				<InlineCustomModels
					prefix={provider.prefix || (usesAnthropic ? "anthropic" : "openai")}
					customModels={customModels}
					onCustomModelsChange={onCustomModelsChange}
					hiddenModels={hiddenModels}
					onToggleHidden={onToggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={onContextWindowChange}
					onTestModel={onTestModel}
				/>
			</Stack>
		</Stack>
	);
});
