/**
 * SSO service — links external identities to local users and provisions accounts.
 *
 * Identity model: each (provider, subject) pair in `user_identities` maps to one
 * local user. A user may link multiple providers. Login resolves the local user
 * from the verified subject; first-time logins may auto-provision a user when
 * the caller's admission policy allows it.
 *
 * The write path here (`resolveExternalLogin`) is shared with LDAP: creating an
 * account and binding an identity is a security-sensitive write, so it exists once
 * rather than growing a second, subtly-different implementation per protocol.
 */
import { randomBytes } from "node:crypto";
import { db } from "@server/db";
import { userIdentities, userPreferences, users } from "@server/db/schema";
import { randomAvatarColor } from "@server/lib/avatar-colors";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { LDAP_PROVIDER_PREFIX } from "@server/lib/ldap/protocol";
import type { OidcClaims } from "@server/lib/oidc";
import type { OidcProviderConfig } from "@server/lib/settings/types";
import { and, eq } from "drizzle-orm";

/** Derive a valid, available username from a raw candidate. */
async function deriveUniqueUsername(rawCandidate: string): Promise<string> {
	const raw = (rawCandidate || "user")
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "")
		.slice(0, 40);
	let base = raw.length >= 3 ? raw : `user-${raw}`.slice(0, 40);
	if (base.length < 3)
		base = `user${generateId(6)
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "")}`;

	// Probe for availability, appending a short suffix on collision.
	for (let attempt = 0; attempt < 8; attempt++) {
		const candidate = attempt === 0 ? base : `${base}-${generateId(4).toLowerCase()}`.slice(0, 50);
		const existing = await db.query.users.findFirst({
			where: eq(users.username, candidate),
			columns: { id: true },
		});
		if (!existing) return candidate;
	}
	// Extremely unlikely fallback.
	return `user-${generateId(10).toLowerCase()}`.slice(0, 50);
}

function emailDomainAllowed(provider: OidcProviderConfig, email: string | undefined): boolean {
	const domains = provider.allowedEmailDomains?.map((d) => d.trim().toLowerCase()).filter(Boolean);
	if (!domains || domains.length === 0) return true;
	if (!email) return false;
	const domain = email.split("@")[1]?.toLowerCase();
	return !!domain && domains.includes(domain);
}

export interface SsoIdentitySummary {
	id: string;
	provider: string;
	email: string | null;
	displayName: string | null;
	lastLoginAt: string | null;
	createdAt: string;
}

/** How a verified external identity resolved to a local account. */
export type ExternalLoginOutcome = "existing_identity" | "linked_existing_account" | "created";

export interface ExternalLoginInput {
	/** Stored in `user_identities.provider`. */
	provider: string;
	/** Stored in `user_identities.subject` — the provider's stable id for the person. */
	subject: string;
	email?: string | null;
	displayName?: string | null;
	/** Raw candidate for a newly created account's username (sanitized and de-duplicated). */
	preferredUsername?: string;
	/**
	 * Runs only when nothing is linked to this subject yet. Return a local user id to
	 * bind this identity to that existing account, or null to provision a new one.
	 * Throw an `AppError` to refuse the login outright.
	 *
	 * It is a callback, not a boolean, for an ordering reason that matters: an
	 * already-linked person is never re-admitted, so a provider's admission policy
	 * (domain allowlist, `allowSignup`, registration switch) must not be evaluated for
	 * them — otherwise tightening a policy would lock out everyone already linked.
	 */
	chooseAccount?: () => Promise<string | null> | string | null;
}

/**
 * Resolve (or provision) the local user for a verified external login, and bind the
 * identity on the way when the caller asks for it.
 *
 * This is the single implementation of "an external provider says who you are, now
 * here is your local account" — SSO and LDAP both come through it, so the account
 * creation rules (role, password hash, default preferences, identity row) cannot drift
 * apart between the two.
 */
async function resolveExternalLogin(
	input: ExternalLoginInput,
): Promise<{ userId: string; outcome: ExternalLoginOutcome }> {
	const subject = (input.subject ?? "").trim();
	if (!subject) throw new AppError("Identity subject is missing", 400, "SSO_SUBJECT_MISSING");

	const identity = await db.query.userIdentities.findFirst({
		where: and(eq(userIdentities.provider, input.provider), eq(userIdentities.subject, subject)),
	});

	if (identity) {
		await db
			.update(userIdentities)
			.set({ lastLoginAt: new Date().toISOString() })
			.where(eq(userIdentities.id, identity.id));
		return { userId: identity.userId, outcome: "existing_identity" };
	}

	const matchedUserId = (await input.chooseAccount?.()) ?? null;

	if (matchedUserId) {
		const now = new Date().toISOString();
		await db
			.insert(userIdentities)
			.values({
				id: generateId(),
				userId: matchedUserId,
				provider: input.provider,
				subject,
				email: input.email ?? null,
				displayName: input.displayName ?? null,
				lastLoginAt: now,
				createdAt: now,
			})
			// Two first-time logins can race for the same unlinked subject; the unique
			// (provider, subject) index decides which one actually binds.
			.onConflictDoNothing();
		const settled = await db.query.userIdentities.findFirst({
			where: and(eq(userIdentities.provider, input.provider), eq(userIdentities.subject, subject)),
			columns: { userId: true },
		});
		if (settled && settled.userId !== matchedUserId) {
			throw new AppError(
				"This directory identity is already linked to another account",
				409,
				"IDENTITY_LINK_CONFLICT",
			);
		}
		return { userId: matchedUserId, outcome: "linked_existing_account" };
	}

	// Provision a new local user + default preferences + link the identity.
	//
	// ⚠️ This path is NOT gated by `settings.auth.registrationOpen` and needs no
	// registration code, and it does not consume the registration attempt limiter.
	// That is intended, not an oversight: the provider has already authenticated the
	// person, so the admission decision belongs to the caller's `chooseAccount` policy
	// rather than to controls designed for anonymous password signup. The consequence an
	// operator must know is that enabling the provider grants accounts even while
	// registration is closed — the admin UI's switch description says so explicitly.
	// Role is always the ordinary `user` (see the insert below); no provider can mint an
	// administrator.
	const now = new Date().toISOString();
	const username = await deriveUniqueUsername(input.preferredUsername ?? "");
	const userId = generateId();
	// SSO/LDAP-only accounts have no usable password. Precompute a random,
	// unguessable bcrypt hash OUTSIDE the transaction (sync transactions
	// cannot await) so password login can never succeed.
	const passwordHash = await Bun.password.hash(randomBytes(32).toString("hex"), {
		algorithm: "bcrypt",
		cost: 10,
	});
	db.transaction((tx) => {
		tx.insert(users)
			.values({
				id: userId,
				username,
				passwordHash,
				role: "user",
				avatarColor: randomAvatarColor(),
				createdAt: now,
			})
			.run();
		tx.insert(userPreferences)
			.values({
				id: generateId(),
				userId,
				language: "en",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		tx.insert(userIdentities)
			.values({
				id: generateId(),
				userId,
				provider: input.provider,
				subject,
				email: input.email ?? null,
				displayName: input.displayName ?? null,
				lastLoginAt: now,
				createdAt: now,
			})
			.run();
	});
	return { userId, outcome: "created" };
}

export const ssoService = {
	/** List a user's linked SSO identities. */
	async listIdentities(userId: string): Promise<SsoIdentitySummary[]> {
		const rows = await db.query.userIdentities.findMany({
			where: eq(userIdentities.userId, userId),
		});
		return rows.map((r) => ({
			id: r.id,
			provider: r.provider,
			email: r.email,
			displayName: r.displayName,
			lastLoginAt: r.lastLoginAt,
			createdAt: r.createdAt,
		}));
	},

	/**
	 * Remove a linked identity (must belong to the user).
	 *
	 * `managed` is returned for a provider-owned binding the user may not drop — an LDAP
	 * directory identity is not a federation link but the account's own login credential,
	 * so unlinking it would lock the person out with no way back in.
	 */
	async unlink(userId: string, identityId: string): Promise<"ok" | "not_found" | "managed"> {
		const identity = await db.query.userIdentities.findFirst({
			where: and(eq(userIdentities.id, identityId), eq(userIdentities.userId, userId)),
			columns: { provider: true },
		});
		if (!identity) return "not_found";
		if (identity.provider.startsWith(LDAP_PROVIDER_PREFIX)) return "managed";
		await db
			.delete(userIdentities)
			.where(and(eq(userIdentities.id, identityId), eq(userIdentities.userId, userId)));
		return "ok";
	},

	/**
	 * Link a verified OIDC identity to an already-authenticated user. Returns
	 * false when the identity is already linked to a DIFFERENT user.
	 */
	async linkIdentity(
		userId: string,
		provider: OidcProviderConfig,
		claims: OidcClaims,
	): Promise<{ ok: boolean; reason?: "already_linked_other" }> {
		const existing = await db.query.userIdentities.findFirst({
			where: and(eq(userIdentities.provider, provider.id), eq(userIdentities.subject, claims.sub)),
		});
		if (existing) {
			if (existing.userId !== userId) return { ok: false, reason: "already_linked_other" };
			// Idempotent: refresh informational claims.
			await db
				.update(userIdentities)
				.set({ email: claims.email ?? null, displayName: claims.name ?? null })
				.where(eq(userIdentities.id, existing.id));
			return { ok: true };
		}
		await db.insert(userIdentities).values({
			id: generateId(),
			userId,
			provider: provider.id,
			subject: claims.sub,
			email: claims.email ?? null,
			displayName: claims.name ?? null,
			createdAt: new Date().toISOString(),
		});
		return { ok: true };
	},

	/**
	 * The shared external-identity login path, used by OIDC (`resolveLogin`) and by the
	 * LDAP directory. See the module-level `resolveExternalLogin` for the contract.
	 */
	resolveExternalLogin,

	/**
	 * Resolve (or provision) the local user for a verified SSO login.
	 * Returns the local user id, or throws an AppError when login is not allowed.
	 */
	async resolveLogin(provider: OidcProviderConfig, claims: OidcClaims): Promise<string> {
		const { userId } = await resolveExternalLogin({
			provider: provider.id,
			subject: claims.sub,
			email: claims.email ?? null,
			displayName: claims.name ?? null,
			preferredUsername: claims.email?.split("@")[0] || claims.name || claims.sub || "user",
			chooseAccount: () => {
				// No linked identity yet. Enforce the email-domain allowlist before any
				// provisioning decision.
				if (!emailDomainAllowed(provider, claims.email)) {
					throw new AppError("Your email domain is not allowed for SSO", 403, "SSO_DOMAIN_DENIED");
				}

				// Note: we deliberately do NOT silently link to an existing local account
				// by matching email. `users` has no email column, and trusting a provider
				// email for cross-account linking risks account takeover via a provider
				// with weak email verification. New subjects therefore go through signup.
				if (!provider.allowSignup) {
					throw new AppError(
						"No account is linked to this identity. Ask an administrator to enable signup or link your account first.",
						403,
						"SSO_SIGNUP_DISABLED",
					);
				}
				return null;
			},
		});
		return userId;
	},
};
