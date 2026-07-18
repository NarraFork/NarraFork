import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import type { AuthPrincipal } from "../auth";
import {
	requireAdmin,
	requireExternalAuth,
	requireExternalScope,
	requireSessionAuth,
} from "../auth";

const adminUser = { sub: "auth-boundary-admin", role: "admin" as const, iat: 0, exp: 0 };

function appWithPrincipal(principal: AuthPrincipal): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("auth", principal);
		c.set("user", principal.user);
		if (principal.type === "oauth") c.set("oauth", principal.oauth);
		await next();
	});
	app.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return app;
}

describe("session/oauth auth boundary", () => {
	test("rejects an OAuth admin principal at the admin boundary", async () => {
		const app = appWithPrincipal({
			type: "oauth",
			user: adminUser,
			oauth: {
				tokenId: "token-admin",
				clientId: "admin-client",
				oauthClientId: "oauth-client-admin",
				grantId: "grant-admin",
				refreshFamilyId: null,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scopes: ["device:manage"],
			},
		});
		app.get("/", requireExternalAuth, requireAdmin, (c) => c.text("ok"));

		const response = await app.request("/");
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
	});

	test("allows a session admin and keeps the principal stable across auth middleware", async () => {
		const app = appWithPrincipal({ type: "session", user: adminUser });
		app.get("/", requireExternalAuth, requireSessionAuth, requireAdmin, (c) => {
			expect(c.get("auth").type).toBe("session");
			return c.text("ok");
		});

		const response = await app.request("/");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});

	test("enforces an OAuth scope while allowing the legacy session path", async () => {
		const oauthApp = appWithPrincipal({
			type: "oauth",
			user: { ...adminUser, role: "user" },
			oauth: {
				tokenId: "token-scoped",
				clientId: "scoped-client",
				oauthClientId: "oauth-client-scoped",
				grantId: "grant-scoped",
				refreshFamilyId: null,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scopes: ["device:manage"],
			},
		});
		oauthApp.get("/device", requireExternalScope("device:manage"), (c) => c.text("ok"));
		oauthApp.get("/narrator", requireExternalScope("narrator:use"), (c) => c.text("ok"));

		const allowed = await oauthApp.request("/device");
		expect(allowed.status).toBe(200);
		const denied = await oauthApp.request("/narrator");
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: "INSUFFICIENT_SCOPE" });

		const sessionApp = appWithPrincipal({ type: "session", user: adminUser });
		sessionApp.get("/device", requireExternalScope("device:manage"), (c) => c.text("ok"));
		const sessionAllowed = await sessionApp.request("/device");
		expect(sessionAllowed.status).toBe(200);
	});

	test("rejects an OAuth principal whose grant has an empty scope list", async () => {
		const app = appWithPrincipal({
			type: "oauth",
			user: { ...adminUser, role: "user" },
			oauth: {
				tokenId: "token-empty",
				clientId: "empty-scope-client",
				oauthClientId: "oauth-client-empty",
				grantId: "grant-empty",
				refreshFamilyId: null,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scopes: [],
			},
		});
		app.get("/", requireExternalScope("device:manage"), (c) => c.text("ok"));

		const response = await app.request("/");
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
	});

	test("does not let an OAuth principal satisfy requireSessionAuth", async () => {
		const app = appWithPrincipal({
			type: "oauth",
			user: adminUser,
			oauth: {
				tokenId: "token-consent",
				clientId: "consent-client",
				oauthClientId: "oauth-client-consent",
				grantId: "grant-consent",
				refreshFamilyId: null,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scopes: [],
			},
		});
		app.get("/", requireSessionAuth, (c) => c.text("ok"));

		const response = await app.request("/");
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
	});
});
