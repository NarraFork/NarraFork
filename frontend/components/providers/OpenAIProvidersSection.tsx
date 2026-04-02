import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	Group,
	NumberInput,
	Paper,
	PasswordInput,
	SegmentedControl,
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
import type { OpenAIProviderState } from "./types";

interface OpenAIProvidersSectionProps {
	providers: OpenAIProviderState[];
	onProvidersChange: (providers: OpenAIProviderState[]) => void;
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

export function OpenAIProvidersSection({
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
}: OpenAIProvidersSectionProps) {
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
				name: "",
				prefix: "",
				apiKey: "",
				baseUrl: "",
				defaultModel: "",
				apiMode: "completions" as const,
				codexAccountId: "",
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
		(id: string, field: keyof OpenAIProviderState, value: string) => {
			onProvidersChange(providers.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
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

	const toggleProviderDisabled = useCallback(
		(id: string) => {
			onProvidersChange(providers.map((p) => (p.id === id ? { ...p, disabled: !p.disabled } : p)));
		},
		[providers, onProvidersChange],
	);

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
				await api.openaiRefreshProviderModels(providerId);
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				qc.invalidateQueries({ queryKey: ["settings"] });
			} catch {
				notifications.show({ color: "red", title: t("openaiRefreshModelsError"), message: "" });
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
							<Title order={4}>{t("openaiProvidersSection")}</Title>
							<Text size="xs" c="dimmed">
								{t("openaiProvidersSectionDesc")}
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
						{t("openaiAddProvider")}
					</Button>
				</Group>
				<Collapse in={sectionExpanded}>
					<Stack>
						{providers.map((p, idx) => {
							const isExpanded = expandedProviders.has(p.id);
							const pModels = providerModelsMap[p.id] ?? [];
							const providerModelCount = pModels.length;
							return (
								<Paper
									key={p.id}
									withBorder
									p="sm"
									style={p.disabled ? { opacity: 0.6 } : undefined}
								>
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
												{p.disabled && (
													<Badge size="xs" variant="light" color="gray">
														{t("providerDisabled")}
													</Badge>
												)}
												{!p.disabled && providerModelCount > 0 && (
													<Badge size="xs" variant="light">
														{t("openaiModelsCount", { count: providerModelCount })}
													</Badge>
												)}
											</Group>
											<Group gap="xs">
												<Switch
													size="xs"
													checked={!p.disabled}
													onChange={(e) => {
														e.stopPropagation();
														toggleProviderDisabled(p.id);
													}}
													onClick={(e) => e.stopPropagation()}
												/>
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
										</Group>
										<Collapse in={isExpanded}>
											<Stack gap="xs" mt="xs">
												<TextInput
													label={t("openaiProviderName")}
													placeholder={t("openaiProviderNamePlaceholder")}
													value={p.name}
													onChange={(e) => updateProvider(p.id, "name", e.currentTarget.value)}
												/>
												<TextInput
													label={t("openaiProviderPrefix")}
													description={t("openaiProviderPrefixDesc")}
													placeholder={t("openaiProviderPrefixPlaceholder")}
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
													label={t("openaiApiKey")}
													placeholder={t("openaiApiKeyPlaceholder")}
													value={p.apiKey}
													onChange={(e) => updateProvider(p.id, "apiKey", e.currentTarget.value)}
												/>
												<TextInput
													label={t("openaiBaseUrl")}
													placeholder={t("openaiBaseUrlPlaceholder")}
													value={p.baseUrl}
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
														onChange={(e) =>
															updateProvider(p.id, "codexAccountId", e.currentTarget.value)
														}
													/>
												)}
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
															? t("openaiRefreshModelsLoading")
															: t("openaiRefreshModels")}
													</Button>
													{providerModelCount > 0 && (
														<Text size="xs" c="dimmed">
															{t("openaiModelsCount", { count: providerModelCount })}
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
