import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Divider,
	Group,
	PasswordInput,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconRefresh, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCodexManagerParityCapability,
	useProviderModelRefreshCapability,
	useProviderQuotaCapability,
	useProviderRuntimeCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";
import { ModelList } from "./ModelList";
import type { OpenAIProviderState } from "./types";

type ProvidersUpdater =
	| OpenAIProviderState[]
	| ((prev: OpenAIProviderState[]) => OpenAIProviderState[]);

interface OpenAIProvidersSectionProps {
	providers: OpenAIProviderState[];
	onProvidersChange: (updater: ProvidersUpdater) => void;
	providerModelsMap: Record<string, ModelOption[]>;
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
	onTestModel?: (model: string) => void;
}

export const OpenAIProvidersSection = React.memo(function OpenAIProvidersSection({
	providers,
	onProvidersChange,
	providerModelsMap,
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
	onTestModel,
}: OpenAIProvidersSectionProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const openaiRuntimeCapability = useProviderRuntimeCapability("openai");
	const openaiRefreshCapability = useProviderModelRefreshCapability("openai");
	const providerRouteUnsupportedReason = t("providerRouteUnsupported");
	const openaiRefreshReason =
		openaiRefreshCapability.reason ?? t("providerRefreshModelsUnsupported");
	const openaiRoutesSupported = openaiRuntimeCapability?.routes?.supported !== false;
	const canRefreshOpenAIProviderModels =
		openaiRefreshCapability.supported &&
		openaiRoutesSupported &&
		openaiRuntimeCapability?.routes?.perProviderModelsRefresh !== false;
	const openaiRefreshUnsupportedReason = openaiRefreshCapability.supported
		? providerRouteUnsupportedReason
		: openaiRefreshReason;
	const openaiQuotaCapability = useProviderQuotaCapability("openai");
	const openaiQuotaUnsupportedReason = openaiQuotaCapability.supported
		? undefined
		: (openaiQuotaCapability.reason ?? t("providerQuotaUnsupported"));
	const codexManagerParity = useCodexManagerParityCapability();
	const showCodexParityWarning =
		providers.some((p) => p.apiMode === "codex") &&
		codexManagerParity?.tsCodexManagerEquivalent === false;
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

	const handleRemoveProvider = useCallback(
		(id: string) => onProvidersChange((prev) => prev.filter((p) => p.id !== id)),
		[onProvidersChange],
	);

	const updateProvider = useCallback(
		(id: string, field: keyof OpenAIProviderState, value: string | boolean) => {
			onProvidersChange((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
		},
		[onProvidersChange],
	);

	const toggleProviderDisabled = useCallback(
		(id: string) => {
			onProvidersChange((prev) =>
				prev.map((p) => (p.id === id ? { ...p, disabled: !p.disabled } : p)),
			);
		},
		[onProvidersChange],
	);

	const handleRefreshProviderModels = useCallback(
		async (providerId: string) => {
			if (!canRefreshOpenAIProviderModels) return;
			if (isProviderDirty?.(providerId)) {
				const saved = await onSaveBeforeRefresh?.();
				if (!saved) return;
			}
			setRefreshingProvider(providerId);
			try {
				const result = await api.openaiRefreshProviderModels(providerId);
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				qc.invalidateQueries({ queryKey: ["settings"] });
				if (result.resolvedBaseUrl) {
					// Suggest-safe fallback (baseUrl + /v1) — prompt the user to fix it.
					notifications.show({
						color: "yellow",
						title: t("anthropicRefreshModelsResolvedUrl"),
						message: result.resolvedBaseUrl,
						autoClose: 8000,
					});
				} else if (result.resolvedModelsUrl) {
					// Informational: model list came from a different path; the chat
					// base URL may not need to change.
					notifications.show({
						color: "blue",
						title: t("openaiModelsFromFallbackUrl"),
						message: result.resolvedModelsUrl,
						autoClose: 8000,
					});
				}
			} catch (err) {
				notifications.show({
					color: "red",
					title: t("openaiRefreshModelsError"),
					message: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setRefreshingProvider(null);
			}
		},
		[canRefreshOpenAIProviderModels, qc, t, isProviderDirty, onSaveBeforeRefresh],
	);

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("openaiProvidersSectionDesc")}
			</Text>

			{openaiQuotaUnsupportedReason && (
				<Alert color="yellow" variant="light" title={t("providerQuotaUnsupported")}>
					{openaiQuotaUnsupportedReason}
				</Alert>
			)}

			{showCodexParityWarning && (
				<Alert color="yellow" variant="light" title={t("codexManagerParityWarning")}>
					{t("codexManagerParityWarningDesc")}
				</Alert>
			)}

			{providers.map((p, idx) => {
				const pModels = providerModelsMap[p.id] ?? [];
				return (
					<React.Fragment key={p.id}>
						{idx > 0 && <Divider />}
						<Stack gap="xs" style={p.disabled ? { opacity: 0.6 } : undefined}>
							<Group justify="space-between">
								<Group gap="xs">
									<Text fw={500} size="sm">
										{p.name || `Provider #${idx + 1}`}
									</Text>
									{p.disabled && (
										<Badge size="xs" variant="light" color="gray">
											{t("providerDisabled")}
										</Badge>
									)}
									{!p.disabled && pModels.length > 0 && (
										<Badge size="xs" variant="light">
											{t("openaiModelsCount", { count: pModels.length })}
										</Badge>
									)}
								</Group>
								<Group gap="xs">
									<Switch
										size="xs"
										checked={!p.disabled}
										onChange={() => toggleProviderDisabled(p.id)}
									/>
									<ActionIcon
										color="red"
										variant="subtle"
										size="sm"
										onClick={() => handleRemoveProvider(p.id)}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							</Group>

							<TextInput
								label={t("openaiProviderName")}
								placeholder={t("openaiProviderNamePlaceholder")}
								value={p.name}
								size="xs"
								onChange={(e) => updateProvider(p.id, "name", e.currentTarget.value)}
							/>
							<TextInput
								label={t("openaiProviderPrefix")}
								description={t("openaiProviderPrefixDesc")}
								placeholder={t("openaiProviderPrefixPlaceholder")}
								value={p.prefix}
								size="xs"
								error={getPrefixError?.(p.prefix, p.id)}
								onChange={(e) =>
									updateProvider(
										p.id,
										"prefix",
										e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
									)
								}
							/>
							<PasswordInput
								label={t("openaiApiKey")}
								placeholder={t("openaiApiKeyPlaceholder")}
								value={p.apiKey}
								size="xs"
								autoComplete="off"
								onChange={(e) => updateProvider(p.id, "apiKey", e.currentTarget.value)}
							/>
							<TextInput
								label={t("openaiBaseUrl")}
								placeholder={t("openaiBaseUrlPlaceholder")}
								value={p.baseUrl}
								size="xs"
								onChange={(e) => updateProvider(p.id, "baseUrl", e.currentTarget.value)}
							/>
							<Stack gap={4}>
								<Text size="sm" fw={500}>
									{t("openaiApiMode")}
								</Text>
								<Text size="xs" c="dimmed">
									{t("openaiApiModeDesc")}
								</Text>
								<SegmentedControl
									size="xs"
									value={p.apiMode}
									onChange={(v) => updateProvider(p.id, "apiMode", v)}
									data={[
										{ label: t("openaiApiModeResponses"), value: "responses" },
										{ label: t("openaiApiModeCompletions"), value: "completions" },
										{ label: t("openaiApiModeCodex"), value: "codex" },
									]}
								/>
							</Stack>
							{p.apiMode === "codex" && (
								<TextInput
									label={t("openaiCodexAccountId")}
									description={t("openaiCodexAccountIdDesc")}
									placeholder={t("openaiCodexAccountIdPlaceholder")}
									value={p.codexAccountId}
									size="xs"
									onChange={(e) => updateProvider(p.id, "codexAccountId", e.currentTarget.value)}
								/>
							)}
							{p.apiMode === "codex" && (
								<Switch
									label={t("openaiCodexWebSocket")}
									description={t("openaiCodexWebSocketDesc")}
									size="xs"
									checked={!!p.codexWebSocket}
									onChange={(e) => updateProvider(p.id, "codexWebSocket", e.currentTarget.checked)}
								/>
							)}
							<Group gap="xs">
								<Button
									size="xs"
									variant="light"
									leftSection={<IconRefresh size={14} />}
									loading={refreshingProvider === p.id}
									disabled={!p.apiKey || !canRefreshOpenAIProviderModels}
									title={
										!canRefreshOpenAIProviderModels ? openaiRefreshUnsupportedReason : undefined
									}
									onClick={() => handleRefreshProviderModels(p.id)}
								>
									{refreshingProvider === p.id
										? t("openaiRefreshModelsLoading")
										: t("openaiRefreshModels")}
								</Button>
								{pModels.length > 0 && (
									<Text size="xs" c="dimmed">
										{t("openaiModelsCount", { count: pModels.length })}
									</Text>
								)}
							</Group>
							{pModels.length > 0 && (
								<ModelList
									models={pModels}
									hiddenModels={hiddenModels}
									onToggleHidden={onToggleHidden}
									onBatchToggleHidden={onBatchToggleHidden}
									modelContextWindows={modelContextWindows}
									onContextWindowChange={onContextWindowChange}
									onTestModel={onTestModel}
								/>
							)}
							<InlineCustomModels
								prefix={p.prefix || "openai"}
								customModels={customModels}
								onCustomModelsChange={onCustomModelsChange}
								hiddenModels={hiddenModels}
								onToggleHidden={onToggleHidden}
								modelContextWindows={modelContextWindows}
								onContextWindowChange={onContextWindowChange}
								onTestModel={onTestModel}
							/>
						</Stack>
					</React.Fragment>
				);
			})}
		</Stack>
	);
});
