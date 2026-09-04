/**
 * The `handler: "server"` commands — everything the settings view can do.
 *
 * ## Credentials come from the vault, not from the input
 *
 * Every command that needs a credential reads it with `secrets.get` (through
 * `credentials.ts`). This is not a stylistic preference: `commands.invoke` carries only
 * `{contributionId, input, context}` and the iframe's `commands.execute` params are a
 * `.strict()` object with no config field, so there is no path by which the host could supply
 * test passes config by hand and so never catches it.
 *
 * ## How a change is persisted
 *
 * A mutating command returns `secretWrites`, which the host validates against the
 * `provider.<contributionId>.*` namespace it derives from the plugin's own registered
 * contributions (`plugin-command-secret-writes.ts`) before applying. The plugin proposes; the
 * host decides.
 *
 * One exception, and it is forced: `auth.browser` returns before the browser callback arrives,
 * so there is no response left to carry a write. That path calls `secrets.set` directly when
 * the callback lands.
 *
 * ## What is never returned
 *
 * No command returns a token. `status` reports whether a credential exists and who it belongs
 * to, never its contents — command output reaches an iframe.
 */

import {
	AuthInputError,
	accountBaseFrom,
	type BrowserAuthAvailability,
	type ClineCredentials,
	DEFAULT_CHAT_BASE_URL,
	fetchBalance,
	fetchUserInfo,
	isTokenExpired,
	type PendingBrowserAuth,
	parseCallbackUrl,
	probeBrowserAuth,
	startBrowserAuth,
} from "./auth";
import {
	accessTokenFor,
	CREDENTIALS_KEY,
	clearCredentials,
	ENABLED_MODELS_KEY,
	loadCredentials,
	loadEnabledModels,
	requireCredentials,
	serializeCredentials,
	storeCredentials,
} from "./credentials";
import { activeProxyUrl } from "./host-hints";
import {
	cachedModelPool,
	fetchRecommendedModels,
	getModelPool,
	MAX_MODELS,
	searchPool,
} from "./models";
import { isRecord, log } from "./rpc";

/** A secret mutation the host should apply. `null` deletes the key. */
export interface CommandSecretWrite {
	key: string;
	value: string | null;
}

/**
 * A JSON value, as the host's `jsonValueSchema` understands it.
 *
 * Defined locally rather than imported: this plugin shares no module with the host, so the
 * shape is restated here and the host validates it again on receipt.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * A non-secret provider config mutation the host should persist. `null` clears the field.
 *
 * The host derives the writable namespace from what the plugin contributed and refuses keys
 * that name a *secret* field, so the two channels stay disjoint rather than overlapping.
 */
export interface CommandConfigWrite {
	key: string;
	value: JsonValue | null;
}

export interface CommandOutcome {
	output: unknown;
	secretWrites?: CommandSecretWrite[];
	/** Non-secret provider config the host should persist. */
	configWrites?: CommandConfigWrite[];
}

export class CommandInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandInputError";
	}
}

/**
 * Upper bound on stored model selections.
 *
 * Higher than {@link MAX_MODELS} on purpose: a user may keep a longer list than the catalog
 * will serve, and silently discarding the tail on save would lose a selection they can see in
 * the UI. The truncation happens at catalog time, where it is visible in the log.
 */
const MAX_STORED_MODELS = 200;

/** Per-entry length cap. A model id is well under this; anything longer is not one. */
const MAX_MODEL_ID_LENGTH = 200;

/** Matches the vault's own per-value ceiling, so an oversize list fails here with a clear reason. */
const MAX_SECRET_VALUE_BYTES = 64 * 1024;

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new CommandInputError(`${field} is required`);
	}
	return value.trim();
}

/**
 * The pending browser sign-in, if one is running.
 *
 * Module-level because it owns a bound port: the listener must be reachable from
 * `auth.cancel` and from `deactivate`/`shutdown`, none of which share a call stack with the
 * command that opened it. Leaving it only in a closure would keep the port bound for the rest
 * of the process lifetime with nothing able to close it.
 */
let pending: PendingBrowserAuth | undefined;

/** Close any pending sign-in. Called by `auth.cancel`, `deactivate` and `shutdown`. */
export function cancelPendingAuth(reason = "Sign-in cancelled"): boolean {
	if (!pending) return false;
	pending.cancel(reason);
	pending = undefined;
	return true;
}

export interface CommandContext {
	/** `config.baseUrl` when the caller knows it. Commands run without config, so usually absent. */
	chatBaseUrl?: string;
}

export type CommandHandler = (input: unknown, context: CommandContext) => Promise<CommandOutcome>;

/** The chat base URL to use. Commands have no injected config, so this is the default. */
function chatBase(context: CommandContext): string {
	return context.chatBaseUrl?.trim() || DEFAULT_CHAT_BASE_URL;
}

/**
 * Sign-in state, model counts and whether browser sign-in is usable.
 *
 * Reads the credential to report identity and expiry but never refreshes: `status` is polled
 * by the settings view, and a poll that could trigger an upstream token exchange would turn an
 * open settings page into recurring traffic.
 */
async function status(_input: unknown, context: CommandContext): Promise<CommandOutcome> {
	let credentials: ClineCredentials | undefined;
	let credentialError: string | undefined;
	try {
		credentials = await loadCredentials();
	} catch (error) {
		// A malformed credential is reported rather than thrown: the settings view must still
		// render, because signing out is how the user recovers from exactly this state.
		credentialError = error instanceof Error ? error.message : "Stored credentials are unreadable";
	}

	const enabledModels = await loadEnabledModels();
	const browserAuth: BrowserAuthAvailability = pending ? "port_busy" : probeBrowserAuth();

	return {
		output: {
			authenticated: credentials !== undefined,
			...(credentialError ? { credentialError } : {}),
			...(credentials?.email ? { email: credentials.email } : {}),
			...(credentials?.displayName ? { displayName: credentials.displayName } : {}),
			...(credentials ? { expiresAt: credentials.expiresAt } : {}),
			...(credentials ? { expired: isTokenExpired(credentials) } : {}),
			hasUserId: Boolean(credentials?.userId),
			enabledModelCount: enabledModels.length,
			enabledModels,
			poolModelCount: cachedModelPool().length,
			// Field name is `browserAuth` everywhere: the settings view reads this exact key.
			browserAuth,
			signInPending: pending !== undefined,
			// Re-reported on every poll so the view can show the URL again after a remount.
			// The panel is a plugin iframe whose session the host may rebuild at any time, and
			// the URL only ever came back in the `auth.browser` response — without this, a
			// remount mid-flow leaves a pending sign-in the user can no longer reach the
			// authorization page for, and the only way out is to wait five minutes for the
			// timeout. Not a credential: it is the page the user must visit to produce one.
			...(pending ? { authorizeUrl: pending.authorizeUrl } : {}),
			chatBaseUrl: chatBase(context),
		},
	};
}

/**
 * Start a browser sign-in and return the URL to open.
 *
 * Returns immediately; the callback arrives later and is persisted from the background
 * continuation. The settings view polls `status` to observe completion, which is the same
 * shape the built-in front end uses.
 */
async function authBrowser(_input: unknown, context: CommandContext): Promise<CommandOutcome> {
	// A second sign-in would fail to bind against the first. Replacing it is friendlier than
	// reporting a conflict the user cannot see the cause of.
	cancelPendingAuth("Superseded by a new sign-in");

	const flow = await startBrowserAuth(accountBaseFrom(chatBase(context)), activeProxyUrl());
	pending = flow;

	void flow.completion
		.then(async (credentials) => {
			await storeCredentials(credentials);
			log("browser sign-in completed");
		})
		.catch((error: unknown) => {
			log("browser sign-in did not complete", {
				error: error instanceof Error ? error.message : "unknown",
			});
		})
		.finally(() => {
			// Only clear if this flow is still the current one; a superseding flow owns the slot.
			if (pending === flow) pending = undefined;
		});

	return { output: { authorizeUrl: flow.authorizeUrl } };
}

async function authCancel(): Promise<CommandOutcome> {
	return { output: { cancelled: cancelPendingAuth() } };
}

/**
 * Import credentials from a pasted callback URL.
 *
 * The path that works without a reachable loopback listener, which is the only option under a
 * container runner and for a remote deployment.
 */
async function authCallback(input: unknown): Promise<CommandOutcome> {
	const callbackUrl = requireString(isRecord(input) ? input.callbackUrl : undefined, "callbackUrl");
	let credentials: ClineCredentials;
	try {
		credentials = parseCallbackUrl(callbackUrl);
	} catch (error) {
		// `AuthInputError` messages name the specific problem, so they are surfaced verbatim.
		if (error instanceof AuthInputError) throw new CommandInputError(error.message);
		throw error;
	}
	// A pasted URL means the browser flow is moot, and its listener should not stay bound.
	cancelPendingAuth("Credentials were imported from a pasted URL");
	return {
		output: {
			ok: true,
			email: credentials.email,
			displayName: credentials.displayName,
		},
		secretWrites: [{ key: CREDENTIALS_KEY, value: serializeCredentials(credentials) }],
	};
}

/**
 * Sign out.
 *
 * The model selection is deliberately kept: it is a preference, not part of the session, and
 * making the user rebuild it after every sign-out would be gratuitous.
 */
async function authLogout(): Promise<CommandOutcome> {
	cancelPendingAuth("Signed out");
	await clearCredentials().catch(() => undefined);
	return {
		output: { ok: true },
		secretWrites: [{ key: CREDENTIALS_KEY, value: null }],
	};
}

/**
 * Account balance, in micro-dollars.
 *
 * The endpoint is addressed by user id, which a fresh sign-in may not have yet (the callback
 * payload does not include it), so it is fetched and written back on first use.
 */
async function balance(_input: unknown, context: CommandContext): Promise<CommandOutcome> {
	const credentials = await requireCredentials();
	const base = chatBase(context);
	const proxyUrl = activeProxyUrl();
	const accountBase = accountBaseFrom(base);
	const accessToken = await accessTokenFor(credentials, base, proxyUrl);

	let userId = credentials.userId;
	const writes: CommandSecretWrite[] = [];
	if (!userId) {
		const info = await fetchUserInfo(accessToken, accountBase, proxyUrl);
		if (!info?.id) {
			throw new Error("Cline did not return a user id, so the balance cannot be fetched");
		}
		userId = info.id;
		const updated: ClineCredentials = {
			...credentials,
			accessToken,
			userId,
			...(info.email ? { email: info.email } : {}),
			...(info.displayName ? { displayName: info.displayName } : {}),
		};
		await storeCredentials(updated);
		writes.push({ key: CREDENTIALS_KEY, value: serializeCredentials(updated) });
	}

	const result = await fetchBalance(accessToken, userId, accountBase, proxyUrl);
	if (!result) throw new Error("Cline did not return a balance");
	return {
		output: { balance: result.balance, userId: result.userId },
		...(writes.length > 0 ? { secretWrites: writes } : {}),
	};
}

async function recommendedModels(
	_input: unknown,
	context: CommandContext,
): Promise<CommandOutcome> {
	const data = await fetchRecommendedModels(accountBaseFrom(chatBase(context)), activeProxyUrl());
	return { output: data };
}

async function modelsRefresh(): Promise<CommandOutcome> {
	const models = await getModelPool({ force: true, proxyUrl: activeProxyUrl() });
	return { output: { count: models.length } };
}

/**
 * Search the pool.
 *
 * Fetches the pool when nothing is cached, unlike `listModels`: a user typing in a search box
 * is waiting for an answer, so paying for the fetch is right here and wrong there.
 */
async function modelsSearch(input: unknown): Promise<CommandOutcome> {
	const query = isRecord(input) && typeof input.query === "string" ? input.query : "";
	const rawLimit = isRecord(input) ? input.limit : undefined;
	const limit =
		typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit > 0
			? Math.min(rawLimit, 200)
			: 50;
	const pool = await getModelPool({ proxyUrl: activeProxyUrl() });
	const { models, total } = searchPool(pool, query, limit);
	return { output: { models, total, poolSize: pool.length } };
}

/**
 * Replace the enabled-model list.
 *
 * Stored as a JSON array in a secret field so the host injects it back into provider calls;
 * see `credentials.ts` and the plugin's own doc for why a non-secret preference travels this
 * way.
 */
async function setEnabledModels(input: unknown): Promise<CommandOutcome> {
	const raw = isRecord(input) ? input.models : undefined;
	if (!Array.isArray(raw)) throw new CommandInputError("models must be an array");

	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== "string") {
			throw new CommandInputError("models must contain only strings");
		}
		const id = entry.trim();
		if (!id) continue;
		if (id.length > MAX_MODEL_ID_LENGTH) {
			throw new CommandInputError(`Model id is too long: ${id.slice(0, 40)}…`);
		}
		seen.add(id);
	}
	if (seen.size > MAX_STORED_MODELS) {
		throw new CommandInputError(`Too many models selected: ${seen.size} > ${MAX_STORED_MODELS}`);
	}

	const models = [...seen];
	const value = JSON.stringify(models);
	if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
		throw new CommandInputError("The model selection is too large to store");
	}

	return {
		output: {
			count: models.length,
			// Surfaced so the settings view can explain why a long selection shows fewer models
			// in the picker than were saved.
			servedToAgent: Math.min(models.length, MAX_MODELS),
			truncated: models.length > MAX_MODELS,
			// The write below goes through the host, which refreshes this provider's catalog after
			// applying it (`refreshCatalogsAfterCommandWrites`). Told to the view as metadata so it
			// can explain a briefly stale model picker without seeing the write itself.
			catalogSync: { requested: true },
		},
		secretWrites: [{ key: ENABLED_MODELS_KEY, value }],
	};
}

export const COMMAND_HANDLERS: Record<string, CommandHandler> = {
	status,
	"auth.browser": authBrowser,
	"auth.cancel": authCancel,
	"auth.callback": authCallback,
	"auth.logout": authLogout,
	balance,
	"recommended-models": recommendedModels,
	"models.refresh": modelsRefresh,
	"models.search": modelsSearch,
	"config.setEnabledModels": setEnabledModels,
};

export function findCommand(contributionId: string): CommandHandler | undefined {
	return COMMAND_HANDLERS[contributionId];
}
