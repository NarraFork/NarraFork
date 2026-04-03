import { ActionIcon, Affix, Button, Group, Loader, Stack, Title, Transition } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnthropicProvidersSection } from "../../components/providers/AnthropicProvidersSection";
import { ClineSection } from "../../components/providers/ClineSection";
import { CodexSection } from "../../components/providers/CodexSection";
import { CustomModelsSection } from "../../components/providers/CustomModelsSection";
import { ModelTestDialog } from "../../components/providers/ModelTestDialog";
import { NUGProvidersSection } from "../../components/providers/NUGProvidersSection";
import { OpenAIProvidersSection } from "../../components/providers/OpenAIProvidersSection";
import {
	createSnapshot,
	initialProvidersState,
	providersReducer,
	type SavedSnapshot,
	useIsDirty,
	useProvidersDispatch,
} from "../../components/providers/providers-reducer";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";

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

	// ── Single reducer replaces 7 useState + 7 useEffect ──
	const [state, dispatch] = useReducer(providersReducer, initialProvidersState);
	const dispatchers = useProvidersDispatch(dispatch);

	// Saved snapshot ref for dirty detection
	const savedSnapshot = useRef(createSnapshot(initialProvidersState));
	// Snapshot captured at save time — passed to onSuccess to avoid stale closure
	const pendingSnapshot = useRef<SavedSnapshot | null>(null);

	// Init from settings (single effect replaces 7)
	useEffect(() => {
		if (settings && !state.initialized) {
			dispatch({ type: "INIT_FROM_SETTINGS", settings: settings as Record<string, unknown> });
		}
	}, [settings, state.initialized]);

	// After init, capture the snapshot for dirty detection
	const prevInitialized = useRef(false);
	useEffect(() => {
		if (state.initialized && !prevInitialized.current) {
			savedSnapshot.current = createSnapshot(state);
			prevInitialized.current = true;
		}
	}, [state.initialized, state]);

	// ── Dirty detection ──
	const isDirty = useIsDirty(state, savedSnapshot.current);

	// Per-provider dirty checkers (kept for save-first checks in sections)
	const isOpenaiProviderDirty = useCallback(
		(providerId: string) => {
			const current = state.openaiProviders.find((p) => p.id === providerId);
			const saved = savedSnapshot.current.openaiProviders.find((p) => p.id === providerId);
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
		[state.openaiProviders],
	);

	const isAnthropicProviderDirty = useCallback(
		(providerId: string) => {
			const current = state.anthropicProviders.find((p) => p.id === providerId);
			const saved = savedSnapshot.current.anthropicProviders.find((p) => p.id === providerId);
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
		[state.anthropicProviders],
	);

		(providerId: string) => {
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
	);

	const isNugProviderDirty = useCallback(
		(providerId: string) => {
			const current = state.nugProviders.find((p) => p.id === providerId);
			const saved = savedSnapshot.current.nugProviders.find((p) => p.id === providerId);
			if (!saved) return true;
			return JSON.stringify(current) !== JSON.stringify(saved);
		},
		[state.nugProviders],
	);

	// ── Prefix conflict detection ──

	const clineProviderPrefixes = useMemo(() => {
		const cps = (settings?.clineProviders ?? []) as Array<{ id: string; prefix?: string }>;
		return cps
			.filter((p): p is { id: string; prefix: string } => !!p.prefix)
			.map((p) => ({ id: p.id, prefix: p.prefix }));
	}, [settings]);

	// Pre-compute prefix → providerId map for fast duplicate lookup
	const allPrefixToId = useMemo(() => {
		const map = new Map<string, string>();
		const allProviders = [
			...state.openaiProviders,
			...state.anthropicProviders,
			...state.nugProviders,
			...clineProviderPrefixes,
		];
		for (const p of allProviders) {
			if (p.prefix) map.set(p.prefix, p.id);
		}
		return map;
	}, [
		state.openaiProviders,
		state.anthropicProviders,
		state.nugProviders,
		clineProviderPrefixes,
	]);

	const getPrefixError = useCallback(
		(prefix: string, currentProviderId: string): string | undefined => {
			if (!prefix) return undefined;
			if (RESERVED_PREFIXES.has(prefix)) return t("prefixReserved", { prefix });
			const dupId = allPrefixToId.get(prefix);
			if (dupId && dupId !== currentProviderId) return t("prefixDuplicate", { prefix });
			return undefined;
		},
		[RESERVED_PREFIXES, allPrefixToId, t],
	);

	// ── Save ──
	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => {
			// Use snapshot captured at save time, not the latest state
			savedSnapshot.current = pendingSnapshot.current ?? createSnapshot(state);
			pendingSnapshot.current = null;
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
		onError: () => {
			pendingSnapshot.current = null;
		},
	});

	const handleSave = useCallback(() => {
		// Migrate modelContextWindows keys when prefix changes
		const migratedWindows = { ...state.modelContextWindows };
		const snap = savedSnapshot.current;

		for (const provider of state.openaiProviders) {
			const original = snap.openaiProviders.find((p) => p.id === provider.id);
			if (original && original.prefix !== provider.prefix) {
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${original.prefix}:`)) {
						const model = key.slice(original.prefix.length + 1);
						migratedWindows[`${provider.prefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}
		for (const provider of state.anthropicProviders) {
			const original = snap.anthropicProviders.find((p) => p.id === provider.id);
			if (original && original.prefix !== provider.prefix) {
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${original.prefix}:`)) {
						const model = key.slice(original.prefix.length + 1);
						migratedWindows[`${provider.prefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}
			if (original && original.prefix !== provider.prefix) {
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${original.prefix}:`)) {
						const model = key.slice(original.prefix.length + 1);
						migratedWindows[`${provider.prefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}
		for (const provider of state.nugProviders) {
			const original = snap.nugProviders.find((p) => p.id === provider.id);
			if (original && original.prefix !== provider.prefix) {
				for (const key of Object.keys(migratedWindows)) {
					if (key.startsWith(`${original.prefix}:`)) {
						const model = key.slice(original.prefix.length + 1);
						migratedWindows[`${provider.prefix}:${model}`] = migratedWindows[key];
						delete migratedWindows[key];
					}
				}
			}
		}

		// Capture snapshot at save time — onSuccess will use this, not the latest state
		pendingSnapshot.current = createSnapshot(state);
		updateMutation.mutate({
			openaiProviders: state.openaiProviders,
			anthropicProviders: state.anthropicProviders,
			nugProviders: state.nugProviders,
			agent: {
				hiddenModels: [...state.hiddenModels],
				customModels: state.customModels,
				modelContextWindows: migratedWindows,
			},
		});
	}, [updateMutation, state]);

	// ── Highlight animation ──
	const [highlight, setHighlight] = useState(false);
	const [testingModel, setTestingModel] = useState<string | null>(null);
	useEffect(() => {
		if (isDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [isDirty]);

	// ── Orphan models (memoized) ──
	const orphanModels = useMemo(() => {
		const knownPrefixes = new Set([
			"codex",
			"cline",
			...state.openaiProviders.map((p) => p.prefix || "openai"),
			...state.anthropicProviders.map((p) => p.prefix || "anthropic"),
			...state.nugProviders.map((p) => p.prefix || "nug"),
		]);
		return state.customModels.filter((m) => {
			const prefix = m.value.split(":")[0];
			return !knownPrefixes.has(prefix);
		});
	}, [
		state.customModels,
		state.openaiProviders,
		state.anthropicProviders,
		state.nugProviders,
	]);

	// ── Models maps (memoized) ──
	const providerModelsMap = useMemo(() => {
		const map: Record<string, ModelOption[]> = {};
		const prefixMap: Record<string, string> = {};
		const groups = (settings?.openaiModelsGrouped ?? []) as Array<{
			providerId: string;
			models: Array<{ id: string }>;
		}>;
		for (const p of (settings?.openaiProviders ?? []) as Array<{ id: string; prefix?: string }>) {
			prefixMap[p.id] = p.prefix ?? "openai";
		}
		for (const group of groups) {
			const prefix = prefixMap[group.providerId] ?? "openai";
			map[group.providerId] = group.models.map((m) => ({
				value: `${prefix}:${m.id}`,
				label: m.id,
				provider: prefix,
			}));
		}
		return map;
	}, [settings?.openaiProviders, settings?.openaiModelsGrouped]);

	const anthropicModelsMap = useMemo(() => {
		const map: Record<string, ModelOption[]> = {};
		const prefixMap: Record<string, string> = {};
		const groups = (settings?.anthropicModelsGrouped ?? []) as Array<{
			providerId: string;
			models: Array<{ id: string }>;
		}>;
		for (const p of (settings?.anthropicProviders ?? []) as Array<{
			id: string;
			prefix?: string;
		}>) {
			prefixMap[p.id] = p.prefix ?? "anthropic";
		}
		for (const group of groups) {
			const prefix = prefixMap[group.providerId] ?? "anthropic";
			map[group.providerId] = group.models.map((m) => ({
				value: `${prefix}:${m.id}`,
				label: m.id,
				provider: prefix,
			}));
		}
		return map;
	}, [settings?.anthropicProviders, settings?.anthropicModelsGrouped]);

		const map: Record<string, ModelOption[]> = {};
		const prefixMap: Record<string, string> = {};
			providerId: string;
			models: Array<Record<string, unknown>>;
		}>;
		}
		for (const group of groups) {
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const id = String(m.model_id ?? m.modelId ?? "");
				if (!id) continue;
				models.push({
					value: `${prefix}:${id}`,
					label: String(
						m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? id,
					),
					provider: prefix,
				});
			}
			map[group.providerId] = models;
		}
		return map;

	const nugModelsMap = useMemo(() => {
		const map: Record<string, ModelOption[]> = {};
		const prefixMap: Record<string, string> = {};
		const groups = (settings?.nugModelsGrouped ?? []) as Array<{
			providerId: string;
			models: Array<Record<string, unknown>>;
		}>;
		for (const p of (settings?.nugProviders ?? []) as Array<{ id: string; prefix?: string }>) {
			prefixMap[p.id] = p.prefix ?? "nug";
		}
		for (const group of groups) {
			const prefix = prefixMap[group.providerId] ?? "nug";
			const models: ModelOption[] = [];
			for (const m of group.models) {
				const id = String(m.model_id ?? m.modelId ?? m.id ?? "");
				if (!id) continue;
				models.push({
					value: `${prefix}:${id}`,
					label: String(
						m.model_short_name ?? m.modelShortName ?? m.model_name ?? m.modelName ?? m.name ?? id,
					),
					provider: prefix,
				});
			}
			map[group.providerId] = models;
		}
		return map;
	}, [settings?.nugProviders, settings?.nugModelsGrouped]);

	// ── Redirect non-admin users ──
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (isLoading) return <Loader />;

	return (
		<>
			<Stack pb={80}>
				<Group mb="xs">
					<ActionIcon variant="subtle" component={Link} to="/admin">
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={2}>{t("providersTitle")}</Title>
				</Group>

					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

				<NUGProvidersSection
					providers={state.nugProviders}
					onProvidersChange={dispatchers.setNugProviders}
					providerModelsMap={nugModelsMap}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					isProviderDirty={isNugProviderDirty}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

					settings={settings}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					onTestModel={setTestingModel}
				/>

				<CodexSection
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					onTestModel={setTestingModel}
				/>

				<ClineSection
					settings={settings}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					onTestModel={setTestingModel}
				/>

				<OpenAIProvidersSection
					providers={state.openaiProviders}
					onProvidersChange={dispatchers.setOpenaiProviders}
					providerModelsMap={providerModelsMap}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					onBatchToggleHidden={dispatchers.batchToggleHidden}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					isProviderDirty={isOpenaiProviderDirty}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

				<AnthropicProvidersSection
					providers={state.anthropicProviders}
					onProvidersChange={dispatchers.setAnthropicProviders}
					providerModelsMap={anthropicModelsMap}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					onBatchToggleHidden={dispatchers.batchToggleHidden}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					isProviderDirty={isAnthropicProviderDirty}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					getPrefixError={getPrefixError}
					onTestModel={setTestingModel}
				/>

				{/* Orphan custom models */}
				{orphanModels.length > 0 && (
					<CustomModelsSection
						customModels={state.customModels}
						onCustomModelsChange={dispatchers.setCustomModels}
						hiddenModels={state.hiddenModels}
						onToggleHidden={dispatchers.toggleHidden}
						prefixOptions={[]}
						modelContextWindows={state.modelContextWindows}
						onContextWindowChange={dispatchers.handleContextWindowChange}
						onTestModel={setTestingModel}
						orphanOnly
						orphanModels={orphanModels}
					/>
				)}
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
