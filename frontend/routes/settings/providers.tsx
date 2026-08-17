import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Affix, Alert, Box, Button, Group, Loader, Stack, Title, Transition } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { ClineSection } from "../../components/providers/ClineSection";
import { CodexSection } from "../../components/providers/CodexSection";
import {
	CUSTOM_API_PROTOCOL_LABEL_KEYS,
	CustomApiProviderSection,
	isAnthropicProtocol,
	isGeminiProtocol,
} from "../../components/providers/CustomApiProviderSection";
import { ModelTestDialog } from "../../components/providers/ModelTestDialog";
import { getModelDefaultContextWindow } from "../../components/providers/model-context-defaults";
import { NUGProvidersSection } from "../../components/providers/NUGProvidersSection";
import { PluginProviderSection } from "../../components/providers/PluginProviderSection";
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
	providersStateFromSettings,
	type SavedSnapshot,
	useIsDirty,
	useProvidersDispatch,
} from "../../components/providers/providers-reducer";
import { useCurrentUser } from "../../hooks/useAuth";
import { useAllModels } from "../../hooks/useModels";
import {
	useProviderModelRefreshCapability,
	useSettingsFeatureCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import { replaceCurrentHistoryState } from "../../lib/history-entry";
import { SAFE_AREA_INSET_BOTTOM } from "../../lib/safe-area";
import { normalizeUrlProtocol } from "../../lib/url";

export const Route = createFileRoute("/settings/providers")({
	component: SettingsProvidersPage,
});

const PROVIDER_SETTINGS_QUERY_GC_TIME_MS = 60_000;
const PROVIDER_SETTINGS_QUERY_STALE_TIME_MS = 30_000;

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

function prepareProviderSettingsSave(state: ProvidersState, savedSnapshot: SavedSnapshot) {
	const migratedWindows = { ...state.modelContextWindows };
	for (const providers of [
		{ cur: state.customApiProviders, saved: savedSnapshot.customApiProviders },
		{ cur: state.nugProviders, saved: savedSnapshot.nugProviders },
	]) {
		for (const provider of providers.cur) {
			const original = providers.saved.find((p) => p.id === provider.id);
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
		baseUrl: normalizeUrlProtocol(provider.baseUrl) ?? "",
	}));
	const normalizedNugProviders = state.nugProviders.map((provider) => ({
		...provider,
		baseUrl: normalizeUrlProtocol(provider.baseUrl) ?? "",
	}));
	const normalizedState: ProvidersState = {
		...state,
		customApiProviders: normalizedCustomApiProviders,
		nugProviders: normalizedNugProviders,
		modelContextWindows: migratedWindows,
	};
	const snapshot = createSnapshot(normalizedState);

	return {
		normalizedState,
		snapshot,
		payload: {
			customApiProviders: normalizedCustomApiProviders,
			nugProviders: normalizedNugProviders,
			agent: {
				hiddenModels: [...state.hiddenModels],
				customModels: state.customModels,
				modelContextWindows: migratedWindows,
				providerOrder: state.providerOrder,
				disabledProviders: [...state.disabledProviders],
			},
		} satisfies Record<string, unknown>,
	};
}

function SettingsProvidersPage() {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();
	const settingsFeatureCapability = useSettingsFeatureCapability();
	const nugRefreshCapability = useProviderModelRefreshCapability("nug");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const search = useSearch({ strict: false }) as {
		oauth_success?: string;
		oauth_error?: string;
		provider?: string;
	};

	const { data: settings, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
		staleTime: PROVIDER_SETTINGS_QUERY_STALE_TIME_MS,
		gcTime: PROVIDER_SETTINGS_QUERY_GC_TIME_MS,
	});

	// ── Single reducer ──
	const [state, dispatch] = useReducer(providersReducer, initialProvidersState);
	const dispatchers = useProvidersDispatch(dispatch);

	const savedSnapshot = useRef(createSnapshot(initialProvidersState));

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

	// OAuth callback handling lives lower in the component so it can call the
	// shared NUG model auto-refresh helper (declared after the reducer wiring).
	const oauthHandledRef = useRef(false);

	// Per-provider dirty checkers
	const customApiDirtyProviderIds = useMemo(
		() => getDirtyProviderIds(state.customApiProviders, savedProviderSnapshot.customApiProviders),
		[state.customApiProviders, savedProviderSnapshot],
	);
	const nugDirtyProviderIds = useMemo(
		() => getDirtyProviderIds(state.nugProviders, savedProviderSnapshot.nugProviders),
		[state.nugProviders, savedProviderSnapshot],
	);
	const isCustomApiProviderDirty = useCallback(
		(providerId: string) => customApiDirtyProviderIds.has(providerId),
		[customApiDirtyProviderIds],
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
	}, [state.customApiProviders, state.nugProviders, clineProviderPrefixes]);
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

	// Generate a unique prefix derived from a base string. If the base is already
	// taken (by another provider or a reserved prefix), append -2, -3, … until free.
	const getUniquePrefix = useCallback(
		(base: string, currentProviderId: string): string => {
			const taken = (candidate: string): boolean => {
				if (RESERVED_PREFIXES.has(candidate)) return true;
				const ownerId = allPrefixToId.get(candidate);
				return !!ownerId && ownerId !== currentProviderId;
			};
			if (!taken(base)) return base;
			for (let i = 2; ; i++) {
				const candidate = `${base}-${i}`;
				if (!taken(candidate)) return candidate;
			}
		},
		[RESERVED_PREFIXES, allPrefixToId],
	);

	// ── Save / Discard ──
	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			// Use setQueryData to synchronously update the cache instead of
			// invalidateQueries which triggers cascading refetches across all
			// mounted components that consume ["settings"].
			qc.setQueryData(["admin", "settings"], data);
			qc.setQueryData(["settings"], data);
		},
		onError: (error) => {
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

	const saveProvidersState = useCallback(
		async (stateToSave: ProvidersState = state) => {
			if (!settingsFeatureCapability.patchSupported) {
				notifications.show({
					title: t("settingsPatchUnsupportedWarning"),
					message: t("settingsPatchUnsupportedWarningDesc"),
					color: "yellow",
				});
				throw new Error(t("settingsPatchUnsupportedWarningDesc"));
			}
			const { payload } = prepareProviderSettingsSave(stateToSave, savedSnapshot.current);
			const response = await updateMutation.mutateAsync(payload);
			const syncedState = providersStateFromSettings(response as Record<string, unknown>);
			savedSnapshot.current = createSnapshot(syncedState);
			dispatch({ type: "SYNC_FROM_SETTINGS", settings: response as Record<string, unknown> });
		},
		[settingsFeatureCapability.patchSupported, t, updateMutation, state],
	);

	const handleSave = useCallback(() => {
		void saveProvidersState()
			.then(() => {
				// After a successful manual save, auto-fetch models for the provider
				// currently being edited and silently fill default context windows.
				void autoFetchAndFillRef.current?.();
			})
			.catch(() => {});
	}, [saveProvidersState]);

	// Holds the latest auto-fetch implementation so handleSave keeps a stable identity.
	const autoFetchAndFillRef = useRef<(() => Promise<void>) | null>(null);

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
				case "nug":
					dispatchers.setNugProviders((prev) => [
						...prev,
						{ id, name: "NUG", prefix: "", apiKey: "", baseUrl: "", defaultModel: "" },
					]);
					break;
				default: {
					const defaultNameByProtocol: Record<Exclude<AddProviderType, "nug">, string> = {
						"anthropic-compatible": t("addProviderAnthropicCompatible"),
						"anthropic-official": t("addProviderClaudeCode"),
						"codex-native": t("addProviderCodex"),
						"responses-compatible": t("addProviderResponses"),
						"completions-compatible": t("addProviderCompletions"),
						"gemini-compatible": t("addProviderGemini"),
					};
					// Gemini defaults to Google's endpoint; others start blank.
					const isGemini = type === "gemini-compatible";
					dispatchers.setCustomApiProviders((prev) => [
						...prev,
						{
							id,
							name: defaultNameByProtocol[type],
							prefix: "",
							apiKey: "",
							baseUrl: isGemini ? "https://generativelanguage.googleapis.com/v1beta" : "",
							defaultModel: isGemini ? "gemini-3-flash-preview" : "",
							protocol: type,
							...(isGemini ? { geminiTransport: "generate-content" as const } : {}),
							codexAccountId: "",
							codexWebSocket: false,
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

	const confirmSaveBeforeRefresh = useCallback(async () => {
		const confirmed = await confirm({
			title: t("saveBeforeRefreshTitle"),
			message: t("saveBeforeRefreshMessage"),
			confirmLabel: t("saveAndRefresh"),
			cancelLabel: tc("cancel"),
			confirmColor: "indigo",
		});
		if (!confirmed) return false;
		try {
			await saveProvidersState();
			return true;
		} catch {
			return false;
		}
	}, [confirm, saveProvidersState, t, tc]);

	const saveBeforeNugAction = useCallback(async () => {
		try {
			await saveProvidersState();
			return true;
		} catch {
			return false;
		}
	}, [saveProvidersState]);

	// After a NUG login (username/password or OAuth) the provider now has a valid
	// API key, so proactively refresh its model list once. Runs quietly: any
	// failure is ignored because the user can still refresh manually.
	const refreshNugModelsAfterLogin = useCallback(
		async (providerId: string) => {
			if (!nugRefreshCapability.supported) return;
			try {
				const result = await api.nugRefreshProviderModels(providerId);
				if (result.modelContextWindows) {
					handleServerContextWindowsMerge(result.modelContextWindows);
				}
				await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				await qc.invalidateQueries({ queryKey: ["settings"] });
			} catch {
				// Non-critical — model list can still be refreshed manually.
			}
		},
		[nugRefreshCapability.supported, qc, handleServerContextWindowsMerge],
	);

	// ── Handle OAuth callback redirect (oauth_success / oauth_error in URL) ──
	useEffect(() => {
		if (oauthHandledRef.current) return;
		if (search.oauth_success) {
			oauthHandledRef.current = true;
			const providerId = search.oauth_success;
			// Force re-fetch settings so the reducer picks up the new OAuth credentials
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
			// Reset reducer so INIT_FROM_SETTINGS re-runs with fresh server data
			prevInitialized.current = false;
			dispatch({ type: "RESET_FOR_REINIT" });
			// Login succeeded and the key is persisted — auto-refresh models once.
			void refreshNugModelsAfterLogin(providerId);
			// Clean URL
			replaceCurrentHistoryState({}, window.location.pathname);
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
			replaceCurrentHistoryState({}, window.location.pathname);
		}
	}, [search.oauth_success, search.oauth_error, qc, t, refreshNugModelsAfterLogin]);

	const saveNugLoginResult = useCallback(
		async (providerId: string, apiKey: string, username: string) => {
			const nextState: ProvidersState = {
				...state,
				nugProviders: state.nugProviders.map((provider) =>
					provider.id === providerId ? { ...provider, apiKey, nugUsername: username } : provider,
				),
			};
			dispatchers.setNugProviders(nextState.nugProviders);
			try {
				await saveProvidersState(nextState);
				// Login succeeded and the key is persisted — auto-refresh models once.
				void refreshNugModelsAfterLogin(providerId);
				return true;
			} catch {
				return false;
			}
		},
		[dispatchers, saveProvidersState, state, refreshNugModelsAfterLogin],
	);

	// ── Models maps (memoized) ──
	const {
		providerLabels,
		codexModels,
		openaiByProvider,
		anthropicByProvider,
		clineByProvider,
		geminiByProvider,
		nugByProvider,
		pluginProviderGroups,
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
					label: `${channel} · ${String(
						m.model_short_name ??
							m.modelShortName ??
							m.model_name ??
							m.modelName ??
							m.name ??
							bareModel,
					)}`,
					provider: prefix,
					channel,
					channelType,
				});
			}
			map[group.providerId] = models;
		}
		return map;
	}, [settings?.nugProviders, settings?.nugModelsGrouped]);

	const geminiModelsMap = useMemo(() => {
		const map: Record<string, ModelOption[]> = {};
		const prefixMap: Record<string, string> = {};
		const groups = (settings?.geminiModelsGrouped ?? []) as Array<{
			providerId: string;
			models: Array<{ id: string; name?: string }>;
		}>;
		for (const p of (settings?.geminiProviders ?? []) as Array<{
			id: string;
			prefix?: string;
		}>) {
			prefixMap[p.id] = p.prefix ?? "gemini";
		}
		for (const group of groups) {
			const prefix = prefixMap[group.providerId] ?? "gemini";
			map[group.providerId] = group.models.map((m) => ({
				value: `${prefix}:${m.id}`,
				label: m.name || m.id,
				provider: prefix,
			}));
		}
		return map;
	}, [settings?.geminiProviders, settings?.geminiModelsGrouped]);

	// ── Build provider groups for overview ──
	const providerGroups = useMemo(() => {
		const byPrefix = new Map<string, ModelOption[]>();
		// Executable-plugin providers, keyed by prefix. They are presented like platform
		// providers (single instance, not user-addable) but need their own lookup because
		// the detail area has to reach the owning plugin rather than a builtin section.
		const pluginByPrefix = new Map<string, { pluginId?: string; contributionId?: string }>();
		for (const group of pluginProviderGroups ?? []) {
			pluginByPrefix.set(group.prefix, {
				...(group.pluginId ? { pluginId: group.pluginId } : {}),
				...(group.contributionId ? { contributionId: group.contributionId } : {}),
			});
		}

		const getBadgeLabel = (prefix: string): string | undefined => {
			const customApiProvider = state.customApiProviders.find((p) => p.prefix === prefix);
			if (customApiProvider) {
				const protocolLabel = t(CUSTOM_API_PROTOCOL_LABEL_KEYS[customApiProvider.protocol]);
				if (!isGeminiProtocol(customApiProvider.protocol)) return protocolLabel;
				const transportLabel = t(
					(customApiProvider.geminiTransport ?? "generate-content") === "interactions"
						? "geminiTransportInteractionsShort"
						: "geminiTransportGenerateContentShort",
				);
				return `${protocolLabel} · ${transportLabel}`;
			}
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
		for (const g of geminiByProvider) for (const m of g.models) addModel(g.prefix, m);
		for (const g of nugByProvider) for (const m of g.models) addModel(g.prefix, m);

		// Add custom models to their respective prefixes
		for (const m of state.customModels) {
			const prefix = m.value.split(":")[0];
			if (prefix) addModel(prefix, m);
		}

		for (const group of pluginProviderGroups ?? []) {
			for (const m of group.models) addModel(group.prefix, m);
		}

		// Ensure platform providers always present
		for (const p of platformPrefixes) ensureEmpty(p);
		// A freshly installed plugin has no model catalog until `listModels` runs, but the
		// card must still appear or the provider looks like it failed to install.
		for (const prefix of pluginByPrefix.keys()) ensureEmpty(prefix);
		// Ensure multi-instance providers always present (even disabled)
		for (const p of state.customApiProviders) ensureEmpty(p.prefix);
		for (const p of state.nugProviders) ensureEmpty(p.prefix);

		return [...byPrefix].map(([prefix, models]) => {
			const plugin = pluginByPrefix.get(prefix);
			// Plugin providers sit in the platform column: like the builtins they are single
			// instance and cannot be added or removed from this page.
			const isPlatform = platformPrefixes.has(prefix) || plugin !== undefined;

			// Find provider config for multi-instance providers so local detail toggles
			// (provider.disabled) and overview toggles (disabledProviders) agree immediately.
			const match = !isPlatform
				? (state.customApiProviders.find((p) => p.prefix === prefix) ??
					state.nugProviders.find((p) => p.prefix === prefix))
				: undefined;
			const providerId = match?.id;
			// `disabledProviders` is a plain prefix set, so the overview toggle already
			// governs plugin providers without any extra wiring. Turning one off hides its
			// models; it deliberately does NOT stop the plugin, which may also contribute
			// tools and views.
			const disabled = state.disabledProviders.has(prefix) || !!match?.disabled;

			return {
				prefix,
				providerId,
				label: providerLabels[prefix] ?? prefix,
				badgeLabel: plugin
					? t("providerBadgePlugin")
					: isPlatform
						? undefined
						: getBadgeLabel(prefix),
				models,
				disabled,
				isPlatform,
				...(plugin?.pluginId ? { pluginId: plugin.pluginId } : {}),
				...(plugin?.contributionId ? { contributionId: plugin.contributionId } : {}),
			};
		});
	}, [
		codexModels,
		openaiByProvider,
		anthropicByProvider,
		clineByProvider,
		geminiByProvider,
		nugByProvider,
		pluginProviderGroups,
		state.customModels,
		providerLabels,
		state.disabledProviders,
		state.customApiProviders,
		state.nugProviders,
		t,
	]);

	// ── Provider label for detail panel ──
	/**
	 * Owning plugin for the selected provider, or undefined for builtins.
	 *
	 * A plugin provider is addressed by its prefix (it is single-instance, like the
	 * builtins), so this is a prefix lookup against the groups built above.
	 */
	const selectedPluginProvider = useMemo(() => {
		if (!selectedProvider) return undefined;
		const group = providerGroups.find((item) => item.prefix === selectedProvider);
		if (!group?.pluginId || !group.contributionId) return undefined;
		return { pluginId: group.pluginId, contributionId: group.contributionId };
	}, [selectedProvider, providerGroups]);

	const selectedProviderLabel = useMemo(() => {
		if (!selectedProvider) return "";
		// Platform providers: selectedProvider is the prefix
			return providerLabels[selectedProvider] ?? selectedProvider;
		}
		// Plugin providers are also addressed by prefix; without this they would fall
		// through to the multi-instance lookup and render with an empty title.
		if (selectedPluginProvider) {
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
		selectedPluginProvider,
		state.customApiProviders,
		state.nugProviders,
		providerLabels,
	]);

	// ── Auto-fetch models + fill default context windows after a manual save ──
	// Triggered by handleSave (only when a provider is being edited). Refreshes the
	// model list for the selected provider, then computes default token counts for
	// recognized model families and silently saves them.
	const autoFetchAndFill = useCallback(async () => {
		const providerId = selectedProvider;
		if (!providerId) return;

		const customApi = state.customApiProviders.find((p) => p.id === providerId);
		const nug = state.nugProviders.find((p) => p.id === providerId);
		const isGemini = customApi ? isGeminiProtocol(customApi.protocol) : false;

		try {
			if (customApi) {
				if (!customApi.apiKey) return;
				if (isGemini) {
					await api.geminiRefreshProviderModels(providerId);
				} else if (isAnthropicProtocol(customApi.protocol)) {
					await api.anthropicRefreshProviderModels(providerId);
				} else {
					await api.openaiRefreshProviderModels(providerId);
				}
			} else if (nug) {
				if (!nug.apiKey || !nug.baseUrl) return;
				await api.nugRefreshProviderModels(providerId);
			} else {
				return;
			}
		} catch {
			// Refresh failed (network/credentials) — skip auto-fill silently.
			return;
		}

		// Fetch fresh settings so we can read the newly-refreshed grouped models.
		let freshSettings: Record<string, unknown>;
		try {
			freshSettings = (await qc.fetchQuery({
				queryKey: ["admin", "settings"],
				queryFn: api.getSettings,
			})) as Record<string, unknown>;
			qc.setQueryData(["settings"], freshSettings);
		} catch {
			return;
		}

		// Resolve this provider's prefix and the list of model ids from grouped data.
		const prefix = customApi?.prefix ?? nug?.prefix ?? "";
		if (!prefix) return;

		const groupedKey = customApi
			? isGemini
				? "geminiModelsGrouped"
				: isAnthropicProtocol(customApi.protocol)
					? "anthropicModelsGrouped"
					: "openaiModelsGrouped"
			: "nugModelsGrouped";
		const grouped = (freshSettings[groupedKey] ?? []) as Array<{
			providerId: string;
			models: Array<Record<string, unknown>>;
		}>;
		const group = grouped.find((g) => g.providerId === providerId);
		if (!group || group.models.length === 0) return;

		const modelIds = group.models
			.map((m) => String(m.id ?? m.model_id ?? m.modelId ?? ""))
			.filter(Boolean);

		// Compute default context windows for recognized model families only.
		const existing = state.modelContextWindows;
		const additions: Record<string, number> = {};
		for (const id of modelIds) {
			const key = `${prefix}:${id}`;
			if (existing[key] != null) continue;
			const def = getModelDefaultContextWindow(id);
			if (def != null) additions[key] = def;
		}
		if (Object.keys(additions).length === 0) return;

		// Silently persist the new context windows.
		const nextState: ProvidersState = {
			...state,
			modelContextWindows: { ...state.modelContextWindows, ...additions },
		};
		dispatchers.mergeContextWindows(additions);
		try {
			await saveProvidersState(nextState);
		} catch {
			// Ignore — the values remain in local state for the user to save manually.
		}
	}, [selectedProvider, state, qc, dispatchers, saveProvidersState]);

	autoFetchAndFillRef.current = autoFetchAndFill;

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
						pluginProvider={selectedPluginProvider}
						settings={settings}
						state={state}
						dispatchers={dispatchers}
						providerModelsMap={providerModelsMap}
						anthropicModelsMap={anthropicModelsMap}
						nugModelsMap={nugModelsMap}
						geminiModelsMap={geminiModelsMap}
						isCustomApiProviderDirty={isCustomApiProviderDirty}
						isNugProviderDirty={isNugProviderDirty}
						getPrefixError={getPrefixError}
						getUniquePrefix={getUniquePrefix}
						onTestModel={setTestingModel}
						onServerContextWindowsMerge={handleServerContextWindowsMerge}
						onSaveBeforeRefresh={confirmSaveBeforeRefresh}
						onSaveBeforeNugAction={saveBeforeNugAction}
						onNugLoginSuccess={saveNugLoginResult}
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
					{!settingsFeatureCapability.patchSupported && (
						<Alert color="yellow" variant="light" title={t("settingsPatchUnsupportedWarning")}>
							{t("settingsPatchUnsupportedWarningDesc")}
						</Alert>
					)}

					<Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
						{renderContent()}
					</Box>
				</Stack>
			</Box>

			<Affix position={{ bottom: `calc(24px + ${SAFE_AREA_INSET_BOTTOM})`, right: 24 }}>
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
								disabled={!settingsFeatureCapability.patchSupported}
								title={
									!settingsFeatureCapability.patchSupported
										? t("settingsPatchUnsupportedWarningDesc")
										: undefined
								}
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
	/**
	 * Owning plugin when the selected provider comes from a plugin. Matched by prefix in
	 * `providerGroups`, because `providerKey` for a plugin provider IS its prefix (plugin
	 * providers are single-instance, like the builtins).
	 */
	pluginProvider?: { pluginId: string; contributionId: string };
	// biome-ignore lint/suspicious/noExplicitAny: dynamic settings JSON
	settings: any;
	state: ProvidersState;
	dispatchers: ReturnType<typeof useProvidersDispatch>;
	providerModelsMap: Record<string, ModelOption[]>;
	anthropicModelsMap: Record<string, ModelOption[]>;
	nugModelsMap: Record<string, ModelOption[]>;
	geminiModelsMap: Record<string, ModelOption[]>;
	isCustomApiProviderDirty: (id: string) => boolean;
	isNugProviderDirty: (id: string) => boolean;
	getPrefixError: (prefix: string, id: string) => string | undefined;
	getUniquePrefix: (base: string, id: string) => string;
	onTestModel: (model: string) => void;
	onServerContextWindowsMerge?: (windows: Record<string, number>) => void;
	onSaveBeforeRefresh: () => Promise<boolean>;
	onSaveBeforeNugAction: () => Promise<boolean>;
	onNugLoginSuccess: (providerId: string, apiKey: string, username: string) => Promise<boolean>;
}

function ProviderSectionContent({
	providerKey,
	pluginProvider,
	settings,
	state,
	dispatchers,
	providerModelsMap,
	anthropicModelsMap,
	nugModelsMap,
	geminiModelsMap,
	isCustomApiProviderDirty,
	isNugProviderDirty,
	getPrefixError,
	getUniquePrefix,
	onTestModel,
	onServerContextWindowsMerge,
	onSaveBeforeRefresh,
	onSaveBeforeNugAction,
	onNugLoginSuccess,
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

	// Plugin providers: the plugin either ships its own `provider-settings` view or falls
	// back to the host's schema-driven form. Checked before the multi-instance lookups
	// because a plugin prefix can never be a custom-API or NUG provider id.
	if (pluginProvider) {
		return (
			<PluginProviderSection
				pluginId={pluginProvider.pluginId}
				contributionId={pluginProvider.contributionId}
				// Model controls are host state, so they are threaded in exactly as they are for
				// the builtin sections above. Without this a plugin provider had no way to hide a
				// model, override a context window or run the model tester: those live behind
				// `/api/settings`, which the plugin's sandboxed iframe cannot reach.
				models={{
					// `providerKey` is the provider's prefix for a plugin provider, which is also
					// how `providerModelsMap` and every model value are keyed.
					prefix: providerKey,
					models: providerModelsMap[providerKey] ?? [],
					hiddenModels: state.hiddenModels,
					onToggleHidden: dispatchers.toggleHidden,
					onBatchToggleHidden: dispatchers.batchToggleHidden,
					modelContextWindows: state.modelContextWindows,
					onContextWindowChange: dispatchers.handleContextWindowChange,
					customModels: state.customModels,
					onCustomModelsChange: dispatchers.setCustomModels,
					onTestModel,
				}}
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
				geminiProviderModelsMap={geminiModelsMap}
				hiddenModels={state.hiddenModels}
				onToggleHidden={dispatchers.toggleHidden}
				onBatchToggleHidden={dispatchers.batchToggleHidden}
				modelContextWindows={state.modelContextWindows}
				onContextWindowChange={dispatchers.handleContextWindowChange}
				isProviderDirty={isCustomApiProviderDirty}
				customModels={state.customModels}
				onCustomModelsChange={dispatchers.setCustomModels}
				getPrefixError={getPrefixError}
				getUniquePrefix={getUniquePrefix}
				onTestModel={onTestModel}
				onSaveBeforeRefresh={onSaveBeforeRefresh}
				onMergeContextWindows={onServerContextWindowsMerge}
				onToggleProviderDisabled={dispatchers.toggleProviderDisabled}
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
				onMergeContextWindows={onServerContextWindowsMerge}
				isProviderDirty={isNugProviderDirty}
				customModels={state.customModels}
				onCustomModelsChange={dispatchers.setCustomModels}
				getPrefixError={getPrefixError}
				getUniquePrefix={getUniquePrefix}
				onTestModel={onTestModel}
				onSaveBeforeRefresh={onSaveBeforeRefresh}
				onSaveBeforeNugAction={onSaveBeforeNugAction}
				onLoginSuccess={onNugLoginSuccess}
			/>
		);
	}
	return null;
}
