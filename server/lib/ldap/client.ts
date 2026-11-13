/**
 * LDAP client — the only place that talks to a directory server.
 *
 * Two connection modes, both ending in a simple bind as the *user* (never as the
 * service account) so the directory itself decides whether the password is right:
 *
 * - `search` (default): bind the service account (or stay anonymous), locate the
 *   person's DN with a filter, then bind as that DN with the submitted password.
 *   This is what OpenLDAP / Active Directory deployments normally need, because
 *   users are not at a predictable DN.
 * - `direct`: render `bindDnTemplate` (a DN or a UPN) with the login name and bind
 *   as it. Cheaper — one round trip — and enough when accounts sit at a fixed
 *   pattern such as `uid=<name>,ou=people,dc=example,dc=com` or `<name>@corp`.
 *
 * Every operation is bounded by the configured connect/operation timeouts, every
 * client is unbound in a `finally`, and search results are capped at two entries so a
 * broad filter can never stream a directory worth of data into the process.
 */
import { Client, type Entry, InvalidCredentialsError, ResultCodeError } from "ldapts";
import type { LdapSettings } from "../settings/types";
import {
	describeLdapConfigProblem,
	LDAP_DEFAULT_CONNECT_TIMEOUT_MS,
	LDAP_DEFAULT_DISPLAY_NAME_ATTRIBUTE,
	LDAP_DEFAULT_EMAIL_ATTRIBUTE,
	LDAP_DEFAULT_SEARCH_FILTER,
	LDAP_DEFAULT_SEARCH_SCOPE,
	LDAP_DEFAULT_TIMEOUT_MS,
	LDAP_DEFAULT_USERNAME_ATTRIBUTE,
	normalizeLdapUsername,
	renderFilterTemplate,
	renderUsernameTemplate,
} from "./protocol";

/** What a successful directory bind tells us about the account. */
export interface LdapDirectoryEntry {
	/** The entry's DN as the directory reported it (or the rendered bind DN). */
	dn: string;
	/**
	 * Stable identity key: the lower-cased directory login name.
	 *
	 * Lower-cased on purpose — directory account names are matched case-insensitively,
	 * so typing `Alice` and `alice` must resolve to the same bound account. The cost is
	 * that renaming an account in the directory orphans its binding; the operator
	 * re-binds by logging in with the new name.
	 */
	id: string;
	email?: string;
	displayName?: string;
}

/**
 * The result of checking a password against the directory.
 *
 * `invalid` and `unavailable` are kept apart deliberately: a wrong password is the
 * user's problem (401), a directory that cannot be reached is the deployment's (503).
 * Reporting the second as the first sends people hunting for a password they know.
 */
export type LdapAuthOutcome =
	| { kind: "ok"; entry: LdapDirectoryEntry }
	| { kind: "invalid" }
	| { kind: "unavailable"; reason: string };

/** Where a connection probe stopped. Drives the admin "test connection" message. */
export type LdapProbeStage = "config" | "connect" | "service_bind" | "search" | "user_bind" | "ok";

export interface LdapProbeResult {
	stage: LdapProbeStage;
	ok: boolean;
	/** Human-readable, credential-free explanation. Never contains a password or a stack. */
	message: string;
	/** Present when a test account's credentials were verified end to end. */
	user?: LdapDirectoryEntry;
}

/** The seam the auth service depends on, so tests never need a real directory. */
export interface LdapAuthClient {
	authenticate(username: string, password: string): Promise<LdapAuthOutcome>;
	probe(input: { username?: string; password?: string }): Promise<LdapProbeResult>;
	close(): Promise<void>;
}

export type LdapClientFactory = (settings: LdapSettings) => LdapAuthClient;

/** A failure the directory itself reported (as opposed to a socket/TLS failure). */
function isServerResponse(error: unknown): boolean {
	return error instanceof ResultCodeError;
}

/** Whether a failure is the directory refusing the credentials. */
function isInvalidCredentials(error: unknown): boolean {
	if (error instanceof InvalidCredentialsError) return true;
	return isServerResponse(error) && (error as ResultCodeError).code === 49;
}

/** Render a failure for a log line or the admin probe: no stack, no credentials. */
function describeError(error: unknown): string {
	if (error instanceof ResultCodeError) return `resultCode ${error.code}: ${error.message}`;
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Read an attribute value case-insensitively, ignoring LDAP attribute options (`;lang-en`). */
function attributeValue(entry: Entry, name: string): string | undefined {
	const target = name.toLowerCase();
	for (const key of Object.keys(entry)) {
		const base = key.split(";")[0]?.trim().toLowerCase();
		if (base !== target) continue;
		const raw = entry[key];
		if (typeof raw === "string") return raw;
		if (Buffer.isBuffer(raw)) return raw.toString("utf8");
		if (Array.isArray(raw)) {
			const first = raw.find((value) => typeof value === "string");
			return typeof first === "string" ? first : undefined;
		}
	}
	return undefined;
}

export function createLdapClient(settings: LdapSettings): LdapAuthClient {
	const url = settings.url.trim();
	const secure = url.toLowerCase().startsWith("ldaps://");
	const rejectUnauthorized = settings.tlsRejectUnauthorized !== false;
	const mode = settings.mode ?? "search";
	const usernameAttribute = settings.usernameAttribute?.trim() || LDAP_DEFAULT_USERNAME_ATTRIBUTE;
	const emailAttribute = settings.emailAttribute?.trim() || LDAP_DEFAULT_EMAIL_ATTRIBUTE;
	const displayNameAttribute =
		settings.displayNameAttribute?.trim() || LDAP_DEFAULT_DISPLAY_NAME_ATTRIBUTE;
	const attributes = [...new Set([usernameAttribute, emailAttribute, displayNameAttribute])];
	const searchBase = settings.searchBase?.trim() ?? "";
	const serviceDn = settings.bindDn?.trim() ?? "";
	const searchFilter = settings.searchFilter?.trim() || LDAP_DEFAULT_SEARCH_FILTER;
	const bindDnTemplate = settings.bindDnTemplate?.trim() ?? "";

	function newClient(): Client {
		return new Client({
			url,
			timeout: settings.timeoutMs ?? LDAP_DEFAULT_TIMEOUT_MS,
			connectTimeout: settings.connectTimeoutMs ?? LDAP_DEFAULT_CONNECT_TIMEOUT_MS,
			tlsOptions: { rejectUnauthorized },
		});
	}

	async function safeUnbind(client: Client): Promise<void> {
		try {
			await client.unbind();
		} catch {
			// The socket is gone either way. A failed unbind must not replace the
			// outcome we are about to report.
		}
	}

	/** Open a connection (upgrading to StartTLS first when asked), run `fn`, then unbind. */
	async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
		const client = newClient();
		try {
			// `startTLS` opens the socket itself; binding before the upgrade would send
			// the service password in the clear.
			if (!secure && settings.startTls) await client.startTLS({ rejectUnauthorized });
			return await fn(client);
		} finally {
			await safeUnbind(client);
		}
	}

	function toDirectoryEntry(entry: Entry, fallbackId: string): LdapDirectoryEntry {
		const id = (attributeValue(entry, usernameAttribute) ?? fallbackId).trim().toLowerCase();
		return {
			dn: entry.dn,
			id,
			email: attributeValue(entry, emailAttribute)?.trim() || undefined,
			displayName: attributeValue(entry, displayNameAttribute)?.trim() || undefined,
		};
	}

	async function authenticateSearchMode(
		username: string,
		password: string,
	): Promise<LdapAuthOutcome> {
		let stage: LdapProbeStage = "service_bind";
		try {
			return await withClient(async (client) => {
				// An empty service DN means anonymous search: no bind is issued at all, so
				// a directory that forbids anonymous binds fails here as `unavailable`
				// rather than silently falling through to a bind that could never work.
				if (serviceDn) await client.bind(serviceDn, settings.bindPassword ?? "");

				stage = "search";
				const result = await client.search(searchBase, {
					scope: settings.searchScope ?? LDAP_DEFAULT_SEARCH_SCOPE,
					filter: renderFilterTemplate(searchFilter, username),
					sizeLimit: 2,
					attributes,
				});
				const entries = result.searchEntries ?? [];
				if (entries.length === 0) return { kind: "invalid" };
				// Two matches means the filter describes more than one person; picking
				// either would be a guess about who is logging in.
				if (entries.length > 1) return { kind: "unavailable", reason: "AMBIGUOUS_SEARCH_RESULT" };

				const found = entries[0] as Entry;
				stage = "user_bind";
				try {
					await client.bind(found.dn, password);
				} catch (error) {
					if (isInvalidCredentials(error)) return { kind: "invalid" };
					throw error;
				}
				return { kind: "ok", entry: toDirectoryEntry(found, username) };
			});
		} catch (error) {
			return { kind: "unavailable", reason: `${stage}: ${describeError(error)}` };
		}
	}

	async function authenticateDirectMode(
		username: string,
		password: string,
	): Promise<LdapAuthOutcome> {
		let dn: string;
		try {
			dn = renderUsernameTemplate(bindDnTemplate, username);
		} catch (error) {
			return { kind: "unavailable", reason: describeError(error) };
		}
		try {
			return await withClient(async (client) => {
				try {
					await client.bind(dn, password);
				} catch (error) {
					if (isInvalidCredentials(error)) return { kind: "invalid" };
					throw error;
				}
				// The password is proven at this point. Attribute lookup is best effort:
				// a directory that hides an entry from the account itself must not turn
				// a valid login into a failure.
				try {
					const result = await client.search(dn, {
						scope: "base",
						filter: "(objectClass=*)",
						sizeLimit: 1,
						attributes,
					});
					const found = (result.searchEntries ?? [])[0] as Entry | undefined;
					if (found) return { kind: "ok", entry: toDirectoryEntry(found, username) };
				} catch {
					// Fall through to the minimal entry.
				}
				return { kind: "ok", entry: { dn, id: username.toLowerCase() } };
			});
		} catch (error) {
			return { kind: "unavailable", reason: describeError(error) };
		}
	}

	/**
	 * Structural checks: connect (plus StartTLS), bind the service account, and run a
	 * base search. Stops at the first failure and names the stage it reached.
	 *
	 * Kept apart from `authenticate` so the admin probe reports *where* a
	 * misconfiguration lives instead of the single "unavailable" the login path shows.
	 */
	async function probeConnection(): Promise<
		{ ok: true } | { ok: false; stage: LdapProbeStage; message: string }
	> {
		const client = newClient();
		try {
			if (!secure && settings.startTls) {
				try {
					await client.startTLS({ rejectUnauthorized });
				} catch (error) {
					return { ok: false, stage: "connect", message: describeError(error) };
				}
			}
			if (serviceDn) {
				try {
					await client.bind(serviceDn, settings.bindPassword ?? "");
				} catch (error) {
					return { ok: false, stage: "service_bind", message: describeError(error) };
				}
			}
			if (mode === "search") {
				try {
					// Also forces the socket open when no service bind was issued.
					await client.search(searchBase, {
						scope: settings.searchScope ?? LDAP_DEFAULT_SEARCH_SCOPE,
						filter: "(objectClass=*)",
						sizeLimit: 1,
						attributes: [usernameAttribute],
					});
				} catch (error) {
					return {
						ok: false,
						stage: isServerResponse(error) ? "search" : "connect",
						message: describeError(error),
					};
				}
			}
			return { ok: true };
		} finally {
			await safeUnbind(client);
		}
	}

	async function authenticate(rawUsername: string, password: string): Promise<LdapAuthOutcome> {
		const username = normalizeLdapUsername(rawUsername);
		// A non-empty DN with an EMPTY password is an *unauthenticated* bind, which
		// several servers answer with success. Refuse before touching the network.
		if (!username || !password) return { kind: "invalid" };
		return mode === "direct"
			? authenticateDirectMode(username, password)
			: authenticateSearchMode(username, password);
	}

	return {
		authenticate,

		async probe(input): Promise<LdapProbeResult> {
			// `ignoreEnabled`: the admin tests settings in order to decide whether to turn
			// LDAP on, so the switch must not be what the probe complains about.
			const problem = describeLdapConfigProblem(settings, { ignoreEnabled: true });
			if (problem) return { stage: "config", ok: false, message: problem };

			const structural = await probeConnection();
			if (!structural.ok) {
				return { stage: structural.stage, ok: false, message: structural.message };
			}

			const username = normalizeLdapUsername(input.username);
			if (!username || !input.password) {
				return {
					stage: "ok",
					ok: true,
					message:
						"Connected, and the base search succeeded. Add a test account to verify the full login path.",
				};
			}

			const outcome = await authenticate(username, input.password);
			if (outcome.kind === "ok") {
				return {
					stage: "ok",
					ok: true,
					message: "Directory login verified.",
					user: outcome.entry,
				};
			}
			if (outcome.kind === "invalid") {
				return {
					stage: "user_bind",
					ok: false,
					message: "The directory rejected this account name or password.",
				};
			}
			return { stage: "user_bind", ok: false, message: outcome.reason };
		},

		async close(): Promise<void> {
			// Each operation unbinds its own connection, so there is nothing held open.
			// The method exists so a caller can treat the client as a resource.
		},
	};
}
