/**
 * A custom API provider with several keys (see provider-keys.ts).
 *
 * Which key a request uses:
 *  - A session keeps the key it started on (prompt caches are per account), unless that
 *    key is cooling down or turned off.
 *  - Otherwise the first usable key in the provider's order.
 *  - If every key is cooling down, the one that recovers first, so the upstream error
 *    (and the agent loop's quota handling) still applies.
 *
 * What a failure does to a key (kept in memory; only `invalid` is saved):
 *  - 401: the key is rejected → turned off as `invalid` until someone edits it.
 *  - 402, or a 429 that says the allowance is used up → cooling down for 30 minutes.
 *  - 403 → 10 minutes; any other 429 → the server's Retry-After, else 60 seconds.
 *  - Anything else (5xx, network, bad request) says nothing about the key.
 *
 * A request moves to the next key only when the key was at fault and nothing has been
 * streamed yet; after output has started, the error goes to the caller as before.
 */
import type { CredentialNetwork } from "@shared/credential-network";
import { logger } from "../logger";
import { getProviderKeyStore, type ProviderKey } from "../provider-keys";
import type { ProxyOverride } from "../settings/types";
import { shouldTreatCodexStreamEventAsYielded } from "./codex-websocket";
import { extractErrorMessage, isHardNonRetryableText } from "./error-handling";
import type {
	BuiltHistory,
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import { ApiError } from "./types";

const MINUTE = 60_000;
const STICKY_LIMIT = 5_000;

export type KeyCooldownReason = "rate_limited" | "quota" | "forbidden";

interface Cooldown {
	until: number;
	reason: KeyCooldownReason;
}

const cooldowns = new Map<string, Cooldown>();
/** `${providerId}\0${session}` → key id. Insertion-ordered, trimmed to STICKY_LIMIT. */
const sticky = new Map<string, string>();

/** Current cooldown of a key, if any; for the key list. */
export function keyCooldown(keyId: string, now = Date.now()): Cooldown | undefined {
	const cooldown = cooldowns.get(keyId);
	return cooldown && cooldown.until > now ? cooldown : undefined;
}

export function clearKeyCooldown(keyId: string): void {
	cooldowns.delete(keyId);
}

/** Keys of a provider that requests may use, in order. */
export function usableProviderKeys(providerId: string): ProviderKey[] {
	return getProviderKeyStore()
		.list(providerId)
		.filter((key) => !key.disabled);
}

export function selectProviderKey(
	providerId: string,
	session?: string,
	exclude?: ReadonlySet<string>,
	now = Date.now(),
): ProviderKey | undefined {
	const keys = usableProviderKeys(providerId).filter((key) => !exclude?.has(key.id));
	if (keys.length === 0) return undefined;
	const ready = keys.filter((key) => !keyCooldown(key.id, now));
	const stickyKey = session ? `${providerId}\0${session}` : undefined;
	const pinned = stickyKey ? sticky.get(stickyKey) : undefined;
	const chosen =
		ready.find((key) => key.id === pinned) ??
		ready[0] ??
		[...keys].sort(
			(a, b) => (cooldowns.get(a.id)?.until ?? 0) - (cooldowns.get(b.id)?.until ?? 0),
		)[0];
	if (stickyKey && chosen) {
		sticky.delete(stickyKey);
		sticky.set(stickyKey, chosen.id);
		if (sticky.size > STICKY_LIMIT) sticky.delete(sticky.keys().next().value as string);
	}
	return chosen;
}

function retryAfterMs(err: ApiError): number | undefined {
	const match = /retry[-_ ]after["':\s]+(\d+)/i.exec(
		`${err.message} ${err.diagnostics?.responseSnippet ?? ""}`,
	);
	const seconds = match ? Number(match[1]) : Number.NaN;
	return Number.isFinite(seconds) && seconds > 0
		? Math.min(seconds * 1000, 60 * MINUTE)
		: undefined;
}

export type KeyFault =
	| { kind: "invalid" }
	| { kind: "cooldown"; ms: number; reason: KeyCooldownReason };

/** Whether an error was this key's fault, and what that means for it. */
export function classifyKeyFault(err: unknown): KeyFault | null {
	if (!(err instanceof ApiError)) return null;
	const text =
		`${extractErrorMessage(err)} ${err.diagnostics?.responseSnippet ?? ""}`.toLowerCase();
	switch (err.status) {
		case 401:
			return { kind: "invalid" };
		case 402:
			return { kind: "cooldown", ms: 30 * MINUTE, reason: "quota" };
		case 403:
			return { kind: "cooldown", ms: 10 * MINUTE, reason: "forbidden" };
		case 429:
			return isHardNonRetryableText(text)
				? { kind: "cooldown", ms: 30 * MINUTE, reason: "quota" }
				: { kind: "cooldown", ms: retryAfterMs(err) ?? MINUTE, reason: "rate_limited" };
		default:
			return null;
	}
}

/** Apply a fault to a key. Returns whether another key should be tried. */
export function reportKeyFault(key: ProviderKey, err: unknown, now = Date.now()): boolean {
	const fault = classifyKeyFault(err);
	if (!fault) return false;
	if (fault.kind === "invalid") {
		try {
			getProviderKeyStore().update(key.id, { disabled: true, disabledReason: "invalid" });
		} catch {
			// The key file is unreadable: keep the key in rotation rather than fail here.
			cooldowns.set(key.id, { until: now + 10 * MINUTE, reason: "forbidden" });
		}
		logger.warn("Provider key rejected by upstream; turned off", {
			providerId: key.providerId,
			keyId: key.id,
		});
	} else {
		cooldowns.set(key.id, { until: now + fault.ms, reason: fault.reason });
		logger.info("Provider key cooling down", {
			providerId: key.providerId,
			keyId: key.id,
			reason: fault.reason,
			seconds: Math.round(fault.ms / 1000),
		});
	}
	return true;
}

/** A connection config that speaks for one key: its secret, and its own network identity. */
export function withProviderKey<
	T extends {
		apiKey: string;
		proxy?: ProxyOverride;
		userAgentMode?: string;
		customUserAgent?: string;
		extraHeaders?: Record<string, string>;
	},
>(config: T, key: { apiKey: string; network?: CredentialNetwork }): T {
	const network = key.network;
	return {
		...config,
		apiKey: key.apiKey,
		...(network?.proxy && network.proxy.mode !== "default" ? { proxy: network.proxy } : {}),
		...(network?.userAgentMode
			? { userAgentMode: network.userAgentMode, customUserAgent: network.customUserAgent }
			: {}),
		...(network?.extraHeaders
			? { extraHeaders: { ...config.extraHeaders, ...network.extraHeaders } }
			: {}),
	};
}

/**
 * One adapter per key, built on demand. The wrapper exposes exactly the optional
 * methods the underlying adapter family has, so callers that probe for them see no
 * difference.
 */
export class PooledProvider implements ProviderAdapter {
	private readonly adapters = new Map<string, { signature: string; adapter: ProviderAdapter }>();
	readonly mayLeakXmlToolCalls?: boolean;
	supportsNativeMediaInput?: ProviderAdapter["supportsNativeMediaInput"];
	toolLoadingTarget?: ProviderAdapter["toolLoadingTarget"];
	getActiveReasoningSource?: ProviderAdapter["getActiveReasoningSource"];
	generateWithHistoryWithMeta?: ProviderAdapter["generateWithHistoryWithMeta"];

	constructor(
		private readonly providerId: string,
		private readonly build: (key: ProviderKey) => ProviderAdapter,
	) {
		const probe = this.current();
		this.mayLeakXmlToolCalls = probe.mayLeakXmlToolCalls;
		if (probe.supportsNativeMediaInput) {
			this.supportsNativeMediaInput = (media, model) =>
				this.current().supportsNativeMediaInput?.(media, model) ?? false;
		}
		if (probe.toolLoadingTarget) {
			this.toolLoadingTarget = (model) => this.current().toolLoadingTarget?.(model);
		}
		if (probe.getActiveReasoningSource) {
			this.getActiveReasoningSource = () => this.current().getActiveReasoningSource?.();
		}
		if (probe.generateWithHistoryWithMeta) {
			this.generateWithHistoryWithMeta = (systemInstruction, content, model, locale, options) =>
				this.withFailover((adapter) =>
					(
						adapter.generateWithHistoryWithMeta as NonNullable<
							ProviderAdapter["generateWithHistoryWithMeta"]
						>
					)(systemInstruction, content, model, locale, options),
				);
		}
	}

	private adapterFor(key: ProviderKey): ProviderAdapter {
		const signature = JSON.stringify([key.apiKey, key.network ?? null]);
		const cached = this.adapters.get(key.id);
		if (cached?.signature === signature) return cached.adapter;
		const adapter = this.build(key);
		this.adapters.set(key.id, { signature, adapter });
		return adapter;
	}

	/** The adapter for formatting work that does not depend on the key. */
	private current(): ProviderAdapter {
		const key = selectProviderKey(this.providerId);
		if (!key) throw new Error("This provider has no usable API key");
		return this.adapterFor(key);
	}

	private async withFailover<T extends object | string>(
		run: (adapter: ProviderAdapter) => Promise<T>,
	): Promise<T> {
		const tried = new Set<string>();
		for (;;) {
			const key = selectProviderKey(this.providerId, undefined, tried);
			if (!key) throw new Error("This provider has no usable API key");
			tried.add(key.id);
			try {
				const result = await run(this.adapterFor(key));
				clearKeyCooldown(key.id);
				if (typeof result === "object" && result !== null && !("credentialId" in result)) {
					return { ...result, credentialId: key.id };
				}
				return result;
			} catch (err) {
				const more =
					reportKeyFault(key, err) && !!selectProviderKey(this.providerId, undefined, tried);
				if (!more) throw err;
			}
		}
	}

	formatTools(tools: Parameters<ProviderAdapter["formatTools"]>[0]): unknown[] {
		return this.current().formatTools(tools);
	}

	buildHistory(dbMessages: DbMessage[], model: string, narratorId?: string): Promise<BuiltHistory> {
		return this.current().buildHistory(dbMessages, model, narratorId);
	}

	injectSystemPrompt(history: unknown[], systemPrompt: string, model: string, locale?: string) {
		this.current().injectSystemPrompt(history, systemPrompt, model, locale);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const session = params.stickySessionKey ?? params.conversationId;
		const tried = new Set<string>();
		for (;;) {
			const key = selectProviderKey(this.providerId, session, tried);
			if (!key) throw new Error("This provider has no usable API key");
			tried.add(key.id);
			let streamed = false;
			try {
				for await (const event of this.adapterFor(key).chat({
					...params,
					onRequestStart: (info) =>
						params.onRequestStart?.({ credentialId: info?.credentialId ?? key.id }),
				})) {
					streamed ||= shouldTreatCodexStreamEventAsYielded(event);
					yield { ...event, credentialId: event.credentialId ?? key.id };
				}
				clearKeyCooldown(key.id);
				return;
			} catch (err) {
				if (params.signal.aborted) throw err;
				const faulted = reportKeyFault(key, err);
				const next = faulted && !streamed && selectProviderKey(this.providerId, session, tried);
				if (!next) throw err;
				logger.info("Retrying with the provider's next key", {
					providerId: this.providerId,
					previousKeyId: key.id,
					error: extractErrorMessage(err).slice(0, 200),
				});
			}
		}
	}

	generate(text: string, model: string): Promise<string> {
		return this.withFailover((adapter) => adapter.generate(text, model));
	}

	generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		return this.withFailover((adapter) =>
			adapter.generateWithMeta(text, model, systemInstruction, options),
		);
	}

	generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string> {
		return this.withFailover((adapter) =>
			adapter.generateWithHistory(systemInstruction, content, model, locale, options),
		);
	}
}

/** Tests only. */
export function resetProviderKeyRuntimeForTests(): void {
	cooldowns.clear();
	sticky.clear();
}
