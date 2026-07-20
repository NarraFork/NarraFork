import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	integrationAuthorities,
	oauthAccessTokens,
	oauthAuthorizationCodes,
	oauthClients,
	oauthGrantEvents,
	oauthGrants,
	users,
} from "../../db/schema";
import { integrationAuthorityService } from "../../services/integration-authority-service";
import { createOAuthGrant, revokeOAuthGrantForUser } from "../../services/oauth-grant-service";
import { generateId } from "../id";
import {
	ACCESS_TOKEN_TTL_SECONDS,
	exchangeCodeForToken,
	hashOAuthSecret,
	issueAuthorizationCode,
	OAUTH_EXTERNAL_V1_SCOPES,
	OAUTH_LAST_USED_THROTTLE_MS,
	OAUTH_SUPPORTED_SCOPES,
	OAuthError,
	refreshAccessToken,
	revokeToken,
	validateAccessToken,
	verifyPkceChallenge,
} from "../oauth-provider";

const CLIENT_ID = "robot-assistant-test";
const REDIRECT_URI = "http://127.0.0.1:9876/callback";
const USERNAME = "oauth-provider-test-user";

let userId = "";
const createdCodeIds: string[] = [];
const createdTokenIds: string[] = [];

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

function pkceChallenge(verifier: string): string {
	return base64url(createHash("sha256").update(verifier).digest());
}

async function ensureUser(): Promise<string> {
	if (userId) return userId;
	const existing = await db.query.users.findFirst({ where: eq(users.username, USERNAME) });
	if (existing) {
		userId = existing.id;
		return userId;
	}
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: USERNAME,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return userId;
}

async function ensureClient(
	overrides: Partial<typeof oauthClients.$inferInsert> = {},
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(oauthClients)
		.values({
			id: generateId(),
			clientId: CLIENT_ID,
			name: "Robot Assistant",
			redirectUris: [REDIRECT_URI],
			scopes: ["device.provision", "narrator.provision"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: await ensureUser(),
			createdAt: now,
			updatedAt: now,
			...overrides,
		})
		.onConflictDoNothing();
}

async function issueCode(input: { scopes?: string[]; verifier?: string; grantId?: string } = {}) {
	const verifier = input.verifier ?? "correct-horse-battery-staple-verifier-0123456789";
	const result = await issueAuthorizationCode({
		clientId: CLIENT_ID,
		userId: await ensureUser(),
		redirectUri: REDIRECT_URI,
		scopes: input.scopes ?? ["device.provision"],
		codeChallenge: pkceChallenge(verifier),
		grantId: input.grantId,
	});
	const row = await db.query.oauthAuthorizationCodes.findFirst({
		where: eq(oauthAuthorizationCodes.codeHash, hashOAuthSecret(result.code)),
	});
	if (row) createdCodeIds.push(row.id);
	return { ...result, verifier, row };
}

async function createGrant(scopes: string[] = ["device.provision", "narrator.provision"]) {
	const grant = await createOAuthGrant({
		clientId: CLIENT_ID,
		userId: await ensureUser(),
		scopes,
	});
	const authority = await integrationAuthorityService.getSnapshot(grant.id);
	expect(authority?.grants.map((item) => item.capabilityId).sort()).toEqual([...scopes].sort());
	return grant;
}

afterEach(async () => {
	for (const id of createdCodeIds.splice(0)) {
		await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.id, id));
	}
	for (const id of createdTokenIds.splice(0)) {
		await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.id, id));
	}
	// Remove any rows created by exchange/refresh inside the tests.
	await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, CLIENT_ID));
	await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.clientId, CLIENT_ID));
	const client = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.clientId, CLIENT_ID),
		columns: { id: true },
	});
	if (client) {
		await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, client.id));
		await db
			.delete(integrationAuthorities)
			.where(eq(integrationAuthorities.integrationId, client.id));
		await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, client.id));
	}
});

describe("oauth-provider canonical scopes", () => {
	test("exposes only direct canonical capability IDs", () => {
		expect(OAUTH_EXTERNAL_V1_SCOPES).toEqual([
			"project.read",
			"device.read",
			"device.provision",
			"device.rotate",
			"narrator.read",
			"event.subscribe",
			"narrator.provision",
			"narrator.send_message",
			"narrator.interrupt",
		]);
		expect(OAUTH_SUPPORTED_SCOPES).toEqual(OAUTH_EXTERNAL_V1_SCOPES);
	});
});

describe("oauth-provider authorization codes", () => {
	test("issues a code and stores only its hash", async () => {
		await ensureClient();
		const { code, row } = await issueCode({ scopes: ["device.provision", "narrator.provision"] });
		expect(code.startsWith("nfcode_")).toBe(true);
		expect(row).toBeTruthy();
		expect(row?.codeHash).toBe(hashOAuthSecret(code));
		expect(row?.codeHash.includes(code)).toBe(false);
		expect(row?.scopes).toEqual(["device.provision", "narrator.provision"]);
		expect(row?.oauthClientId).toBeTruthy();
		expect(row?.grantId).toBeNull();
		expect(row?.consumedAt).toBeNull();
	});

	test("normalizes duplicate and padded scopes before storing a code", async () => {
		await ensureClient();
		const { row } = await issueCode({ scopes: [" device.provision ", "device.provision"] });
		expect(row?.scopes).toEqual(["device.provision"]);
	});

	test("rejects unknown scopes", async () => {
		await ensureClient();
		await expect(
			issueAuthorizationCode({
				clientId: CLIENT_ID,
				userId: await ensureUser(),
				redirectUri: REDIRECT_URI,
				scopes: ["admin:everything"],
				codeChallenge: "x",
			}),
		).rejects.toThrow(OAuthError);
	});

	test("rejects scopes the client is not registered for", async () => {
		await ensureClient({ scopes: ["narrator.provision"] });
		// Re-insert path uses onConflictDoNothing, so update the row directly.
		await db
			.update(oauthClients)
			.set({ scopes: ["narrator.provision"] })
			.where(eq(oauthClients.clientId, CLIENT_ID));
		await expect(issueCode({ scopes: ["device.provision"] })).rejects.toThrow(OAuthError);
		// Restore for other tests.
		await db
			.update(oauthClients)
			.set({ scopes: ["device.provision", "narrator.provision"] })
			.where(eq(oauthClients.clientId, CLIENT_ID));
	});

	test("rejects unregistered redirect URIs and unknown/revoked clients", async () => {
		await ensureClient();
		await expect(
			issueAuthorizationCode({
				clientId: CLIENT_ID,
				userId: await ensureUser(),
				redirectUri: "https://evil.example/callback",
				scopes: ["device.provision"],
				codeChallenge: "x",
			}),
		).rejects.toThrow(OAuthError);
		await expect(
			issueAuthorizationCode({
				clientId: "no-such-client",
				userId: await ensureUser(),
				redirectUri: REDIRECT_URI,
				scopes: [],
				codeChallenge: "x",
			}),
		).rejects.toThrow(OAuthError);

		await db
			.update(oauthClients)
			.set({ revokedAt: new Date().toISOString() })
			.where(eq(oauthClients.clientId, CLIENT_ID));
		await expect(issueCode()).rejects.toThrow(OAuthError);
		await db
			.update(oauthClients)
			.set({ revokedAt: null, publicClient: false })
			.where(eq(oauthClients.clientId, CLIENT_ID));
		await expect(issueCode()).rejects.toThrow(OAuthError);
		await db
			.update(oauthClients)
			.set({ publicClient: true })
			.where(eq(oauthClients.clientId, CLIENT_ID));
	});
});

describe("oauth-provider code exchange (PKCE)", () => {
	test("exchanges a code for access + refresh tokens with the correct verifier", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode({ scopes: ["device.provision"] });
		const pair = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		expect(pair.tokenType).toBe("Bearer");
		expect(pair.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
		expect(pair.accessToken.startsWith("nfat_")).toBe(true);
		expect(pair.refreshToken.startsWith("nfrt_")).toBe(true);
		expect(pair.scope).toBe("device.provision");

		// The access token validates and carries the grant's user/client/scopes.
		const validated = await validateAccessToken(pair.accessToken);
		expect(validated).toMatchObject({
			userId: await ensureUser(),
			clientId: CLIENT_ID,
			grantId: null,
			scopes: ["device.provision"],
		});
		expect(validated?.tokenId).toBeTruthy();
		expect(validated?.oauthClientId).toBeTruthy();
		expect(validated?.refreshFamilyId).toBe(validated?.tokenId);
		expect(Date.parse(validated?.expiresAt ?? "")).toBeGreaterThan(Date.now());

		// Only hashes are persisted.
		const tokenRow = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(pair.accessToken)),
		});
		expect(tokenRow?.refreshTokenHash).toBe(hashOAuthSecret(pair.refreshToken));
		expect(tokenRow?.tokenHash.includes(pair.accessToken)).toBe(false);
	});

	test("a code is single-use even when the verifier is wrong", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		await expect(
			exchangeCodeForToken({
				code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: `${verifier}-wrong`,
			}),
		).rejects.toThrow(OAuthError);
		// Retrying with the CORRECT verifier still fails: the code was consumed.
		await expect(
			exchangeCodeForToken({
				code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: verifier,
			}),
		).rejects.toThrow(OAuthError);
	});

	test("atomically allows only one concurrent exchange", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		const exchange = () =>
			exchangeCodeForToken({
				code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: verifier,
			});

		const results = await Promise.allSettled([exchange(), exchange()]);
		const successful = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		const failed = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);

		expect(successful).toHaveLength(1);
		expect(failed).toHaveLength(1);
		expect(failed[0]).toBeInstanceOf(OAuthError);
		expect((failed[0] as OAuthError).oauthError).toBe("invalid_grant");
		expect(await validateAccessToken(successful[0].accessToken)).toBeTruthy();
	});

	test("rejects expired codes", async () => {
		await ensureClient();
		const { code, verifier, row } = await issueCode();
		if (!row) throw new Error("expected code row");
		await db
			.update(oauthAuthorizationCodes)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(oauthAuthorizationCodes.id, row.id));
		await expect(
			exchangeCodeForToken({
				code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: verifier,
			}),
		).rejects.toThrow(OAuthError);
	});

	test("rejects mismatched client_id and redirect_uri", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		await expect(
			exchangeCodeForToken({
				code,
				clientId: "some-other-client",
				redirectUri: REDIRECT_URI,
				codeVerifier: verifier,
			}),
		).rejects.toThrow(OAuthError);
		await expect(
			exchangeCodeForToken({
				code,
				clientId: CLIENT_ID,
				redirectUri: `${REDIRECT_URI}/other`,
				codeVerifier: verifier,
			}),
		).rejects.toThrow(OAuthError);
	});

	test("verifyPkceChallenge accepts only the exact S256 digest", () => {
		const verifier = "abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJ";
		expect(verifyPkceChallenge(verifier, pkceChallenge(verifier))).toBe(true);
		expect(verifyPkceChallenge(`${verifier}x`, pkceChallenge(verifier))).toBe(false);
		expect(verifyPkceChallenge(verifier, "not-a-real-challenge")).toBe(false);
	});
});

describe("oauth-provider refresh / revoke / validate", () => {
	test("refresh replay revokes the entire rotated family", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode({ scopes: ["narrator.provision"] });
		const first = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		const second = await refreshAccessToken({
			refreshToken: first.refreshToken,
			clientId: CLIENT_ID,
		});
		expect(second.accessToken).not.toBe(first.accessToken);
		expect(second.refreshToken).not.toBe(first.refreshToken);
		expect(second.scope).toBe("narrator.provision");
		const root = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(first.accessToken)),
		});
		const child = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(second.accessToken)),
		});
		expect(child?.refreshFamilyId).toBe(root?.id);
		expect(child?.refreshParentTokenId).toBe(root?.id);
		expect(child?.refreshFamilyExpiresAt).toBe(root?.refreshFamilyExpiresAt);

		// Rotation keeps the child usable until an old refresh token is replayed.
		expect(await validateAccessToken(first.accessToken)).toBeNull();
		expect(await validateAccessToken(second.accessToken)).toBeTruthy();
		await expect(
			refreshAccessToken({ refreshToken: first.refreshToken, clientId: CLIENT_ID }),
		).rejects.toThrow(OAuthError);
		expect(await validateAccessToken(second.accessToken)).toBeNull();
		const events = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.oauthClientId, root?.oauthClientId as string),
		});
		expect(events.map((event) => event.eventType)).toEqual(
			expect.arrayContaining(["token_issued", "refresh_rotated", "refresh_reuse_detected"]),
		);
		const serializedEvents = JSON.stringify(events);
		expect(serializedEvents).not.toContain(first.refreshToken);
		expect(serializedEvents).not.toContain(second.accessToken);
	});

	test("atomically allows only one concurrent refresh", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode({ scopes: ["narrator.provision"] });
		const first = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		const refresh = () =>
			refreshAccessToken({ refreshToken: first.refreshToken, clientId: CLIENT_ID });

		const results = await Promise.allSettled([refresh(), refresh()]);
		const successful = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		const failed = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);

		expect(successful).toHaveLength(1);
		expect(failed).toHaveLength(1);
		expect(failed[0]).toBeInstanceOf(OAuthError);
		expect((failed[0] as OAuthError).oauthError).toBe("invalid_grant");
		expect(await validateAccessToken(first.accessToken)).toBeNull();
		// The CAS loser is treated as reuse, so even the winner's child is revoked.
		expect(await validateAccessToken(successful[0].accessToken)).toBeNull();
	});

	test("refresh rejects a token issued to a different client", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		const pair = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		await expect(
			refreshAccessToken({ refreshToken: pair.refreshToken, clientId: "another-client" }),
		).rejects.toThrow(OAuthError);
	});

	test("revoking the access token invalidates it; revoking refresh blocks rotation", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		const pair = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		await revokeToken(pair.accessToken);
		expect(await validateAccessToken(pair.accessToken)).toBeNull();

		await revokeToken(pair.refreshToken);
		await expect(
			refreshAccessToken({ refreshToken: pair.refreshToken, clientId: CLIENT_ID }),
		).rejects.toThrow(OAuthError);

		// Unknown tokens are a silent no-op.
		await expect(revokeToken("nfat_does-not-exist")).resolves.toBeUndefined();
	});

	test("client revocation immediately invalidates existing bearer tokens", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		const pair = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		expect(await validateAccessToken(pair.accessToken)).toBeTruthy();

		try {
			await db
				.update(oauthClients)
				.set({ revokedAt: new Date().toISOString() })
				.where(eq(oauthClients.clientId, CLIENT_ID));
			expect(await validateAccessToken(pair.accessToken)).toBeNull();
		} finally {
			await db
				.update(oauthClients)
				.set({ revokedAt: null })
				.where(eq(oauthClients.clientId, CLIENT_ID));
		}
	});

	test("validateAccessToken rejects expired and unknown tokens", async () => {
		await ensureClient();
		const { code, verifier } = await issueCode();
		const pair = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		const row = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(pair.accessToken)),
		});
		if (!row) throw new Error("expected token row");
		await db
			.update(oauthAccessTokens)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(oauthAccessTokens.id, row.id));
		expect(await validateAccessToken(pair.accessToken)).toBeNull();
		expect(await validateAccessToken("nfat_never-issued")).toBeNull();
		expect(await validateAccessToken("")).toBeNull();
	});
});

describe("oauth-provider grant lifecycle", () => {
	test("persists grant bindings through code, access token, and refresh rotation", async () => {
		await ensureClient();
		const grant = await createGrant(["device.provision", "narrator.provision"]);
		const issued = await issueCode({
			scopes: ["device.provision"],
			grantId: grant.id,
		});
		expect(issued.row?.oauthClientId).toBe(grant.oauthClientId);
		expect(issued.row?.grantId).toBe(grant.id);
		const first = await exchangeCodeForToken({
			code: issued.code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: issued.verifier,
		});
		const firstRow = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(first.accessToken)),
		});
		expect(firstRow?.oauthClientId).toBe(grant.oauthClientId);
		expect(firstRow?.grantId).toBe(grant.id);
		expect((await validateAccessToken(first.accessToken))?.grantId).toBe(grant.id);

		const rotated = await refreshAccessToken({
			refreshToken: first.refreshToken,
			clientId: CLIENT_ID,
		});
		const rotatedRow = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(rotated.accessToken)),
		});
		expect(rotatedRow?.oauthClientId).toBe(grant.oauthClientId);
		expect(rotatedRow?.grantId).toBe(grant.id);
	});

	test("grant revocation immediately blocks code exchange, refresh, and bearer use", async () => {
		await ensureClient();
		const firstGrant = await createGrant();
		const pending = await issueCode({ grantId: firstGrant.id });
		await revokeOAuthGrantForUser({ grantId: firstGrant.id, userId: await ensureUser() });
		await expect(
			exchangeCodeForToken({
				code: pending.code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: pending.verifier,
			}),
		).rejects.toThrow(OAuthError);

		const secondGrant = await createGrant();
		const issued = await issueCode({ grantId: secondGrant.id });
		const pair = await exchangeCodeForToken({
			code: issued.code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: issued.verifier,
		});
		expect(await validateAccessToken(pair.accessToken)).toBeTruthy();
		await revokeOAuthGrantForUser({ grantId: secondGrant.id, userId: await ensureUser() });
		expect(await validateAccessToken(pair.accessToken)).toBeNull();
		await expect(
			refreshAccessToken({ refreshToken: pair.refreshToken, clientId: CLIENT_ID }),
		).rejects.toThrow(OAuthError);
	});

	test("client revocation blocks a pending code and refresh immediately", async () => {
		await ensureClient();
		const pending = await issueCode();
		const { code, verifier } = await issueCode();
		const pair = await exchangeCodeForToken({
			code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: verifier,
		});
		try {
			await db
				.update(oauthClients)
				.set({ revokedAt: new Date().toISOString() })
				.where(eq(oauthClients.clientId, CLIENT_ID));
			await expect(
				exchangeCodeForToken({
					code: pending.code,
					clientId: CLIENT_ID,
					redirectUri: REDIRECT_URI,
					codeVerifier: pending.verifier,
				}),
			).rejects.toThrow(OAuthError);
			expect(await validateAccessToken(pair.accessToken)).toBeNull();
			await expect(
				refreshAccessToken({ refreshToken: pair.refreshToken, clientId: CLIENT_ID }),
			).rejects.toThrow(OAuthError);
		} finally {
			await db
				.update(oauthClients)
				.set({ revokedAt: null })
				.where(eq(oauthClients.clientId, CLIENT_ID));
		}
	});

	test("scope reductions immediately affect bearer, refresh, and authorization code", async () => {
		await ensureClient();
		const grant = await createGrant(["device.provision", "narrator.provision"]);
		const issued = await issueCode({
			scopes: ["device.provision", "narrator.provision"],
			grantId: grant.id,
		});
		const pair = await exchangeCodeForToken({
			code: issued.code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: issued.verifier,
		});
		const pendingGrantCode = await issueCode({
			scopes: ["device.provision", "narrator.provision"],
			grantId: grant.id,
		});
		try {
			const authority = await integrationAuthorityService.getSnapshot(grant.id);
			if (!authority) throw new Error("expected integration authority");
			await integrationAuthorityService.replaceGrants({
				authorityId: grant.id,
				expectedRevision: authority.authority.revision,
				grants: [
					{
						capabilityId: "narrator.provision",
						scope: { type: "integration", id: grant.id },
						createdBy: { type: "system" },
					},
				],
			});
			expect((await validateAccessToken(pair.accessToken))?.scopes).toEqual(["narrator.provision"]);

			const refreshed = await refreshAccessToken({
				refreshToken: pair.refreshToken,
				clientId: CLIENT_ID,
			});
			expect(refreshed.scope).toBe("narrator.provision");
			expect((await validateAccessToken(refreshed.accessToken))?.scopes).toEqual([
				"narrator.provision",
			]);

			const exchangedAfterGrantReduction = await exchangeCodeForToken({
				code: pendingGrantCode.code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: pendingGrantCode.verifier,
			});
			expect(exchangedAfterGrantReduction.scope).toBe("narrator.provision");

			const pendingClientCode = await issueCode({
				scopes: ["narrator.provision"],
				grantId: grant.id,
			});
			await db
				.update(oauthClients)
				.set({ scopes: ["device.provision"] })
				.where(eq(oauthClients.clientId, CLIENT_ID));
			expect((await validateAccessToken(refreshed.accessToken))?.scopes).toEqual([]);
			const exchangedAfterClientReduction = await exchangeCodeForToken({
				code: pendingClientCode.code,
				clientId: CLIENT_ID,
				redirectUri: REDIRECT_URI,
				codeVerifier: pendingClientCode.verifier,
			});
			expect(exchangedAfterClientReduction.scope).toBe("");
			const refreshedAfterClientReduction = await refreshAccessToken({
				refreshToken: exchangedAfterGrantReduction.refreshToken,
				clientId: CLIENT_ID,
			});
			expect(refreshedAfterClientReduction.scope).toBe("");
		} finally {
			await db
				.update(oauthClients)
				.set({ scopes: ["device.provision", "narrator.provision"] })
				.where(eq(oauthClients.clientId, CLIENT_ID));
		}
	});

	test("throttles lastUsedAt updates to approximately five minutes", async () => {
		await ensureClient();
		const grant = await createGrant(["device.provision"]);
		const issued = await issueCode({ scopes: ["device.provision"], grantId: grant.id });
		const pair = await exchangeCodeForToken({
			code: issued.code,
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			codeVerifier: issued.verifier,
		});
		const tokenRow = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(pair.accessToken)),
		});
		if (!tokenRow) throw new Error("expected access token row");
		const old = new Date(Date.now() - OAUTH_LAST_USED_THROTTLE_MS - 1_000).toISOString();
		await db
			.update(oauthAccessTokens)
			.set({ lastUsedAt: old })
			.where(eq(oauthAccessTokens.id, tokenRow?.id ?? ""));
		await db.update(oauthGrants).set({ lastUsedAt: old }).where(eq(oauthGrants.id, grant.id));
		await db
			.update(oauthClients)
			.set({ lastUsedAt: old })
			.where(eq(oauthClients.clientId, CLIENT_ID));
		await validateAccessToken(pair.accessToken);

		const firstTouch = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.id, tokenRow?.id ?? ""),
			columns: { lastUsedAt: true },
		});
		const firstGrantTouch = await db.query.oauthGrants.findFirst({
			where: eq(oauthGrants.id, grant.id),
			columns: { lastUsedAt: true },
		});
		const firstClientTouch = await db.query.oauthClients.findFirst({
			where: eq(oauthClients.clientId, CLIENT_ID),
			columns: { lastUsedAt: true },
		});
		expect(firstTouch?.lastUsedAt).not.toBe(old);
		expect(firstGrantTouch?.lastUsedAt).not.toBe(old);
		expect(firstClientTouch?.lastUsedAt).not.toBe(old);

		const recent = new Date().toISOString();
		await db
			.update(oauthAccessTokens)
			.set({ lastUsedAt: recent })
			.where(eq(oauthAccessTokens.id, tokenRow?.id ?? ""));
		await db.update(oauthGrants).set({ lastUsedAt: recent }).where(eq(oauthGrants.id, grant.id));
		await db
			.update(oauthClients)
			.set({ lastUsedAt: recent })
			.where(eq(oauthClients.clientId, CLIENT_ID));
		await validateAccessToken(pair.accessToken);
		const secondTouch = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.id, tokenRow?.id ?? ""),
			columns: { lastUsedAt: true },
		});
		expect(secondTouch?.lastUsedAt).toBe(recent);
	});
});
