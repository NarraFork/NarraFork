import { Affix, Button, Loader, Stack, Title, Transition } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnthropicProvidersSection } from "../../components/providers/AnthropicProvidersSection";
import { CodexSection } from "../../components/providers/CodexSection";
import { CustomModelsSection } from "../../components/providers/CustomModelsSection";
import { OpenAIProvidersSection } from "../../components/providers/OpenAIProvidersSection";
import {
	type AnthropicProviderState,
	ensurePrefix,
	type OpenAIProviderState,
} from "../../components/providers/types";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { type ModelOption, modelValue } from "../../lib/constants";

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
	const [providersInitialized, setProvidersInitialized] = useState(false);

	// Anthropic providers state
	const [anthropicProviders, setAnthropicProviders] = useState<AnthropicProviderState[]>([]);
	const [anthropicInitialized, setAnthropicInitialized] = useState(false);


	// Hidden models state
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);
	const [hiddenInitialized, setHiddenInitialized] = useState(false);

	// Custom models state
	const [customModels, setCustomModels] = useState<
		Array<{ value: string; label: string; provider?: string }>
	>([]);
	const [customInitialized, setCustomInitialized] = useState(false);

	// Model context windows state
	const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>({});
	const [contextWindowsInitialized, setContextWindowsInitialized] = useState(false);

	// Server snapshot for dirty detection
	const serverSnapshot = useRef({
		openaiProviders: [] as OpenAIProviderState[],
		anthropicProviders: [] as AnthropicProviderState[],
		hiddenModels: [] as string[],
		customModels: [] as Array<{ value: string; label: string; provider?: string }>,
		modelContextWindows: {} as Record<string, number>,
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

	// Sync Anthropic providers from settings
	useEffect(() => {
		if (settings && !anthropicInitialized) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const providers = (settings.anthropicProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "anthropic",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				maxMode: p.maxMode ?? false,
			}));
			setAnthropicProviders(providers);
			serverSnapshot.current.anthropicProviders = providers;
			setAnthropicInitialized(true);
		}
	}, [settings, anthropicInitialized]);

	useEffect(() => {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				id: p.id ?? "",
				name: p.name ?? "",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
			}));
		}

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

	// Sync model context windows from settings
	useEffect(() => {
		if (settings && !contextWindowsInitialized) {
			const windows = (settings.agent?.modelContextWindows as Record<string, number>) ?? {};
			setModelContextWindows(windows);
			serverSnapshot.current.modelContextWindows = windows;
			setContextWindowsInitialized(true);
		}
	}, [settings, contextWindowsInitialized]);

	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => {
			serverSnapshot.current = {
				openaiProviders: [...openaiProviders],
				anthropicProviders: [...anthropicProviders],
				hiddenModels: [...hiddenModels],
				customModels: [...customModels],
				modelContextWindows: { ...modelContextWindows },
			};
			setProvidersInitialized(true);
			setAnthropicInitialized(true);
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});

	const isDirty = useMemo(() => {
		if (
			!providersInitialized ||
			!anthropicInitialized ||
			!hiddenInitialized ||
			!customInitialized ||
			!contextWindowsInitialized
		)
			return false;
		const s = serverSnapshot.current;
		return (
			JSON.stringify(openaiProviders) !== JSON.stringify(s.openaiProviders) ||
			JSON.stringify(anthropicProviders) !== JSON.stringify(s.anthropicProviders) ||
			JSON.stringify(hiddenModels) !== JSON.stringify(s.hiddenModels) ||
			JSON.stringify(customModels) !== JSON.stringify(s.customModels) ||
			JSON.stringify(modelContextWindows) !== JSON.stringify(s.modelContextWindows)
		);
	}, [
		providersInitialized,
		anthropicInitialized,
		hiddenInitialized,
		customInitialized,
		contextWindowsInitialized,
		openaiProviders,
		anthropicProviders,
		hiddenModels,
		customModels,
		modelContextWindows,
	]);

	const isOpenaiProviderDirty = useCallback(
		(providerId: string) => {
			const current = openaiProviders.find((p) => p.id === providerId);
			const saved = serverSnapshot.current.openaiProviders.find((p) => p.id === providerId);
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
		[openaiProviders],
	);

	const isAnthropicProviderDirty = useCallback(
		(providerId: string) => {
			const current = anthropicProviders.find((p) => p.id === providerId);
			const saved = serverSnapshot.current.anthropicProviders.find((p) => p.id === providerId);
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
		[anthropicProviders],
	);

		(providerId: string) => {
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
	);

	const [highlight, setHighlight] = useState(false);
	useEffect(() => {
		if (isDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [isDirty]);

	const handleSave = useCallback(() => {
		// Migrate modelContextWindows keys when prefix changes
		const migratedWindows = { ...modelContextWindows };
		for (const provider of openaiProviders) {
			const original = serverSnapshot.current.openaiProviders.find((p) => p.id === provider.id);
			if (original && original.prefix !== provider.prefix) {
				const oldPrefix = original.prefix;
				const newPrefix = provider.prefix;
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${oldPrefix}:`)) {
						const model = key.slice(oldPrefix.length + 1);
						migratedWindows[`${newPrefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}
		for (const provider of anthropicProviders) {
			const original = serverSnapshot.current.anthropicProviders.find((p) => p.id === provider.id);
			if (original && original.prefix !== provider.prefix) {
				const oldPrefix = original.prefix;
				const newPrefix = provider.prefix;
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${oldPrefix}:`)) {
						const model = key.slice(oldPrefix.length + 1);
						migratedWindows[`${newPrefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}
			if (original && original.prefix !== provider.prefix) {
				const oldPrefix = original.prefix;
				const newPrefix = provider.prefix;
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${oldPrefix}:`)) {
						const model = key.slice(oldPrefix.length + 1);
						migratedWindows[`${newPrefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}

		updateMutation.mutate({
			openaiProviders,
			anthropicProviders,
			agent: { hiddenModels, customModels, modelContextWindows: migratedWindows },
		});
	}, [
		updateMutation,
		openaiProviders,
		anthropicProviders,
		hiddenModels,
		customModels,
		modelContextWindows,
	]);

	const toggleHidden = useCallback((modelVal: string) => {
		setHiddenModels((prev) =>
			prev.includes(modelVal) ? prev.filter((id) => id !== modelVal) : [...prev, modelVal],
		);
	}, []);

	const handleContextWindowChange = useCallback((modelVal: string, size: number | null) => {
		setModelContextWindows((prev) => {
			if (size == null) {
				const next = { ...prev };
				delete next[modelVal];
				return next;
			}
			return { ...prev, [modelVal]: size };
		});
	}, []);

	// Redirect non-admin users
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (isLoading) return <Loader />;

	// Build OpenAI models from per-provider grouped data
	const openaiModelsGrouped: Array<{
		providerId: string;
		providerName: string;
		models: Array<{ id: string }>;
	}> = settings?.openaiModelsGrouped ?? [];

	const serverProviders: Array<{ id: string; prefix?: string; name?: string }> =
		settings?.openaiProviders ?? [];

	const providerPrefixMap: Record<string, string> = {};
	for (const p of serverProviders) {
		providerPrefixMap[p.id] = p.prefix ?? "openai";
	}

	const providerModelsMap: Record<string, ModelOption[]> = {};
	for (const group of openaiModelsGrouped) {
		const prefix = providerPrefixMap[group.providerId] ?? "openai";
		providerModelsMap[group.providerId] = group.models.map((m) => ({
			value: `${prefix}:${m.id}`,
			label: m.id,
			provider: prefix,
		}));
	}

	// Build Anthropic models from per-provider grouped data
	const anthropicModelsGrouped: Array<{
		providerId: string;
		providerName: string;
		models: Array<{ id: string }>;
	}> = settings?.anthropicModelsGrouped ?? [];

	const serverAnthropicProviders: Array<{ id: string; prefix?: string; name?: string }> =
		settings?.anthropicProviders ?? [];

	const anthropicPrefixMap: Record<string, string> = {};
	for (const p of serverAnthropicProviders) {
		anthropicPrefixMap[p.id] = p.prefix ?? "anthropic";
	}

	const anthropicModelsMap: Record<string, ModelOption[]> = {};
	for (const group of anthropicModelsGrouped) {
		const prefix = anthropicPrefixMap[group.providerId] ?? "anthropic";
		anthropicModelsMap[group.providerId] = group.models.map((m) => ({
			value: `${prefix}:${m.id}`,
			label: m.id,
			provider: prefix,
		}));
	}

		providerId: string;
		providerName: string;
		models: Array<Record<string, unknown>>;


	}

		const models: ModelOption[] = [];
		for (const m of group.models) {
			const id = String(m.model_id ?? m.modelId ?? "");
			if (!id) continue;
			models.push({
				value: `${prefix}:${id}`,
				label: String(m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? id),
				provider: prefix,
			});
		}
	}

	// Provider prefix options for custom model add
	const prefixOptions = [
		{ value: "codex", label: "Codex" },
		...serverProviders.map((p) => ({
			value: p.prefix ?? "openai",
			label: p.name ?? p.prefix ?? "openai",
		})),
		...serverAnthropicProviders.map((p) => ({
			value: p.prefix ?? "anthropic",
			label: p.name ?? p.prefix ?? "anthropic",
		})),
		})),
	];
	const seenPrefixes = new Set<string>();
	const uniquePrefixOptions = prefixOptions.filter((o) => {
		if (seenPrefixes.has(o.value)) return false;
		seenPrefixes.add(o.value);
		return true;
	});

	return (
		<>
			<Stack>
				<Title order={2}>{t("providersTitle")}</Title>

					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
				/>

					settings={settings}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
				/>

				<CodexSection hiddenModels={hiddenModels} onToggleHidden={toggleHidden} />

				<OpenAIProvidersSection
					providers={openaiProviders}
					onProvidersChange={setOpenaiProviders}
					providerModelsMap={providerModelsMap}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					isProviderDirty={isOpenaiProviderDirty}
				/>

				<AnthropicProvidersSection
					providers={anthropicProviders}
					onProvidersChange={setAnthropicProviders}
					providerModelsMap={anthropicModelsMap}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					isProviderDirty={isAnthropicProviderDirty}
				/>

				<CustomModelsSection
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					prefixOptions={uniquePrefixOptions}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
				/>
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
