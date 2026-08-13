/**
 * SSO service — links OIDC identities to local users and provisions accounts.
 *
 * Identity model: each (provider, subject) pair in `user_identities` maps to one
 * local user. A user may link multiple providers. Login resolves the local user
 * from the verified subject; first-time logins may auto-provision a user when
 * the provider allows signup and the email domain (if restricted) matches.
 */
import { randomBytes } from "node:crypto";
import { db } from "@server/db";
import { userIdentities, userPreferences, users } from "@server/db/schema";
import { randomAvatarColor } from "@server/lib/avatar-colors";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import type { OidcClaims } from "@server/lib/oidc";
import type { OidcProviderConfig } from "@server/lib/settings/types";
import { and, eq } from "drizzle-orm";

/** Derive a valid, available username from OIDC claims. */
async function deriveUniqueUsername(claims: OidcClaims): Promise<string> {
	const raw = (claims.email?.split("@")[0] || claims.name || claims.sub || "user")
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

	/** Remove a linked identity (must belong to the user). */
	async unlink(userId: string, identityId: string): Promise<boolean> {
		const res = await db
			.delete(userIdentities)
			.where(and(eq(userIdentities.id, identityId), eq(userIdentities.userId, userId)))
			.returning({ id: userIdentities.id });
		return res.length > 0;
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
	 * Resolve (or provision) the local user for a verified SSO login.
	 * Returns the local user id, or throws an AppError when login is not allowed.
	 */
	async resolveLogin(provider: OidcProviderConfig, claims: OidcClaims): Promise<string> {
		const identity = await db.query.userIdentities.findFirst({
			where: and(eq(userIdentities.provider, provider.id), eq(userIdentities.subject, claims.sub)),
		});

		if (identity) {
			await db
				.update(userIdentities)
				.set({ lastLoginAt: new Date().toISOString() })
				.where(eq(userIdentities.id, identity.id));
			return identity.userId;
		}

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

		// Provision a new local user + default preferences + link the identity.
		//
		// ⚠️ This path is NOT gated by `settings.auth.registrationOpen` and needs no
		// registration code, and it does not consume the registration attempt limiter.
		// That is intended, not an oversight: the provider has already authenticated the
		// person, so the admission decision belongs to `allowSignup` plus
		// `allowedEmailDomains` (checked above) rather than to controls designed for
		// anonymous password signup. The consequence an operator must know is that
		// `allowSignup` grants accounts even while registration is closed — the admin UI's
		// switch description says so explicitly. Role is always the ordinary `user`
		// (see the insert below); SSO can never mint an administrator.
		const now = new Date().toISOString();
		const username = await deriveUniqueUsername(claims);
		const userId = generateId();
		// SSO-only accounts have no usable password. Precompute a random,
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
					provider: provider.id,
					subject: claims.sub,
					email: claims.email ?? null,
					displayName: claims.name ?? null,
					lastLoginAt: now,
					createdAt: now,
				})
				.run();
		});
		return userId;
	},
};
