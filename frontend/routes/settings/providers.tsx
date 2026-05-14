import { Affix, Box, Button, Group, Loader, Stack, Title, Transition } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClineSection } from "../../components/providers/ClineSection";
import { CodexSection } from "../../components/providers/CodexSection";
import {
	CUSTOM_API_PROTOCOL_LABEL_KEYS,
	CustomApiProviderSection,
} from "../../components/providers/CustomApiProviderSection";
import { ModelTestDialog } from "../../components/providers/ModelTestDialog";
import { NUGProvidersSection } from "../../components/providers/NUGProvidersSection";
import { ProviderConfigView } from "../../components/providers/ProviderConfigView";
import {
	type AddProviderType,
	ProviderOverviewView,
} from "../../components/providers/ProviderOverviewView";
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
import { normalizeProxyUrl } from "../../lib/proxy";

export const Route = createFileRoute("/settings/providers")({
	component: SettingsProvidersPage,
});

const PROVIDER_SETTINGS_QUERY_GC_TIME_MS = 60_000;

function getDirtyProviderIds<T extends { id: string }>(
	currentProviders: T[],
	savedProviders: T[],
): Set<string> {
	const savedById = new Map(savedProviders.map((provider) => [provider.id, provider]));
	const dirtyIds = new Set<string>();

	for (const currentProvider of currentProviders) {
		const savedProvider = savedById.get(currentProvider.id);
		if (!savedProvider || JSON.stringify(currentProvider) !== JSON.stringify(savedProvider)) {
			dirtyIds.add(currentProvider.id);
		}
	}

	return dirtyIds;
}

function SettingsProvidersPage() {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const qc = useQueryClient();
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const search = useSearch({ strict: false }) as {
		oauth_success?: string;
		oauth_error?: string;
		provider?: string;
	};

	const { data: settings, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
		gcTime: PROVIDER_SETTINGS_QUERY_GC_TIME_MS,
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

	const savedProviderSnapshot = savedSnapshot.current;
	const isDirty = useIsDirty(state, savedProviderSnapshot);

	// ── Handle OAuth callback redirect (oauth_success / oauth_error in URL) ──
	const oauthHandledRef = useRef(false);
	useEffect(() => {
		if (oauthHandledRef.current) return;
		if (search.oauth_success) {
			oauthHandledRef.current = true;
			// Force re-fetch settings so the reducer picks up the new OAuth credentials
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
			// Reset reducer so INIT_FROM_SETTINGS re-runs with fresh server data
			prevInitialized.current = false;
			dispatch({ type: "RESET_FOR_REINIT" });
			// Clean URL
			window.history.replaceState({}, "", window.location.pathname);
		} else if (search.oauth_error) {
			oauthHandledRef.current = true;
			const errorCode = decodeURIComponent(search.oauth_error);
			const errorKey = `nugOAuthError_${errorCode}`;
			// Use specific i18n key if available, otherwise show raw error
			const message = t(errorKey, { defaultValue: "" }) || errorCode;
			notifications.show({
				title: t("nugOAuthError"),
				message,
				color: "red",
			});
			window.history.replaceState({}, "", window.location.pathname);
		}
	}, [search.oauth_success, search.oauth_error, qc, t]);

	// Per-provider dirty checkers
	const customApiDirtyProviderIds = useMemo(
		() => getDirtyProviderIds(state.customApiProviders, savedProviderSnapshot.customApiProviders),
		[state.customApiProviders, savedProviderSnapshot],
	);
	);
	const nugDirtyProviderIds = useMemo(
		() => getDirtyProviderIds(state.nugProviders, savedProviderSnapshot.nugProviders),
		[state.nugProviders, savedProviderSnapshot],
	);
	const isCustomApiProviderDirty = useCallback(
		(providerId: string) => customApiDirtyProviderIds.has(providerId),
		[customApiDirtyProviderIds],
	);
	);
	const isNugProviderDirty = useCallback(
		(providerId: string) => nugDirtyProviderIds.has(providerId),
		[nugDirtyProviderIds],
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
			...state.customApiProviders,
			...state.nugProviders,
			...clineProviderPrefixes,
		]) {
			if (p.prefix) map.set(p.prefix, p.id);
		}
		return map;
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
		onError: (error) => {
			pendingSnapshot.current = null;
			notifications.show({
				title: tc("operationFailed"),
				message: error instanceof Error ? error.message : tc("unexpectedError"),
				color: "red",
			});
		},
	});
	const handleDiscard = useCallback(() => {
		dispatch({ type: "RESTORE_FROM_SNAPSHOT", snapshot: savedSnapshot.current });
	}, []);
	const handleSave = useCallback(() => {
		const migratedWindows = { ...state.modelContextWindows };
		const snap = savedSnapshot.current;
		for (const providers of [
			{ cur: state.customApiProviders, saved: snap.customApiProviders },
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
		const normalizedCustomApiProviders = state.customApiProviders.map((provider) => ({
			...provider,
			proxy: normalizeProxyUrl(provider.proxy) ?? "",
		}));
		const normalizedState = { ...state, customApiProviders: normalizedCustomApiProviders };
		pendingSnapshot.current = createSnapshot(normalizedState);
		dispatchers.setCustomApiProviders(normalizedCustomApiProviders);
		updateMutation.mutate({
			customApiProviders: normalizedCustomApiProviders,
			nugProviders: state.nugProviders,
			agent: {
				hiddenModels: [...state.hiddenModels],
				customModels: state.customModels,
				modelContextWindows: migratedWindows,
				providerOrder: state.providerOrder,
				disabledProviders: [...state.disabledProviders],
			},
		});
	}, [dispatchers, updateMutation, state]);

	// ── UI state ──
	const [highlight, setHighlight] = useState(false);
	const [testingModel, setTestingModel] = useState<string | null>(null);
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

	useEffect(() => {
		if (search.provider === "codex") setSelectedProvider("codex");
	}, [search.provider]);

	useEffect(() => {
		if (isDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [isDirty]);

	// ── Add provider ──
	const handleAddProvider = useCallback(
		(type: AddProviderType) => {
			const id = Math.random().toString(36).slice(2, 10);
			switch (type) {
						...prev,
					]);
					break;
				case "nug":
					dispatchers.setNugProviders((prev) => [
						...prev,
						{ id, name: "NUG", prefix: "", apiKey: "", baseUrl: "", defaultModel: "" },
					]);
					break;
				default: {
						"anthropic-compatible": t("addProviderAnthropicCompatible"),
						"anthropic-official": t("addProviderClaudeCode"),
						"codex-native": t("addProviderCodex"),
						"responses-compatible": t("addProviderResponses"),
						"completions-compatible": t("addProviderCompletions"),
					};
					dispatchers.setCustomApiProviders((prev) => [
						...prev,
						{
							id,
							name: defaultNameByProtocol[type],
							prefix: "",
							apiKey: "",
							baseUrl: "",
							defaultModel: "",
							protocol: type,
							codexAccountId: "",
							codexWebSocket: false,
							proxy: "",
							tlsRejectUnauthorized: true,
						},
					]);
					break;
				}
			}
			// Route to new provider by its immutable ID
			setSelectedProvider(id);
		},
		[dispatchers, t],
	);

	// ── Server-side context window merge (e.g. after Cline model add) ──
	const handleServerContextWindowsMerge = useCallback(
		(windows: Record<string, number>) => {
			dispatchers.mergeContextWindows(windows);
			// Also update the saved snapshot so dirty detection doesn't falsely trigger
			const snap = savedSnapshot.current;
			for (const [key, value] of Object.entries(windows)) {
				if (!(key in snap.modelContextWindows)) {
					snap.modelContextWindows[key] = value;
				}
			}
		},
		[dispatchers],
	);

	// ── Models maps (memoized) ──
	const {
		providerLabels,
		codexModels,
		openaiByProvider,
		anthropicByProvider,
		clineByProvider,
	} = useAllModels();

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
				const channel = String(m.channel ?? id.split(":")[0] ?? "");
				const channelType = String(m.channelType ?? channel);
				const rawBareModel = m.model ?? id.split(":").slice(1).join(":");
				const bareModel = String(rawBareModel || id);
				models.push({
					value: `${prefix}:${id}`,
					label: `${String(
						m.model_short_name ??
							m.modelShortName ??
							m.model_name ??
							m.modelName ??
							m.name ??
							bareModel,
					)} · ${channel} / ${channelType}`,
					provider: prefix,
					channel,
					channelType,
				});
			}
			map[group.providerId] = models;
		}
		return map;
	}, [settings?.nugProviders, settings?.nugModelsGrouped]);

	// ── Build provider groups for overview ──
	const providerGroups = useMemo(() => {
		const byPrefix = new Map<string, ModelOption[]>();

		const getBadgeLabel = (prefix: string): string | undefined => {
			const customApiProvider = state.customApiProviders.find((p) => p.prefix === prefix);
			if (customApiProvider) return t(CUSTOM_API_PROTOCOL_LABEL_KEYS[customApiProvider.protocol]);
			if (state.nugProviders.some((p) => p.prefix === prefix)) return "nug";
			return undefined;
		};

		const addModel = (prefix: string, m: ModelOption) => {
			let arr = byPrefix.get(prefix);
			if (!arr) {
				arr = [];
				byPrefix.set(prefix, arr);
			}
			arr.push(m);
		};
		const ensureEmpty = (prefix: string) => {
			if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
		};

		for (const m of codexModels) addModel("codex", m);
		for (const g of openaiByProvider) for (const m of g.models) addModel(g.prefix, m);
		for (const g of anthropicByProvider) for (const m of g.models) addModel(g.prefix, m);
		for (const g of clineByProvider) for (const m of g.models) addModel(g.prefix, m);

		// Add custom models to their respective prefixes
		for (const m of state.customModels) {
			const prefix = m.value.split(":")[0];
			if (prefix) addModel(prefix, m);
		}

		// Ensure platform providers always present
		for (const p of platformPrefixes) ensureEmpty(p);
		// Ensure multi-instance providers always present (even disabled)
		for (const p of state.customApiProviders) ensureEmpty(p.prefix);
		for (const p of state.nugProviders) ensureEmpty(p.prefix);

		return [...byPrefix].map(([prefix, models]) => {
			const isPlatform = platformPrefixes.has(prefix);
			const disabled = state.disabledProviders.has(prefix);

			// Find provider ID for multi-instance providers
			let providerId: string | undefined;
			if (!isPlatform) {
				const match =
					state.customApiProviders.find((p) => p.prefix === prefix) ??
					state.nugProviders.find((p) => p.prefix === prefix);
				providerId = match?.id;
			}
			return {
				prefix,
				providerId,
				label: providerLabels[prefix] ?? prefix,
				badgeLabel: isPlatform ? undefined : getBadgeLabel(prefix),
				models,
				disabled,
				isPlatform,
			};
		});
	}, [
		codexModels,
		openaiByProvider,
		anthropicByProvider,
		clineByProvider,
		state.customModels,
		providerLabels,
		state.disabledProviders,
		state.customApiProviders,
		state.nugProviders,
		t,
	]);

	// ── Provider label for detail panel ──
	const selectedProviderLabel = useMemo(() => {
		if (!selectedProvider) return "";
		// Platform providers: selectedProvider is the prefix
			return providerLabels[selectedProvider] ?? selectedProvider;
		}
		// Multi-instance providers: selectedProvider is the provider ID
		const p =
			state.customApiProviders.find((p) => p.id === selectedProvider) ??
			state.nugProviders.find((p) => p.id === selectedProvider);
		if (p?.prefix) return providerLabels[p.prefix] ?? p.prefix;
		return p?.name ?? "";
	}, [
		selectedProvider,
		state.customApiProviders,
		state.nugProviders,
		providerLabels,
	]);

	if (isLoading) return <Loader />;

	// ── Render overview or config view ──
	const renderContent = () => {
		if (selectedProvider) {
			return (
				<ProviderConfigView
					providerLabel={selectedProviderLabel}
					onClose={() => setSelectedProvider(null)}
				>
					<ProviderSectionContent
						providerKey={selectedProvider}
						settings={settings}
						state={state}
						dispatchers={dispatchers}
						providerModelsMap={providerModelsMap}
						anthropicModelsMap={anthropicModelsMap}
						nugModelsMap={nugModelsMap}
						isCustomApiProviderDirty={isCustomApiProviderDirty}
						isNugProviderDirty={isNugProviderDirty}
						getPrefixError={getPrefixError}
						onTestModel={setTestingModel}
						onServerContextWindowsMerge={handleServerContextWindowsMerge}
					/>
				</ProviderConfigView>
			);
		}

		return (
			<ProviderOverviewView
				groups={providerGroups}
				hiddenModels={state.hiddenModels}
				onToggleProviderDisabled={dispatchers.toggleProviderDisabled}
				onOpenProviderConfig={setSelectedProvider}
				onAddProvider={handleAddProvider}
				selectedProvider={selectedProvider}
			/>
		);
	};

	return (
		<>
			<Box
				style={{
					height: isMobile ? undefined : "calc(100vh - 80px)",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				<Stack
					gap="md"
					style={{
						flex: 1,
						padding: "var(--mantine-spacing-md)",
						minHeight: 0,
						overflow: "hidden",
					}}
				>
					<Group gap="xs">
						<Title order={2}>{t("providersTitle")}</Title>
					</Group>

					<Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
						{renderContent()}
					</Box>
				</Stack>
			</Box>

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

// ── Provider Section Content ──

interface ProviderSectionContentProps {
	providerKey: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic settings JSON
	settings: any;
	state: ProvidersState;
	dispatchers: ReturnType<typeof useProvidersDispatch>;
	providerModelsMap: Record<string, ModelOption[]>;
	anthropicModelsMap: Record<string, ModelOption[]>;
	nugModelsMap: Record<string, ModelOption[]>;
	isCustomApiProviderDirty: (id: string) => boolean;
	isNugProviderDirty: (id: string) => boolean;
	getPrefixError: (prefix: string, id: string) => string | undefined;
	onTestModel: (model: string) => void;
	onServerContextWindowsMerge?: (windows: Record<string, number>) => void;
}

function ProviderSectionContent({
	providerKey,
	settings,
	state,
	dispatchers,
	providerModelsMap,
	anthropicModelsMap,
	nugModelsMap,
	isCustomApiProviderDirty,
	isNugProviderDirty,
	getPrefixError,
	onTestModel,
	onServerContextWindowsMerge,
}: ProviderSectionContentProps) {
	// Platform providers: matched by prefix
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
	}
	if (providerKey === "codex") {
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
	}
	if (providerKey === "cline") {
		return (
			<ClineSection
				settings={settings}
				hiddenModels={state.hiddenModels}
				onToggleHidden={dispatchers.toggleHidden}
				customModels={state.customModels}
				onCustomModelsChange={dispatchers.setCustomModels}
				modelContextWindows={state.modelContextWindows}
				onContextWindowChange={dispatchers.handleContextWindowChange}
				onMergeContextWindows={onServerContextWindowsMerge}
				onTestModel={onTestModel}
			/>
		);
	}

	// Multi-instance providers: matched by ID (immutable, survives prefix edits)
	const customApiMatch = state.customApiProviders.find((p) => p.id === providerKey);
	if (customApiMatch) {
		return (
			<CustomApiProviderSection
				provider={customApiMatch}
				onProvidersChange={dispatchers.setCustomApiProviders}
				openAIProviderModelsMap={providerModelsMap}
				anthropicProviderModelsMap={anthropicModelsMap}
				hiddenModels={state.hiddenModels}
				onToggleHidden={dispatchers.toggleHidden}
				onBatchToggleHidden={dispatchers.batchToggleHidden}
				modelContextWindows={state.modelContextWindows}
				onContextWindowChange={dispatchers.handleContextWindowChange}
				isProviderDirty={isCustomApiProviderDirty}
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
	const nugMatch = state.nugProviders.find((p) => p.id === providerKey);
	if (nugMatch) {
		return (
			<NUGProvidersSection
				providers={[nugMatch]}
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

	return null;
}
