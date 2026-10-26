import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { narrators } from "../../../server/db/schema";
import type { AuthSessionStore } from "../../../server/services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../../server/services/auth/store";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

// Snapshot real modules before mocking so afterAll can re-point each specifier
// back. Bun's mock.module is process-wide and mock.restore() does NOT undo it.
const realDbModule = { ...(await import("../../../server/db")) };
const realTerminalService = { ...(await import("../../../server/services/terminal-service")) };
const realAdminModules: Record<string, () => unknown> = {
	"../../../server/db": () => realDbModule,
	"../../../server/services/terminal-service": () => realTerminalService,
};

mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/services/terminal-service", () => ({
	terminalService: {
		listAll: async () => [{ status: "running" }, { status: "exited" }],
	},
}));

const { adminRoutes } = await import("../../../server/routes/admin");

const authUser = {
	sub: "admin-1",
	role: "admin" as const,
	iat: 0,
	exp: Number.MAX_SAFE_INTEGER,
};

/**
 * `assertAdmin` authorizes against the LIVE role read through the session store, never the
 * token's `role` claim. The middleware below only sets `c.get("user")`, so this seam makes
 * the store report the acting admin as an admin; without it the admin-gated diagnostics
 * route would hit the (mocked, user-less) database and 401 USER_GONE.
 */
const sessionStoreSeam: AuthSessionStore = {
	...authSessionStore,
	findSessionState: async (id) => ({
		id,
		role: id === authUser.sub ? "admin" : "user",
		tokenVersion: 0,
	}),
};
setAuthStores({ session: sessionStoreSeam, mfa: authMfaStore });

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("auth", { type: "session", user: authUser });
	c.set("user", authUser);
	await next();
});
app.route("/", adminRoutes);

const NOW = "2025-01-01T00:00:00.000Z";

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	setAuthStores(undefined);
	for (const [specifier, factory] of Object.entries(realAdminModules)) {
		mock.module(specifier, factory);
	}
	mock.restore();
});

function seedNarrator(id: string, status: "idle" | "working" | "waiting" | "archived") {
	db.insert(narrators)
		.values({
			id,
			status,
			type: "primary",
			variant: "primary",
			inheritMode: "fresh",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("admin diagnostics", () => {
	it("counts working and waiting narrators from a single status query", async () => {
		seedNarrator("n-working-1", "working");
		seedNarrator("n-working-2", "working");
		seedNarrator("n-waiting", "waiting");
		seedNarrator("n-idle", "idle");

		const res = await app.request("/diagnostics");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			narrators: { thinking: number; waiting: number };
			terminals: { total: number; running: number };
			worktreeWatchers?: unknown;
		};
		expect(body.narrators).toEqual({ thinking: 2, waiting: 1 });
		expect(body.terminals).toEqual({ total: 2, running: 1 });
		expect(body.worktreeWatchers).toBeUndefined();
	});
});
