/**
 * LDAP / Active Directory authentication service.
 *
 * The directory is a *credential provider*, not a second way to sign in: the ordinary
 * login form posts a username and password, the local account stays the authorization
 * record, and only a password that fails local verification is offered to the directory.
 * Everything downstream (role, session, MFA) is unchanged, which is why there is no
 * `ldap` login route and no new login form field.
 *
 * Account policy after the directory accepts the password (see `resolveLocalUser`):
 *  1. a bound identity (`user_identities.provider = "ldap:default"`) → sign in;
 *  2. no binding but a local account of the same name → bind it, and log the link;
 *  3. otherwise only `settings.auth.registrationOpen` decides: create an ordinary
 *     `user` account, or refuse with `LDAP_ACCOUNT_REQUIRED`.
 *
 * The client is injectable (`setLdapClientFactoryForTests`) so tests never need a real
 * directory, matching `setUploadsDirForTests` and `setAuthStores` elsewhere.
 */
import { db } from "@server/db";
import { userIdentities, users } from "@server/db/schema";
import { AppError } from "@server/lib/errors";
import {
	createLdapClient,
	type LdapAuthClient,
	type LdapAuthOutcome,
	type LdapClientFactory,
	type LdapDirectoryEntry,
	type LdapProbeResult,
} from "@server/lib/ldap/client";
import {
	describeLdapConfigProblem,
	LDAP_PROVIDER_ID,
	normalizeLdapUsername,
	sanitizeDerivedUsername,
} from "@server/lib/ldap/protocol";
import { logger } from "@server/lib/logger";
import { settings } from "@server/lib/settings";
import type { LdapSettings } from "@server/lib/settings/types";
import { and, eq, sql } from "drizzle-orm";
import { type ExternalLoginOutcome, ssoService } from "./sso-service";

let clientFactory: LdapClientFactory = createLdapClient;

/** Tests only: swap the directory client (pass undefined to restore the real one). */
export function setLdapClientFactoryForTests(factory: LdapClientFactory | undefined): void {
	clientFactory = factory ?? createLdapClient;
}

/** The stored directory configuration, whether or not it is usable. */
export function readLdapSettings(): LdapSettings | undefined {
	return settings.auth.ldap;
}

/**
 * Whether directory logins are actually available right now.
 *
 * A configuration that is switched on but not structurally complete does not count:
 * falling back to a half-configured directory would turn every wrong password into a
 * 503 and make local logins look broken.
 */
export function isLdapEnabled(): boolean {
	const config = readLdapSettings();
	if (!config) return false;
	return describeLdapConfigProblem(config) === null;
}

/**
 * Check a password against the directory.
 *
 * Never throws: `unavailable` carries the reason for the log, while the caller decides
 * how to answer the client. An empty password is `invalid` without any network call —
 * see `createLdapClient`.
 */
export async function authenticate(
	rawUsername: string,
	password: string,
): Promise<LdapAuthOutcome> {
	const config = readLdapSettings();
	if (!config || !isLdapEnabled()) {
		return { kind: "unavailable", reason: "LDAP_NOT_CONFIGURED" };
	}
	const username = normalizeLdapUsername(rawUsername);
	if (!username || !password) return { kind: "invalid" };

	let client: LdapAuthClient | undefined;
	try {
		client = clientFactory(config);
		return await client.authenticate(username, password);
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			await client?.close();
		} catch {
			// Closing is best effort; the outcome is already decided.
		}
	}
}

/** Find a local account whose username matches a directory name, ignoring case. */
async function findLocalUserByName(name: string): Promise<{ id: string } | undefined> {
	const lower = name.trim().toLowerCase();
	if (!lower) return undefined;
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(sql`lower(${users.username}) = ${lower}`)
		.limit(1);
	return rows[0];
}

/**
 * Map a directory entry to a local user id, per the policy in the module header.
 *
 * Throws `LDAP_ACCOUNT_REQUIRED` when the directory authenticated the person but the
 * instance has no account for them and registration is closed — a 403 the UI turns into
 * "ask an administrator", not a 401 that suggests a wrong password.
 */
export async function resolveLocalUser(
	entry: LdapDirectoryEntry,
): Promise<{ userId: string; outcome: ExternalLoginOutcome }> {
	const derived = sanitizeDerivedUsername(entry.id);
	const resolved = await ssoService.resolveExternalLogin({
		provider: LDAP_PROVIDER_ID,
		subject: entry.id,
		email: entry.email ?? null,
		displayName: entry.displayName ?? null,
		preferredUsername: derived,
		chooseAccount: async () => {
			// Nobody is bound to this directory subject yet. A local account carrying the
			// same name IS this person's account, so bind it rather than creating a
			// duplicate; the caller logs the link so the privilege that implies stays
			// auditable.
			for (const name of [...new Set([derived, entry.id])]) {
				const matched = await findLocalUserByName(name);
				if (matched) return matched.id;
			}
			if (!settings.auth.registrationOpen) {
				throw new AppError(
					"The directory accepted these credentials, but no account exists for them on this instance and registration is closed. Ask an administrator to create one.",
					403,
					"LDAP_ACCOUNT_REQUIRED",
				);
			}
			return null;
		},
	});

	if (resolved.outcome === "linked_existing_account") {
		logger.info("LDAP identity linked to an existing local account", {
			userId: resolved.userId,
			directorySubject: entry.id,
		});
	}
	return resolved;
}

/**
 * Re-check a password against the directory for a user who already has a binding.
 *
 * Used by step-up verification: a directory-only account has no local password to prove,
 * so without this the export-credentials flow would be closed to it entirely.
 */
export async function verifyLinkedUserPassword(userId: string, password: string): Promise<boolean> {
	if (!isLdapEnabled()) return false;
	const identity = await db.query.userIdentities.findFirst({
		where: and(eq(userIdentities.userId, userId), eq(userIdentities.provider, LDAP_PROVIDER_ID)),
		columns: { subject: true },
	});
	if (!identity) return false;
	const outcome = await authenticate(identity.subject, password);
	return outcome.kind === "ok";
}

/**
 * Admin diagnostic: how far does this configuration get?
 *
 * `config` is an unsaved form value when the admin is testing before saving; its
 * `enabled` switch is ignored on purpose (testing is how one decides to flip it).
 */
export async function probe(input: {
	config?: LdapSettings;
	username?: string;
	password?: string;
}): Promise<LdapProbeResult> {
	const config = input.config ?? readLdapSettings();
	if (!config) {
		return { stage: "config", ok: false, message: "No LDAP server is configured yet." };
	}

	let client: LdapAuthClient | undefined;
	try {
		client = clientFactory(config);
		return await client.probe({ username: input.username, password: input.password });
	} catch (error) {
		return {
			stage: "connect",
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		try {
			await client?.close();
		} catch {
			// Closing is best effort; the probe result is already decided.
		}
	}
}

export const ldapAuthService = {
	isEnabled: isLdapEnabled,
	authenticate,
	resolveLocalUser,
	verifyLinkedUserPassword,
	probe,
};
