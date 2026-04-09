import {
	ActionIcon,
	Affix,
	Box,
	Button,
	Group,
	Loader,
	Menu,
	Title,
	Transition,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowLeft, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnthropicProvidersSection } from "../../components/providers/AnthropicProvidersSection";
import { ClineSection } from "../../components/providers/ClineSection";
import { CodexSection } from "../../components/providers/CodexSection";
import { CustomModelsSection } from "../../components/providers/CustomModelsSection";
import { ModelOverviewTab, type ProviderGroup } from "../../components/providers/ModelOverviewTab";
import { ModelTestDialog } from "../../components/providers/ModelTestDialog";
import { NUGProvidersSection } from "../../components/providers/NUGProvidersSection";
import { OpenAIProvidersSection } from "../../components/providers/OpenAIProvidersSection";
import { ProviderDetailPanel } from "../../components/providers/ProviderDetailPanel";
import {
	createSnapshot,
	initialProvidersState,
	type ProvidersState,
	providersReducer,
	type SavedSnapshot,
	useIsDirty,
	useProvidersDispatch,
} from "../../components/providers/providers-reducer";
import { useCurrentUser } from "../../hooks/useAuth";
import { useAllModels } from "../../hooks/useModels";
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
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;

	const { data: settings, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	// ── Single reducer ──
	const [state, dispatch] = useReducer(providersReducer, initialProvidersState);
	const dispatchers = useProvidersDispatch(dispatch);

	const savedSnapshot = useRef(createSnapshot(initialProvidersState));
	const pendingSnapshot = useRef<SavedSnapshot | null>(null);

	useEffect(() => {
		if (settings && !state.initialized) {
			dispatch({ type: "INIT_FROM_SETTINGS", settings: settings as Record<string, unknown> });
		}
	}, [settings, state.initialized]);

	const prevInitialized = useRef(false);
	useEffect(() => {
		if (state.initialized && !prevInitialized.current) {
			savedSnapshot.current = createSnapshot(state);
			prevInitialized.current = true;
		}
	}, [state.initialized, state]);

	const isDirty = useIsDirty(state, savedSnapshot.current);

	// Per-provider dirty checkers
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
	const allPrefixToId = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of [
			...state.openaiProviders,
			...state.anthropicProviders,
			...state.nugProviders,
			...clineProviderPrefixes,
		]) {
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

	// ── Save / Discard ──
	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => {
			savedSnapshot.current = pendingSnapshot.current ?? createSnapshot(state);
			pendingSnapshot.current = null;
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
		onError: () => {
			pendingSnapshot.current = null;
		},
	});
	const handleDiscard = useCallback(() => {
		dispatch({ type: "RESTORE_FROM_SNAPSHOT", snapshot: savedSnapshot.current });
	}, []);
	const handleSave = useCallback(() => {
		const migratedWindows = { ...state.modelContextWindows };
		const snap = savedSnapshot.current;
		for (const providers of [
			{ cur: state.openaiProviders, saved: snap.openaiProviders },
			{ cur: state.anthropicProviders, saved: snap.anthropicProviders },
			{ cur: state.nugProviders, saved: snap.nugProviders },
		]) {
			for (const provider of providers.cur) {
				const original = providers.saved.find(
					(p: { id: string; prefix: string }) => p.id === provider.id,
				);
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
		}
		pendingSnapshot.current = createSnapshot(state);
		updateMutation.mutate({
			openaiProviders: state.openaiProviders,
			anthropicProviders: state.anthropicProviders,
			nugProviders: state.nugProviders,
			agent: {
				hiddenModels: [...state.hiddenModels],
				customModels: state.customModels,
				modelContextWindows: migratedWindows,
				providerOrder: state.providerOrder,
				disabledProviders: [...state.disabledProviders],
			},
		});
	}, [updateMutation, state]);

	// ── UI state ──
	const [highlight, setHighlight] = useState(false);
	const [testingModel, setTestingModel] = useState<string | null>(null);
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	useEffect(() => {
		if (isDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [isDirty]);

	// ── Add provider ──
	const handleAddProvider = useCallback(
			const id = Math.random().toString(36).slice(2, 10);
			switch (type) {
						...prev,
					]);
					break;
				case "openai":
					dispatchers.setOpenaiProviders((prev) => [
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
					setSelectedProvider("openai");
					break;
				case "anthropic":
					dispatchers.setAnthropicProviders((prev) => [
						...prev,
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
					setSelectedProvider("anthropic");
					break;
				case "nug":
					dispatchers.setNugProviders((prev) => [
						...prev,
						{ id, name: "NUG", prefix: "nug", apiKey: "", baseUrl: "", defaultModel: "" },
					]);
					setSelectedProvider("nug");
					break;
			}
		},
		[dispatchers],
	);

	// ── Models maps (memoized) ──
	const { allModels, providerLabels } = useAllModels();

	const providerModelsMap = useMemo(() => {
		const map: Record<string, ModelOption[]> = {};
		const prefixMap: Record<string, string> = {};
		const groups = (settings?.openaiModelsGrouped ?? []) as Array<{
			providerId: string;
			models: Array<{ id: string }>;
		}>;
		for (const p of (settings?.openaiProviders ?? []) as Array<{
			id: string;
			prefix?: string;
		}>) {
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
			id: string;
			prefix?: string;
		}>) {
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
		for (const p of (settings?.nugProviders ?? []) as Array<{
			id: string;
			prefix?: string;
		}>) {
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

	// ── Orphan models ──
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

	// ── Build provider groups for overview ──
	const providerGroups: ProviderGroup[] = useMemo(() => {
		const groups: ProviderGroup[] = [];
		// Group allModels by provider prefix
		const byPrefix = new Map<string, ModelOption[]>();
		for (const m of allModels) {
			const prefix = m.provider ?? m.value.split(":")[0] ?? "unknown";
			if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
			byPrefix.get(prefix)?.push(m);
		}
		// Also include disabled multi-instance providers that have no models
		for (const p of state.openaiProviders) {
			if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []);
		}
		for (const p of state.anthropicProviders) {
			if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []);
		}
			if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []);
		}
		for (const p of state.nugProviders) {
			if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []);
		}
		for (const [prefix, models] of byPrefix) {
			const isPlatform = platformPrefixes.has(prefix);
			// Check disabled status
			let disabled = state.disabledProviders.has(prefix);
			if (!isPlatform) {
				// Multi-instance: check the provider's own disabled field
				const allDisabled = [
					...state.openaiProviders.filter((p) => p.prefix === prefix),
					...state.anthropicProviders.filter((p) => p.prefix === prefix),
					...state.nugProviders.filter((p) => p.prefix === prefix),
				];
				if (allDisabled.length > 0 && allDisabled.every((p) => p.disabled)) {
					disabled = true;
				}
			}
			groups.push({
				prefix,
				label: providerLabels[prefix] ?? prefix,
				models,
				disabled,
				isPlatform,
			});
		}
		return groups;
	}, [
		allModels,
		providerLabels,
		state.disabledProviders,
		state.openaiProviders,
		state.anthropicProviders,
		state.nugProviders,
	]);

	// ── Provider label for detail panel ──
	const selectedProviderLabel = useMemo(() => {
		if (!selectedProvider) return "";
		return providerLabels[selectedProvider] ?? selectedProvider;
	}, [selectedProvider, providerLabels]);

	// ── Redirect non-admin users ──
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (isLoading) return <Loader />;

	return (
		<>
			<Box
				pb={80}
				style={{
					display: "flex",
					height: isMobile ? undefined : "calc(100vh - 80px)",
					overflow: "hidden",
				}}
			>
				{/* Left: Model Overview */}
				<Box
					style={{
						flex: 1,
						minWidth: 0,
						overflow: "auto",
						padding: "var(--mantine-spacing-md)",
					}}
				>
					<Group mb="xs" justify="space-between">
						<Group gap="xs">
							<ActionIcon variant="subtle" component={Link} to="/admin">
								<IconArrowLeft size={18} />
							</ActionIcon>
							<Title order={2}>{t("providersTitle")}</Title>
						</Group>
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<Button size="xs" variant="light" leftSection={<IconPlus size={14} />}>
									{t("addProvider")}
								</Button>
							</Menu.Target>
							<Menu.Dropdown>
								</Menu.Item>
								<Menu.Item onClick={() => handleAddProvider("openai")}>
									{t("addProviderOpenai")}
								</Menu.Item>
								<Menu.Item onClick={() => handleAddProvider("anthropic")}>
									{t("addProviderAnthropic")}
								</Menu.Item>
								<Menu.Item onClick={() => handleAddProvider("nug")}>
									{t("addProviderNug")}
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</Group>

					<ModelOverviewTab
						groups={providerGroups}
						hiddenModels={state.hiddenModels}
						providerOrder={state.providerOrder}
						disabledProviders={state.disabledProviders}
						onProviderOrderChange={dispatchers.setProviderOrder}
						onToggleProviderDisabled={dispatchers.toggleProviderDisabled}
						onOpenProviderDetail={setSelectedProvider}
						selectedProvider={selectedProvider}
					/>
				</Box>

				{/* Right: Provider Detail Panel */}
				{!isMobile && selectedProvider && (
					<ProviderDetailPanel
						selectedProvider={selectedProvider}
						providerLabel={selectedProviderLabel}
						onClose={() => setSelectedProvider(null)}
					>
						<ProviderSectionContent
							provider={selectedProvider}
							settings={settings}
							state={state}
							dispatchers={dispatchers}
							providerModelsMap={providerModelsMap}
							anthropicModelsMap={anthropicModelsMap}
							nugModelsMap={nugModelsMap}
							isOpenaiProviderDirty={isOpenaiProviderDirty}
							isAnthropicProviderDirty={isAnthropicProviderDirty}
							isNugProviderDirty={isNugProviderDirty}
							getPrefixError={getPrefixError}
							onTestModel={setTestingModel}
							orphanModels={orphanModels}
						/>
					</ProviderDetailPanel>
				)}
			</Box>

			{/* Mobile: Drawer for provider detail */}
			{isMobile && selectedProvider && (
				<ProviderDetailPanel
					selectedProvider={selectedProvider}
					providerLabel={selectedProviderLabel}
					onClose={() => setSelectedProvider(null)}
				>
					<ProviderSectionContent
						provider={selectedProvider}
						settings={settings}
						state={state}
						dispatchers={dispatchers}
						providerModelsMap={providerModelsMap}
						anthropicModelsMap={anthropicModelsMap}
						nugModelsMap={nugModelsMap}
						isOpenaiProviderDirty={isOpenaiProviderDirty}
						isAnthropicProviderDirty={isAnthropicProviderDirty}
						isNugProviderDirty={isNugProviderDirty}
						getPrefixError={getPrefixError}
						onTestModel={setTestingModel}
						orphanModels={orphanModels}
					/>
				</ProviderDetailPanel>
			)}

			<Affix position={{ bottom: 24, right: 24 }}>
				<Transition transition="slide-up" mounted={isDirty}>
					{(styles) => (
						<Group
							gap="xs"
							style={{
								...styles,
								boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
								borderRadius: 8,
							}}
						>
							<Button variant="subtle" size="md" onClick={handleDiscard}>
								{t("unsavedDiscard")}
							</Button>
							<Button
								onClick={handleSave}
								loading={updateMutation.isPending}
								size="md"
								style={{
									animation: highlight ? "providersPulse 1.5s ease" : undefined,
								}}
							>
								{t("unsavedSave")}
							</Button>
						</Group>
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

// ── Provider Section Content (renders the right section for a given provider) ──

interface ProviderSectionContentProps {
	provider: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic settings JSON
	settings: any;
	state: ProvidersState;
	dispatchers: ReturnType<typeof useProvidersDispatch>;
	providerModelsMap: Record<string, ModelOption[]>;
	anthropicModelsMap: Record<string, ModelOption[]>;
	nugModelsMap: Record<string, ModelOption[]>;
	isOpenaiProviderDirty: (id: string) => boolean;
	isAnthropicProviderDirty: (id: string) => boolean;
	isNugProviderDirty: (id: string) => boolean;
	getPrefixError: (prefix: string, id: string) => string | undefined;
	onTestModel: (model: string) => void;
	orphanModels: ModelOption[];
}

function ProviderSectionContent({
	provider,
	settings,
	state,
	dispatchers,
	providerModelsMap,
	anthropicModelsMap,
	nugModelsMap,
	isOpenaiProviderDirty,
	isAnthropicProviderDirty,
	isNugProviderDirty,
	getPrefixError,
	onTestModel,
	orphanModels,
}: ProviderSectionContentProps) {
	switch (provider) {
			return (
					settings={settings}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					onTestModel={onTestModel}
				/>
			);
		case "codex":
			return (
				<CodexSection
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					onTestModel={onTestModel}
				/>
			);
		case "cline":
			return (
				<ClineSection
					settings={settings}
					hiddenModels={state.hiddenModels}
					onToggleHidden={dispatchers.toggleHidden}
					customModels={state.customModels}
					onCustomModelsChange={dispatchers.setCustomModels}
					modelContextWindows={state.modelContextWindows}
					onContextWindowChange={dispatchers.handleContextWindowChange}
					onTestModel={onTestModel}
				/>
			);
		default: {
			// Multi-instance providers: find which type this prefix belongs to
			const openaiMatch = state.openaiProviders.find((p) => p.prefix === provider);
			if (openaiMatch) {
				return (
					<OpenAIProvidersSection
						providers={state.openaiProviders.filter((p) => p.prefix === provider)}
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
						onTestModel={onTestModel}
					/>
				);
			}
			const anthropicMatch = state.anthropicProviders.find((p) => p.prefix === provider);
			if (anthropicMatch) {
				return (
					<AnthropicProvidersSection
						providers={state.anthropicProviders.filter((p) => p.prefix === provider)}
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
						onTestModel={onTestModel}
					/>
				);
			}
				return (
						hiddenModels={state.hiddenModels}
						onToggleHidden={dispatchers.toggleHidden}
						modelContextWindows={state.modelContextWindows}
						onContextWindowChange={dispatchers.handleContextWindowChange}
						customModels={state.customModels}
						onCustomModelsChange={dispatchers.setCustomModels}
						getPrefixError={getPrefixError}
						onTestModel={onTestModel}
					/>
				);
			}
			const nugMatch = state.nugProviders.find((p) => p.prefix === provider);
			if (nugMatch) {
				return (
					<NUGProvidersSection
						providers={state.nugProviders.filter((p) => p.prefix === provider)}
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
						onTestModel={onTestModel}
					/>
				);
			}
			// Orphan custom models
			if (orphanModels.length > 0) {
				return (
					<CustomModelsSection
						customModels={state.customModels}
						onCustomModelsChange={dispatchers.setCustomModels}
						hiddenModels={state.hiddenModels}
						onToggleHidden={dispatchers.toggleHidden}
						prefixOptions={[]}
						modelContextWindows={state.modelContextWindows}
						onContextWindowChange={dispatchers.handleContextWindowChange}
						onTestModel={onTestModel}
						orphanOnly
						orphanModels={orphanModels}
					/>
				);
			}
			return null;
		}
	}
}
