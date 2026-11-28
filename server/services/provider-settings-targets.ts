import {
	type CodexManager,
	type CodexProviderSettingsIdentity,
	getCodexManager,
	MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE,
} from "@server/lib/codex-manager";
import {
	type CommandCodeAuthState,
	resolveCommandCodeToken,
} from "@server/lib/commandcode-manager";
import { AppError } from "@server/lib/errors";
import { settings } from "@server/lib/settings";
import type { NarraForkSettings } from "@server/lib/settings/types";
import {
	type ProviderSettingsTargetKind,
	providerSettingsTargetKindSchema,
} from "@shared/provider-settings";
import { type ProviderRegistryEntry, pluginProviderRegistry } from "./plugin-provider-registry";

/**
 * Public allowlist, not a provider configuration or an execution capability.
 * `available` describes saved/registered lifecycle state, NOT credential readiness.
 * Never add config, keys, URLs, local paths, proxies, callbacks or registry entries here.
 */
export interface ProviderSettingsTarget {
	readonly kind: ProviderSettingsTargetKind;
	readonly id: string;
	readonly name: string;
	readonly disabled: boolean;
	readonly available: boolean;
}

export type ProviderSettingsPlatformKind = "codex" | "commandcode" | "tokendance";

/**
 * Identity contract:
 * - custom-api / nug: the canonical saved record's `id`, unchanged across renames/protocols.
 * - codex: `codex:credential:<persisted CodexCredential.id>`, never an in-memory generated ID,
 *   accountId/email/displayName/currentId. `codex:pool` is the real default pool slot,
 *   never an alias for a credential. Identity reads do not persist missing legacy IDs.
 * - Command Code: one `commandcode:singleton` slot. Settings and CLI auth are two sources
 *   of that SAME slot; `CommandCode` is the model-routing alias, not a persisted identity.
 * - TokenDance: one `tokendance:singleton` slot. Rotating `generation` is NOT identity.
 * - executable-plugin: the exact registered `providerInstanceId`, including its generation.
 *   Neither providerPrefix nor providerTypeId is an instance-id alias.
 */
export const PROVIDER_SETTINGS_SINGLETON_IDS = Object.freeze({
	codex: "codex:pool",
	commandcode: "commandcode:singleton",
	tokendance: "tokendance:singleton",
});

/** Hard budgets; a truncated source must never hide a later duplicate identity. */
export const MAX_PROVIDER_SETTINGS_TARGETS = 1_024;
const MAX_TARGET_ID_CHARS = 128;
const MAX_SAVED_ID_CHARS = 50;
const MAX_TARGET_NAME_CHARS = 160;
const MAX_TARGET_LIST_BYTES = 512 * 1_024;
const FORBIDDEN_IDS = new Set(["__proto__", "prototype", "constructor", ".", ".."]);

export type ProviderSettingsCodexIdentity = CodexProviderSettingsIdentity;
export type ProviderSettingsCodexReader = Pick<
	CodexManager,
	| "getProviderSettingsIdentity"
	| "listProviderSettingsIdentities"
	| "getProviderSettingsPoolIdentity"
>;

type TargetSettings = Pick<
	NarraForkSettings,
	"customApiProviders" | "nugProviders" | "commandCode" | "tokendance"
> & { agent?: Pick<NarraForkSettings["agent"], "disabledProviders"> };

type PluginTargetIdentity = Pick<
	ProviderRegistryEntry,
	"kind" | "providerInstanceId" | "providerPrefix" | "displayName" | "disabled" | "status"
>;

export interface ProviderSettingsTargetDirectoryOptions {
	/** Read the live saved settings, never the UI's editable draft. */
	getSettings?: () => TargetSettings;
	/** Production uses the actual registry; tests can inject an independently registered one. */
	listPluginProviders?: () => readonly PluginTargetIdentity[];
	/** Uses only exact lookup / identity pages / pool identity, never snapshot or credentials. */
	getCodexManager?: () => ProviderSettingsCodexReader;
	/** Reads the real settings/CLI singleton. A token may enter here but never exits the DTO. */
	getCommandCodeAuth?: (apiKey?: string) => CommandCodeAuthState;
}

export type ProviderSettingsTargetFailure =
	| "invalid"
	| "not-found"
	| "ambiguous"
	| "source-unavailable"
	| "limit-exceeded";

export type ProviderSettingsTargetResolution =
	| {
			readonly status: "resolved" | "disabled" | "unavailable";
			readonly target: ProviderSettingsTarget;
	  }
	| { readonly status: ProviderSettingsTargetFailure };

interface TargetIndex {
	byId: Map<string, ProviderSettingsTarget | ProviderSettingsTargetFailure>;
}

class TargetSourceError extends Error {
	constructor(readonly status: "source-unavailable" | "limit-exceeded") {
		super("Provider settings target source is unavailable");
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Ignore inherited properties and accessors; a projection must not run user callbacks. */
function own(value: unknown, key: string): unknown {
	if (!record(value)) return undefined;
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function containsControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code < 32 || (code >= 127 && code <= 159)) return true;
	}
	return false;
}

function validId(value: unknown, maxChars = MAX_TARGET_ID_CHARS): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxChars &&
		value === value.trim() &&
		!containsControlCharacter(value) &&
		!FORBIDDEN_IDS.has(value)
	);
}

function codexInstanceId(value: unknown): value is string {
	return validId(value, MAX_SAVED_ID_CHARS) && /^[A-Za-z0-9_-]+$/.test(value);
}

export function codexProviderSettingsTargetId(credentialId: string): string {
	if (!codexInstanceId(credentialId)) {
		throw new AppError("Invalid Codex provider settings identity", 400, "INVALID_PROVIDER_TARGET");
	}
	return `codex:credential:${credentialId}`;
}

function platformKind(id: string): ProviderSettingsPlatformKind | undefined {
	if (id === PROVIDER_SETTINGS_SINGLETON_IDS.codex) return "codex";
	if (id === PROVIDER_SETTINGS_SINGLETON_IDS.commandcode) return "commandcode";
	if (id === PROVIDER_SETTINGS_SINGLETON_IDS.tokendance) return "tokendance";
	if (id.startsWith("codex:credential:") && codexInstanceId(id.slice("codex:credential:".length)))
		return "codex";
	return undefined;
}

function safeName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const bounded = value.slice(0, MAX_TARGET_NAME_CHARS);
	const trimmed = bounded.trim();
	if (
		!trimmed ||
		containsControlCharacter(bounded) ||
		trimmed.startsWith("{") ||
		trimmed.startsWith("[")
	) {
		return fallback;
	}
	return bounded;
}

function target(
	kind: ProviderSettingsTargetKind,
	id: string,
	name: unknown,
	disabled: boolean,
	available = !disabled,
): ProviderSettingsTarget {
	return Object.freeze({ kind, id, name: safeName(name, id), disabled, available });
}

function sourceArray(value: unknown): readonly unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new TargetSourceError("source-unavailable");
	if (value.length > MAX_PROVIDER_SETTINGS_TARGETS) throw new TargetSourceError("limit-exceeded");
	return value;
}

function optionalDisabled(value: unknown): boolean | undefined {
	if (value === undefined) return false;
	return typeof value === "boolean" ? value : undefined;
}

function disabledPrefixes(saved: unknown): Set<string> {
	const value = own(own(saved, "agent"), "disabledProviders");
	const prefixes = sourceArray(value);
	if (prefixes.some((prefix) => !validId(prefix))) {
		throw new TargetSourceError("source-unavailable");
	}
	return new Set(prefixes as string[]);
}

function add(index: TargetIndex, id: string, value: ProviderSettingsTarget | undefined): void {
	if (index.byId.has(id)) {
		index.byId.set(id, "ambiguous");
		return;
	}
	index.byId.set(id, value ?? "source-unavailable");
}

function addSavedProviders(
	index: TargetIndex,
	kind: "custom-api" | "nug",
	providers: unknown,
	disabled: ReadonlySet<string>,
): void {
	for (const provider of sourceArray(providers)) {
		const id = own(provider, "id");
		if (!validId(id, MAX_SAVED_ID_CHARS)) continue;
		const ownDisabled = optionalDisabled(own(provider, "disabled"));
		const prefix = own(provider, "prefix");
		add(
			index,
			id,
			ownDisabled === undefined
				? undefined
				: target(
						kind,
						id,
						own(provider, "name"),
						ownDisabled || (typeof prefix === "string" && disabled.has(prefix)),
					),
		);
	}
}

/**
 * Independent source reads are intentional: a broken plugin/platform cannot turn a valid
 * custom-api or nug identity into a missing target. Resolution validates before any read.
 * Authentication, contribution ownership and connection issuance belong to the caller.
 */
export class ProviderSettingsTargetDirectory {
	private readonly getSettings: () => TargetSettings;
	private readonly listPluginProviders: () => readonly PluginTargetIdentity[];
	private readonly getCodexManager: () => ProviderSettingsCodexReader;
	private readonly getCommandCodeAuth: (apiKey?: string) => CommandCodeAuthState;

	constructor(options: ProviderSettingsTargetDirectoryOptions = {}) {
		this.getSettings = options.getSettings ?? (() => settings);
		this.listPluginProviders = options.listPluginProviders ?? (() => pluginProviderRegistry.list());
		this.getCodexManager = options.getCodexManager ?? getCodexManager;
		this.getCommandCodeAuth = options.getCommandCodeAuth ?? resolveCommandCodeToken;
	}

	/**
	 * Lists only unique, valid saved identities, including disabled/unavailable ones.
	 * Malformed/duplicate records are omitted; resolving such an id still fails closed.
	 * Failed or over-budget sources throw a fixed, credential-free error, never an empty success.
	 */
	list(kind: ProviderSettingsTargetKind): readonly ProviderSettingsTarget[] {
		const parsed = providerSettingsTargetKindSchema.safeParse(kind);
		if (!parsed.success) {
			throw new AppError("Invalid provider settings target kind", 400, "INVALID_PROVIDER_TARGET");
		}
		let index: TargetIndex;
		try {
			index = this.collect(parsed.data);
		} catch (error) {
			throw new AppError(
				"Provider settings targets are unavailable",
				503,
				error instanceof TargetSourceError && error.status === "limit-exceeded"
					? "PROVIDER_TARGET_LIMIT_EXCEEDED"
					: "PROVIDER_TARGET_SOURCE_UNAVAILABLE",
			);
		}
		const targets = [...index.byId.values()].filter(
			(value): value is ProviderSettingsTarget => typeof value !== "string",
		);
		if (targets.length > MAX_PROVIDER_SETTINGS_TARGETS) {
			throw new AppError(
				"Provider settings target limit exceeded",
				503,
				"PROVIDER_TARGET_LIMIT_EXCEEDED",
			);
		}
		if (Buffer.byteLength(JSON.stringify(targets)) > MAX_TARGET_LIST_BYTES) {
			throw new AppError(
				"Provider settings target limit exceeded",
				503,
				"PROVIDER_TARGET_LIMIT_EXCEEDED",
			);
		}
		return Object.freeze(targets);
	}

	resolve(kind: unknown, id: unknown): ProviderSettingsTargetResolution {
		const parsed = providerSettingsTargetKindSchema.safeParse(kind);
		if (!parsed.success || !validId(id)) return { status: "invalid" };
		if (
			(parsed.data === "custom-api" || parsed.data === "nug") &&
			!validId(id, MAX_SAVED_ID_CHARS)
		) {
			return { status: "invalid" };
		}
		const platform = parsed.data === "platform" ? platformKind(id) : undefined;
		if (parsed.data === "platform" && !platform) return { status: "invalid" };
		let index: TargetIndex;
		try {
			index = this.collect(parsed.data, platform, id);
		} catch (error) {
			return {
				status: error instanceof TargetSourceError ? error.status : "source-unavailable",
			};
		}
		const match = index.byId.get(id);
		if (!match) return { status: "not-found" };
		if (typeof match === "string") return { status: match };
		return {
			status: match.disabled ? "disabled" : match.available ? "resolved" : "unavailable",
			target: match,
		};
	}

	private collect(
		kind: ProviderSettingsTargetKind,
		platform?: ProviderSettingsPlatformKind,
		id?: string,
	): TargetIndex {
		const saved = this.getSettings();
		if (!record(saved)) throw new TargetSourceError("source-unavailable");
		const disabled = disabledPrefixes(saved);
		const index: TargetIndex = { byId: new Map() };
		if (kind === "custom-api" || kind === "nug") {
			// Legacy protocol arrays are derived aliases, not additional saved targets. Even an
			// empty canonical array is authoritative; no prefix/name/legacy-array fallback.
			addSavedProviders(
				index,
				kind,
				own(saved, kind === "custom-api" ? "customApiProviders" : "nugProviders"),
				disabled,
			);
		} else if (kind === "executable-plugin") {
			for (const entry of sourceArray(this.listPluginProviders())) {
				if (own(entry, "kind") !== "executable-plugin") continue;
				const id = own(entry, "providerInstanceId");
				if (!validId(id)) continue;
				const ownDisabled = optionalDisabled(own(entry, "disabled"));
				const status = own(entry, "status");
				const prefix = own(entry, "providerPrefix");
				const isDisabled =
					ownDisabled === true || (typeof prefix === "string" && disabled.has(prefix));
				add(
					index,
					id,
					ownDisabled === undefined || (status !== "available" && status !== "unavailable")
						? undefined
						: target(
								kind,
								id,
								own(entry, "displayName"),
								isDisabled,
								!isDisabled && status === "available",
							),
				);
			}
		} else {
			if (!platform || platform === "codex") this.addCodex(index, disabled, id);
			if (!platform || platform === "commandcode") this.addCommandCode(index, saved, disabled);
			if (!platform || platform === "tokendance") this.addTokenDance(index, saved, disabled);
		}
		return index;
	}

	private addCodex(index: TargetIndex, disabled: ReadonlySet<string>, id?: string): void {
		const manager = this.getCodexManager();
		if (!id || id === PROVIDER_SETTINGS_SINGLETON_IDS.codex) {
			const pool = manager.getProviderSettingsPoolIdentity();
			if (pool.status !== "ok") {
				if (pool.status === "ambiguous")
					index.byId.set(PROVIDER_SETTINGS_SINGLETON_IDS.codex, "ambiguous");
				else
					throw new TargetSourceError(
						pool.status === "limit-exceeded" ? pool.status : "source-unavailable",
					);
			} else if (
				typeof pool.exists !== "boolean" ||
				typeof pool.available !== "boolean" ||
				(!pool.exists && pool.available)
			) {
				throw new TargetSourceError("source-unavailable");
			} else if (pool.exists) {
				add(
					index,
					PROVIDER_SETTINGS_SINGLETON_IDS.codex,
					target(
						"platform",
						PROVIDER_SETTINGS_SINGLETON_IDS.codex,
						"Codex",
						disabled.has("codex"),
						!disabled.has("codex") && pool.available,
					),
				);
			}
			if (id) return;
		}
		if (id) {
			const instanceId = id.slice("codex:credential:".length);
			const match = manager.getProviderSettingsIdentity(instanceId);
			if (match.status === "found") {
				if (own(match.identity, "id") !== instanceId)
					throw new TargetSourceError("source-unavailable");
				this.addCodexCredential(index, match.identity, disabled);
			} else if (match.status !== "not-found") {
				index.byId.set(id, match.status === "invalid" ? "source-unavailable" : match.status);
			}
			return;
		}
		let offset = 0;
		let count = 0;
		for (;;) {
			const page = manager.listProviderSettingsIdentities({
				offset,
				limit: MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE,
			});
			if (page.status !== "ok")
				throw new TargetSourceError(
					page.status === "limit-exceeded" ? page.status : "source-unavailable",
				);
			const identities = sourceArray(page.identities);
			if (identities.length > MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE)
				throw new TargetSourceError("source-unavailable");
			count += identities.length;
			if (
				count + Number(index.byId.has(PROVIDER_SETTINGS_SINGLETON_IDS.codex)) >
				MAX_PROVIDER_SETTINGS_TARGETS
			) {
				throw new TargetSourceError("limit-exceeded");
			}
			for (const identity of identities) this.addCodexCredential(index, identity, disabled);
			if (page.nextOffset === null) return;
			if (
				!Number.isSafeInteger(page.nextOffset) ||
				identities.length === 0 ||
				page.nextOffset !== offset + identities.length
			) {
				throw new TargetSourceError("source-unavailable");
			}
			offset = page.nextOffset;
		}
	}

	private addCodexCredential(
		index: TargetIndex,
		credential: unknown,
		disabled: ReadonlySet<string>,
	): void {
		const instanceId = own(credential, "id");
		if (!codexInstanceId(instanceId)) throw new TargetSourceError("source-unavailable");
		const id = codexProviderSettingsTargetId(instanceId);
		const ownDisabled = optionalDisabled(own(credential, "disabled"));
		const archivedAt = own(credential, "archivedAt");
		const validArchive =
			archivedAt === undefined ||
			(typeof archivedAt === "number" && Number.isFinite(archivedAt) && archivedAt >= 0);
		const isDisabled = ownDisabled === true || disabled.has("codex");
		add(
			index,
			id,
			ownDisabled === undefined || !validArchive
				? undefined
				: target(
						"platform",
						id,
						own(credential, "displayName"),
						isDisabled,
						!isDisabled && !(typeof archivedAt === "number" && archivedAt > 0),
					),
		);
	}

	private addCommandCode(index: TargetIndex, saved: unknown, disabled: ReadonlySet<string>): void {
		const config = own(saved, "commandCode");
		const apiKey = own(config, "apiKey");
		if (apiKey !== undefined && typeof apiKey !== "string")
			throw new TargetSourceError("source-unavailable");
		const auth = this.getCommandCodeAuth(apiKey as string | undefined);
		if (own(auth, "reason") === "read_failed") throw new TargetSourceError("source-unavailable");
		const token = own(own(auth, "credential"), "token");
		if (typeof token !== "string" || !token.trim()) return;
		const ownDisabled = optionalDisabled(own(config, "disabled"));
		add(
			index,
			PROVIDER_SETTINGS_SINGLETON_IDS.commandcode,
			ownDisabled === undefined
				? undefined
				: target(
						"platform",
						PROVIDER_SETTINGS_SINGLETON_IDS.commandcode,
						"Command Code",
						ownDisabled || disabled.has("CommandCode"),
					),
		);
	}

	private addTokenDance(index: TargetIndex, saved: unknown, disabled: ReadonlySet<string>): void {
		const config = own(saved, "tokendance");
		const apiKey = own(config, "apiKey");
		if (apiKey !== undefined && typeof apiKey !== "string")
			throw new TargetSourceError("source-unavailable");
		if (typeof apiKey !== "string" || !apiKey.trim()) return;
		const ownDisabled = optionalDisabled(own(config, "disabled"));
		add(
			index,
			PROVIDER_SETTINGS_SINGLETON_IDS.tokendance,
			ownDisabled === undefined
				? undefined
				: target(
						"platform",
						PROVIDER_SETTINGS_SINGLETON_IDS.tokendance,
						"TokenDance",
						ownDisabled || disabled.has("tokendance"),
					),
		);
	}
}

export const providerSettingsTargets = new ProviderSettingsTargetDirectory();

export function resolveProviderSettingsTarget(
	kind: unknown,
	id: unknown,
): ProviderSettingsTargetResolution {
	return providerSettingsTargets.resolve(kind, id);
}

export function listProviderSettingsTargets(
	kind: ProviderSettingsTargetKind,
): readonly ProviderSettingsTarget[] {
	return providerSettingsTargets.list(kind);
}
