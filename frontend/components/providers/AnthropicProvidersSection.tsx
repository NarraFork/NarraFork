import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	Group,
	NumberInput,
	Paper,
	PasswordInput,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconEyeOff,
	IconPlayerPlay,
	IconPlus,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";
import type { AnthropicProviderState } from "./types";

interface AnthropicProvidersSectionProps {
	providers: AnthropicProviderState[];
	onProvidersChange: (providers: AnthropicProviderState[]) => void;
	providerModelsMap: Record<string, ModelOption[]>;
	hiddenModels: string[];
	onToggleHidden: (modelVal: string) => void;
	onBatchToggleHidden: (modelValues: string[], hidden: boolean) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	isProviderDirty?: (providerId: string) => boolean;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	getPrefixError?: (prefix: string, providerId: string) => string | undefined;
	onTestModel?: (model: string) => void;
}

export function AnthropicProvidersSection({
	providers,
	onProvidersChange,
	providerModelsMap,
	hiddenModels,
	onToggleHidden,
	onBatchToggleHidden,
	modelContextWindows,
	onContextWindowChange,
	isProviderDirty,
	customModels,
	onCustomModelsChange,
	getPrefixError,
	onTestModel,
}: AnthropicProvidersSectionProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [sectionExpanded, setSectionExpanded] = useState(false);
	const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

	const handleAddProvider = useCallback(() => {
		const id = Math.random().toString(36).slice(2, 10);
		onProvidersChange([
			...providers,
			{
				id,
				name: "Anthropic",
				prefix: "anthropic",
				apiKey: "",
				baseUrl: "",
				defaultModel: "",
				proxy: "",
			},
		]);
		setExpandedProviders((prev) => new Set(prev).add(id));
	}, [providers, onProvidersChange]);

	const handleRemoveProvider = useCallback(
		(id: string) => {
			onProvidersChange(providers.filter((p) => p.id !== id));
		},
		[providers, onProvidersChange],
	);

	const updateProvider = useCallback(
		(id: string, field: keyof AnthropicProviderState, value: string | boolean | null) => {
			onProvidersChange(
				providers.map((p): AnthropicProviderState => {
					if (p.id !== id) return p;
					if (field === "defaultReasoningEffort") {
						const effort = value as "none" | "low" | "medium" | "high" | null;
						return { ...p, defaultReasoningEffort: effort || null };
					}
					return { ...p, [field]: value };
				}),
			);
		},
		[providers, onProvidersChange],
	);

	const toggleProviderExpanded = useCallback((id: string) => {
		setExpandedProviders((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const handleRefreshProviderModels = useCallback(
		async (providerId: string) => {
			if (isProviderDirty?.(providerId)) {
				notifications.show({
					color: "yellow",
					title: t("refreshModelsSaveFirst"),
					message: "",
				});
				return;
			}
			setRefreshingProvider(providerId);
			try {
				await api.anthropicRefreshProviderModels(providerId);
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				qc.invalidateQueries({ queryKey: ["settings"] });
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
		[qc, t, isProviderDirty],
	);

	return (
		<Paper withBorder p="md">
			<Stack>
				<Group
					justify="space-between"
					style={{ cursor: "pointer" }}
					onClick={() => setSectionExpanded((v) => !v)}
				>
					<Group gap="xs">
						{sectionExpanded ? <IconChevronDown size={20} /> : <IconChevronRight size={20} />}
						<div>
							<Title order={4}>{t("anthropicProvidersSection")}</Title>
							<Text size="xs" c="dimmed">
								{t("anthropicProvidersSectionDesc")}
							</Text>
						</div>
					</Group>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={(e) => {
							e.stopPropagation();
							setSectionExpanded(true);
							handleAddProvider();
						}}
					>
						{t("anthropicAddProvider")}
					</Button>
				</Group>
				<Collapse in={sectionExpanded}>
					<Stack>
						{providers.map((p, idx) => {
							const isExpanded = expandedProviders.has(p.id);
							const pModels = providerModelsMap[p.id] ?? [];
							const providerModelCount = pModels.length;
							return (
								<Paper key={p.id} withBorder p="sm">
									<Stack gap="xs">
										<Group
											justify="space-between"
											style={{ cursor: "pointer" }}
											onClick={() => toggleProviderExpanded(p.id)}
										>
											<Group gap="xs">
												{isExpanded ? (
													<IconChevronDown size={16} />
												) : (
													<IconChevronRight size={16} />
												)}
												<Text fw={500} size="sm">
													{p.name || `Provider #${idx + 1}`}
												</Text>
												{providerModelCount > 0 && (
													<Badge size="xs" variant="light">
														{t("anthropicModelsCount", {
															count: providerModelCount,
														})}
													</Badge>
												)}
											</Group>
											<ActionIcon
												color="red"
												variant="subtle"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													handleRemoveProvider(p.id);
												}}
											>
												<IconTrash size={14} />
											</ActionIcon>
										</Group>
										<Collapse in={isExpanded}>
											<Stack gap="xs" mt="xs">
												<TextInput
													label={t("anthropicProviderName")}
													placeholder={t("anthropicProviderNamePlaceholder")}
													value={p.name}
													onChange={(e) => updateProvider(p.id, "name", e.currentTarget.value)}
												/>
												<TextInput
													label={t("anthropicProviderPrefix")}
													description={t("anthropicProviderPrefixDesc")}
													placeholder={t("anthropicProviderPrefixPlaceholder")}
													value={p.prefix}
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
													onChange={(e) => updateProvider(p.id, "apiKey", e.currentTarget.value)}
												/>
												<TextInput
													label={t("anthropicBaseUrl")}
													placeholder={t("anthropicBaseUrlPlaceholder")}
													value={p.baseUrl}
													onChange={(e) => updateProvider(p.id, "baseUrl", e.currentTarget.value)}
												/>
												<TextInput
													label={t("anthropicProxy")}
													placeholder={t("anthropicProxyPlaceholder")}
													description={t("anthropicProxyDesc")}
													value={p.proxy ?? ""}
													onChange={(e) => updateProvider(p.id, "proxy", e.currentTarget.value)}
												/>
												{p.proxy && (
													<Switch
														label={t("anthropicTlsRejectUnauthorized")}
														description={t("anthropicTlsRejectUnauthorizedDesc")}
														checked={p.tlsRejectUnauthorized === false}
														onChange={(e) =>
															updateProvider(
																p.id,
																"tlsRejectUnauthorized",
																!e.currentTarget.checked,
															)
														}
													/>
												)}
												<Switch
													label={t("anthropicOfficialApi")}
													description={t("anthropicOfficialApiDesc")}
													checked={!!p.officialApi}
													onChange={(e) =>
														updateProvider(p.id, "officialApi", e.currentTarget.checked)
													}
												/>
												<Group gap="xs">
													<Button
														size="xs"
														variant="light"
														leftSection={<IconRefresh size={14} />}
														loading={refreshingProvider === p.id}
														disabled={!p.apiKey}
														onClick={() => handleRefreshProviderModels(p.id)}
													>
														{refreshingProvider === p.id
															? t("anthropicRefreshModelsLoading")
															: t("anthropicRefreshModels")}
													</Button>
													{providerModelCount > 0 && (
														<Text size="xs" c="dimmed">
															{t("anthropicModelsCount", {
																count: providerModelCount,
															})}
														</Text>
													)}
												</Group>
												{pModels.length > 0 &&
													(() => {
														const allHidden = pModels.every((m) => hiddenModels.includes(m.value));
														return (
															<Stack gap="xs" mt="xs">
																<Group gap="xs" justify="flex-end">
																	<Tooltip
																		label={allHidden ? t("showAllModels") : t("hideAllModels")}
																	>
																		<ActionIcon
																			variant="subtle"
																			color={allHidden ? "gray" : "blue"}
																			onClick={() =>
																				onBatchToggleHidden(
																					pModels.map((m) => m.value),
																					!allHidden,
																				)
																			}
																		>
																			{allHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
																		</ActionIcon>
																	</Tooltip>
																</Group>
																{pModels.map((m) => {
																	const isHidden = hiddenModels.includes(m.value);
																	return (
																		<Group
																			key={m.value}
																			gap="xs"
																			wrap="wrap"
																			style={isHidden ? { opacity: 0.5 } : undefined}
																		>
																			<TextInput
																				value={m.value}
																				disabled
																				style={{ flex: 1, minWidth: 120 }}
																			/>
																			<TextInput
																				value={m.label}
																				disabled
																				style={{ flex: 1, minWidth: 120 }}
																			/>
																			<NumberInput
																				placeholder={t("contextWindowPlaceholder")}
																				value={modelContextWindows[m.value] || ""}
																				onChange={(v) =>
																					onContextWindowChange(
																						m.value,
																						typeof v === "number" ? v : null,
																					)
																				}
																				min={1}
																				step={1000}
																				suffix={` ${t("contextWindowSuffix")}`}
																				w={180}
																				size="xs"
																			/>
																			<Tooltip label={t("modelTestBtn")}>
																				<ActionIcon
																					variant="subtle"
																					color="teal"
																					onClick={() => onTestModel?.(m.value)}
																				>
																					<IconPlayerPlay size={16} />
																				</ActionIcon>
																			</Tooltip>
																			<ActionIcon
																				variant="subtle"
																				color={isHidden ? "gray" : "blue"}
																				onClick={() => onToggleHidden(m.value)}
																			>
																				{isHidden ? (
																					<IconEyeOff size={16} />
																				) : (
																					<IconEye size={16} />
																				)}
																			</ActionIcon>
																		</Group>
																	);
																})}
															</Stack>
														);
													})()}
												<InlineCustomModels
													prefix={p.prefix || "anthropic"}
													customModels={customModels}
													onCustomModelsChange={onCustomModelsChange}
													hiddenModels={hiddenModels}
													onToggleHidden={onToggleHidden}
													modelContextWindows={modelContextWindows}
													onContextWindowChange={onContextWindowChange}
												/>
											</Stack>
										</Collapse>
									</Stack>
								</Paper>
							);
						})}
					</Stack>
				</Collapse>
			</Stack>
		</Paper>
	);
}
