import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Divider,
	Group,
	PasswordInput,
	Select,
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
	useProviderModelRefreshCapability,
	useProviderQuotaCapability,
	useProviderRuntimeCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";
import { ModelList } from "./ModelList";
import type { AnthropicProviderState } from "./types";

type ProvidersUpdater =
	| AnthropicProviderState[]
	| ((prev: AnthropicProviderState[]) => AnthropicProviderState[]);

interface AnthropicProvidersSectionProps {
	providers: AnthropicProviderState[];
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

export const AnthropicProvidersSection = React.memo(function AnthropicProvidersSection({
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
}: AnthropicProvidersSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const qc = useQueryClient();
	const anthropicRuntimeCapability = useProviderRuntimeCapability("anthropic");
	const anthropicRefreshCapability = useProviderModelRefreshCapability("anthropic");
	const providerRouteUnsupportedReason = t("providerRouteUnsupported");
	const anthropicRefreshReason =
		anthropicRefreshCapability.reason ?? t("providerRefreshModelsUnsupported");
	const anthropicRoutesSupported = anthropicRuntimeCapability?.routes?.supported !== false;
	const canRefreshAnthropicProviderModels =
		anthropicRefreshCapability.supported &&
		anthropicRoutesSupported &&
		anthropicRuntimeCapability?.routes?.perProviderModelsRefresh !== false;
	const anthropicRefreshUnsupportedReason = anthropicRefreshCapability.supported
		? providerRouteUnsupportedReason
		: anthropicRefreshReason;
	const anthropicQuotaCapability = useProviderQuotaCapability("anthropic");
	const anthropicQuotaUnsupportedReason = anthropicQuotaCapability.supported
		? undefined
		: (anthropicQuotaCapability.reason ?? t("providerQuotaUnsupported"));
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

	const handleRemoveProvider = useCallback(
		(id: string) => onProvidersChange((prev) => prev.filter((p) => p.id !== id)),
		[onProvidersChange],
	);

	const updateProvider = useCallback(
		(id: string, field: keyof AnthropicProviderState, value: string | boolean | null) => {
			onProvidersChange((prev) =>
				prev.map((p): AnthropicProviderState => {
					if (p.id !== id) return p;
					if (field === "defaultReasoningEffort") {
						const effort = value as "none" | "low" | "medium" | "high" | null;
						return { ...p, defaultReasoningEffort: effort || null };
					}
					return { ...p, [field]: value };
				}),
			);
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
			if (!canRefreshAnthropicProviderModels) return;
			if (isProviderDirty?.(providerId)) {
				const saved = await onSaveBeforeRefresh?.();
				if (!saved) return;
			}
			setRefreshingProvider(providerId);
			try {
				const result = await api.anthropicRefreshProviderModels(providerId);
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				qc.invalidateQueries({ queryKey: ["settings"] });
				if (result.resolvedBaseUrl) {
					notifications.show({
						color: "yellow",
						title: t("anthropicRefreshModelsResolvedUrl"),
						message: result.resolvedBaseUrl,
						autoClose: 8000,
					});
				}
			} catch {
				notifications.show({
					color: "red",
					title: t("anthropicRefreshModelsError"),
					message: "",
				});
			} finally {
				setRefreshingProvider(null);
			}
		},
		[canRefreshAnthropicProviderModels, qc, t, isProviderDirty, onSaveBeforeRefresh],
	);

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("anthropicProvidersSectionDesc")}
			</Text>

			{anthropicQuotaUnsupportedReason && (
				<Alert color="yellow" variant="light" title={t("providerQuotaUnsupported")}>
					{anthropicQuotaUnsupportedReason}
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
											{t("anthropicModelsCount", { count: pModels.length })}
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
								label={t("anthropicProviderName")}
								placeholder={t("anthropicProviderNamePlaceholder")}
								value={p.name}
								size="xs"
								onChange={(e) => updateProvider(p.id, "name", e.currentTarget.value)}
							/>
							<TextInput
								label={t("anthropicProviderPrefix")}
								description={t("anthropicProviderPrefixDesc")}
								placeholder={t("anthropicProviderPrefixPlaceholder")}
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
								label={t("anthropicApiKey")}
								placeholder={t("anthropicApiKeyPlaceholder")}
								value={p.apiKey}
								size="xs"
								autoComplete="off"
								onChange={(e) => updateProvider(p.id, "apiKey", e.currentTarget.value)}
							/>
							<TextInput
								label={t("anthropicBaseUrl")}
								placeholder={t("anthropicBaseUrlPlaceholder")}
								value={p.baseUrl}
								size="xs"
								onChange={(e) => updateProvider(p.id, "baseUrl", e.currentTarget.value)}
							/>
							<Switch
								label={t("anthropicTlsRejectUnauthorized")}
								description={t("anthropicTlsRejectUnauthorizedDesc")}
								size="xs"
								checked={p.tlsRejectUnauthorized === false}
								onChange={(e) =>
									updateProvider(p.id, "tlsRejectUnauthorized", !e.currentTarget.checked)
								}
							/>
							<Switch
								label={t("anthropicOfficialApi")}
								description={t("anthropicOfficialApiDesc")}
								size="xs"
								checked={!!p.officialApi}
								onChange={(e) => updateProvider(p.id, "officialApi", e.currentTarget.checked)}
							/>
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
								value={p.defaultReasoningEffort || "auto"}
								onChange={(v) =>
									updateProvider(p.id, "defaultReasoningEffort", v === "auto" ? null : (v ?? null))
								}
							/>
							<Group gap="xs">
								<Button
									size="xs"
									variant="light"
									leftSection={<IconRefresh size={14} />}
									loading={refreshingProvider === p.id}
									disabled={!p.apiKey || !canRefreshAnthropicProviderModels}
									title={
										!canRefreshAnthropicProviderModels
											? anthropicRefreshUnsupportedReason
											: undefined
									}
									onClick={() => handleRefreshProviderModels(p.id)}
								>
									{refreshingProvider === p.id
										? t("anthropicRefreshModelsLoading")
										: t("anthropicRefreshModels")}
								</Button>
								{pModels.length > 0 && (
									<Text size="xs" c="dimmed">
										{t("anthropicModelsCount", { count: pModels.length })}
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
								prefix={p.prefix || "anthropic"}
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
