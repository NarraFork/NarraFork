import { useCallback, useMemo } from "react";
import type { PlatformInstanceRow } from "../../../shared/platform-instances";
import type { ProxyOverride } from "../../lib/proxy";
import type { NUGProviderState } from "./NUGProvidersSection";
import type {
	AnthropicProviderState,
	CustomApiProtocol,
	CustomApiProviderState,
	OpenAIProviderState,
	UserAgentMode,
} from "./types";

// ── Types ──────────────────────────────────────────────

export interface CustomModelEntry {
	value: string;
	label: string;
	provider?: string;
}

/** Command Code 平台 provider 的草稿（settings.commandCode 的镜像）。 */
export interface CommandCodeState {
	apiKey: string;
	/** 后端据此把该 provider 从可用候选里剔除，所以必须跟着草稿一起保存。 */
	disabled: boolean;
	proxy?: ProxyOverride;
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
}

/**
 * 平台集成（codex / Command Code / TokenDance）的前缀清单。
 *
 * 约定：**平台 provider 的启用开关一律写成这里的草稿**，由页面底部的保存条统一提交，
 * 「放弃更改」随快照回滚。UI 里不允许直接调用后端接口去改启用状态 —— 新增平台 provider
 * 时把它加进这个数组，`SET_PLATFORM_DISABLED` 会强制你在这里落地对应字段。
 */
export const PLATFORM_PROVIDER_PREFIXES = ["codex", "CommandCode", "tokendance"] as const;

export type PlatformProviderPrefix = (typeof PLATFORM_PROVIDER_PREFIXES)[number];

/** 判断某个 prefix 是不是平台 provider（决定开关走草稿还是普通 provider 的 toggle）。 */
export function isPlatformProviderPrefix(prefix: string): prefix is PlatformProviderPrefix {
	return (PLATFORM_PROVIDER_PREFIXES as readonly string[]).includes(prefix);
}

export interface ProvidersState {
	customApiProviders: CustomApiProviderState[];
	openaiProviders: OpenAIProviderState[];
	anthropicProviders: AnthropicProviderState[];
	nugProviders: NUGProviderState[];
	commandCode: CommandCodeState;
	/** TokenDance 的连接开关草稿（它存在自己的连接记录里，保存时单独提交）。 */
	tokenDanceDisabled: boolean;
	hiddenModels: Set<string>;
	customModels: CustomModelEntry[];
	/** 平台集成实例清单（含启用与配置），与其它供应商一样作为草稿统一提交。 */
	platformInstances: PlatformInstanceRow[];
	modelProtocols: Record<string, CustomApiProtocol>;
	providerOrder: string[];
	disabledProviders: Set<string>;
	/** Prefixes left out of `auto:<model>` routing (`agent.autoExcludedProviders`). */
	autoExcludedProviders: Set<string>;
	initialized: boolean;
}

export interface SavedSnapshot {
	customApiProviders: CustomApiProviderState[];
	openaiProviders: OpenAIProviderState[];
	anthropicProviders: AnthropicProviderState[];
	nugProviders: NUGProviderState[];
	commandCode: CommandCodeState;
	tokenDanceDisabled: boolean;
	platformInstances: PlatformInstanceRow[];
	hiddenModels: string[];
	customModels: CustomModelEntry[];
	modelProtocols: Record<string, CustomApiProtocol>;
	providerOrder: string[];
	disabledProviders: string[];
	autoExcludedProviders: string[];
}

// Functional updater types
type Updater<T> = T | ((prev: T) => T);

export type ProvidersAction =
	| { type: "INIT_FROM_SETTINGS"; settings: Record<string, unknown> }
	| { type: "SYNC_FROM_SETTINGS"; settings: Record<string, unknown> }
	| { type: "SET_CUSTOM_API_PROVIDERS"; providers: Updater<CustomApiProviderState[]> }
	| { type: "SET_OPENAI_PROVIDERS"; providers: Updater<OpenAIProviderState[]> }
	| { type: "SET_ANTHROPIC_PROVIDERS"; providers: Updater<AnthropicProviderState[]> }
	| { type: "SET_NUG_PROVIDERS"; providers: Updater<NUGProviderState[]> }
	| { type: "SET_COMMAND_CODE"; config: CommandCodeState }
	| { type: "SET_PLATFORM_DISABLED"; prefix: PlatformProviderPrefix; disabled: boolean }
	| { type: "SET_PLATFORM_INSTANCES"; instances: Updater<PlatformInstanceRow[]> }
	| { type: "TOGGLE_HIDDEN"; modelVal: string }
	| { type: "BATCH_TOGGLE_HIDDEN"; modelValues: string[]; hidden: boolean }
	| { type: "SET_CUSTOM_MODELS"; models: CustomModelEntry[] }
	| { type: "SET_MODEL_PROTOCOL"; modelVal: string; protocol: CustomApiProtocol | null }
	| { type: "SET_PROVIDER_ORDER"; order: string[] }
	| { type: "TOGGLE_PROVIDER_DISABLED"; prefix: string }
	| { type: "SET_AUTO_EXCLUDED"; prefix: string; excluded: boolean }
	| { type: "MARK_SAVED" }
	| { type: "RESTORE_FROM_SNAPSHOT"; snapshot: SavedSnapshot }
	| { type: "RESET_FOR_REINIT" };

// ── Helpers ────────────────────────────────────────────

function resolveUpdater<T>(prev: T, updater: Updater<T>): T {
	return typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
}

function protocolFromOpenAI(provider: OpenAIProviderState): CustomApiProtocol {
	switch (provider.apiMode) {
		case "completions":
			return "completions-compatible";
		default:
			// codex / responses / unset all fold into the unified Responses protocol.
			return provider.responsesApi === false ? "completions-compatible" : "openai-responses";
	}
}

function protocolFromAnthropic(_officialApi?: boolean): CustomApiProtocol {
	return "anthropic-messages";
}

function isAnthropicProtocol(protocol: CustomApiProtocol): boolean {
	return protocol === "anthropic-messages";
}

function customApiToOpenAI(provider: CustomApiProviderState): OpenAIProviderState | null {
	let apiMode: NonNullable<OpenAIProviderState["apiMode"]> | null = null;
	if (provider.protocol === "openai-responses") apiMode = "codex";
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
		officialApi: true,
		nativeSearch: provider.nativeSearch ?? true,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
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
		protocol: provider.protocol ?? "openai-responses",
		geminiTransport:
			provider.protocol === "gemini-compatible"
				? (provider.geminiTransport ?? "generate-content")
				: provider.geminiTransport,
		defaultContextWindow: provider.defaultContextWindow,
		defaultReasoningEffort: provider.defaultReasoningEffort,
		proxy: provider.proxy,
		tlsRejectUnauthorized: provider.tlsRejectUnauthorized ?? true,
		nativeSearch: provider.nativeSearch ?? provider.protocol === "anthropic-messages",
		codexAccountId: provider.codexAccountId ?? "",
		codexWebSocket: provider.codexWebSocket ?? false,
		codexWebSearch: provider.codexWebSearch ?? true,
		codexImageGeneration: provider.codexImageGeneration ?? true,
		userAgentMode: provider.userAgentMode,
		customUserAgent: provider.customUserAgent,
		extraHeaders: provider.extraHeaders,
		disabled: provider.disabled ?? false,
	};
}

function deriveCustomApiProvidersFromLegacy(
	openaiProviders: OpenAIProviderState[],
	anthropicProviders: AnthropicProviderState[],
	geminiProviders: Array<Partial<CustomApiProviderState>> = [],
): CustomApiProviderState[] {
	// Only reached when the server returned no customApiProviders at all. The
	// server's normalize (custom-api-providers.ts) is authoritative for legacy
	// migration pins (native tools/search off, UA); this path just reconstructs
	// a displayable state for very old responses.
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
	for (const provider of geminiProviders) {
		if (!provider.id || byId.has(provider.id)) continue;
		byId.set(
			provider.id,
			normalizeCustomApiProvider({
				...provider,
				protocol: "gemini-compatible",
				geminiTransport: provider.geminiTransport ?? "generate-content",
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
	commandCode: { apiKey: "", disabled: false },
	tokenDanceDisabled: false,
	platformInstances: [],
	hiddenModels: new Set(),
	customModels: [],
	modelProtocols: {},
	providerOrder: [],
	disabledProviders: new Set(),
	autoExcludedProviders: new Set(),
	initialized: false,
};

// ── Reducer ────────────────────────────────────────────

export function providersReducer(state: ProvidersState, action: ProvidersAction): ProvidersState {
	switch (action.type) {
		case "SYNC_FROM_SETTINGS":
			return providersStateFromSettings(action.settings);

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
				nativeSearch: p.nativeSearch ?? p.officialApi ?? false,
				userAgentMode: p.userAgentMode,
				customUserAgent: p.customUserAgent,
				extraHeaders: p.extraHeaders,
				disabled: p.disabled ?? false,
			}));

			const gemini = (Array.isArray(s.geminiProviders) ? s.geminiProviders : []).map(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic settings JSON
				(p: any) => ({
					...p,
					protocol: "gemini-compatible" as const,
					geminiTransport: p.geminiTransport ?? "generate-content",
					codexAccountId: p.codexAccountId ?? "",
				}),
			);

			const rawCustomApiProviders: unknown[] = Array.isArray(s.customApiProviders)
				? s.customApiProviders
				: [];
			const customApiProviders =
				rawCustomApiProviders.length > 0
					? rawCustomApiProviders.map((p) =>
							normalizeCustomApiProvider(p as Partial<CustomApiProviderState>),
						)
					: deriveCustomApiProvidersFromLegacy(openai, anthropic, gemini);
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
				egressMode: p.egressMode,
				egressProxyUrl: p.egressProxyUrl,
				egressAllowDirectFallback: p.egressAllowDirectFallback,
			}));

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const agent: any = s.agent ?? {};
			// Legacy migration: convert old-format hidden model names (without provider prefix)
			// to new prefixed format. Bare claude names resolve to the Anthropic provider.
			const hidden = (agent.hiddenModels ?? []).map((v: string) => {
				if (!v || v.includes(":")) return v;
				if (
					["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5", "claude-opus-4.6"].includes(
						v,
					)
				)
					return `anthropic:${v}`;
				if (v === "claude-haiku") return "anthropic:claude-haiku-4.5";
				if (v === "claude-sonnet") return "anthropic:claude-sonnet-4.5";
				if (v === "claude-opus") return "anthropic:claude-opus-4.6";
				return `openai:${v}`;
			});

			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const custom = (agent.customModels ?? []).map((m: any) => ({
				value: m.value?.includes(":") ? m.value : `${m.provider ?? "openai"}:${m.value}`,
				label: m.label ?? "",
				provider: m.provider,
			}));

			const modelProtocols = (agent.modelProtocols as Record<string, CustomApiProtocol>) ?? {};

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
				commandCode: {
					apiKey: s.commandCode?.apiKey ?? "",
					disabled: s.commandCode?.disabled === true,
					proxy: s.commandCode?.proxy,
					userAgentMode: s.commandCode?.userAgentMode,
					customUserAgent: s.commandCode?.customUserAgent,
					extraHeaders: s.commandCode?.extraHeaders,
				},
				tokenDanceDisabled: s.tokendance?.disabled === true,
				// 平台实例清单：卡片、开关与配置都从这里出发，改动先落在草稿上。
				platformInstances: Array.isArray(agent.platformInstances)
					? (agent.platformInstances as PlatformInstanceRow[]).map((instance) => ({
							...instance,
							config: { ...instance.config },
						}))
					: [],
				hiddenModels: new Set(hidden),
				customModels: custom,
				modelProtocols,
				providerOrder,
				disabledProviders,
				autoExcludedProviders: new Set<string>((agent.autoExcludedProviders as string[]) ?? []),
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

		case "SET_COMMAND_CODE":
			return { ...state, commandCode: action.config };

		case "SET_PLATFORM_INSTANCES":
			return {
				...state,
				platformInstances: resolveUpdater(state.platformInstances, action.instances),
			};

		case "SET_PLATFORM_DISABLED": {
			// 平台 provider 的启用开关只有这一个写入点：它只改草稿，绝不碰后端接口。
			// 保存条是唯一的提交点，「放弃更改」时随快照一起回滚。
			switch (action.prefix) {
				case "codex": {
					const next = new Set(state.disabledProviders);
					if (action.disabled) next.add("codex");
					else next.delete("codex");
					return { ...state, disabledProviders: next };
				}
				case "CommandCode":
					return {
						...state,
						commandCode: { ...state.commandCode, disabled: action.disabled },
					};
				case "tokendance":
					return { ...state, tokenDanceDisabled: action.disabled };
			}
			return state;
		}

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

		case "SET_MODEL_PROTOCOL": {
			const next = { ...state.modelProtocols };
			if (action.protocol) next[action.modelVal] = action.protocol;
			else delete next[action.modelVal];
			return { ...state, modelProtocols: next };
		}

		case "SET_PROVIDER_ORDER":
			return { ...state, providerOrder: action.order };

		case "TOGGLE_PROVIDER_DISABLED": {
			if (!action.prefix) return state;
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

		case "SET_AUTO_EXCLUDED": {
			if (!action.prefix || state.autoExcludedProviders.has(action.prefix) === action.excluded) {
				return state;
			}
			const next = new Set(state.autoExcludedProviders);
			if (action.excluded) next.add(action.prefix);
			else next.delete(action.prefix);
			return { ...state, autoExcludedProviders: next };
		}

		case "RESTORE_FROM_SNAPSHOT": {
			const snap = action.snapshot;
			return {
				...state,
				customApiProviders: snap.customApiProviders.map((p) => ({ ...p })),
				openaiProviders: snap.openaiProviders.map((p) => ({ ...p })),
				anthropicProviders: snap.anthropicProviders.map((p) => ({ ...p })),
				nugProviders: snap.nugProviders.map((p) => ({ ...p })),
				commandCode: { ...snap.commandCode },
				tokenDanceDisabled: snap.tokenDanceDisabled,
				platformInstances: snap.platformInstances.map((instance) => ({
					...instance,
					config: { ...instance.config },
				})),
				hiddenModels: new Set(snap.hiddenModels),
				customModels: snap.customModels.map((m) => ({ ...m })),
				modelProtocols: { ...snap.modelProtocols },
				providerOrder: [...snap.providerOrder],
				disabledProviders: new Set(snap.disabledProviders),
				autoExcludedProviders: new Set(snap.autoExcludedProviders),
			};
		}

		case "RESET_FOR_REINIT":
			return initialProvidersState;

		default:
			return state;
	}
}

export function providersStateFromSettings(settings: Record<string, unknown>): ProvidersState {
	return providersReducer(initialProvidersState, { type: "INIT_FROM_SETTINGS", settings });
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
		if (JSON.stringify(state.commandCode) !== JSON.stringify(savedSnapshot.commandCode))
			return true;
		if (state.tokenDanceDisabled !== savedSnapshot.tokenDanceDisabled) return true;
		if (JSON.stringify(state.platformInstances) !== JSON.stringify(savedSnapshot.platformInstances))
			return true;
		// Key order is not meaningful here, so compare sorted entries rather than the raw objects.
		if (
			JSON.stringify(Object.entries(state.modelProtocols).sort()) !==
			JSON.stringify(Object.entries(savedSnapshot.modelProtocols).sort())
		)
			return true;
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
			JSON.stringify([...state.autoExcludedProviders].sort()) !==
			JSON.stringify([...savedSnapshot.autoExcludedProviders].sort())
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
		commandCode: { ...state.commandCode },
		tokenDanceDisabled: state.tokenDanceDisabled,
		platformInstances: state.platformInstances.map((instance) => ({
			...instance,
			config: { ...instance.config },
		})),
		hiddenModels: [...state.hiddenModels],
		customModels: state.customModels.map((m) => ({ ...m })),
		modelProtocols: { ...state.modelProtocols },
		providerOrder: [...state.providerOrder],
		disabledProviders: [...state.disabledProviders],
		autoExcludedProviders: [...state.autoExcludedProviders],
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

	const setCommandCode = useCallback(
		(config: CommandCodeState) => dispatch({ type: "SET_COMMAND_CODE", config }),
		[dispatch],
	);

	/** 平台 provider 启用开关的唯一入口（只改草稿，保存条统一提交）。 */
	const setPlatformDisabled = useCallback(
		(prefix: PlatformProviderPrefix, disabled: boolean) =>
			dispatch({ type: "SET_PLATFORM_DISABLED", prefix, disabled }),
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

	const setModelProtocol = useCallback(
		(modelVal: string, protocol: CustomApiProtocol | null) =>
			dispatch({ type: "SET_MODEL_PROTOCOL", modelVal, protocol }),
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

	const setAutoExcluded = useCallback(
		(prefix: string, excluded: boolean) =>
			dispatch({ type: "SET_AUTO_EXCLUDED", prefix, excluded }),
		[dispatch],
	);

	return useMemo(
		() => ({
			setCustomApiProviders,
			setOpenaiProviders,
			setAnthropicProviders,
			setNugProviders,
			setCommandCode,
			setPlatformDisabled,
			toggleHidden,
			batchToggleHidden,
			setCustomModels,
			setModelProtocol,
			setProviderOrder,
			toggleProviderDisabled,
			setAutoExcluded,
		}),
		[
			setCustomApiProviders,
			setOpenaiProviders,
			setAnthropicProviders,
			setNugProviders,
			setCommandCode,
			setPlatformDisabled,
			toggleHidden,
			batchToggleHidden,
			setCustomModels,
			setModelProtocol,
			setProviderOrder,
			toggleProviderDisabled,
			setAutoExcluded,
		],
	);
}
