/**
 * The graph route's commit-refresh gate must follow the backend ACTUALLY serving
 * reads, not the legacy `NF_READ_BACKEND` selector.
 *
 * The bug this pins: in production PostgreSQL mode the master switch
 * (`NF_DATABASE_BACKEND=postgres`) owns backend selection and `postgres-runtime`
 * THROWS if `NF_READ_BACKEND`/`NF_WRITE_BACKEND` are set, so a route that asks
 * `selectReadBackend(process.env.NF_READ_BACKEND)` can only ever hear "sqlite" —
 * and the graph route then ran its SQLite commit refresh against the fail-closed
 * SQLite proxy, degrading every graph response with a warn. The gate now asks the
 * composed read adapter (`projectReadBackend()`), which is what actually serves the
 * graph.
 *
 * These tests drive the real route end to end and assert on git/commit-sync spies,
 * not on source text. The only module mock is the ACL bridge (`project-access`),
 * which is not under test; the adapters are the real classes with their query
 * methods stubbed, so `instanceof` still identifies them.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Snapshot before mocking: Bun's mock.module is process-wide and mock.restore()
// does NOT undo it, so afterAll re-points the specifier back.
const realProjectAccess = { ...(await import("../../lib/project-access")) };

mock.module("../../lib/project-access", () => ({
	...realProjectAccess,
	requireProjectAccess: async () => undefined,
	projectPrincipalOf: () => ({ userId: "graph-gate-admin", isAdmin: true }),
}));

afterAll(() => {
	mock.module("../../lib/project-access", () => realProjectAccess);
	mock.restore();
});

const { graphRoutes } = await import("../graph");
const { projectReadBackend, setProjectReadAdapter } = await import("../../services/read");
const { PostgresProjectReadAdapter } = await import(
	"../../services/read/postgres-project-read-adapter"
);
const { SqliteProjectReadAdapter } = await import(
	"../../services/read/sqlite-project-read-adapter"
);
const { gitService } = await import("../../services/git-service");
const { commitSyncService } = await import("../../services/commit-sync-service");

const app = new Hono().route("/projects", graphRoutes);

const ENV_KEYS = ["NF_DATABASE_BACKEND", "NF_READ_BACKEND", "NF_WRITE_BACKEND"] as const;
const savedEnv = new Map<string, string | undefined>(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

/** HEAD already cached on the chapter row: a refresh that runs but syncs nothing. */
const CACHED_HEAD = "cached0000000000000000000000000000000000";

/** One active chapter WITH a worktree — the exact shape that enters the refresh branch. */
function activeChapterRow(id: string) {
	return {
		id,
		title: "Gate chapter",
		status: "active",
		branch: "chapter/gate",
		role: "branch",
		color: null,
		groupLabel: null,
		explorationGroupId: null,
		isRoot: 0,
		graphX: null,
		graphY: null,
		commitCount: 3,
		headCommitSha: CACHED_HEAD,
		worktreePath: `/tmp/narrafork-graph-gate/${id}`,
		panelExpanded: 0,
		panelWidth: null,
		panelHeight: null,
		reviewSourceChapterId: null,
		reviewStatus: null,
	};
}

const EMPTY_AUXILIARY = { narrators: [], containers: [], detachedPanels: [] };

/**
 * What the composition seam injects in production PostgreSQL mode: the real
 * `PostgresProjectReadAdapter` class, with only its query methods stubbed so the
 * test needs no database. `instanceof` still identifies it as PostgreSQL.
 */
function postgresAdapterServing(chapters: unknown[]) {
	const adapter = new PostgresProjectReadAdapter({} as never);
	return Object.assign(adapter, {
		getGraph: async () => ({ chapters, edges: [] }),
		getGraphAuxiliaryData: async () => EMPTY_AUXILIARY,
	});
}

/** The SQLite equivalent: the real class, query methods stubbed. */
function sqliteAdapterServing(chapters: unknown[]) {
	const adapter = new SqliteProjectReadAdapter();
	return Object.assign(adapter, {
		getGraph: async () => ({ chapters, edges: [] }),
		getGraphAuxiliaryData: async () => EMPTY_AUXILIARY,
	});
}

/** Spy counters plus restore, swapping service methods the way graph-degraded tests do. */
const restores: Array<() => void> = [];
function stub<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
	const original = target[key];
	target[key] = value;
	restores.push(() => {
		target[key] = original;
	});
}

interface GraphResponse {
	nodes: Array<{ id: string; data: { commitCount: number; headCommitSha: string | null } }>;
	degraded: boolean;
	fallbacks: Array<Record<string, unknown>>;
}

async function getGraph(projectId: string): Promise<GraphResponse> {
	const res = await app.request(`/projects/${projectId}/graph`);
	expect(res.status).toBe(200);
	return (await res.json()) as GraphResponse;
}

afterEach(() => {
	setProjectReadAdapter(undefined);
	for (const restore of restores.splice(0)) restore();
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("graph read backend gate", () => {
	test("the seam reports the composed adapter's backend, not the legacy selector's", () => {
		// No adapter injected, no legacy selector: the historical SQLite default.
		delete process.env.NF_READ_BACKEND;
		expect(projectReadBackend().backend).toBe("sqlite");

		// The composition seam's adapter answers PostgreSQL even though the selector
		// cannot (NF_READ_BACKEND must be absent in production PG mode).
		setProjectReadAdapter(postgresAdapterServing([]));
		expect(projectReadBackend().backend).toBe("postgres");

		// An injected SQLite adapter keeps answering SQLite.
		setProjectReadAdapter(sqliteAdapterServing([]));
		expect(projectReadBackend().backend).toBe("sqlite");
	});

	test("production PG master switch with no legacy NF_*: graph does not run the SQLite refresh", async () => {
		// Exactly the production PG environment: master switch on, legacy selectors
		// absent (postgres-runtime would refuse to boot with them set).
		process.env.NF_DATABASE_BACKEND = "postgres";
		delete process.env.NF_READ_BACKEND;
		delete process.env.NF_WRITE_BACKEND;
		setProjectReadAdapter(postgresAdapterServing([activeChapterRow("ch_pg")]));

		let headReads = 0;
		let commitSyncs = 0;
		stub(gitService, "getHeadCommit", async () => {
			headReads += 1;
			return CACHED_HEAD;
		});
		stub(commitSyncService, "syncChapterCommits", async () => {
			commitSyncs += 1;
			return 0;
		});

		const graph = await getGraph("proj_pg");

		// The chapter is active and has a worktree: a wrongly-"sqlite" gate WOULD have
		// refreshed it. The refresh not running is the fix, and it must cost nothing —
		// no degraded flag, no fallback entries, cached metadata served as-is.
		expect(headReads).toBe(0);
		expect(commitSyncs).toBe(0);
		expect(graph.degraded).toBe(false);
		expect(graph.fallbacks).toEqual([]);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.nodes[0]?.data.commitCount).toBe(3);
		expect(graph.nodes[0]?.data.headCommitSha).toBe(CACHED_HEAD);
	});

	test("SQLite path unchanged: when SQLite serves reads the commit refresh still runs", async () => {
		delete process.env.NF_DATABASE_BACKEND;
		delete process.env.NF_READ_BACKEND;
		delete process.env.NF_WRITE_BACKEND;
		// The no-injection default constructs a SQLite adapter (the seam test above pins
		// that answer); injecting the same class with stubbed queries keeps this route
		// test hermetic while exercising the identical gate outcome.
		setProjectReadAdapter(sqliteAdapterServing([activeChapterRow("ch_sqlite")]));

		let headReads = 0;
		let commitSyncs = 0;
		stub(gitService, "getHeadCommit", async () => {
			headReads += 1;
			return CACHED_HEAD;
		});
		stub(commitSyncService, "syncChapterCommits", async () => {
			commitSyncs += 1;
			return 0;
		});

		const graph = await getGraph("proj_sqlite");

		// The refresh ran (HEAD read for the active chapter), found HEAD unchanged, so
		// nothing synced and nothing degraded — byte-for-byte the old SQLite behavior.
		expect(headReads).toBe(1);
		expect(commitSyncs).toBe(0);
		expect(graph.degraded).toBe(false);
		expect(graph.fallbacks).toEqual([]);
		expect(graph.nodes).toHaveLength(1);
	});
});
