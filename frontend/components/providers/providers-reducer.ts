import { useCallback, useMemo } from "react";
import type { NUGProviderState } from "./NUGProvidersSection";

// ── Types ──────────────────────────────────────────────

export interface CustomModelEntry {
	value: string;
	label: string;
	provider?: string;
}

export interface ProvidersState {
	openaiProviders: OpenAIProviderState[];
	anthropicProviders: AnthropicProviderState[];
	nugProviders: NUGProviderState[];
	hiddenModels: Set<string>;
	customModels: CustomModelEntry[];
	modelContextWindows: Record<string, number>;
	initialized: boolean;
}

export interface SavedSnapshot {
	openaiProviders: OpenAIProviderState[];
	anthropicProviders: AnthropicProviderState[];
	nugProviders: NUGProviderState[];
	hiddenModels: string[];
	customModels: CustomModelEntry[];
	modelContextWindows: Record<string, number>;
}

// Functional updater types
type Updater<T> = T | ((prev: T) => T);

export type ProvidersAction =
	| { type: "INIT_FROM_SETTINGS"; settings: Record<string, unknown> }
	| { type: "SET_OPENAI_PROVIDERS"; providers: Updater<OpenAIProviderState[]> }
	| { type: "SET_ANTHROPIC_PROVIDERS"; providers: Updater<AnthropicProviderState[]> }
	| { type: "SET_NUG_PROVIDERS"; providers: Updater<NUGProviderState[]> }
	| { type: "TOGGLE_HIDDEN"; modelVal: string }
	| { type: "BATCH_TOGGLE_HIDDEN"; modelValues: string[]; hidden: boolean }
	| { type: "SET_CUSTOM_MODELS"; models: CustomModelEntry[] }
	| { type: "SET_CONTEXT_WINDOW"; modelVal: string; size: number | null }
	| { type: "MARK_SAVED" };

// ── Helpers ────────────────────────────────────────────

function resolveUpdater<T>(prev: T, updater: Updater<T>): T {
	return typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
}

// ── Initial state ──────────────────────────────────────

export const initialProvidersState: ProvidersState = {
	openaiProviders: [],
	anthropicProviders: [],
	nugProviders: [],
	hiddenModels: new Set(),
	customModels: [],
	modelContextWindows: {},
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
				apiMode: p.apiMode ?? "responses",
				codexAccountId: p.codexAccountId ?? "",
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
				defaultReasoningEffort: p.defaultReasoningEffort ?? null,
				proxy: p.proxy ?? "",
				tlsRejectUnauthorized: p.tlsRejectUnauthorized ?? true,
				disabled: p.disabled ?? false,
			}));

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				id: p.id ?? "",
				name: p.name ?? "",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				disabled: p.disabled ?? false,
			}));

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

			return {
				openaiProviders: openai,
				anthropicProviders: anthropic,
				nugProviders: nug,
				hiddenModels: new Set(hidden),
				customModels: custom,
				modelContextWindows: windows,
				initialized: true,
			};
		}

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

			return {
				...state,
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
		if (state.openaiProviders.length !== savedSnapshot.openaiProviders.length) return true;
		if (state.anthropicProviders.length !== savedSnapshot.anthropicProviders.length) return true;
		if (state.nugProviders.length !== savedSnapshot.nugProviders.length) return true;
		if (state.hiddenModels.size !== savedSnapshot.hiddenModels.length) return true;
		if (state.customModels.length !== savedSnapshot.customModels.length) return true;

		// Deep comparison via JSON.stringify only when lengths match
		if (JSON.stringify(state.openaiProviders) !== JSON.stringify(savedSnapshot.openaiProviders))
			return true;
		if (
			JSON.stringify(state.anthropicProviders) !== JSON.stringify(savedSnapshot.anthropicProviders)
		)
			return true;
			return true;
		if (JSON.stringify(state.nugProviders) !== JSON.stringify(savedSnapshot.nugProviders))
			return true;
		if (
			JSON.stringify([...state.hiddenModels].sort()) !==
			JSON.stringify(savedSnapshot.hiddenModels.sort())
		)
			return true;
		if (JSON.stringify(state.customModels) !== JSON.stringify(savedSnapshot.customModels))
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
		openaiProviders: state.openaiProviders.map((p) => ({ ...p })),
		anthropicProviders: state.anthropicProviders.map((p) => ({ ...p })),
		nugProviders: state.nugProviders.map((p) => ({ ...p })),
		hiddenModels: [...state.hiddenModels],
		customModels: state.customModels.map((m) => ({ ...m })),
		modelContextWindows: { ...state.modelContextWindows },
	};
}

/** Build dispatch wrappers that support functional updaters. */
export function useProvidersDispatch(dispatch: React.Dispatch<ProvidersAction>) {
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

	return useMemo(
		() => ({
			setOpenaiProviders,
			setAnthropicProviders,
			setNugProviders,
			toggleHidden,
			batchToggleHidden,
			setCustomModels,
			handleContextWindowChange,
		}),
		[
			setOpenaiProviders,
			setAnthropicProviders,
			setNugProviders,
			toggleHidden,
			batchToggleHidden,
			setCustomModels,
			handleContextWindowChange,
		],
	);
}
