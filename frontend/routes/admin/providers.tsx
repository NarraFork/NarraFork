import {
	ActionIcon,
	Affix,
	Badge,
	Button,
	Collapse,
	Group,
	Loader,
	NativeSelect,
	Paper,
	PasswordInput,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
	Title,
	Transition,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconEyeOff,
	IconPlus,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { BUILTIN_MODELS, type ModelOption, modelValue } from "../../lib/constants";

interface OpenAIProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	apiMode: "responses" | "completions" | "codex";
	codexAccountId: string;
}

/** Ensure a model value has a "provider:" prefix. */
function ensurePrefix(val: string): string {
	if (!val || val.includes(":")) return val;
	return `openai:${val}`;
}

export const Route = createFileRoute("/admin/providers")({
	component: ProvidersPage,
});

function ProvidersPage() {
	const { data: user } = useCurrentUser();
	const navigate = useNavigate();
	const { t } = useTranslation("settings");
	const qc = useQueryClient();

	const { data: settings, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	// OpenAI providers state
	const [openaiProviders, setOpenaiProviders] = useState<OpenAIProviderState[]>([]);
	const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);
	const [providersInitialized, setProvidersInitialized] = useState(false);

	// Hidden models state
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);
	const [hiddenInitialized, setHiddenInitialized] = useState(false);

	// Custom models state
	const [customModels, setCustomModels] = useState<
		Array<{ value: string; label: string; provider?: string }>
	>([]);
	const [customInitialized, setCustomInitialized] = useState(false);
	const [newModelValue, setNewModelValue] = useState("");
	const [newModelLabel, setNewModelLabel] = useState("");
	const [newModelProvider, setNewModelProvider] = useState("openai");


	// Server snapshot for dirty detection
	const serverSnapshot = useRef({
		openaiProviders: [] as OpenAIProviderState[],
		hiddenModels: [] as string[],
		customModels: [] as Array<{ value: string; label: string; provider?: string }>,
	});

	// Sync providers from settings
	useEffect(() => {
		if (settings && !providersInitialized) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const providers = (settings.openaiProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "openai",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				apiMode: p.apiMode ?? "responses",
				codexAccountId: p.codexAccountId ?? "",
			}));
			setOpenaiProviders(providers);
			serverSnapshot.current.openaiProviders = providers;
			setProvidersInitialized(true);
		}
	}, [settings, providersInitialized]);

	// Sync hidden models from settings
	useEffect(() => {
		if (settings && !hiddenInitialized) {
			const hidden = (settings.agent?.hiddenModels ?? []).map((v: string) => ensurePrefix(v));
			setHiddenModels(hidden);
			serverSnapshot.current.hiddenModels = hidden;
			setHiddenInitialized(true);
		}
	}, [settings, hiddenInitialized]);

	// Sync custom models from settings
	useEffect(() => {
		if (settings && !customInitialized) {
			const custom = (settings.agent?.customModels ?? []).map(
				(m: { value: string; label: string; provider?: string }) => ({
					...m,
					value: m.value.includes(":") ? m.value : modelValue(m.provider ?? "openai", m.value),
				}),
			);
			setCustomModels(custom);
			serverSnapshot.current.customModels = custom;
			setCustomInitialized(true);
		}
	}, [settings, customInitialized]);

	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => {
			serverSnapshot.current = {
				openaiProviders: [...openaiProviders],
				hiddenModels: [...hiddenModels],
				customModels: [...customModels],
			};
			setProvidersInitialized(true);
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});

	const isDirty = useMemo(() => {
		if (!providersInitialized || !hiddenInitialized || !customInitialized) return false;
		const s = serverSnapshot.current;
		return (
			JSON.stringify(openaiProviders) !== JSON.stringify(s.openaiProviders) ||
			JSON.stringify(hiddenModels) !== JSON.stringify(s.hiddenModels) ||
			JSON.stringify(customModels) !== JSON.stringify(s.customModels)
		);
	}, [
		providersInitialized,
		hiddenInitialized,
		customInitialized,
		openaiProviders,
		hiddenModels,
		customModels,
	]);

	const [highlight, setHighlight] = useState(false);
	useEffect(() => {
		if (isDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [isDirty]);

	const handleSave = useCallback(() => {
		updateMutation.mutate({
			openaiProviders,
			agent: { hiddenModels, customModels },
		});
	}, [updateMutation, openaiProviders, hiddenModels, customModels]);

	// Provider handlers
	const handleAddProvider = useCallback(() => {
		const id = Math.random().toString(36).slice(2, 10);
		setOpenaiProviders((prev) => [
			...prev,
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
	}, []);

	const handleRemoveProvider = useCallback((id: string) => {
		setOpenaiProviders((prev) => prev.filter((p) => p.id !== id));
	}, []);

	const updateProvider = useCallback(
		(id: string, field: keyof OpenAIProviderState, value: string) => {
			setOpenaiProviders((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
		},
		[],
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
			setRefreshingProvider(providerId);
			try {
				await api.openaiRefreshProviderModels(providerId);
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				qc.invalidateQueries({ queryKey: ["settings"] });
			} catch {
				notifications.show({
					color: "red",
					title: t("openaiRefreshModelsError"),
					message: "",
				});
			} finally {
				setRefreshingProvider(null);
			}
		},
		[qc, t],
	);

		try {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		} catch {
			notifications.show({
				color: "red",
				title: t("openaiRefreshModelsError"),
				message: "",
			});
		} finally {
		}
	}, [qc, t]);

	const toggleHidden = useCallback((modelVal: string) => {
		setHiddenModels((prev) =>
			prev.includes(modelVal) ? prev.filter((id) => id !== modelVal) : [...prev, modelVal],
		);
	}, []);

	const handleAddModel = useCallback(() => {
		const v = newModelValue.trim();
		const l = newModelLabel.trim();
		if (!v || !l) return;
		const fullValue = modelValue(newModelProvider, v);
		if (customModels.some((m) => m.value === fullValue)) return;
		setCustomModels((prev) => [
			...prev,
			{ value: fullValue, label: l, provider: newModelProvider },
		]);
		setNewModelValue("");
		setNewModelLabel("");
	}, [newModelValue, newModelLabel, newModelProvider, customModels]);

	const handleRemoveModel = useCallback((value: string) => {
		setCustomModels((prev) => prev.filter((m) => m.value !== value));
	}, []);

	// Redirect non-admin users
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (isLoading) return <Loader />;

				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				.map((m: any) => {
					const id = String(m.model_id ?? m.modelId ?? "");
					return {
						label: String(
							m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? id,
						),
					};
				})
		: BUILTIN_MODELS;

	// Build OpenAI models from per-provider grouped data
	const openaiModelsGrouped: Array<{
		providerId: string;
		providerName: string;
		models: Array<{ id: string }>;
	}> = settings?.openaiModelsGrouped ?? [];

	const serverProviders: Array<{ id: string; prefix?: string; name?: string }> =
		settings?.openaiProviders ?? [];

	// Build provider prefix lookup
	const providerPrefixMap: Record<string, string> = {};
	for (const p of serverProviders) {
		providerPrefixMap[p.id] = p.prefix ?? "openai";
	}

	// Build per-provider fetched models
	const providerModelsMap: Record<string, ModelOption[]> = {};
	for (const group of openaiModelsGrouped) {
		const prefix = providerPrefixMap[group.providerId] ?? "openai";
		providerModelsMap[group.providerId] = group.models.map((m) => ({
			value: `${prefix}:${m.id}`,
			label: m.id,
			provider: prefix,
		}));
	}

	// Provider prefix options for custom model add
	const prefixOptions = [
		...serverProviders.map((p) => ({
			value: p.prefix ?? "openai",
			label: p.name ?? p.prefix ?? "openai",
		})),
	];
	// Deduplicate
	const seenPrefixes = new Set<string>();
	const uniquePrefixOptions = prefixOptions.filter((o) => {
		if (seenPrefixes.has(o.value)) return false;
		seenPrefixes.add(o.value);
		return true;
	});

	return (
		<>
			<Stack>
				<Title order={2}>{t("providersTitle", { defaultValue: "AI Providers" })}</Title>

				<Paper withBorder p="md">
					<Stack>
						<Group justify="space-between">
							<div>
								<Text size="xs" c="dimmed">
										defaultValue: "{{count}} models",
									})}
								</Text>
							</div>
							<Button
								size="xs"
								variant="light"
								leftSection={<IconRefresh size={14} />}
							>
							</Button>
						</Group>
							const isHidden = hiddenModels.includes(m.value);
							return (
								<Group key={m.value} gap="xs" style={isHidden ? { opacity: 0.5 } : undefined}>
									<TextInput value={m.value} disabled style={{ flex: 1 }} />
									<TextInput value={m.label} disabled style={{ flex: 1 }} />
									<ActionIcon
										variant="subtle"
										color={isHidden ? "gray" : "blue"}
										onClick={() => toggleHidden(m.value)}
									>
										{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
									</ActionIcon>
								</Group>
							);
						})}
					</Stack>
				</Paper>

				{/* === OpenAI Providers Section === */}
				<Paper withBorder p="md">
					<Stack>
						<Group justify="space-between">
							<div>
								<Title order={4}>{t("openaiProvidersSection")}</Title>
								<Text size="xs" c="dimmed">
									{t("openaiProvidersSectionDesc")}
								</Text>
							</div>
							<Button
								size="xs"
								variant="light"
								leftSection={<IconPlus size={14} />}
								onClick={handleAddProvider}
							>
								{t("openaiAddProvider")}
							</Button>
						</Group>
						{openaiProviders.map((p, idx) => {
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
														{t("openaiModelsCount", { count: providerModelCount })}
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
															{
																label: t("openaiApiModeResponses"),
																value: "responses",
															},
															{
																label: t("openaiApiModeCompletions"),
																value: "completions",
															},
															// TODO: codex mode hidden until ready
															// { label: t("openaiApiModeCodex"), value: "codex" },
														]}
													/>
												</Stack>
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
															{t("openaiModelsCount", {
																count: providerModelCount,
															})}
														</Text>
													)}
												</Group>
												{/* Per-provider model list with hide/show */}
												{pModels.length > 0 && (
													<Stack gap="xs" mt="xs">
														{pModels.map((m) => {
															const isHidden = hiddenModels.includes(m.value);
															return (
																<Group
																	key={m.value}
																	gap="xs"
																	style={isHidden ? { opacity: 0.5 } : undefined}
																>
																	<TextInput value={m.value} disabled style={{ flex: 1 }} />
																	<TextInput value={m.label} disabled style={{ flex: 1 }} />
																	<ActionIcon
																		variant="subtle"
																		color={isHidden ? "gray" : "blue"}
																		onClick={() => toggleHidden(m.value)}
																	>
																		{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
																	</ActionIcon>
																</Group>
															);
														})}
													</Stack>
												)}
											</Stack>
										</Collapse>
									</Stack>
								</Paper>
							);
						})}
					</Stack>
				</Paper>

				{/* === Custom Models Section === */}
				<Paper withBorder p="md">
					<Stack>
						<div>
							<Title order={4}>{t("customModelsSection", { defaultValue: "Custom Models" })}</Title>
							<Text size="xs" c="dimmed">
								{t("customModelsDesc")}
							</Text>
						</div>
						{customModels.map((m) => {
							const isHidden = hiddenModels.includes(m.value);
							return (
								<Group key={m.value} gap="xs" style={isHidden ? { opacity: 0.5 } : undefined}>
									<TextInput value={m.value} disabled style={{ flex: 1 }} />
									<TextInput value={m.label} disabled style={{ flex: 1 }} />
									<Badge
										size="sm"
										variant="light"
										w={70}
									>
										{m.provider ?? "openai"}
									</Badge>
									<ActionIcon
										variant="subtle"
										color={isHidden ? "gray" : "blue"}
										onClick={() => toggleHidden(m.value)}
									>
										{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
									</ActionIcon>
									<ActionIcon
										color="red"
										variant="subtle"
										onClick={() => handleRemoveModel(m.value)}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							);
						})}
						<Group gap="xs">
							<TextInput
								placeholder={t("modelValuePlaceholder")}
								value={newModelValue}
								onChange={(e) => setNewModelValue(e.currentTarget.value)}
								style={{ flex: 1 }}
							/>
							<TextInput
								placeholder={t("modelLabelPlaceholder")}
								value={newModelLabel}
								onChange={(e) => setNewModelLabel(e.currentTarget.value)}
								style={{ flex: 1 }}
							/>
							<NativeSelect
								size="xs"
								data={uniquePrefixOptions}
								value={newModelProvider}
								onChange={(e) => setNewModelProvider(e.currentTarget.value)}
								w={100}
							/>
							<ActionIcon
								variant="light"
								onClick={handleAddModel}
								disabled={!newModelValue.trim() || !newModelLabel.trim()}
							>
								<IconPlus size={14} />
							</ActionIcon>
						</Group>
					</Stack>
				</Paper>
			</Stack>

			<Affix position={{ bottom: 24, right: 24 }}>
				<Transition transition="slide-up" mounted={isDirty}>
					{(styles) => (
						<Button
							onClick={handleSave}
							loading={updateMutation.isPending}
							size="md"
							style={{
								...styles,
								boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
								animation: highlight ? "providersPulse 1.5s ease" : undefined,
							}}
						>
							{t("unsavedSave")}
						</Button>
					)}
				</Transition>
			</Affix>

			<style>{`
			@keyframes providersPulse {
				0% { box-shadow: 0 0 0 0 var(--mantine-color-indigo-5); }
				40% { box-shadow: 0 0 0 10px transparent; }
				100% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
			}
		`}</style>
		</>
	);
}
