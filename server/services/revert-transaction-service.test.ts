/**
 * Rollback activity admission, bounded workspace ranges and the large fixed-plan case.
 * Shared fixture: ./__tests__/revert-transaction.fixture.ts (importing it registers the hooks).
 * Sibling suites: revert-transaction-interleaving.test.ts, revert-transaction-real-tools.test.ts.
 */
import { Database } from "bun:sqlite";
import { describe, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import * as readWorkers from "../lib/db-worker/pool";
import { generateId } from "../lib/id";
import {
	access,
	closeFixture,
	coordinatorState,
	db,
	execution,
	fixtureSetupMs,
	hash,
	history,
	journalFiles,
	makeFixtureTransaction,
	namespace,
	operation,
	options,
	owner,
	prepare,
	principal,
	restores,
	root,
	runtime,
	setService,
	test,
	twoFiles,
	workspace,
	write,
} from "./__tests__/revert-transaction.fixture";
import { localDirectoryIdentity, localObjectIdentity } from "./file-change-local-io";
import { restoreLocalFile } from "./file-change-local-restore";
import { localFileChangeRuntimeBinding } from "./file-change-runtime";
import {
	buildRevertScopeRanges,
	type RevertTransactionOutcome,
} from "./revert-transaction-service";
import { freezeWorkspaceRanges, WORKSPACE_RANGE_LIMITS } from "./workspace-write-ranges";

describe("rollback activity admission and bounded ranges", () => {
	test("strict fixture close releases retained prepared statements before directory removal", async () => {
		const directory = await fs.mkdtemp(join(root, "close-probe-"));
		const client = new Database(join(directory, "owned.sqlite"));
		client.exec("PRAGMA journal_mode=WAL; CREATE TABLE owned(value TEXT);");
		const retained = client.prepare("SELECT value FROM owned");
		try {
			expect(retained.all()).toEqual([]);
			client.close(true);
			expect(() => retained.all()).toThrow("Database has closed");
			await fs.rm(directory, { recursive: true, force: true });
			await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			retained.finalize();
			client.close(true);
		}
	});

	test("fixture cancellation drains its database workers before local close and removal", async () => {
		const directory = await fs.mkdtemp(join(root, "reader-close-probe-"));
		const client = new Database(join(directory, "owned.sqlite"));
		client.exec("PRAGMA journal_mode=WAL; CREATE TABLE owned(value TEXT);");
		const retained = client.prepare("SELECT value FROM owned");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const original = readWorkers.closeDbWorkerConnections;
		const close = spyOn(readWorkers, "closeDbWorkerConnections").mockImplementation(
			async (path, afterClose) => {
				expect(path).toBe(client.filename);
				expect(controller.signal.aborted).toBe(true);
				entered.resolve();
				await release.promise;
				return original(path, afterClose);
			},
		);
		const pending = closeFixture({
			controller,
			work: new Set(),
			holds: new Set(),
			restores: [],
			root: directory,
			sqlite: client,
		});
		try {
			await entered.promise;
			expect(retained.all()).toEqual([]);
			await fs.access(directory);
			release.resolve();
			await pending;
			expect(() => retained.all()).toThrow("Database has closed");
			await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			await pending;
			close.mockRestore();
			retained.finalize();
			client.close(true);
		}
	});

	test("actual lifetime includes a bounded-response read already running when the body settles", async () => {
		const instance = makeFixtureTransaction(db, options);
		const body = Promise.withResolvers<RevertTransactionOutcome>();
		const read = Promise.withResolvers<null>();
		const entered = Promise.withResolvers<void>();
		const outcome: RevertTransactionOutcome = {
			planId: "owned-response-read",
			status: "compensated",
			journalStatus: "compensated",
			settling: false,
			reason: null,
		};
		const internals = instance as unknown as {
			run(run: { started: boolean }): Promise<RevertTransactionOutcome>;
			safeOperation(): Promise<null>;
		};
		const run = spyOn(internals, "run").mockImplementation((state) => {
			state.started = true;
			return body.promise;
		});
		const lookup = spyOn(internals, "safeOperation").mockImplementation(() => {
			entered.resolve();
			return read.promise;
		});
		const schedule = globalThis.setTimeout;
		let response: (() => void) | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => {
			if (delay === 30_000) response = () => callback(...args);
			return schedule(callback, delay, ...args);
		}) as typeof setTimeout);
		const controller = new AbortController();
		const attempt = instance.execute({
			principal,
			narratorId: "narrator",
			planId: outcome.planId,
			planHash: "a".repeat(64),
			signal: controller.signal,
		});
		let settled = false;
		void attempt.whenSettled.then(() => {
			settled = true;
		});
		try {
			controller.abort();
			expect(response).toBeDefined();
			response?.();
			await entered.promise;
			body.resolve(outcome);
			expect(await attempt.result).toBe(outcome);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			read.resolve(null);
			expect(await attempt.whenSettled).toBe(outcome);
			expect(lookup).toHaveBeenCalledTimes(1);
		} finally {
			body.resolve(outcome);
			read.resolve(null);
			await attempt.whenSettled;
			timer.mockRestore();
			lookup.mockRestore();
			run.mockRestore();
		}
	});

	test.each([
		256, 257, 1000,
	])("%s fixed targets keep scope admission within the global range budget", async (count) => {
		await write(join(workspace, "scope-seed.txt"), "seed");
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		if (!scope) throw new Error("Missing scope");
		const paths = Array.from({ length: count }, (_, i) => join(workspace, `range-${i}.txt`));
		const ranges = buildRevertScopeRanges(scope, paths);
		expect(ranges).toEqual(
			count === 256
				? paths.map((canonicalPath) => ({ kind: "file", canonicalPath }))
				: [{ kind: "subtree", canonicalPath: scope.canonicalRoot }],
		);
		expect(freezeWorkspaceRanges(scope, ranges)).toEqual(ranges);
		expect(ranges.length).toBeLessThanOrEqual(WORKSPACE_RANGE_LIMITS.count);
		expect(Buffer.byteLength(JSON.stringify({ version: 1, ranges }))).toBeLessThanOrEqual(
			WORKSPACE_RANGE_LIMITS.jsonBytes,
		);
		expect(paths).toHaveLength(count);
		expect(WORKSPACE_RANGE_LIMITS).toMatchObject({ count: 256, jsonBytes: 128 * 1024 });
	});

	test("serialized UTF-8 bytes include the version wrapper and trigger scope fallback", async () => {
		await write(join(workspace, "scope-seed.txt"), "seed");
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		if (!scope) throw new Error("Missing scope");
		const path = join(workspace, "字".repeat(200));
		const padding = "字".repeat(80);
		let ranges: { kind: "file"; canonicalPath: string }[] | undefined;
		// Account for the actual canonical temporary prefix, without changing any
		// count/byte/padding limit or deriving expectations from production output.
		for (let count = 180; count > 0; count--) {
			const candidate = Array.from({ length: count }, (_, i) => ({
				kind: "file" as const,
				canonicalPath: `${path}-${i}`,
			}));
			const compactJson = JSON.stringify({ version: 1, ranges: candidate });
			const paddedJson = JSON.stringify({
				version: 1,
				ranges: candidate.map((range) => ({
					...range,
					canonicalPath: `${range.canonicalPath}${padding}`,
				})),
			});
			if (
				compactJson.length < WORKSPACE_RANGE_LIMITS.jsonBytes &&
				Buffer.byteLength(compactJson) < WORKSPACE_RANGE_LIMITS.jsonBytes &&
				paddedJson.length < WORKSPACE_RANGE_LIMITS.jsonBytes &&
				Buffer.byteLength(paddedJson) > WORKSPACE_RANGE_LIMITS.jsonBytes
			) {
				ranges = candidate;
				break;
			}
		}
		if (!ranges) throw new Error("Cannot construct the UTF-8 range-boundary fixture");
		// Stay under the count budget, cross bytes rather than UTF-16 characters.
		const compact = JSON.stringify({ version: 1, ranges });
		expect(compact.length).toBeLessThan(WORKSPACE_RANGE_LIMITS.jsonBytes);
		expect(Buffer.byteLength(compact)).toBeLessThan(WORKSPACE_RANGE_LIMITS.jsonBytes);
		const oversized = ranges.map((range) => ({
			...range,
			canonicalPath: `${range.canonicalPath}${padding}`,
		}));
		expect(oversized.length).toBeLessThan(WORKSPACE_RANGE_LIMITS.count);
		expect(JSON.stringify({ version: 1, ranges: oversized }).length).toBeLessThan(
			WORKSPACE_RANGE_LIMITS.jsonBytes,
		);
		expect(Buffer.byteLength(JSON.stringify({ version: 1, ranges: oversized }))).toBeGreaterThan(
			WORKSPACE_RANGE_LIMITS.jsonBytes,
		);
		expect(
			buildRevertScopeRanges(
				scope,
				ranges.map((range) => range.canonicalPath),
			),
		).toEqual(ranges);
		const fallback = buildRevertScopeRanges(
			scope,
			oversized.map((range) => range.canonicalPath),
		);
		expect(fallback).toEqual([{ kind: "subtree", canonicalPath: scope.canonicalRoot }]);
		expect(freezeWorkspaceRanges(scope, fallback)).toEqual(fallback);
	});

	test("exact 128 KiB serialized boundary stays precise and one extra byte falls back", async () => {
		await write(join(workspace, "scope-seed.txt"), "seed");
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		if (!scope) throw new Error("Missing scope");
		const ranges = Array.from({ length: 32 }, (_, i) => ({
			kind: "file" as const,
			canonicalPath: join(workspace, `long-${i}-`),
		}));
		const initialBytes = Buffer.byteLength(JSON.stringify({ version: 1, ranges }));
		const padding = Math.floor((WORKSPACE_RANGE_LIMITS.jsonBytes - initialBytes) / ranges.length);
		for (const range of ranges) range.canonicalPath += "x".repeat(padding);
		ranges[0].canonicalPath += "x".repeat(
			WORKSPACE_RANGE_LIMITS.jsonBytes - Buffer.byteLength(JSON.stringify({ version: 1, ranges })),
		);
		expect(Buffer.byteLength(JSON.stringify({ version: 1, ranges }))).toBe(
			WORKSPACE_RANGE_LIMITS.jsonBytes,
		);
		expect(
			buildRevertScopeRanges(
				scope,
				ranges.map((range) => range.canonicalPath),
			),
		).toEqual(ranges);
		ranges[0].canonicalPath += "x";
		expect(
			buildRevertScopeRanges(
				scope,
				ranges.map((range) => range.canonicalPath),
			),
		).toEqual([{ kind: "subtree", canonicalPath: scope.canonicalRoot }]);
	});

	test("fallback never masks an invalid target outside its authorized scope", async () => {
		await write(join(workspace, "scope-seed.txt"), "seed");
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		if (!scope) throw new Error("Missing scope");
		const paths = Array.from({ length: 257 }, (_, i) => join(workspace, `range-${i}`));
		paths[256] = join(root, "outside-scope");
		expect(() => buildRevertScopeRanges(scope, paths)).toThrow("escapes");
		expect(coordinatorState.leases.size).toBe(0);
		expect((await runtime.evidence.getScope(scope.id))?.activeLeaseId).toBeNull();
	});

	test.each([
		"target",
		"scope",
	] as const)("existing %s activity rejects apply without consuming the prepared plan", async (kind) => {
		const targetRoot = join(workspace, "target");
		await fs.mkdir(targetRoot);
		const path = join(targetRoot, "activity.txt");
		await fs.writeFile(path, "original");
		await write(path, "changed");
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		if (!scope) throw new Error("Missing scope");
		const binding = localFileChangeRuntimeBinding("local");
		if (!binding) throw new Error("Missing runtime");
		const activityScope =
			kind === "target"
				? {
						...scope,
						id: generateId(),
						workspaceInstanceId: generateId(),
						canonicalRoot: targetRoot,
						rootIdentityJson: { object: await localDirectoryIdentity(targetRoot) },
					}
				: scope;
		if (kind === "target") db.insert(schema.fileChangeScopes).values(activityScope).run();
		const activity = runtime.coordinator.registerActivity({
			scope: activityScope,
			runtime: binding,
		});
		try {
			// Preview remains read-only and useful while Bash/unknown execution is active.
			const plan = await prepare();
			const before = history();
			const files = journalFiles(plan);
			const failure = await execution(plan).result.catch((error: unknown) => error);
			expect(failure).toMatchObject({ code: "uncoordinated_activity" });
			expect(await fs.readFile(path, "utf8")).toBe("changed");
			expect(history()).toBe(before);
			expect(journalFiles(plan)).toEqual(files);
			expect(operation(plan)?.status).toBe("prepared");
			expect(coordinatorState.leases.size).toBe(0);
			expect((await runtime.evidence.getScope(scope.id))?.activeMutationCount).toBe(0);
		} finally {
			runtime.coordinator.endActivity(activity);
		}
	});

	test("a real registered activity in the last dispatch barrier vetoes an observing native restore", async () => {
		const { a, plan } = await twoFiles();
		const file = journalFiles(plan)[0];
		const scope = await runtime.evidence.getScope(file.scopeId);
		const binding = localFileChangeRuntimeBinding("local");
		const expected = file.expectedStateJson;
		const desired = file.desiredStateJson;
		if (!scope || !binding || expected.kind !== "regular" || desired.kind !== "regular")
			throw new Error("Missing regular-file fixture");
		const before = history();
		const files = journalFiles(plan);
		const mutationId = generateId();
		await runtime.coordinator.withRollback(
			{
				scope,
				runtime: binding,
				activityPolicy: "observe",
				executionClass: "local_file_io",
				ranges: [{ kind: "file", canonicalPath: a }],
			},
			async (lease) => {
				let activity: ReturnType<typeof runtime.coordinator.registerActivity> | undefined;
				try {
					const result = await restoreLocalFile({
						mutationId,
						requestDigest: hash("last-dispatch-activity-regression"),
						backend: localBackend,
						lease,
						scope,
						identity: file.identityJson,
						executionBinding: lease.executionBinding,
						rootObjectIdentity: await localDirectoryIdentity(scope.canonicalRoot),
						expectedObjectIdentity: localObjectIdentity(await fs.lstat(a, { bigint: true })),
						expected,
						desired,
						signal: AbortSignal.timeout(30_000),
						readRuntime: localFileChangeRuntimeBinding,
						async authorize(guard) {
							await access.authorizeFile({
								principal,
								owner,
								identity: file.identityJson,
								signal: guard.signal,
							});
						},
						assertCurrent: () => lease.assertCurrent(),
						readBlob: (ref, options) => namespace.store.readBytes(ref, options),
						onDispatch() {
							lease.registerMutation(mutationId);
							activity = runtime.coordinator.registerActivity({ scope, runtime: binding });
						},
					});
					await result.whenSettled;
					expect(activity).toBeDefined();
					expect(lease.overlappedUncoordinatedActivity).toBe(true);
					expect(result).toMatchObject({
						status: "not_dispatched",
						reason: "guard_failed",
						stats: { dispatches: 0, bytesWritten: 0 },
					});
					expect(await fs.readFile(a, "utf8")).toBe("changed");
					expect(history()).toBe(before);
					expect(journalFiles(plan)).toEqual(files);
				} finally {
					if (activity) runtime.coordinator.endActivity(activity);
					if (lease.pendingMutationCount) lease.settle(mutationId, "not_applied");
				}
			},
		);
		expect(operation(plan)?.status).toBe("prepared");
		expect(coordinatorState.leases.size).toBe(0);
	});

	test("strict rollback rejects new intersecting activity but allows sibling activity", async () => {
		const { a, plan } = await twoFiles();
		const fixed = journalFiles(plan)[0];
		const scope = await runtime.evidence.getScope(fixed.scopeId);
		const binding = localFileChangeRuntimeBinding("local");
		if (!scope || !binding) throw new Error("Missing scope/runtime");
		const siblingRoot = join(workspace, "sibling");
		await fs.mkdir(siblingRoot);
		const siblingPath = join(siblingRoot, "untouched.txt");
		await fs.writeFile(siblingPath, "sibling contents");
		const siblingScope = {
			...scope,
			id: generateId(),
			workspaceInstanceId: generateId(),
			canonicalRoot: siblingRoot,
			rootIdentityJson: { object: await localDirectoryIdentity(siblingRoot) },
		};
		db.insert(schema.fileChangeScopes).values(siblingScope).run();
		const sibling = runtime.coordinator.registerActivity({ scope: siblingScope, runtime: binding });
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		let checked = false;
		const spy = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation((request, body) =>
			original(request, async (batch) => {
				expect(batch.leases[0].activityPolicy).toBe("strict");
				expect(() => runtime.coordinator.registerActivity({ scope, runtime: binding })).toThrow(
					"rollback",
				);
				const brief = runtime.coordinator.registerActivity({
					scope: siblingScope,
					runtime: binding,
				});
				runtime.coordinator.endActivity(brief);
				checked = true;
				return body(batch);
			}),
		);
		restores.push(() => spy.mockRestore());
		try {
			expect((await execution(plan).result).status).toBe("committed");
			expect(checked).toBe(true);
			expect(await fs.readFile(a, "utf8")).toBe("original");
			expect(await fs.readFile(siblingPath, "utf8")).toBe("sibling contents");
		} finally {
			runtime.coordinator.endActivity(sibling);
		}
	});

	test("activity on one member rejects a multi-scope plan without consuming partial leases", async () => {
		const other = join(root, "other");
		await fs.mkdir(other);
		for (const cwd of [workspace, other]) {
			const path = join(cwd, "file.txt");
			await fs.writeFile(path, "original");
			await write(path, "changed", cwd);
		}
		const scopes = db.select().from(schema.fileChangeScopes).limit(3).all();
		expect(scopes).toHaveLength(2);
		const target = scopes.find((scope) => scope.canonicalRoot === other);
		const binding = localFileChangeRuntimeBinding("local");
		if (!target || !binding) throw new Error("Missing scope/runtime");
		const plan = await prepare();
		const before = history();
		const files = journalFiles(plan);
		const activity = runtime.coordinator.registerActivity({ scope: target, runtime: binding });
		try {
			const failure = await execution(plan).result.catch((error: unknown) => error);
			expect(failure).toMatchObject({ code: "uncoordinated_activity" });
			expect(history()).toBe(before);
			expect(journalFiles(plan)).toEqual(files);
			expect(operation(plan)?.status).toBe("prepared");
			expect(coordinatorState.leases.size).toBe(0);
			for (const scope of scopes) {
				expect((await runtime.evidence.getScope(scope.id))?.fencingToken).toBe(scope.fencingToken);
				expect((await runtime.evidence.getScope(scope.id))?.activeLeaseId).toBeNull();
				expect(await fs.readFile(join(scope.canonicalRoot, "file.txt"), "utf8")).toBe("changed");
			}
		} finally {
			runtime.coordinator.endActivity(activity);
		}
	});

	test("real 257-file prepared plan applies under one bounded scope subtree lease", async () => {
		const started = performance.now();
		let previous = started;
		const mark = (stage: string, result?: Awaited<ReturnType<typeof execution>["result"]>) => {
			if (process.env.NF_REVERT_FIXTURE_TIMINGS !== "1") return;
			const now = performance.now();
			console.info("[fixture-257]", {
				stage,
				elapsedMs: Math.round(now - started),
				stageMs: Math.round(now - previous),
				fixtureSetupMs: Math.round(fixtureSetupMs),
				...(result
					? { status: result.status, reason: result.reason, settling: result.settling }
					: {}),
			});
			previous = now;
		};
		mark("fixture_ready");
		setService(makeFixtureTransaction(db, { ...options, timeoutMs: 120_000 }));
		const paths = Array.from({ length: 257 }, (_, i) => join(workspace, `budget-${i}.txt`));
		for (const path of paths) {
			await fs.writeFile(path, "original");
			await write(path, "changed");
		}
		mark("actual_tool_evidence_ready");
		const siblingRoot = join(workspace, "unselected-sibling");
		await fs.mkdir(siblingRoot);
		const siblingPath = join(siblingRoot, "not-in-plan.txt");
		await fs.writeFile(siblingPath, "keep this content");
		const plan = await prepare();
		mark("manifest_prepared");
		expect(plan.expectedFileCount).toBe(257);
		const scope = db.select().from(schema.fileChangeScopes).limit(1).get();
		const binding = localFileChangeRuntimeBinding("local");
		if (!scope || !binding) throw new Error("Missing scope/runtime");
		const siblingScope = {
			...scope,
			id: generateId(),
			workspaceInstanceId: generateId(),
			canonicalRoot: siblingRoot,
			rootIdentityJson: { object: await localDirectoryIdentity(siblingRoot) },
		};
		db.insert(schema.fileChangeScopes).values(siblingScope).run();
		const activity = runtime.coordinator.registerActivity({
			scope: siblingScope,
			runtime: binding,
		});
		const before = history(FILE_CHANGE_LIMITS.revertFiles);
		const files = journalFiles(plan, FILE_CHANGE_LIMITS.revertFiles);
		expect(files).toHaveLength(257);
		try {
			// A large fixed plan tightens admission to its authorized scope, not its mutation set.
			const failure = await execution(plan).result.catch((error: unknown) => error);
			expect(failure).toMatchObject({ code: "uncoordinated_activity" });
			expect(history(FILE_CHANGE_LIMITS.revertFiles)).toBe(before);
			expect(journalFiles(plan, FILE_CHANGE_LIMITS.revertFiles)).toEqual(files);
			for (const path of paths) expect(await fs.readFile(path, "utf8")).toBe("changed");
			expect(operation(plan)?.status).toBe("prepared");
			expect(coordinatorState.leases.size).toBe(0);
		} finally {
			runtime.coordinator.endActivity(activity);
		}
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		let entered = false;
		const spy = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation((request, body) =>
			original(request, async (batch) => {
				expect(batch.leases).toHaveLength(1);
				expect(batch.leases[0].ranges).toEqual([{ kind: "subtree", canonicalPath: workspace }]);
				entered = true;
				return body(batch);
			}),
		);
		restores.push(() => spy.mockRestore());
		mark("activity_rejection_verified");
		const result = await execution(plan).result;
		mark("apply_response", result);
		expect(result.status).toBe("committed");
		expect(entered).toBe(true);
		for (const path of paths) expect(await fs.readFile(path, "utf8")).toBe("original");
		expect(await fs.readFile(siblingPath, "utf8")).toBe("keep this content");
		expect(db.select().from(schema.narratorMessageRefs).limit(1).all()).toHaveLength(0);
		expect(
			db
				.select()
				.from(schema.revertOperationFiles)
				.where(eq(schema.revertOperationFiles.revertOperationId, plan.id))
				.limit(1000)
				.all()
				.every((file) => file.status === "verified"),
		).toBe(true);
		expect(coordinatorState.leases.size).toBe(0);
		mark("all_original_assertions_passed");
	}, 120_000);
});
