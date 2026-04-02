import { Affix, Button, Loader, Stack, Title, Transition } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnthropicProvidersSection } from "../../components/providers/AnthropicProvidersSection";
import { ClineSection } from "../../components/providers/ClineSection";
import { CodexSection } from "../../components/providers/CodexSection";
import { CustomModelsSection } from "../../components/providers/CustomModelsSection";
import { ModelTestDialog } from "../../components/providers/ModelTestDialog";
import { type NUGProviderState, NUGProvidersSection } from "../../components/providers/NUGProvidersSection";
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


	// NUG providers state
	const [nugProviders, setNugProviders] = useState<NUGProviderState[]>([]);
	const [nugInitialized, setNugInitialized] = useState(false);

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
		nugProviders: [] as NUGProviderState[],
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
				disabled: p.disabled ?? false,
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
				defaultReasoningEffort: p.defaultReasoningEffort ?? null,
				proxy: p.proxy ?? "",
				tlsRejectUnauthorized: p.tlsRejectUnauthorized ?? true,
				disabled: p.disabled ?? false,
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
				disabled: p.disabled ?? false,
			}));
		}

	// Sync NUG providers from settings
	useEffect(() => {
		if (settings && !nugInitialized) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const providers = (settings.nugProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "nug",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				disabled: p.disabled ?? false,
				nugUsername: p.nugUsername,
				nugUserId: p.nugUserId,
			}));
			setNugProviders(providers);
			serverSnapshot.current.nugProviders = providers;
			setNugInitialized(true);
		}
	}, [settings, nugInitialized]);

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
				nugProviders: [...nugProviders],
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
			!nugInitialized ||
			!hiddenInitialized ||
			!customInitialized ||
			!contextWindowsInitialized
		)
			return false;
		const s = serverSnapshot.current;
		return (
			JSON.stringify(openaiProviders) !== JSON.stringify(s.openaiProviders) ||
			JSON.stringify(anthropicProviders) !== JSON.stringify(s.anthropicProviders) ||
			JSON.stringify(nugProviders) !== JSON.stringify(s.nugProviders) ||
			JSON.stringify(hiddenModels) !== JSON.stringify(s.hiddenModels) ||
			JSON.stringify(customModels) !== JSON.stringify(s.customModels) ||
			JSON.stringify(modelContextWindows) !== JSON.stringify(s.modelContextWindows)
		);
	}, [
		providersInitialized,
		anthropicInitialized,
		nugInitialized,
		hiddenInitialized,
		customInitialized,
		contextWindowsInitialized,
		openaiProviders,
		anthropicProviders,
		nugProviders,
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

	const isNugProviderDirty = useCallback(
		(providerId: string) => {
			const current = nugProviders.find((p) => p.id === providerId);
			const saved = serverSnapshot.current.nugProviders.find((p) => p.id === providerId);
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
		[nugProviders],
	);

	// Prefix conflict detection — reserved prefixes and cross-provider duplicates
	// Extract cline provider prefixes from settings (cline state is not locally managed)
	const clineProviderPrefixes = useMemo(() => {
		const cps = (settings?.clineProviders ?? []) as Array<{ id: string; prefix?: string }>;
		return cps
			.filter((p): p is { id: string; prefix: string } => !!p.prefix)
			.map((p) => ({ id: p.id, prefix: p.prefix }));
	}, [settings]);
	const getPrefixError = useCallback(
		(prefix: string, currentProviderId: string): string | undefined => {
			if (!prefix) return undefined;
			if (RESERVED_PREFIXES.has(prefix)) return t("prefixReserved", { prefix });
			// Check duplicates across all provider types
			const allProviders: Array<{ id: string; prefix: string }> = [
				...openaiProviders,
				...anthropicProviders,
				...nugProviders,
				...clineProviderPrefixes,
			];
			const dup = allProviders.find((p) => p.prefix === prefix && p.id !== currentProviderId);
			if (dup) return t("prefixDuplicate", { prefix });
			return undefined;
		},
		[
			RESERVED_PREFIXES,
			openaiProviders,
			anthropicProviders,
			nugProviders,
			clineProviderPrefixes,
			t,
		],
	);

	const [highlight, setHighlight] = useState(false);
	const [testingModel, setTestingModel] = useState<string | null>(null);
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
		for (const provider of nugProviders) {
			const original = serverSnapshot.current.nugProviders.find((p) => p.id === provider.id);
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
			nugProviders,
			agent: { hiddenModels, customModels, modelContextWindows: migratedWindows },
		});
	}, [
		updateMutation,
		openaiProviders,
		anthropicProviders,
		nugProviders,
		hiddenModels,
		customModels,
		modelContextWindows,
	]);

	const toggleHidden = useCallback((modelVal: string) => {
		setHiddenModels((prev) =>
			prev.includes(modelVal) ? prev.filter((id) => id !== modelVal) : [...prev, modelVal],
		);
	}, []);

	const batchToggleHidden = useCallback((modelValues: string[], hidden: boolean) => {
		setHiddenModels((prev) => {
			if (hidden) {
				const set = new Set(prev);
				for (const v of modelValues) set.add(v);
				return [...set];
			}
			const removeSet = new Set(modelValues);
			return prev.filter((id) => !removeSet.has(id));
		});
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

	// Build NUG models from per-provider grouped data
	const nugModelsGrouped: Array<{
		providerId: string;
		providerName: string;
		models: Array<Record<string, unknown>>;
	}> = settings?.nugModelsGrouped ?? [];

	const serverNugProviders: Array<{ id: string; prefix?: string; name?: string }> =
		settings?.nugProviders ?? [];

	const nugPrefixMap: Record<string, string> = {};
	for (const p of serverNugProviders) {
		nugPrefixMap[p.id] = p.prefix ?? "nug";
	}

	const nugModelsMap: Record<string, ModelOption[]> = {};
	for (const group of nugModelsGrouped) {
		const prefix = nugPrefixMap[group.providerId] ?? "nug";
		const models: ModelOption[] = [];
		for (const m of group.models) {
			const id = String(m.model_id ?? m.modelId ?? m.id ?? "");
			if (!id) continue;
			models.push({
				value: `${prefix}:${id}`,
				label: String(m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? m.name ?? id),
				provider: prefix,
			});
		}
		nugModelsMap[group.providerId] = models;
	}

	return (
		<>
			<Stack pb={80}>
				<Title order={2}>{t("providersTitle")}</Title>

					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

				<NUGProvidersSection
					providers={nugProviders}
					onProvidersChange={setNugProviders}
					providerModelsMap={nugModelsMap}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					isProviderDirty={isNugProviderDirty}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

					settings={settings}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					onTestModel={setTestingModel}
				/>

				<CodexSection
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					onTestModel={setTestingModel}
				/>

				<ClineSection
					settings={settings}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					onTestModel={setTestingModel}
				/>

				<OpenAIProvidersSection
					providers={openaiProviders}
					onProvidersChange={setOpenaiProviders}
					providerModelsMap={providerModelsMap}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					onBatchToggleHidden={batchToggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					isProviderDirty={isOpenaiProviderDirty}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

				<AnthropicProvidersSection
					providers={anthropicProviders}
					onProvidersChange={setAnthropicProviders}
					providerModelsMap={anthropicModelsMap}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					onBatchToggleHidden={batchToggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={handleContextWindowChange}
					isProviderDirty={isAnthropicProviderDirty}
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

				{/* Orphan custom models: models whose provider prefix doesn't match any configured provider */}
				{(() => {
					const knownPrefixes = new Set([
						"codex",
						"cline",
						...openaiProviders.map((p) => p.prefix || "openai"),
						...anthropicProviders.map((p) => p.prefix || "anthropic"),
						...nugProviders.map((p) => p.prefix || "nug"),
					]);
					const orphanModels = customModels.filter((m) => {
						const prefix = m.value.split(":")[0];
						return !knownPrefixes.has(prefix);
					});
					if (orphanModels.length === 0) return null;
					return (
						<CustomModelsSection
							customModels={customModels}
							onCustomModelsChange={setCustomModels}
							hiddenModels={hiddenModels}
							onToggleHidden={toggleHidden}
							prefixOptions={[]}
							modelContextWindows={modelContextWindows}
							onContextWindowChange={handleContextWindowChange}
							onTestModel={setTestingModel}
							orphanOnly
							orphanModels={orphanModels}
						/>
					);
				})()}
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
			<ModelTestDialog
				opened={testingModel !== null}
				onClose={() => setTestingModel(null)}
				modelValue={testingModel ?? ""}
			/>
		</>
	);
}
