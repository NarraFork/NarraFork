/**
 * Passkey (WebAuthn) service — all database-backed credential operations and
 * the four WebAuthn ceremony steps (registration options/verify,
 * authentication options/verify).
 *
 * Credentials live in `user_passkeys`; the public key is stored base64url-
 * encoded. Pending ceremony challenges live in `webauthn_challenges` (see
 * lib/webauthn.ts).
 *
 * A passkey serves two roles:
 *  - usernameless login (a discoverable credential identifies the user), and
 *  - a second factor after password (the user id is already known).
 * Both roles share the same registration + verification code here.
 */

import { db } from "@server/db";
import { userPasskeys } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { consumeChallenge, type ResolvedRp, resolveRp, saveChallenge } from "@server/lib/webauthn";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, desc, eq } from "drizzle-orm";

export interface PasskeySummary {
	id: string;
	name: string | null;
	deviceType: string | null;
	backedUp: boolean;
	lastUsedAt: string | null;
	createdAt: string;
}

function toSummary(row: typeof userPasskeys.$inferSelect): PasskeySummary {
	return {
		id: row.id,
		name: row.name,
		deviceType: row.deviceType,
		backedUp: row.backedUp,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
	};
}

export const passkeyService = {
	/** List a user's registered passkeys (newest first). */
	async list(userId: string): Promise<PasskeySummary[]> {
		const rows = await db.query.userPasskeys.findMany({
			where: eq(userPasskeys.userId, userId),
			orderBy: [desc(userPasskeys.createdAt)],
		});
		return rows.map(toSummary);
	},

	async hasAny(userId: string): Promise<boolean> {
		const row = await db.query.userPasskeys.findFirst({
			where: eq(userPasskeys.userId, userId),
			columns: { id: true },
		});
		return !!row;
	},

	/** Rename a passkey (must belong to the user). */
	async rename(userId: string, id: string, name: string): Promise<boolean> {
		const res = await db
			.update(userPasskeys)
			.set({ name })
			.where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
			.returning({ id: userPasskeys.id });
		return res.length > 0;
	},

	/** Delete a passkey (must belong to the user). */
	async remove(userId: string, id: string): Promise<boolean> {
		const res = await db
			.delete(userPasskeys)
			.where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
			.returning({ id: userPasskeys.id });
		return res.length > 0;
	},

	// === Registration ceremony ===

	/** Build registration options and persist the challenge. */
	async registrationOptions(params: {
		userId: string;
		username: string;
		originHeader: string | null | undefined;
	}) {
		const rp = resolveRp(params.originHeader);
		const existing = await db.query.userPasskeys.findMany({
			where: eq(userPasskeys.userId, params.userId),
			columns: { credentialId: true, transports: true },
		});
		const options = await generateRegistrationOptions({
			rpName: rp.rpName,
			rpID: rp.rpID,
			userName: params.username,
			// Stable per-user handle so re-registration replaces, not duplicates.
			userID: isoBase64URL.toBuffer(isoBase64URL.fromUTF8String(params.userId)),
			attestationType: "none",
			excludeCredentials: existing.map((c) => ({
				id: c.credentialId,
				transports: c.transports as never,
			})),
			authenticatorSelection: {
				residentKey: "preferred",
				userVerification: "preferred",
			},
		});
		await saveChallenge(options.challenge, "registration", params.userId);
		return options;
	},

	/** Verify a registration response and persist the new credential. */
	async verifyRegistration(params: {
		userId: string;
		response: RegistrationResponseJSON;
		name?: string;
		originHeader: string | null | undefined;
	}): Promise<{ ok: boolean }> {
		const rp = resolveRp(params.originHeader);
		const challenge = params.response.response.clientDataJSON
			? extractChallenge(params.response.response.clientDataJSON)
			: null;
		if (!challenge) return { ok: false };

		const pending = await consumeChallenge(challenge, "registration");
		if (!pending.ok || pending.userId !== params.userId) return { ok: false };

		let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
		try {
			verification = await verifyRegistrationResponse({
				response: params.response,
				expectedChallenge: challenge,
				expectedOrigin: rp.expectedOrigins,
				expectedRPID: rp.rpID,
				requireUserVerification: false,
			});
		} catch {
			return { ok: false };
		}
		if (!verification.verified || !verification.registrationInfo) return { ok: false };

		const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
		const now = new Date().toISOString();
		await db.insert(userPasskeys).values({
			id: generateId(),
			userId: params.userId,
			credentialId: credential.id,
			publicKey: isoBase64URL.fromBuffer(credential.publicKey),
			counter: credential.counter,
			transports: (credential.transports as string[]) ?? null,
			deviceType: credentialDeviceType,
			backedUp: credentialBackedUp,
			name: params.name?.trim() || defaultPasskeyName(),
			createdAt: now,
		});
		return { ok: true };
	},

	// === Authentication ceremony ===

	/**
	 * Build authentication options and persist the challenge. When userId is
	 * provided (second-factor flow) the allowed credentials are restricted to
	 * that user; otherwise an empty allowlist enables usernameless login via a
	 * discoverable credential.
	 */
	async authenticationOptions(params: {
		userId: string | null;
		originHeader: string | null | undefined;
	}) {
		const rp = resolveRp(params.originHeader);
		let allowCredentials: { id: string; transports?: never }[] | undefined;
		if (params.userId) {
			const creds = await db.query.userPasskeys.findMany({
				where: eq(userPasskeys.userId, params.userId),
				columns: { credentialId: true, transports: true },
			});
			allowCredentials = creds.map((c) => ({
				id: c.credentialId,
				transports: c.transports as never,
			}));
		}
		const options = await generateAuthenticationOptions({
			rpID: rp.rpID,
			userVerification: "preferred",
			allowCredentials,
		});
		await saveChallenge(options.challenge, "authentication", params.userId);
		return options;
	},

	/**
	 * Verify an authentication response. Returns the owning userId on success.
	 * When expectedUserId is given (2FA), the resolved credential must belong to
	 * that user.
	 */
	async verifyAuthentication(params: {
		response: AuthenticationResponseJSON;
		expectedUserId: string | null;
		originHeader: string | null | undefined;
	}): Promise<{ ok: boolean; userId: string | null }> {
		const rp = resolveRp(params.originHeader);
		const challenge = extractChallenge(params.response.response.clientDataJSON);
		if (!challenge) return { ok: false, userId: null };

		const pending = await consumeChallenge(challenge, "authentication");
		if (!pending.ok) return { ok: false, userId: null };
		if (params.expectedUserId && pending.userId && pending.userId !== params.expectedUserId) {
			return { ok: false, userId: null };
		}

		const credentialId = params.response.id;
		const stored = await db.query.userPasskeys.findFirst({
			where: eq(userPasskeys.credentialId, credentialId),
		});
		if (!stored) return { ok: false, userId: null };
		// Enforce ownership for the 2FA flow.
		if (params.expectedUserId && stored.userId !== params.expectedUserId) {
			return { ok: false, userId: null };
		}

		let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
		try {
			verification = await verifyAuthenticationResponse({
				response: params.response,
				expectedChallenge: challenge,
				expectedOrigin: rp.expectedOrigins,
				expectedRPID: rp.rpID,
				requireUserVerification: false,
				credential: {
					id: stored.credentialId,
					publicKey: isoBase64URL.toBuffer(stored.publicKey),
					counter: stored.counter,
					transports: (stored.transports as never) ?? undefined,
				},
			});
		} catch {
			return { ok: false, userId: null };
		}
		if (!verification.verified) return { ok: false, userId: null };

		// Persist the new signature counter + last-used timestamp.
		await db
			.update(userPasskeys)
			.set({
				counter: verification.authenticationInfo.newCounter,
				lastUsedAt: new Date().toISOString(),
			})
			.where(eq(userPasskeys.id, stored.id));

		return { ok: true, userId: stored.userId };
	},
};

/** Decode the base64url challenge embedded in clientDataJSON. */
function extractChallenge(clientDataJSON: string): string | null {
	try {
		const json = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as { challenge?: string };
		return json.challenge ?? null;
	} catch {
		return null;
	}
}

function defaultPasskeyName(): string {
	return `Passkey ${new Date().toISOString().slice(0, 10)}`;
}

export type { ResolvedRp };
