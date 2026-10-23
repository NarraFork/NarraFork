import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { fileChangeScopes, workspaceWriteActivities } from "../db/schema";
import { generateId } from "../lib/id";
import {
	finishRemoteActivity,
	markRemoteActivityRunning,
	registerRemoteTerminalActivity,
} from "./remote-tree-snapshot-hooks";
import {
	createWorkspaceWriteCoordinatorState,
	WorkspaceWriteCoordinator,
} from "./workspace-write-coordinator";

const runtime = { runtimeEpoch: "test-native", runtimeGeneration: 1 };
function fixture() {
	const id = generateId();
	const scope = {
		id,
		sourceInstanceId: id,
		workspaceInstanceId: id,
		deviceId: `device-${id}`,
		canonicalRoot: `/test/${id}`,
		pathFlavor: "posix" as const,
	};
	db.insert(fileChangeScopes)
		.values({
			...scope,
			displayRoot: scope.canonicalRoot,
			status: "active",
			rootIdentityJson: { inode: id },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
	const make = () =>
		new WorkspaceWriteCoordinator({
			db,
			state: createWorkspaceWriteCoordinatorState(),
			readRuntime: () => runtime,
		});
	const metadata = {
		narratorId: "test-narrator",
		userId: "test-user",
		projectId: null,
		bindingId: id,
		bindingRevision: 1,
		contextKey: id,
		rootEvidenceDigest: id,
		kind: "bash" as "bash" | "pty",
		operationId: id,
		attempt: 1,
	};
	return { scope, make, metadata };
}

describe("durable remote write activity", () => {
	test("revert reports crashed activity without blocking known file rollback", async () => {
		const f = fixture();
		const before = f.make();
		const token = before.registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		before.markActivityRunning(token);
		const after = f.make();
		await after.reconcileActivitiesOnStartup();
		expect(() => after.assertRevertActivityBarrier(f.scope)).not.toThrow();
		let reverted = false;
		await after.withRollback({ scope: f.scope, runtime }, () => {
			reverted = true;
		});
		expect(reverted).toBe(true);
		expect(
			db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, f.scope.id)).get()?.status,
		).toBe("needs_verification");
	});

	test("revert still rejects a current-process running activity", () => {
		const f = fixture();
		const coordinator = f.make();
		const token = coordinator.registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		coordinator.markActivityRunning(token);
		expect(() => coordinator.assertRevertActivityBarrier(f.scope)).toThrow();
	});
	for (const kind of ["bash", "pty"] as const)
		test(`${kind} crash preserves unknown barrier`, async () => {
			const f = fixture();
			const before = f.make();
			const token = before.registerActivity({
				scope: f.scope,
				runtime,
				durable: { ...f.metadata, kind },
			});
			before.markActivityRunning(token);
			const after = f.make();
			await after.withRollback({ scope: f.scope, runtime }, () => {});
			await after.reconcileActivitiesOnStartup();
			expect(
				db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, f.scope.id)).get()?.status,
			).toBe("needs_verification");
			expect(
				db
					.select()
					.from(workspaceWriteActivities)
					.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
					.get()?.status,
			).toBe("unknown");
			await after.withRollback({ scope: f.scope, runtime }, () => {});
		});

	test("prepared crash and scope aliases cannot bypass the durable recovery hold", async () => {
		const f = fixture();
		f.make().registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		const alias = fixture();
		db.update(fileChangeScopes)
			.set({ deviceId: f.scope.deviceId, canonicalRoot: f.scope.canonicalRoot })
			.where(eq(fileChangeScopes.id, alias.scope.id))
			.run();
		alias.scope.deviceId = f.scope.deviceId;
		alias.scope.canonicalRoot = f.scope.canonicalRoot;
		await f.make().withRollback({ scope: alias.scope, runtime }, () => {});
		const after = f.make();
		await after.reconcileActivitiesOnStartup();
		expect(
			db
				.select()
				.from(workspaceWriteActivities)
				.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
				.get()?.status,
		).toBe("unknown");
		expect(() => after.inspectRecovery({ scope: f.scope })).toThrow("Durable workspace activity");
	});

	test("actual standalone PTY wrapper persists registration through a coordinator restart", async () => {
		const f = fixture();
		const coordinator = f.make();
		const terminalId = generateId();
		const target = {
			deviceId: f.scope.deviceId,
			cwd: f.scope.canonicalRoot,
			canonicalPath: f.scope.canonicalRoot,
			pathFlavor: "posix" as const,
			runtimeGeneration: 1,
			backendKind: "remote" as const,
			selectionSource: "explicit" as const,
		};
		const identity = { target, activityId: `pty:${terminalId}` };
		await registerRemoteTerminalActivity({
			...identity,
			principal: { userId: "test-user", isAdmin: false },
			terminalId,
			runtimeGeneration: 1,
			workspaceContext: {
				deviceId: f.scope.deviceId,
				cwd: f.scope.canonicalRoot,
				pathFlavor: "posix",
				revision: 1,
				contextKey: terminalId,
				capabilities: { switchDirectory: true },
			},
			scopeFactory: async () => {
				const scope = db
					.select()
					.from(fileChangeScopes)
					.where(eq(fileChangeScopes.id, f.scope.id))
					.get();
				if (!scope) throw new Error("Missing test terminal scope");
				return { scope, runtime, coordinator, assertCurrent: async () => {} };
			},
		});
		markRemoteActivityRunning(identity);
		expect(
			db
				.select()
				.from(workspaceWriteActivities)
				.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
				.get(),
		).toMatchObject({ status: "running", kind: "pty", operationId: terminalId, narratorId: null });
		await f.make().reconcileActivitiesOnStartup();
		expect(
			db
				.select()
				.from(workspaceWriteActivities)
				.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
				.get()?.status,
		).toBe("unknown");
		await finishRemoteActivity({ ...identity, outcome: "unknown" });
	});

	test("unknown cannot later be promoted to finished", async () => {
		const f = fixture();
		const coordinator = f.make();
		const token = coordinator.registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		coordinator.endActivity(token, "unknown");
		expect(() => coordinator.endActivity(token, "finished")).toThrow("no longer registered");
		expect(
			db
				.select()
				.from(workspaceWriteActivities)
				.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
				.get()?.status,
		).toBe("unknown");
		await f.make().withRollback({ scope: f.scope, runtime }, () => {});
	});

	test("finished activity does not block rollback", async () => {
		const f = fixture();
		const coordinator = f.make();
		const token = coordinator.registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		coordinator.markActivityRunning(token);
		coordinator.endActivity(token, "finished");
		expect(
			db
				.select()
				.from(workspaceWriteActivities)
				.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
				.get()?.status,
		).toBe("finished");
		await f.make().withRollback({ scope: f.scope, runtime }, () => {});
	});

	test("prepared insert failure prevents spawn", () => {
		const f = fixture();
		const coordinator = f.make();
		let spawns = 0;
		db.run(
			`CREATE TEMP TRIGGER reject_activity BEFORE INSERT ON workspace_write_activities BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END`,
		);
		try {
			expect(() => {
				coordinator.registerActivity({ scope: f.scope, runtime, durable: f.metadata });
				spawns++;
			}).toThrow("test persistence failure");
			expect(spawns).toBe(0);
		} finally {
			db.run("DROP TRIGGER reject_activity");
		}
	});

	test("startup scope persistence failure leaves the prepared record as a rollback hold", async () => {
		const f = fixture();
		f.make().registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		const after = f.make();
		db.run(
			"CREATE TEMP TRIGGER reject_activity_scope BEFORE UPDATE ON file_change_scopes BEGIN SELECT RAISE(ABORT, 'test scope persistence failure'); END",
		);
		try {
			await expect(after.reconcileActivitiesOnStartup()).rejects.toThrow(
				"test scope persistence failure",
			);
			expect(
				db
					.select()
					.from(workspaceWriteActivities)
					.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
					.get()?.status,
			).toBe("prepared");
			expect(() => after.assertRevertActivityBarrier(f.scope)).not.toThrow();
		} finally {
			db.run("DROP TRIGGER reject_activity_scope");
		}
		await after.reconcileActivitiesOnStartup();
		expect(
			db
				.select()
				.from(workspaceWriteActivities)
				.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
				.get()?.status,
		).toBe("unknown");
	});

	test("startup processes multiple pages, skips current owner and finished rows", async () => {
		const f = fixture();
		const old = f.make();
		const finished = old.registerActivity({
			scope: f.scope,
			runtime,
			durable: { ...f.metadata, operationId: "finished" },
		});
		old.endActivity(finished, "finished");
		for (let i = 0; i < 35; i++)
			old.registerActivity({
				scope: f.scope,
				runtime,
				durable: { ...f.metadata, operationId: `${i}` },
			});
		const current = f.make();
		const own = current.registerActivity({ scope: f.scope, runtime, durable: f.metadata });
		const result = await current.reconcileActivitiesOnStartup();
		expect(result.inspected).toBeGreaterThanOrEqual(35);
		const rows = db
			.select()
			.from(workspaceWriteActivities)
			.where(eq(workspaceWriteActivities.scopeId, f.scope.id))
			.all();
		expect(rows.filter((row) => row.status === "unknown")).toHaveLength(35);
		expect(rows.filter((row) => row.status === "prepared")).toHaveLength(1);
		expect(rows.filter((row) => row.status === "finished")).toHaveLength(1);
		current.endActivity(own, "unknown");
	});
});
