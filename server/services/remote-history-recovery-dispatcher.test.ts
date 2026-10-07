import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldTick } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import * as schema from "../db/schema";
import { resolveBackend } from "../lib/agent/execution/registry";
import { generateId } from "../lib/id";
import { startNativeRemoteExecutorFixture } from "./__tests__/native-remote-executor-fixture";
import { getDeviceConnectionGeneration } from "./device-connection-service";
import { createDevice } from "./device-service";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { SQLiteRemoteHistoryMetadataStore } from "./remote-history-journal";
import {
	captureRemoteRecoveryAuthProvenance,
	withRemoteRecoveryAuthProvenance,
} from "./remote-history-recovery-auth";
import {
	enqueueAuthenticatedRemoteHistoryRecovery,
	RemoteHistoryRecoveryDispatcher,
	type RemoteRecoveryPassSummary,
	startRemoteHistoryRecoveryDispatcher,
} from "./remote-history-recovery-dispatcher";
import {
	authorizeRemoteHistoryTarget,
	RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
for (const scenario of [
	"reconnect",
	"connected_startup",
	"missing_auth",
	"revoked_session",
	"revoked_path",
	"replaced_source",
	"page_budget",
] as const) {
	test.skipIf(process.platform !== "linux")(
		`official native authenticated recovery ${scenario}`,
		async () => {
			const directory = await mkdtemp(join(testEnvironment.isolatedHome, "auto-native-recovery-"));
			const root = join(directory, "root");
			const userId = generateId();
			const narratorId = generateId();
			const now = new Date().toISOString();
			let native: Awaited<ReturnType<typeof startNativeRemoteExecutorFixture>> | undefined;
			let stop: (() => Promise<void>) | undefined;
			try {
				await mkdir(root);
				await writeFile(join(root, "a.txt"), "before\n", { mode: 0o600 });
				db.insert(schema.users)
					.values({
						id: userId,
						username: userId,
						passwordHash: "fixture-not-secret",
						createdAt: now,
					})
					.run();
				const device = await createDevice({
					name: `Recovery ${userId}`,
					createdBy: userId,
					ownerScope: "private",
					scope: "global",
					connectionMode: "reverse",
				});
				native = await startNativeRemoteExecutorFixture({
					directory,
					root,
					deviceId: device.device.id,
					token: device.token,
				});
				const initialGeneration = native.backend.runtimeGeneration;
				db.insert(schema.narrators)
					.values({
						id: narratorId,
						ownerUserId: userId,
						cwd: root,
						defaultDeviceId: device.device.id,
						workspaceContext: {
							revision: 0,
							deviceId: device.device.id,
							cwd: root,
							pathFlavor: "posix",
							contextKey: `auto:${userId}`,
							capabilities: { switchDirectory: true },
						},
						permissionMode: "bypassPermissions",
						createdAt: now,
						updatedAt: now,
					})
					.run();
				let allowed = true;
				const registry = new RemoteWorkspaceHistoryRuntime({
					db,
					auditRuntime: await getDefaultLocalFileChangeRuntime(),
					backend: (id) => resolveBackend({ requested: id }),
					metadataStore: new SQLiteRemoteHistoryMetadataStore(db),
					authorize: async (...args) => {
						if (!allowed) throw new Error("Original path authorization revoked");
						await authorizeRemoteHistoryTarget(...args);
					},
				});
				const actor = { userId, narratorId, projectId: null, kind: "human" as const };
				const endpoint = await registry.resolve(
					actor,
					{
						deviceId: device.device.id,
						cwd: root,
						lexicalPath: join(root, "a.txt"),
						canonicalPath: join(root, "a.txt"),
						runtimeGeneration: initialGeneration,
					},
					"write",
					AbortSignal.timeout(10_000),
				);
				const proof = captureRemoteRecoveryAuthProvenance({
					type: "session",
					user: {
						sub: userId,
						role: "user",
						iat: Math.floor(Date.now() / 1000),
						exp: Math.floor(Date.now() / 1000) + 600,
					},
				});
				native.dropNextMutationReply();
				const write = () =>
					endpoint.runtime.execute({
						identity: endpoint.identity,
						operationId: `editor:${userId}`,
						requestDigest: hash(userId),
						signal: AbortSignal.timeout(600),
						authorize: async () => {},
						construct: () => ({ nextBytes: Buffer.from("native-after\n"), result: true }),
						commit: async () => {
							throw new Error("Lost real reply cannot commit in the caller");
						},
					});
				const failure = await (scenario === "missing_auth"
					? write()
					: withRemoteRecoveryAuthProvenance(proof, write)
				).then(
					() => undefined,
					(error) => error,
				);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toContain("unknown");
				expect(native.droppedReceipt?.state).toBe("settled");
				const original = db
					.select({
						id: schema.workspaceWriteLeases.leaseId,
						scopeId: schema.workspaceWriteLeases.scopeId,
						status: schema.workspaceWriteLeases.status,
					})
					.from(schema.workspaceWriteLeases)
					.where(eq(schema.workspaceWriteLeases.deviceId, device.device.id))
					.limit(2)
					.all();
				expect(original).toHaveLength(1);
				expect(original[0].status).toBe("quarantined");
				if (scenario === "revoked_session")
					db.update(schema.users).set({ tokenVersion: 1 }).where(eq(schema.users.id, userId)).run();
				if (scenario === "revoked_path") allowed = false;
				if (scenario === "replaced_source")
					await rename(
						join(directory, "executor-private"),
						join(directory, "original-executor-private"),
					);
				if (scenario === "page_budget") {
					const lease = db
						.select()
						.from(schema.workspaceWriteLeases)
						.where(eq(schema.workspaceWriteLeases.leaseId, original[0].id))
						.get();
					if (!lease) throw new Error("Original lease required");
					for (let index = 0; index < 90; index++)
						db.insert(schema.workspaceWriteLeases)
							.values({
								...lease,
								leaseId: `~budget-${String(index).padStart(3, "0")}-${userId}`,
								mutationManifestJson: {
									version: 1,
									mutations: [{ mutationId: `unknown-${index}`, outcome: "unknown" }],
								},
							})
							.run();
				}
				let finish!: (summary: RemoteRecoveryPassSummary) => void;
				const finished = new Promise<RemoteRecoveryPassSummary>((resolve) => {
					finish = resolve;
				});
				let clock = Date.now();
				stop = startRemoteHistoryRecoveryDispatcher({
					registry: async () => registry,
					generation: getDeviceConnectionGeneration,
					now: () => clock,
					onSummary: (summary) => {
						if (summary.released || summary.manual) finish(summary);
					},
				});
				if (scenario !== "connected_startup" && scenario !== "page_budget") {
					await native.restartFixtureChild();
					clock += 60_001;
					const generation = getDeviceConnectionGeneration(device.device.id);
					if (generation === null) throw new Error("Real authenticated connection required");
					expect(generation).toBeGreaterThan(initialGeneration);
					expect(
						enqueueAuthenticatedRemoteHistoryRecovery(device.device.id, initialGeneration),
					).toBe(false);
					expect(enqueueAuthenticatedRemoteHistoryRecovery(device.device.id, generation)).toBe(
						true,
					);
				}
				const summary = await finished;
				await stop();
				stop = undefined;
				const after = db
					.select({ status: schema.workspaceWriteLeases.status })
					.from(schema.workspaceWriteLeases)
					.where(eq(schema.workspaceWriteLeases.leaseId, original[0].id))
					.get();
				if (
					scenario === "reconnect" ||
					scenario === "connected_startup" ||
					scenario === "page_budget"
				) {
					expect(summary.released).toBe(1);
					expect(after?.status).toBe("recovered");
					expect(
						db
							.select({ settlement: schema.fileChangeOperations.settlement })
							.from(schema.fileChangeOperations)
							.where(eq(schema.fileChangeOperations.ownerUserId, userId))
							.limit(2)
							.all()[0]?.settlement,
					).toBe("settled");
				} else {
					expect(summary.manual).toBeGreaterThan(0);
					expect(after?.status).toBe("quarantined");
				}
				if (scenario === "page_budget") {
					expect(summary.visited).toBe(64);
					expect(summary.budgetReached).toBe(true);
				}
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("native-after\n");
				expect(native.trace.filter((rpc) => rpc.method === "history.mutate")).toHaveLength(1);
			} finally {
				await stop?.();
				await native?.dispose();
				db.delete(schema.narrators).where(eq(schema.narrators.id, narratorId)).run();
				db.delete(schema.users).where(eq(schema.users.id, userId)).run();
				await rm(directory, { recursive: true, force: true });
			}
		},
		90_000,
	);
}

test("queue admission caps devices/active providers, generation replacement cancels and stop drains", async () => {
	const waiting: ((error: Error) => void)[] = [];
	let opened = 0;
	let admit!: () => void;
	const firstTwo = new Promise<void>((resolve) => {
		admit = resolve;
	});
	const generations = new Map<string, number>();
	const dispatcher = new RemoteHistoryRecoveryDispatcher({
		generation: (id) => generations.get(id) ?? null,
		registry: () =>
			new Promise<never>((_resolve, reject) => {
				waiting.push(reject);
				if (++opened === 2) admit();
			}),
	});
	for (let index = 0; index < 64; index++) {
		const id = `device-${index}`;
		generations.set(id, 1);
		expect(dispatcher.enqueue(id, 1)).toBe(true);
	}
	generations.set("overflow", 1);
	expect(dispatcher.enqueue("overflow", 1)).toBe(false);
	await firstTwo;
	expect(opened).toBe(2);
	expect(dispatcher.enqueue("device-0", 1)).toBe(true);
	generations.set("device-0", 2);
	expect(dispatcher.enqueue("device-0", 1)).toBe(false);
	expect(dispatcher.enqueue("device-0", 2)).toBe(true);
	const stopping = dispatcher.stop();
	for (const reject of waiting) reject(new Error("Provider cancelled during shutdown"));
	await stopping;
	await yieldTick();
	expect(opened).toBe(2);
	expect(dispatcher.enqueue("device-0", 2)).toBe(false);
});
