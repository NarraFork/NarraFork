import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { workspaceWriteLeases } from "@server/db/schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { WorkspaceOwnerEndedEvidence } from "./workspace-execution-owner";
import {
	reconcileWorkspaceOwnersOnStartup,
	WORKSPACE_STARTUP_RECONCILIATION_LIMITS,
	type WorkspaceStartupReconciliationDeps,
} from "./workspace-startup-reconciliation";
import { WORKSPACE_WRITE_LEASE_TEST_DDL } from "./workspace-write-lease-store";

let sqlite: Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.exec("CREATE TABLE file_change_scopes(id TEXT PRIMARY KEY, status TEXT NOT NULL)");
	sqlite.exec(WORKSPACE_WRITE_LEASE_TEST_DDL);
	db = drizzle(sqlite);
});
afterEach(() => sqlite.close());
function add(
	id: string,
	options: {
		scopeStatus?: string;
		executionClass?: "unknown" | "local_file_io";
		device?: string;
		ended?: boolean;
	} = {},
) {
	sqlite
		.query("INSERT INTO file_change_scopes(id,status) VALUES (?,?)")
		.run(id, options.scopeStatus ?? "active");
	db.insert(workspaceWriteLeases)
		.values({
			leaseId: id,
			scopeId: id,
			ownerEpoch: "old-owner",
			deviceId: options.device ?? "local",
			executionClass: options.executionClass ?? "local_file_io",
			runtimeEpoch: "old-runtime",
			runtimeGeneration: 0,
			fencingToken: 1,
			scopeRevision: 1,
			pathFlavor: "posix",
			status: "quarantined",
			rangesJson: { version: 1, ranges: [{ kind: "file", canonicalPath: `/work/${id}` }] },
			mutationManifestJson: { version: 1, mutations: [] },
			executionEndedAt: options.ended ? "2026-09-18T00:00:00Z" : null,
			createdAt: "2026-09-18T00:00:00Z",
			updatedAt: "2026-09-18T00:00:00Z",
		})
		.run();
}
function fixture() {
	const proof = { ownerEpoch: "old-owner" } as WorkspaceOwnerEndedEvidence;
	const terminate = mock(() => true);
	const reconcile = mock(async (_scopeId: string, _leaseId: string, _signal: AbortSignal) => ({
		recovered: true,
	}));
	const prove = mock(async () => proof as WorkspaceOwnerEndedEvidence | null);
	const deps: WorkspaceStartupReconciliationDeps = {
		database: db as WorkspaceStartupReconciliationDeps["database"],
		runtime: {
			coordinator: {
				recordLocalOwnerTermination: terminate,
			} as unknown as WorkspaceStartupReconciliationDeps["runtime"]["coordinator"],
		},
		assertAuthority: () => undefined,
		proveOwnerEnded: prove,
		reconcile,
	};
	return { proof, terminate, reconcile, prove, deps };
}

describe("bounded cold-start workspace reconciliation", () => {
	test("paginates candidates and probes each owner once before admitting reconciliation", async () => {
		for (let index = 0; index < 35; index++) add(`lease-${String(index).padStart(3, "0")}`);
		const f = fixture();
		expect(await reconcileWorkspaceOwnersOnStartup(f.deps)).toEqual({
			inspected: 35,
			reconciled: 35,
			deferred: 0,
			stopped: false,
		});
		expect(f.prove).toHaveBeenCalledTimes(1);
		expect(f.terminate).toHaveBeenCalledTimes(35);
		expect(f.reconcile).toHaveBeenCalledTimes(35);
	});

	test("never treats legacy, external execution, remote devices or independent root barriers as native recovery", async () => {
		add("legacy", { executionClass: "unknown" });
		add("root-uncertainty", { scopeStatus: "needs_verification" });
		add("remote", { device: "remote" });
		add("ended-native", { ended: true });
		const f = fixture();
		expect(await reconcileWorkspaceOwnersOnStartup(f.deps)).toEqual({
			inspected: 2,
			reconciled: 1,
			deferred: 1,
			stopped: false,
		});
		expect(f.prove).toHaveBeenCalledTimes(1);
		expect(f.terminate).toHaveBeenCalledWith("root-uncertainty", f.proof);
		expect(f.reconcile).toHaveBeenCalledTimes(1);
		expect(f.reconcile.mock.calls[0]?.[0]).toBe("ended-native");
	});

	test("missing or unobservable owner proof leaves every candidate protected", async () => {
		add("a");
		add("b");
		const f = fixture();
		f.prove.mockImplementation(async () => null);
		expect(await reconcileWorkspaceOwnersOnStartup(f.deps)).toEqual({
			inspected: 2,
			reconciled: 0,
			deferred: 2,
			stopped: false,
		});
		expect(f.prove).toHaveBeenCalledTimes(1);
		expect(f.terminate).not.toHaveBeenCalled();
		expect(f.reconcile).not.toHaveBeenCalled();
	});

	test("cancellation while observing an owner cannot subsequently acknowledge its lease", async () => {
		add("a");
		const controller = new AbortController();
		const f = fixture();
		f.prove.mockImplementation(async () => {
			controller.abort();
			return f.proof;
		});
		expect((await reconcileWorkspaceOwnersOnStartup(f.deps, controller.signal)).stopped).toBe(true);
		expect(f.terminate).not.toHaveBeenCalled();
		expect(f.reconcile).not.toHaveBeenCalled();
	});

	test("unknown or revoked single-instance authority stops without releasing barriers", async () => {
		add("a");
		const f = fixture();
		f.deps.assertAuthority = () => {
			throw new Error("multiple instances");
		};
		expect(await reconcileWorkspaceOwnersOnStartup(f.deps)).toEqual({
			inspected: 0,
			reconciled: 0,
			deferred: 0,
			stopped: true,
		});
		expect(f.prove).not.toHaveBeenCalled();
		expect(f.reconcile).not.toHaveBeenCalled();
	});

	test("single pass is capped and reconciliation rejection is not counted as clearance", async () => {
		for (let i = 0; i < 140; i++) add(`lease-${String(i).padStart(3, "0")}`, { ended: true });
		const f = fixture();
		f.reconcile.mockImplementation(async () => {
			throw new Error("changed after observation");
		});
		const result = await reconcileWorkspaceOwnersOnStartup(f.deps);
		expect(result.inspected).toBe(WORKSPACE_STARTUP_RECONCILIATION_LIMITS.maxItems);
		expect(result.reconciled).toBe(0);
		expect(result.deferred).toBe(result.inspected);
	});
});
