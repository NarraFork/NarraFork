import { expect, test } from "bun:test";
import { SESSION_VERSION_CLAIM } from "@shared/session-auth";
import { Hono } from "hono";
import { currentRemoteRecoveryAuthProvenance } from "../../services/remote-history-recovery-auth";
import type { AuthPrincipal } from "../auth";
import { remoteRecoveryProvenance } from "../remote-recovery-provenance";

// Middleware-boundary tests, not token-authentication or native recovery proof.
// Production HTTP suites independently establish c.auth through real auth middleware.
function principal(userId: string): AuthPrincipal {
	const now = Math.floor(Date.now() / 1000);
	return {
		type: "session",
		user: { sub: userId, role: "user", iat: now, exp: now + 3600, [SESSION_VERSION_CLAIM]: 7 },
	};
}

test("verified session provenance is request-local and does not persist bearer or role", async () => {
	const auth = principal("real-requester");
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("auth", auth);
		c.set("user", auth.user);
		await next();
	});
	app.use("*", remoteRecoveryProvenance);
	app.get("/", async (c) => {
		await Promise.resolve();
		expect(currentRemoteRecoveryAuthProvenance("someone-else")).toBeUndefined();
		return c.json(currentRemoteRecoveryAuthProvenance(auth.user.sub));
	});
	const result = await (
		await app.request("/", { headers: { authorization: "Bearer secret" } })
	).json();
	expect(result).toEqual({
		version: 1,
		userId: auth.user.sub,
		issuedAtSeconds: auth.user.iat,
		expiresAtSeconds: auth.user.exp,
		authentication: "session",
		tokenVersion: 7,
	});
	expect(JSON.stringify(result)).not.toContain("secret");
	expect(result.role).toBeUndefined();
	expect(currentRemoteRecoveryAuthProvenance(auth.user.sub)).toBeUndefined();
});

test("OAuth provenance stays OAuth and snapshots only its original identifiers and ceilings", async () => {
	const session = principal("oauth-requester");
	const auth: AuthPrincipal = {
		type: "oauth",
		user: session.user,
		oauth: {
			tokenId: "original-token-id",
			clientId: "original-client",
			oauthClientId: "original-oauth-client",
			grantId: "original-grant",
			refreshFamilyId: "original-family",
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			scopes: ["narrators:write"],
		},
	};
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("auth", auth);
		c.set("user", auth.user);
		await next();
	});
	app.use("*", remoteRecoveryProvenance);
	app.get("/", async (c) => {
		auth.oauth.scopes.push("mutated-after-capture");
		const copy = currentRemoteRecoveryAuthProvenance(auth.user.sub);
		if (copy?.authentication !== "oauth") throw new Error("Missing original OAuth provenance");
		copy.oauth.scopes.push("mutated-getter-copy");
		return c.json(currentRemoteRecoveryAuthProvenance(auth.user.sub));
	});
	const result = await (
		await app.request("/", { headers: { authorization: "Bearer oauth-secret" } })
	).json();
	expect(result.authentication).toBe("oauth");
	expect(result.oauth.tokenId).toBe("original-token-id");
	expect(result.oauth.grantId).toBe("original-grant");
	expect(result.oauth.scopes).toEqual(["narrators:write"]);
	expect(result.tokenVersion).toBeUndefined();
	expect(JSON.stringify(result)).not.toContain("oauth-secret");
});

test("legacy bare user and client JSON cannot fabricate session provenance", async () => {
	const user = principal("legacy-user").user;
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", user);
		await next();
	});
	app.use("*", remoteRecoveryProvenance);
	app.post("/", (c) => c.json({ proof: currentRemoteRecoveryAuthProvenance(user.sub) ?? null }));
	const response = await app.request("/", {
		method: "POST",
		body: JSON.stringify({ auth: principal("forged-body"), authentication: "session" }),
		headers: { "content-type": "application/json" },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ proof: null });
});

test("concurrent authenticated actors cannot borrow the other's asynchronous provenance", async () => {
	const app = new Hono();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let waiting = 0;
	app.use("*", async (c, next) => {
		const auth = principal(c.req.path.slice(1));
		c.set("auth", auth);
		c.set("user", auth.user);
		await next();
	});
	app.use("*", remoteRecoveryProvenance);
	app.get("/:id", async (c) => {
		if (++waiting === 2) release?.();
		await gate;
		const userId = c.req.param("id");
		expect(
			currentRemoteRecoveryAuthProvenance(userId === "first" ? "second" : "first"),
		).toBeUndefined();
		return c.json(currentRemoteRecoveryAuthProvenance(userId));
	});
	const responses = await Promise.all([app.request("/first"), app.request("/second")]);
	expect((await responses[0].json()).userId).toBe("first");
	expect((await responses[1].json()).userId).toBe("second");
	expect(currentRemoteRecoveryAuthProvenance("first")).toBeUndefined();
	expect(currentRemoteRecoveryAuthProvenance("second")).toBeUndefined();
});
