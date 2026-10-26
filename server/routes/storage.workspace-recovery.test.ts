import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import type { AuthSessionStore } from "../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../services/auth/store";
import { storageRoutes } from "./storage";

/**
 * The guarded storage routes run `assertAdmin`, which authorizes against the LIVE role read
 * through the session store, never the token's `role` claim. The middleware below only sets
 * `c.get("user")`, so this seam resolves each principal's role by actor id. The two roles
 * carry distinct subs so one test can exercise both without the lookup (or its cache)
 * colliding; an unauthenticated request sets no user and still 401s before this is reached.
 */
const ADMIN_ACTOR_ID = "authenticated-admin";
const NON_ADMIN_ACTOR_ID = "authenticated-user";
const sessionStoreSeam: AuthSessionStore = {
	...authSessionStore,
	findSessionState: async (id) => ({
		id,
		role: id === ADMIN_ACTOR_ID ? "admin" : "user",
		tokenVersion: 0,
	}),
};
setAuthStores({ session: sessionStoreSeam, mfa: authMfaStore });

afterAll(() => {
	setAuthStores(undefined);
});

const app = new Hono();
app.use("*", async (c, next) => {
	const role = c.req.header("x-test-role");
	if (role)
		c.set("user", {
			sub: role === "admin" ? ADMIN_ACTOR_ID : NON_ADMIN_ACTOR_ID,
			role: role as "admin" | "user",
			iat: 0,
			exp: 9999999999,
		});
	await next();
});
app.onError(
	(error) =>
		new Response(JSON.stringify({ error: error.message }), {
			status: error instanceof AppError ? error.statusCode : 500,
		}),
);
app.route("/storage", storageRoutes);

describe("retired workspace recovery routes", () => {
	test.each([
		["GET", "/workspace-barriers"],
		["POST", "/workspace-barriers/scope-a/observe"],
		["POST", "/workspace-barriers/scope-a/recover"],
		["POST", "/workspace-barriers/scope-a/retry-persistence"],
		["POST", "/workspace-barriers/scope-a/maintenance/begin"],
		["POST", "/workspace-barriers/scope-a/maintenance/observe"],
		["POST", "/workspace-barriers/scope-a/maintenance/commit"],
		["POST", "/workspace-barriers/scope-a/maintenance/cancel"],
	])("%s %s is absent for every role", async (method, path) => {
		for (const role of [null, "user", "admin"]) {
			const response = await app.request(`/storage${path}`, {
				method,
				headers: role ? { "x-test-role": role } : {},
			});
			expect(response.status).toBe(404);
		}
	});

	test("retains ordinary storage authorization and request validation", async () => {
		for (const path of ["/scan/start", "/database/preview", "/database/cleanup"]) {
			for (const [role, status] of [
				[null, 401],
				["user", 403],
				["admin", 400],
			] as const) {
				const response = await app.request(`/storage${path}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(role ? { "x-test-role": role } : {}),
					},
					body: JSON.stringify({ categories: ["invalid"], target: "invalid" }),
				});
				expect(response.status).toBe(status);
			}
		}
	});
});
