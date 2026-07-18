import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { narrators } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

// Snapshot real modules before mocking so afterAll can re-point each specifier
// back. Bun's mock.module is process-wide and mock.restore() does NOT undo it.
const realDbModule = { ...(await import("../../../server/db")) };
const realTerminalService = { ...(await import("../../../server/services/terminal-service")) };
const realWorktreeWatcher = { ...(await import("../../../server/services/worktree-watcher")) };
const realAdminModules: Record<string, () => unknown> = {
	"../../../server/db": () => realDbModule,
	"../../../server/services/terminal-service": () => realTerminalService,
	"../../../server/services/worktree-watcher": () => realWorktreeWatcher,
};

mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/services/terminal-service", () => ({
	terminalService: {
		listAll: async () => [{ status: "running" }, { status: "exited" }],
	},
}));
mock.module("../../../server/services/worktree-watcher", () => ({
	worktreeWatcher: {
		getActivePaths: () => ["/repo/.worktrees/chapter-a"],
		getActiveCount: () => 1,
	},
}));

const { adminRoutes } = await import("../../../server/routes/admin");

const authUser = {
	sub: "admin-1",
	role: "admin" as const,
	iat: 0,
	exp: Number.MAX_SAFE_INTEGER,
};
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
			worktreeWatchers: { count: number; paths: string[] };
		};
		expect(body.narrators).toEqual({ thinking: 2, waiting: 1 });
		expect(body.terminals).toEqual({ total: 2, running: 1 });
		expect(body.worktreeWatchers).toEqual({ count: 1, paths: ["/repo/.worktrees/chapter-a"] });
	});
});
