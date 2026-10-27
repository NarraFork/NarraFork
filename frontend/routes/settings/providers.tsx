import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	Affix,
	Alert,
	Box,
	Button,
	Group,
	Skeleton,
	Stack,
	Title,
	Transition,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { TokenDancePublicConnection } from "@shared/tokendance";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Outlet,
	useNavigate,
	useRouter,
	useRouterState,
	useSearch,
} from "@tanstack/react-router";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/confirm-dialog-context";
import { CodexSection } from "../../components/providers/CodexSection";
import { CommandCodeSection } from "../../components/providers/CommandCodeSection";
import {
	CUSTOM_API_PROTOCOL_LABEL_KEYS,
	CustomApiProviderSection,
	isAnthropicProtocol,
	isGeminiProtocol,
} from "../../components/providers/CustomApiProviderSection";
import { ModelTestDialog } from "../../components/providers/ModelTestDialog";
import { NUGProvidersSection } from "../../components/providers/NUGProvidersSection";
import { PluginProviderSection } from "../../components/providers/PluginProviderSection";
import { ProviderConfigView } from "../../components/providers/ProviderConfigView";
import { ProviderOverviewView } from "../../components/providers/ProviderOverviewView";
import {
	ProviderAddContext,
	ProviderImportContext,
	TokenDanceAddContext,
} from "../../components/providers/provider-add-context";
import type { AddProviderDraft } from "../../components/providers/provider-add-draft";
import { createProviderAndRefresh } from "../../components/providers/provider-create-flow";
import { rebaseProviderState } from "../../components/providers/provider-settings-rebase";
import {
	createSnapshot,
	initialProvidersState,
	isPlatformProviderPrefix,
	type ProvidersState,
	providersReducer,
	providersStateFromSettings,
	useIsDirty,
	useProvidersDispatch,
} from "../../components/providers/providers-reducer";
import { TokenDanceSection } from "../../components/providers/TokenDanceSection";
import {
	claimTokenDanceDraft,
	clearTokenDanceFlow,
	restoreTokenDanceDraft,
	setTokenDanceDraftOwner,
	startTokenDanceLogin,
	TOKENDANCE_FLOW_MARKER,
	TokenDanceFreshSettingsError,
	tokenDanceDraftSnapshot,
} from "../../components/providers/tokendance-flow";
import { useCurrentUser } from "../../hooks/useAuth";
import { modelCatalogKeys } from "../../hooks/useModelCatalog";
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

function prepareProviderSettingsSave(state: ProvidersState) {
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
	};
	const snapshot = createSnapshot(normalizedState);

	return {
		normalizedState,
		snapshot,
		payload: {
			customApiProviders: normalizedCustomApiProviders,
			nugProviders: normalizedNugProviders,
			commandCode: state.commandCode,
			agent: {
				hiddenModels: [...state.hiddenModels],
				customModels: state.customModels,
				modelProtocols: state.modelProtocols,
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
	const isAddingProvider = useRouterState({
		select: (router) => router.matches.some((match) => match.routeId === "/settings/providers/add"),
	});
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
	const stateRef = useRef(state);
	stateRef.current = state;
	const providerPageMountedRef = useRef(true);
	const isAddingRef = useRef(isAddingProvider);
	isAddingRef.current = isAddingProvider;
	const creationIdRef = useRef<string | null>(null);
	useEffect(() => {
		providerPageMountedRef.current = true;
		return () => {
			providerPageMountedRef.current = false;
		};
	}, []);
	useEffect(() => {
		if (!isAddingProvider) creationIdRef.current = null;
	}, [isAddingProvider]);

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

	const navigate = useNavigate();
	const isTokenDanceCallback = useRouterState({
		select: (router) =>
			router.matches.some((match) => match.routeId === "/settings/providers/tokendance/callback"),
	});
	const [restoredAddPage, setRestoredAddPage] = useState<Record<string, unknown>>();
	const consumeRestoredAddPage = useCallback(() => setRestoredAddPage(undefined), []);
	const [restoreError, setRestoreError] = useState(false);
	const [restoreFetchError, setRestoreFetchError] = useState(false);
	const [returnEpoch, setReturnEpoch] = useState(0);
	const draftActorRef = useRef(user?.id);
	draftActorRef.current = user?.id;
	useEffect(() => {
		setTokenDanceDraftOwner(user?.id);
	}, [user?.id]);
	useEffect(() => {
		const onReturn = () => setReturnEpoch((value) => value + 1);
		window.addEventListener("pageshow", onReturn);
		return () => window.removeEventListener("pageshow", onReturn);
	}, []);
	useEffect(() => {
		// A pageshow epoch reruns restoration after a bfcache browser return.
		void returnEpoch;
		void user?.id;
		if (!state.initialized || isTokenDanceCallback || user?.role !== "admin" || !user?.id) return;
		let flowId: string | null = null;
		try {
			flowId =
				typeof sessionStorage === "undefined"
					? null
					: sessionStorage.getItem(TOKENDANCE_FLOW_MARKER);
		} catch {
			setRestoreError(true);
			return;
		}
		if (!flowId) return;
		let active = true;
		void claimTokenDanceDraft(flowId, user.id)
			.then(({ restore, fresh }) => {
				if (!active || draftActorRef.current !== user.id) return;
				setRestoreFetchError(false);
				if (restore.status !== "completed")
					notifications.show({ message: t("tokendance.loginFailed"), color: "yellow" });
				const freshState = providersStateFromSettings(fresh);
				if (restore.draftSnapshot) {
					const recovered = restoreTokenDanceDraft(restore.draftSnapshot, fresh);
					// Edits made after this parent mounted take precedence over late restoration.
					const latest = rebaseProviderState(stateRef.current, savedSnapshot.current, {
						...fresh,
						customApiProviders: recovered.customApiProviders,
						nugProviders: recovered.nugProviders,
						agent: { ...(fresh.agent as Record<string, unknown>), ...createSnapshot(recovered) },
					});
					savedSnapshot.current = createSnapshot(freshState);
					dispatch({ type: "RESTORE_FROM_SNAPSHOT", snapshot: createSnapshot(latest) });
					if (restore.draftSnapshot.addPage) {
						setRestoredAddPage(restore.draftSnapshot.addPage);
						if (restore.status !== "completed")
							void navigate({ to: "/settings/providers/add", replace: true });
					}
				} else setRestoreError(true);
				qc.setQueryData(["settings"], fresh);
				qc.setQueryData(["admin", "settings"], fresh);
				clearTokenDanceFlow(flowId);
			})
			.catch((cause) => {
				if (!active || draftActorRef.current !== user.id) return;
				if (cause instanceof TokenDanceFreshSettingsError) {
					setRestoreFetchError(true);
					return;
				}
				setRestoreError(true);
				clearTokenDanceFlow(flowId);
			});
		return () => {
			active = false;
		};
	}, [state.initialized, isTokenDanceCallback, user?.role, user?.id, navigate, qc, returnEpoch, t]);
	const tokenDanceLogin = useCallback(
		(addPage?: Record<string, unknown>) =>
			startTokenDanceLogin(
				tokenDanceDraftSnapshot(stateRef.current, savedSnapshot.current, addPage),
			),
		[],
	);
	const tokenDance = settings?.tokendance as TokenDancePublicConnection | undefined;
	const refreshTokenDanceSettings = useCallback(async () => {
		const fresh = await api.getSettings();
		qc.setQueryData(["settings"], fresh);
		qc.setQueryData(["admin", "settings"], fresh);
	}, [qc]);

	const savedProviderSnapshot = savedSnapshot.current;
	const isDirty = useIsDirty(state, savedProviderSnapshot);
	/** 平台 provider 的开关都在 state 里（见 PLATFORM_PROVIDER_PREFIXES），草稿即真值。 */
	const tokenDanceDisabled = state.tokenDanceDisabled;
	const providerSettingsDirty = isDirty;

	// TokenDance 的连接状态可能被登录/刷新改变：没有草稿时跟服务端保持一致，
	// 有草稿（与快照不同）时留给用户自己保存。
	useEffect(() => {
		if (!state.initialized || !tokenDance) return;
		const serverDisabled = !!tokenDance.disabled;
		if (serverDisabled === state.tokenDanceDisabled) return;
		if (state.tokenDanceDisabled !== savedProviderSnapshot.tokenDanceDisabled) return;
		dispatchers.setPlatformDisabled("tokendance", serverDisabled);
	}, [state.initialized, state.tokenDanceDisabled, tokenDance, savedProviderSnapshot, dispatchers]);

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
	const RESERVED_PREFIXES = useMemo(() => new Set(["codex", "CommandCode"]), []);
	const allPrefixToId = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of [...state.customApiProviders, ...state.nugProviders]) {
			if (p.prefix) map.set(p.prefix, p.id);
		}
		return map;
	}, [state.customApiProviders, state.nugProviders]);
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
			// 平台集成里 TokenDance 的开关存在它自己的连接记录里，所以先提交它、再存 settings：
			// 这样 settings 响应里的 tokendance.disabled 已是新值，SYNC 之后草稿不会回退。
			if (stateToSave.tokenDanceDisabled !== savedSnapshot.current.tokenDanceDisabled) {
				try {
					await api.tokenDanceUpdateConnection(stateToSave.tokenDanceDisabled);
				} catch {
					notifications.show({ message: t("tokendance.operationFailed"), color: "red" });
					throw new Error(t("tokendance.operationFailed"));
				}
			}
			const { payload } = prepareProviderSettingsSave(stateToSave);
			const response = await updateMutation.mutateAsync(payload);
			// 快照先行、SYNC 随后：快照一变，概览排序（只看快照）在 SYNC 触发的这次
			// 渲染里就重排 —— 不需要额外的信号 state，也不存在时序窗口。
			savedSnapshot.current = createSnapshot(
				providersStateFromSettings(response as Record<string, unknown>),
			);
			dispatch({ type: "SYNC_FROM_SETTINGS", settings: response as Record<string, unknown> });
			// 凭据可能刚被替换，额度要按新的 key 重新拉取。
			void qc.invalidateQueries({ queryKey: ["commandcode", "usage"] });
			// Prefix renames and removed providers move or drop provider-model overrides.
			void qc.invalidateQueries({ queryKey: modelCatalogKeys.all });
		},
		[settingsFeatureCapability.patchSupported, t, updateMutation, state, qc],
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

	/**
	 * 刷新 Command Code 模型。未保存的新 API key 只随这次请求带上，不把整份设置草稿一起提交。
	 * 已保存的 key 则等服务端缓存更新后重新读取设置。
	 */
	const refreshCommandCodeModels = useCallback(async () => {
		const draftKey = state.commandCode.apiKey.trim();
		const savedKey = savedSnapshot.current.commandCode.apiKey.trim();
		const unsavedKey =
			draftKey && draftKey !== savedKey && !draftKey.startsWith("*") ? draftKey : undefined;
		const models = await api.commandCodeRefreshModels(
			unsavedKey ? { apiKey: unsavedKey } : undefined,
		);
		if (unsavedKey) {
			const patch = (current: unknown) =>
				current && typeof current === "object"
					? { ...current, commandcodeModels: models, commandcodeModelsPending: false }
					: current;
			qc.setQueryData(["settings"], patch);
			qc.setQueryData(["admin", "settings"], patch);
			return;
		}
		await qc.invalidateQueries({ queryKey: ["settings"] });
		await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
	}, [state.commandCode.apiKey, qc]);

	// ── UI state ──
	const [highlight, setHighlight] = useState(false);
	const [testingModel, setTestingModel] = useState<string | null>(null);
	// The open provider lives in the URL (`?provider=`), not in component state, so deep
	// links (model picker, Codex quota, TokenDance recovery), reloads and back/forward all
	// land on the same page. Opening from the overview pushes an entry and closing steps
	// back over it; closing a deep-linked detail replaces its entry with the overview.
	const router = useRouter();
	const setSelectedProvider = useCallback(
		(key: string | null) => {
			if (key) {
				void navigate({
					to: "/settings/providers",
					search: { provider: key },
					state: (prev) => ({ ...prev, providerDetailFromOverview: true }),
				});
				return;
			}
			if (router.state.location.state.providerDetailFromOverview) {
				router.history.back();
				return;
			}
			void navigate({ to: "/settings/providers", search: {}, replace: true });
		},
		[navigate, router],
	);

	useEffect(() => {
		if (providerSettingsDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [providerSettingsDirty]);

	// ── Add provider ──
	/** Save one provider under `id`, then refresh its models (shared by add and import). */
	const createProvider = useCallback(
		async (id: string, draft: AddProviderDraft) => {
			if (!settingsFeatureCapability.patchSupported)
				throw new Error(t("settingsPatchUnsupportedWarningDesc"));
			const bounded = async <T,>(
				execute: (options: { signal: AbortSignal; maxResponseBytes: number }) => Promise<T>,
			): Promise<T> => {
				const controller = new AbortController();
				const timer = setTimeout(
					() => controller.abort(new Error(t("addProviderRequestTimeout"))),
					30_000,
				);
				try {
					return await execute({ signal: controller.signal, maxResponseBytes: 8 * 1024 * 1024 });
				} finally {
					clearTimeout(timer);
				}
			};
			const applyServerSettings = (response: Record<string, unknown>) => {
				if (providerPageMountedRef.current) {
					const next = rebaseProviderState(stateRef.current, savedSnapshot.current, response);
					savedSnapshot.current = createSnapshot(providersStateFromSettings(response));
					stateRef.current = next;
					dispatch({ type: "RESTORE_FROM_SNAPSHOT", snapshot: createSnapshot(next) });
				}
				qc.setQueryData(["admin", "settings"], response);
				qc.setQueryData(["settings"], response);
			};
			return createProviderAndRefresh(id, draft, stateRef.current, {
				getSettings: () => bounded((options) => api.getSettings(options)),
				updateSettings: (payload) => bounded((options) => api.updateSettings(payload, options)),
				refreshModels: (providerId, protocol) =>
					bounded<unknown>((options) => {
						switch (protocol) {
							case "nug":
								return api.nugRefreshProviderModels(providerId, options);
							case "gemini-compatible":
								return api.geminiRefreshProviderModels(providerId, options);
							case "anthropic-messages":
								return api.anthropicRefreshProviderModels(providerId, options);
							default:
								return api.openaiRefreshProviderModels(providerId, options);
						}
					}),
				onSaved: applyServerSettings,
				onRefreshed: applyServerSettings,
				messages: {
					invalidDraft: t("addProviderInvalidDraft"),
					prefixConflict: (prefix) =>
						t(prefix === "codex" ? "prefixReserved" : "prefixDuplicate", { prefix }),
					unconfirmedSave: t("addProviderSaveUnconfirmed"),
				},
			});
		},
		[settingsFeatureCapability.patchSupported, qc, t],
	);

	const handleAddProvider = useCallback(
		async (draft: AddProviderDraft) => {
			const id = creationIdRef.current ?? nanoid();
			creationIdRef.current = id;
			const result = await createProvider(id, draft);
			const openCreated =
				providerPageMountedRef.current && isAddingRef.current && creationIdRef.current === id;
			if ("refreshError" in result) {
				notifications.show({
					title: t("addProviderSavedRefreshFailed"),
					message:
						result.refreshError instanceof Error
							? result.refreshError.message
							: tc("unexpectedError"),
					color: "yellow",
				});
			} else {
				notifications.show({
					title: t("addProviderSaved"),
					message: t("addProviderModelsRefreshed"),
					color: "green",
				});
			}
			// The add route navigates back with this id, which opens the new provider.
			return openCreated ? result.providerId : undefined;
		},
		[createProvider, t, tc],
	);

	// Each imported provider is a separate creation with its own id; the import
	// panel reports the batch outcome itself, so no per-provider notification.
	const handleImportProvider = useCallback(
		async (draft: AddProviderDraft) => {
			const result = await createProvider(nanoid(), draft);
			return { refreshFailed: "refreshError" in result };
		},
		[createProvider],
	);

	// Existence-only probe of other tools' config directories (reads no file),
	// so the add page offers "import from this machine" only when there is something.
	const canImport = user?.role === "admin";
	const localDetect = useQuery({
		queryKey: ["provider-import", "local-detect"],
		queryFn: api.detectLocalProviders,
		enabled: canImport && isAddingProvider,
		staleTime: 0,
		gcTime: 60_000,
		retry: false,
	});
	const importContext = useMemo(
		() =>
			canImport
				? {
						importProvider: handleImportProvider,
						detectedSources: localDetect.data?.sources,
						detecting: localDetect.isPending && localDetect.fetchStatus !== "idle",
					}
				: null,
		[
			canImport,
			handleImportProvider,
			localDetect.data,
			localDetect.isPending,
			localDetect.fetchStatus,
		],
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
				await api.nugRefreshProviderModels(providerId);
				await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				await qc.invalidateQueries({ queryKey: ["settings"] });
				await qc.invalidateQueries({ queryKey: modelCatalogKeys.all });
			} catch {
				// Non-critical — model list can still be refreshed manually.
			}
		},
		[nugRefreshCapability.supported, qc],
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
		commandcodeModels,
		openaiByProvider,
		anthropicByProvider,
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
	// 排序键（inactive）只由 savedProviderSnapshot 决定，且 Array.sort 是稳定排序：
	// 草稿变化时重算但顺序不变；保存成功后快照更新，同一次渲染里顺序自然重排。
	const providerGroups = useMemo(() => {
		const byPrefix = new Map<string, ModelOption[]>();
		const platformPrefixes = new Set(["codex", "CommandCode"]);
		if (tokenDance?.connected) platformPrefixes.add("tokendance");
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

		if (tokenDance?.connected)
			for (const m of tokenDance.models)
				addModel("tokendance", {
					value: `tokendance:${m.id}`,
					label: m.name || m.id,
					provider: "tokendance",
				});
		for (const m of codexModels) addModel("codex", m);
		for (const m of commandcodeModels) addModel("CommandCode", m);
		for (const g of openaiByProvider) for (const m of g.models) addModel(g.prefix, m);
		for (const g of anthropicByProvider) for (const m of g.models) addModel(g.prefix, m);
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

		return (
			[...byPrefix]
				.map(([prefix, models]) => {
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
					// CommandCode carries its own persisted flag (settings.commandCode.disabled,
					// which is what stops the provider server-side), so the overview reads the
					// draft directly and reflects a toggle before it is saved.
					const disabled =
						prefix === "tokendance"
							? tokenDanceDisabled
							: prefix === "CommandCode"
								? state.commandCode.disabled
								: state.disabledProviders.has(prefix) || !!match?.disabled;

					// 排序只看**已保存**的开关状态：用户开着的 provider（哪怕还没配凭据）按
					// 意图排在前面，关掉的排到最后。未配置的引导交给卡片徽章（unverified），
					// 不再作为排序键 —— 否则无凭据的 codex 恒垫底，开关切了卡片也不动。
					const savedMatch = !isPlatform
						? (savedProviderSnapshot.customApiProviders.find((p) => p.prefix === prefix) ??
							savedProviderSnapshot.nugProviders.find((p) => p.prefix === prefix))
						: undefined;
					const inactive =
						prefix === "tokendance"
							? savedProviderSnapshot.tokenDanceDisabled
							: prefix === "CommandCode"
								? savedProviderSnapshot.commandCode.disabled
								: savedProviderSnapshot.disabledProviders.includes(prefix) ||
									!!savedMatch?.disabled;

					return {
						prefix,
						providerId,
						label:
							prefix === "tokendance" && tokenDance?.connected
								? tokenDance.name || "TokenDance"
								: (providerLabels[prefix] ?? prefix),
						badgeLabel: plugin
							? t("providerBadgePlugin")
							: isPlatform
								? undefined
								: getBadgeLabel(prefix),
						models,
						disabled,
						inactive,
						isPlatform,
						...(plugin?.pluginId ? { pluginId: plugin.pluginId } : {}),
						...(plugin?.contributionId ? { contributionId: plugin.contributionId } : {}),
					};
				})
				// 未启用的排到最后；同组内保持原有顺序（平台 provider 固定在前）。
				.sort((a, b) => Number(a.inactive) - Number(b.inactive))
		);
	}, [
		codexModels,
		commandcodeModels,
		openaiByProvider,
		anthropicByProvider,
		geminiByProvider,
		nugByProvider,
		pluginProviderGroups,
		tokenDance,
		state.customModels,
		providerLabels,
		state.disabledProviders,
		state.customApiProviders,
		state.nugProviders,
		state.commandCode,
		savedProviderSnapshot,
		tokenDanceDisabled,
		t,
	]);

	// Resolve `?provider=` (a provider id or a model prefix) to a key the config view can
	// render: the provider id for multi-instance providers, the prefix for platform and
	// plugin providers. Anything else (an unknown or not-yet-loaded target, or a prefix
	// that only carries custom models) shows the overview rather than an empty detail.
	const selectedProvider = useMemo(() => {
		const target = search.provider;
		if (!target) return null;
		if (target === "tokendance") return tokenDance?.connected ? "tokendance" : null;
		if (target === "codex" || target === "CommandCode") return target;
		const configured = [...state.customApiProviders, ...state.nugProviders];
		const byId = configured.find((p) => p.id === target);
		if (byId) return byId.id;
		const lower = target.toLowerCase();
		const byPrefix =
			configured.find((p) => p.prefix === target) ??
			configured.find((p) => p.prefix?.toLowerCase() === lower);
		if (byPrefix) return byPrefix.id;
		return pluginProviderGroups?.some((group) => group.prefix === target) ? target : null;
	}, [
		search.provider,
		tokenDance?.connected,
		state.customApiProviders,
		state.nugProviders,
		pluginProviderGroups,
	]);

	// ── Provider label for detail panel ──
	/**
	 * Plugin provider models for the detail area, keyed by prefix.
	 *
	 * `providerModelsMap` is openai-only, so feeding it to a plugin provider's section
	 * always produced an empty list (`?? []`) — the overview cards read
	 * `pluginProviderGroups` correctly, which is exactly why the card showed models while
	 * the detail list below the iframe stayed empty.
	 */
	const pluginModelsByPrefix = useMemo(() => {
		const map: Record<string, ModelOption[]> = {};
		for (const group of pluginProviderGroups ?? []) map[group.prefix] = group.models;
		return map;
	}, [pluginProviderGroups]);

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
		if (["codex", "CommandCode", "tokendance"].includes(selectedProvider)) {
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

	// ── Auto-fetch models after a manual save ──
	// Triggered by handleSave (only when a provider is being edited). Refreshes the
	// model list for the selected provider. Windows are not filled in here: the model
	// catalog supplies them, and a stored value would pin this provider entry for good.
	const autoFetchAndFill = useCallback(async () => {
		const providerId = selectedProvider;
		if (!providerId) return;
		// Platform providers (codex / commandcode) manage their own model lists.
		if (["codex", "CommandCode"].includes(providerId)) return;

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

		// The refreshed listing changes model lists and the windows their rows show.
		await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
		await qc.invalidateQueries({ queryKey: ["settings"] });
		await qc.invalidateQueries({ queryKey: modelCatalogKeys.all });
	}, [selectedProvider, state, qc]);
	autoFetchAndFillRef.current = autoFetchAndFill;

	if (isTokenDanceCallback) return <Outlet />;
	if (isLoading) {
		return (
			<Stack gap="md" p="md" aria-busy="true" data-testid="providers-settings-skeleton">
				<Group justify="space-between">
					<Title order={2}>{t(isAddingProvider ? "addProvider" : "providersTitle")}</Title>
					{isAddingProvider && (
						<Button
							variant="subtle"
							onClick={() =>
								void navigate({ to: "/settings/providers", search: {}, replace: true })
							}
						>
							{t("addProviderBack")}
						</Button>
					)}
				</Group>
				<Skeleton height={42} />
				<Skeleton height={180} />
				<Skeleton height={240} />
			</Stack>
		);
	}

	if (isAddingProvider) {
		return (
			<TokenDanceAddContext
				value={
					user?.role === "admin"
						? { login: tokenDanceLogin, restoredAddPage, consumeRestoredAddPage }
						: null
				}
			>
				<ProviderAddContext value={handleAddProvider}>
					<ProviderImportContext value={importContext}>
						{restoreFetchError && (
							<Alert color="yellow">
								{t("tokendance.settingsUnavailable")}
								<Button
									size="xs"
									variant="light"
									onClick={() => setReturnEpoch((value) => value + 1)}
								>
									{t("tokendance.retryRestore")}
								</Button>
							</Alert>
						)}
						<Outlet />
					</ProviderImportContext>
				</ProviderAddContext>
			</TokenDanceAddContext>
		);
	}

	// ── Render overview or config view ──
	const renderContent = () => {
		if (selectedProvider) {
			return (
				<ProviderConfigView
					providerLabel={selectedProviderLabel}
					onClose={() => setSelectedProvider(null)}
				>
					{selectedProvider === "tokendance" && tokenDance?.connected ? (
						<TokenDanceSection
							connection={tokenDance}
							enabled={!tokenDanceDisabled}
							onToggleEnabled={() =>
								dispatchers.setPlatformDisabled("tokendance", !tokenDanceDisabled)
							}
							hiddenModels={state.hiddenModels}
							onToggleHidden={dispatchers.toggleHidden}
							onBatchToggleHidden={dispatchers.batchToggleHidden}
							modelProtocols={state.modelProtocols}
							onModelProtocolChange={dispatchers.setModelProtocol}
							onTestModel={setTestingModel}
							onLogin={() => tokenDanceLogin()}
							onChanged={refreshTokenDanceSettings}
							onDeleted={() => setSelectedProvider(null)}
						/>
					) : (
						<ProviderSectionContent
							providerKey={selectedProvider}
							pluginProvider={selectedPluginProvider}
							state={state}
							dispatchers={dispatchers}
							providerModelsMap={providerModelsMap}
							commandcodeModels={commandcodeModels}
							pluginModelsByPrefix={pluginModelsByPrefix}
							anthropicModelsMap={anthropicModelsMap}
							nugModelsMap={nugModelsMap}
							geminiModelsMap={geminiModelsMap}
							isCustomApiProviderDirty={isCustomApiProviderDirty}
							isNugProviderDirty={isNugProviderDirty}
							getPrefixError={getPrefixError}
							getUniquePrefix={getUniquePrefix}
							onTestModel={setTestingModel}
							onSaveBeforeRefresh={confirmSaveBeforeRefresh}
							onSaveBeforeNugAction={saveBeforeNugAction}
							onNugLoginSuccess={saveNugLoginResult}
							onRefreshCommandCodeModels={refreshCommandCodeModels}
						/>
					)}
				</ProviderConfigView>
			);
		}

		return (
			<ProviderOverviewView
				groups={providerGroups}
				hiddenModels={state.hiddenModels}
				onToggleProviderDisabled={(prefix) => {
					// 平台集成（codex / Command Code / TokenDance）的开关一律写成草稿，
					// 由底部保存条统一提交 —— 见 PLATFORM_PROVIDER_PREFIXES 的约定。
					if (isPlatformProviderPrefix(prefix)) {
						const group = providerGroups.find((item) => item.prefix === prefix);
						if (!group) return;
						dispatchers.setPlatformDisabled(prefix, !group.disabled);
						return;
					}
					dispatchers.toggleProviderDisabled(prefix);
				}}
				onOpenProviderConfig={setSelectedProvider}
				selectedProvider={selectedProvider}
			/>
		);
	};

	return (
		<>
			{restoreFetchError && (
				<Alert color="yellow">
					{t("tokendance.settingsUnavailable")}
					<Button size="xs" variant="light" onClick={() => setReturnEpoch((value) => value + 1)}>
						{t("tokendance.retryRestore")}
					</Button>
				</Alert>
			)}
			{restoreError && (
				<Alert color="yellow" onClose={() => setRestoreError(false)} withCloseButton>
					{t("tokendance.draftUnavailable")}
				</Alert>
			)}
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
				<Transition transition="slide-up" mounted={providerSettingsDirty}>
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
// providerKey is either a platform prefix (codex) or a provider ID

interface ProviderSectionContentProps {
	providerKey: string;
	/**
	 * Owning plugin when the selected provider comes from a plugin. Matched by prefix in
	 * `providerGroups`, because `providerKey` for a plugin provider IS its prefix (plugin
	 * providers are single-instance, like the builtins).
	 */
	pluginProvider?: { pluginId: string; contributionId: string };
	state: ProvidersState;
	dispatchers: ReturnType<typeof useProvidersDispatch>;
	providerModelsMap: Record<string, ModelOption[]>;
	/** Command Code 的模型（已带 `CommandCode:` 前缀），由后端从 Provider API 拉取并缓存。 */
	commandcodeModels: ModelOption[];
	/** Plugin provider models keyed by prefix (the detail area's source for plugin providers). */
	pluginModelsByPrefix: Record<string, ModelOption[]>;
	anthropicModelsMap: Record<string, ModelOption[]>;
	nugModelsMap: Record<string, ModelOption[]>;
	geminiModelsMap: Record<string, ModelOption[]>;
	isCustomApiProviderDirty: (id: string) => boolean;
	isNugProviderDirty: (id: string) => boolean;
	getPrefixError: (prefix: string, id: string) => string | undefined;
	getUniquePrefix: (base: string, id: string) => string;
	onTestModel: (model: string) => void;
	onSaveBeforeRefresh: () => Promise<boolean>;
	onSaveBeforeNugAction: () => Promise<boolean>;
	onNugLoginSuccess: (providerId: string, apiKey: string, username: string) => Promise<boolean>;
	/** 刷新 Command Code 的模型列表（草稿未保存时由页面负责先落盘）。 */
	onRefreshCommandCodeModels: () => Promise<void>;
}

function ProviderSectionContent({
	providerKey,
	pluginProvider,
	state,
	dispatchers,
	providerModelsMap,
	commandcodeModels,
	pluginModelsByPrefix,
	anthropicModelsMap,
	nugModelsMap,
	geminiModelsMap,
	isCustomApiProviderDirty,
	isNugProviderDirty,
	getPrefixError,
	getUniquePrefix,
	onTestModel,
	onSaveBeforeRefresh,
	onSaveBeforeNugAction,
	onNugLoginSuccess,
	onRefreshCommandCodeModels,
}: ProviderSectionContentProps) {
	// Platform providers: matched by prefix
	if (providerKey === "CommandCode") {
		return (
			<CommandCodeSection
				value={state.commandCode}
				onChange={dispatchers.setCommandCode}
				onToggleDisabled={() =>
					dispatchers.setPlatformDisabled("CommandCode", !state.commandCode.disabled)
				}
				models={commandcodeModels}
				hiddenModels={state.hiddenModels}
				onToggleHidden={dispatchers.toggleHidden}
				onBatchToggleHidden={dispatchers.batchToggleHidden}
				customModels={state.customModels}
				onCustomModelsChange={dispatchers.setCustomModels}
				modelProtocols={state.modelProtocols}
				onModelProtocolChange={dispatchers.setModelProtocol}
				onTestModel={onTestModel}
				onRefreshModels={onRefreshCommandCodeModels}
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
				modelProtocols={state.modelProtocols}
				onModelProtocolChange={dispatchers.setModelProtocol}
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
					// `providerKey` is the provider's prefix for a plugin provider — the key of
					// `pluginModelsByPrefix` and of every model value inside it.
					prefix: providerKey,
					models: pluginModelsByPrefix[providerKey] ?? [],
					hiddenModels: state.hiddenModels,
					onToggleHidden: dispatchers.toggleHidden,
					onBatchToggleHidden: dispatchers.batchToggleHidden,
					customModels: state.customModels,
					onCustomModelsChange: dispatchers.setCustomModels,
					modelProtocols: state.modelProtocols,
					onModelProtocolChange: dispatchers.setModelProtocol,
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
				isProviderDirty={isCustomApiProviderDirty}
				customModels={state.customModels}
				onCustomModelsChange={dispatchers.setCustomModels}
				modelProtocols={state.modelProtocols}
				onModelProtocolChange={dispatchers.setModelProtocol}
				getPrefixError={getPrefixError}
				getUniquePrefix={getUniquePrefix}
				onTestModel={onTestModel}
				onSaveBeforeRefresh={onSaveBeforeRefresh}
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
