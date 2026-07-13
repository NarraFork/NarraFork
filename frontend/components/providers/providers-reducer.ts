import { useCallback, useMemo } from "react";
import type { NUGProviderState } from "./NUGProvidersSection";
import type {
	AnthropicProviderState,
	CustomApiProtocol,
	CustomApiProviderState,
	OpenAIProviderState,
} from "./types";

// ── Types ──────────────────────────────────────────────

export interface CustomModelEntry {
	value: string;
	label: string;
	provider?: string;
}

export interface ProvidersState {
	customApiProviders: CustomApiProviderState[];
	openaiProviders: OpenAIProviderState[];
	anthropicProviders: AnthropicProviderState[];
	nugProviders: NUGProviderState[];
	hiddenModels: Set<string>;
	customModels: CustomModelEntry[];
	modelContextWindows: Record<string, number>;
	providerOrder: string[];
	disabledProviders: Set<string>;
	initialized: boolean;
}

export interface SavedSnapshot {
	customApiProviders: CustomApiProviderState[];
	openaiProviders: OpenAIProviderState[];
	anthropicProviders: AnthropicProviderState[];
	nugProviders: NUGProviderState[];
	hiddenModels: string[];
	customModels: CustomModelEntry[];
	modelContextWindows: Record<string, number>;
	providerOrder: string[];
	disabledProviders: string[];
}

// Functional updater types
type Updater<T> = T | ((prev: T) => T);

export type ProvidersAction =
	| { type: "INIT_FROM_SETTINGS"; settings: Record<string, unknown> }
	| { type: "SET_CUSTOM_API_PROVIDERS"; providers: Updater<CustomApiProviderState[]> }
	| { type: "SET_OPENAI_PROVIDERS"; providers: Updater<OpenAIProviderState[]> }
	| { type: "SET_ANTHROPIC_PROVIDERS"; providers: Updater<AnthropicProviderState[]> }
	| { type: "SET_NUG_PROVIDERS"; providers: Updater<NUGProviderState[]> }
	| { type: "TOGGLE_HIDDEN"; modelVal: string }
	| { type: "BATCH_TOGGLE_HIDDEN"; modelValues: string[]; hidden: boolean }
	| { type: "SET_CUSTOM_MODELS"; models: CustomModelEntry[] }
	| { type: "SET_CONTEXT_WINDOW"; modelVal: string; size: number | null }
	| { type: "SET_PROVIDER_ORDER"; order: string[] }
	| { type: "TOGGLE_PROVIDER_DISABLED"; prefix: string }
	| { type: "MERGE_CONTEXT_WINDOWS"; windows: Record<string, number> }
	| { type: "MARK_SAVED" }
	| { type: "RESTORE_FROM_SNAPSHOT"; snapshot: SavedSnapshot }
	| { type: "RESET_FOR_REINIT" };

// ── Helpers ────────────────────────────────────────────

function resolveUpdater<T>(prev: T, updater: Updater<T>): T {
	return typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
}

function protocolFromOpenAI(provider: OpenAIProviderState): CustomApiProtocol {
	switch (provider.apiMode) {
		case "codex":
			return "codex-native";
		case "completions":
			return "completions-compatible";
		case "responses":
			return "responses-compatible";
		default:
			return provider.responsesApi === false ? "completions-compatible" : "responses-compatible";
	}
}

function protocolFromAnthropic(officialApi?: boolean): CustomApiProtocol {
	return officialApi ? "anthropic-official" : "anthropic-compatible";
}

function isAnthropicProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "anthropic-official" || protocol === "anthropic-compatible";
}

function customApiToOpenAI(provider: CustomApiProviderState): OpenAIProviderState | null {
	let apiMode: NonNullable<OpenAIProviderState["apiMode"]> | null = null;
	if (provider.protocol === "codex-native") apiMode = "codex";
	else if (provider.protocol === "responses-compatible") apiMode = "responses";
	else if (provider.protocol === "completions-compatible") apiMode = "completions";
	if (!apiMode) return null;
	return {
		id: provider.id,
		name: provider.name,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		apiMode,
		proxy: provider.proxy,
		codexAccountId: provider.codexAccountId ?? "",
		codexWebSocket: provider.codexWebSocket ?? false,
		codexWebSearch: provider.codexWebSearch ?? true,
		codexImageGeneration: provider.codexImageGeneration ?? true,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
		disabled: provider.disabled ?? false,
	};
}

function customApiToAnthropic(provider: CustomApiProviderState): AnthropicProviderState | null {
	if (!isAnthropicProtocol(provider.protocol)) return null;
	return {
		id: provider.id,
		name: provider.name,
		prefix: provider.prefix,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		proxy: provider.proxy,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized ?? true,
		officialApi: provider.protocol === "anthropic-official",
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
		disabled: provider.disabled ?? false,
	};
}

function deriveSplitProviders(customApiProviders: CustomApiProviderState[]): {
	openai: OpenAIProviderState[];
	anthropic: AnthropicProviderState[];
} {
	return {
		openai: customApiProviders.flatMap((provider) => {
			const converted = customApiToOpenAI(provider);
			return converted ? [converted] : [];
		}),
		anthropic: customApiProviders.flatMap((provider) => {
			const converted = customApiToAnthropic(provider);
			return converted ? [converted] : [];
		}),
	};
}

function normalizeCustomApiProvider(
	provider: Partial<CustomApiProviderState>,
): CustomApiProviderState {
	return {
		id: provider.id ?? "",
		name: provider.name ?? "",
		prefix: provider.prefix ?? "openai",
		apiKey: provider.apiKey ?? "",
		baseUrl: provider.baseUrl ?? "",
		defaultModel: provider.defaultModel ?? "",
		protocol: provider.protocol ?? "responses-compatible",
		defaultContextWindow: provider.defaultContextWindow,
		proxy: provider.proxy,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized ?? true,
		codexAccountId: provider.codexAccountId ?? "",
		codexWebSocket: provider.codexWebSocket ?? false,
		codexWebSearch: provider.codexWebSearch ?? true,
		codexImageGeneration: provider.codexImageGeneration ?? true,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		emulateCodexHeaders: provider.emulateCodexHeaders,
		disabled: provider.disabled ?? false,
	};
}

function deriveCustomApiProvidersFromLegacy(
	openaiProviders: OpenAIProviderState[],
	anthropicProviders: AnthropicProviderState[],
): CustomApiProviderState[] {
	const byId = new Map<string, CustomApiProviderState>();
	for (const provider of openaiProviders) {
		byId.set(
			provider.id,
			normalizeCustomApiProvider({
				...provider,
				protocol: protocolFromOpenAI(provider),
			}),
		);
	}
	for (const provider of anthropicProviders) {
		const existing = byId.get(provider.id);
		byId.set(
			provider.id,
			normalizeCustomApiProvider({
				...existing,
				...provider,
				protocol: protocolFromAnthropic(provider.officialApi),
				codexAccountId: existing?.codexAccountId ?? "",
				codexWebSocket: existing?.codexWebSocket ?? false,
				codexWebSearch: existing?.codexWebSearch ?? true,
				codexImageGeneration: existing?.codexImageGeneration ?? true,
			}),
		);
	}
	return [...byId.values()];
}

function withDerivedCustomApiProviders(
	state: ProvidersState,
	customApiProviders: CustomApiProviderState[],
): ProvidersState {
	const normalized = customApiProviders.map(normalizeCustomApiProvider);
	const split = deriveSplitProviders(normalized);
	return {
		...state,
		customApiProviders: normalized,
		openaiProviders: split.openai,
		anthropicProviders: split.anthropic,
	};
}

// ── Initial state ──────────────────────────────────────

export const initialProvidersState: ProvidersState = {
	customApiProviders: [],
	openaiProviders: [],
	anthropicProviders: [],
	nugProviders: [],
	hiddenModels: new Set(),
	customModels: [],
	modelContextWindows: {},
	providerOrder: [],
	disabledProviders: new Set(),
	initialized: false,
};

// ── Reducer ────────────────────────────────────────────

export function providersReducer(state: ProvidersState, action: ProvidersAction): ProvidersState {
	switch (action.type) {
		case "INIT_FROM_SETTINGS": {
			if (state.initialized) return state;
			// biome-ignore lint/suspicious/noExplicitAny: dynamic settings JSON
			const s: any = action.settings;

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const openai = (s.openaiProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "openai",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				responsesApi: p.responsesApi,
				apiMode: p.apiMode,
				codexAccountId: p.codexAccountId ?? "",
				codexWebSocket: p.codexWebSocket ?? false,
				codexWebSearch: p.codexWebSearch ?? true,
				codexImageGeneration: p.codexImageGeneration ?? true,
				userAgentMode: p.userAgentMode,
				customUserAgent: p.customUserAgent,
				extraHeaders: p.extraHeaders,
				emulateCodexHeaders: p.emulateCodexHeaders,
				proxy: p.proxy,
				disabled: p.disabled ?? false,
			}));

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const anthropic = (s.anthropicProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "anthropic",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				proxy: p.proxy,
				tlsRejectUnauthorized: p.tlsRejectUnauthorized ?? true,
				officialApi: p.officialApi ?? false,
				userAgentMode: p.userAgentMode,
				customUserAgent: p.customUserAgent,
				extraHeaders: p.extraHeaders,
				emulateCodexHeaders: p.emulateCodexHeaders,
				disabled: p.disabled ?? false,
			}));

			const rawCustomApiProviders: unknown[] = Array.isArray(s.customApiProviders)
				? s.customApiProviders
				: [];
			const customApiProviders =
				rawCustomApiProviders.length > 0
					? rawCustomApiProviders.map((p) =>
							normalizeCustomApiProvider(p as Partial<CustomApiProviderState>),
						)
					: deriveCustomApiProvidersFromLegacy(openai, anthropic);
			const splitCustomApiProviders = deriveSplitProviders(customApiProviders);

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const nug = (s.nugProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "nug",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				disabled: p.disabled ?? false,
				nugUsername: p.nugUsername,
				nugUserId: p.nugUserId,
				oauthClientId: p.oauthClientId,
				oauthClientSecret: p.oauthClientSecret,
				oauthDeviceId: p.oauthDeviceId,
				proxy: p.proxy,
			}));

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const agent: any = s.agent ?? {};
			// Legacy migration: convert old-format hidden model names (without provider prefix)
			// Safe to remove once all users have migrated to v0.2.0+ (when prefix format was introduced).
			const hidden = (agent.hiddenModels ?? []).map((v: string) => {
				if (!v || v.includes(":")) return v;
				if (
					["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5", "claude-opus-4.6"].includes(
						v,
					)
				)
				return `openai:${v}`;
			});

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const custom = (agent.customModels ?? []).map((m: any) => ({
				value: m.value?.includes(":") ? m.value : `${m.provider ?? "openai"}:${m.value}`,
				label: m.label ?? "",
				provider: m.provider,
			}));

			const windows = (agent.modelContextWindows as Record<string, number>) ?? {};

			const providerOrder: string[] = (agent.providerOrder as string[]) ?? [];
			const disabledProviders = new Set<string>((agent.disabledProviders as string[]) ?? []);

			// Sync: multi-instance providers with disabled=true → disabledProviders
			for (const p of [...openai, ...anthropic, ...nug]) {
				if (p.disabled && p.prefix) disabledProviders.add(p.prefix);
			}
			// customApiProviders (incl. gemini-compatible) also carry a disabled flag.
			for (const p of customApiProviders) {
				if (p.disabled && p.prefix) disabledProviders.add(p.prefix);
			}

			return {
				customApiProviders,
				openaiProviders: splitCustomApiProviders.openai,
				anthropicProviders: splitCustomApiProviders.anthropic,
				nugProviders: nug,
				hiddenModels: new Set(hidden),
				customModels: custom,
				modelContextWindows: windows,
				providerOrder,
				disabledProviders,
				initialized: true,
			};
		}

		case "SET_CUSTOM_API_PROVIDERS":
			return withDerivedCustomApiProviders(
				state,
				resolveUpdater(state.customApiProviders, action.providers),
			);

		case "SET_OPENAI_PROVIDERS":
			return {
				...state,
				openaiProviders: resolveUpdater(state.openaiProviders, action.providers),
			};

		case "SET_ANTHROPIC_PROVIDERS":
			return {
				...state,
				anthropicProviders: resolveUpdater(state.anthropicProviders, action.providers),
			};

		case "SET_NUG_PROVIDERS":
			return {
				...state,
				nugProviders: resolveUpdater(state.nugProviders, action.providers),
			};

		case "TOGGLE_HIDDEN": {
			const next = new Set(state.hiddenModels);
			if (next.has(action.modelVal)) next.delete(action.modelVal);
			else next.add(action.modelVal);
			return { ...state, hiddenModels: next };
		}

		case "BATCH_TOGGLE_HIDDEN": {
			const next = new Set(state.hiddenModels);
			if (action.hidden) {
				for (const v of action.modelValues) next.add(v);
			} else {
				for (const v of action.modelValues) next.delete(v);
			}
			return { ...state, hiddenModels: next };
		}

		case "SET_CUSTOM_MODELS":
			return { ...state, customModels: action.models };

		case "SET_CONTEXT_WINDOW": {
			if (action.size == null) {
				const next = { ...state.modelContextWindows };
				delete next[action.modelVal];
				return { ...state, modelContextWindows: next };
			}
			return {
				...state,
				modelContextWindows: {
					...state.modelContextWindows,
					[action.modelVal]: action.size,
				},
			};
		}

		case "SET_PROVIDER_ORDER":
			return { ...state, providerOrder: action.order };

		case "MERGE_CONTEXT_WINDOWS": {
			// Merge server-side context windows into local state without overwriting user edits
			const merged = { ...state.modelContextWindows };
			let changed = false;
			for (const [key, value] of Object.entries(action.windows)) {
				if (!(key in merged)) {
					merged[key] = value;
					changed = true;
				}
			}
			return changed ? { ...state, modelContextWindows: merged } : state;
		}

		case "TOGGLE_PROVIDER_DISABLED": {
			const next = new Set(state.disabledProviders);
			const willDisable = !next.has(action.prefix);
			if (willDisable) next.add(action.prefix);
			else next.delete(action.prefix);

			// Sync disabled field on multi-instance providers sharing this prefix.
			// Only create new arrays for provider types that actually have a matching prefix.
			const syncDisabled = <T extends { prefix: string; disabled?: boolean }>(
				providers: T[],
			): T[] => {
				const touched = providers.some((p) => p.prefix === action.prefix);
				if (!touched) return providers;
				return providers.map((p) =>
					p.prefix === action.prefix ? { ...p, disabled: willDisable } : p,
				);
			};

			const nextCustomApi = syncDisabled(state.customApiProviders);
			const nextNug = syncDisabled(state.nugProviders);
			const customApiChanged = nextCustomApi !== state.customApiProviders;

			// Only re-derive openai/anthropic arrays if customApiProviders actually changed.
			// This avoids creating new array references for all provider types on every toggle.
			let nextOpenai = state.openaiProviders;
			let nextAnthropic = state.anthropicProviders;
			if (customApiChanged) {
				const normalized = nextCustomApi.map(normalizeCustomApiProvider);
				const split = deriveSplitProviders(normalized);
				nextOpenai = split.openai;
				nextAnthropic = split.anthropic;
			}

			return {
				...state,
				customApiProviders: customApiChanged
					? nextCustomApi.map(normalizeCustomApiProvider)
					: state.customApiProviders,
				openaiProviders: nextOpenai,
				anthropicProviders: nextAnthropic,
				nugProviders: nextNug,
				disabledProviders: next,
			};
		}

		case "RESTORE_FROM_SNAPSHOT": {
			const snap = action.snapshot;
			return {
				...state,
				customApiProviders: snap.customApiProviders.map((p) => ({ ...p })),
				openaiProviders: snap.openaiProviders.map((p) => ({ ...p })),
				anthropicProviders: snap.anthropicProviders.map((p) => ({ ...p })),
				nugProviders: snap.nugProviders.map((p) => ({ ...p })),
				hiddenModels: new Set(snap.hiddenModels),
				customModels: snap.customModels.map((m) => ({ ...m })),
				modelContextWindows: { ...snap.modelContextWindows },
				providerOrder: [...snap.providerOrder],
				disabledProviders: new Set(snap.disabledProviders),
			};
		}

		case "RESET_FOR_REINIT":
			return initialProvidersState;

		default:
			return state;
	}
}

// ── Custom hooks ───────────────────────────────────────

/**
 * Check if the current state differs from the saved snapshot.
 * @param savedSnapshot - Must be a stable reference (e.g. ref.current).
 *   Passing a new object each render will defeat the useMemo cache.
 */
export function useIsDirty(state: ProvidersState, savedSnapshot: SavedSnapshot): boolean {
	return useMemo(() => {
		if (!state.initialized) return false;
		// Fast path: array length comparison
		if (state.customApiProviders.length !== savedSnapshot.customApiProviders.length) return true;
		if (state.nugProviders.length !== savedSnapshot.nugProviders.length) return true;
		if (state.hiddenModels.size !== savedSnapshot.hiddenModels.length) return true;
		if (state.customModels.length !== savedSnapshot.customModels.length) return true;
		if (state.providerOrder.length !== savedSnapshot.providerOrder.length) return true;
		if (state.disabledProviders.size !== savedSnapshot.disabledProviders.length) return true;

		// Deep comparison via JSON.stringify only when lengths match
		if (
			JSON.stringify(state.customApiProviders) !== JSON.stringify(savedSnapshot.customApiProviders)
		)
			return true;
		if (JSON.stringify(state.nugProviders) !== JSON.stringify(savedSnapshot.nugProviders))
			return true;
		if (
			JSON.stringify([...state.hiddenModels].sort()) !==
			JSON.stringify([...savedSnapshot.hiddenModels].sort())
		)
			return true;
		if (JSON.stringify(state.customModels) !== JSON.stringify(savedSnapshot.customModels))
			return true;
		if (JSON.stringify(state.providerOrder) !== JSON.stringify(savedSnapshot.providerOrder))
			return true;
		if (
			JSON.stringify([...state.disabledProviders].sort()) !==
			JSON.stringify([...savedSnapshot.disabledProviders].sort())
		)
			return true;
		if (
			JSON.stringify(state.modelContextWindows) !==
			JSON.stringify(savedSnapshot.modelContextWindows)
		)
			return true;

		return false;
	}, [state, savedSnapshot]);
}

/** Create a snapshot of the current state for dirty detection. */
export function createSnapshot(state: ProvidersState): SavedSnapshot {
	return {
		customApiProviders: state.customApiProviders.map((p) => ({ ...p })),
		openaiProviders: state.openaiProviders.map((p) => ({ ...p })),
		anthropicProviders: state.anthropicProviders.map((p) => ({ ...p })),
		nugProviders: state.nugProviders.map((p) => ({ ...p })),
		hiddenModels: [...state.hiddenModels],
		customModels: state.customModels.map((m) => ({ ...m })),
		modelContextWindows: { ...state.modelContextWindows },
		providerOrder: [...state.providerOrder],
		disabledProviders: [...state.disabledProviders],
	};
}

/** Build dispatch wrappers that support functional updaters. */
export function useProvidersDispatch(dispatch: React.Dispatch<ProvidersAction>) {
	const setCustomApiProviders = useCallback(
		(
			updater:
				| CustomApiProviderState[]
				| ((prev: CustomApiProviderState[]) => CustomApiProviderState[]),
		) => dispatch({ type: "SET_CUSTOM_API_PROVIDERS", providers: updater }),
		[dispatch],
	);

	const setOpenaiProviders = useCallback(
		(updater: OpenAIProviderState[] | ((prev: OpenAIProviderState[]) => OpenAIProviderState[])) =>
			dispatch({ type: "SET_OPENAI_PROVIDERS", providers: updater }),
		[dispatch],
	);

	const setAnthropicProviders = useCallback(
		(
			updater:
				| AnthropicProviderState[]
				| ((prev: AnthropicProviderState[]) => AnthropicProviderState[]),
		) => dispatch({ type: "SET_ANTHROPIC_PROVIDERS", providers: updater }),
		[dispatch],
	);

	const setNugProviders = useCallback(
		(updater: NUGProviderState[] | ((prev: NUGProviderState[]) => NUGProviderState[])) =>
			dispatch({ type: "SET_NUG_PROVIDERS", providers: updater }),
		[dispatch],
	);

	const toggleHidden = useCallback(
		(modelVal: string) => dispatch({ type: "TOGGLE_HIDDEN", modelVal }),
		[dispatch],
	);

	const batchToggleHidden = useCallback(
		(modelValues: string[], hidden: boolean) =>
			dispatch({ type: "BATCH_TOGGLE_HIDDEN", modelValues, hidden }),
		[dispatch],
	);

	const setCustomModels = useCallback(
		(models: CustomModelEntry[]) => dispatch({ type: "SET_CUSTOM_MODELS", models }),
		[dispatch],
	);

	const handleContextWindowChange = useCallback(
		(modelVal: string, size: number | null) =>
			dispatch({ type: "SET_CONTEXT_WINDOW", modelVal, size }),
		[dispatch],
	);

	const setProviderOrder = useCallback(
		(order: string[]) => dispatch({ type: "SET_PROVIDER_ORDER", order }),
		[dispatch],
	);

	const toggleProviderDisabled = useCallback(
		(prefix: string) => dispatch({ type: "TOGGLE_PROVIDER_DISABLED", prefix }),
		[dispatch],
	);

	const mergeContextWindows = useCallback(
		(windows: Record<string, number>) => dispatch({ type: "MERGE_CONTEXT_WINDOWS", windows }),
		[dispatch],
	);

	return useMemo(
		() => ({
			setCustomApiProviders,
			setOpenaiProviders,
			setAnthropicProviders,
			setNugProviders,
			toggleHidden,
			batchToggleHidden,
			setCustomModels,
			handleContextWindowChange,
			setProviderOrder,
			toggleProviderDisabled,
			mergeContextWindows,
		}),
		[
			setCustomApiProviders,
			setOpenaiProviders,
			setAnthropicProviders,
			setNugProviders,
			toggleHidden,
			batchToggleHidden,
			setCustomModels,
			handleContextWindowChange,
			setProviderOrder,
			toggleProviderDisabled,
			mergeContextWindows,
		],
	);
}
