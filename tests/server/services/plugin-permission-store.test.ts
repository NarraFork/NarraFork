import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PluginPermissionConflictError,
	PluginPermissionStore,
	type PluginPermissionRequest,
} from "@server/services/plugin-permission-store";
import { PluginStateStore } from "@server/services/plugin-state-store";

const tempRoots: string[] = [];
const installationId = "a".repeat(64);

async function makeStores() {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-permissions-"));
	tempRoots.push(root);
	const stateStore = new PluginStateStore(root);
	await stateStore.updateState("com.example.permissions", {
		current: { version: "1.0.0", hash: installationId },
		compatibility: "compatible",
	});
	const permissionStore = new PluginPermissionStore({
		root,
		stateStore,
		now: () => new Date("2026-07-18T12:00:00.000Z"),
	});
	return { root, stateStore, permissionStore };
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginPermissionStore", () => {
	test("persists complete grants per installation and mirrors only the bounded summary", async () => {
		const { root, stateStore, permissionStore } = await makeStores();
		const replaced = await permissionStore.replace(
			"com.example.permissions",
			installationId,
			[
				{
					grantId: "grant-projects",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: {
						fields: ["id", "name"],
						resourceIds: ["project-1"],
						maxRatePerSecond: 10,
						maxBytes: 4096,
					},
					expiresAt: "2026-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
				},
			],
			{ expectedRevision: 0, grantedBy: "ignored-default" },
		);

		expect(replaced.changed).toBe(true);
		expect(replaced.set).toMatchObject({
			pluginId: "com.example.permissions",
			installationId: installationId,
			revision: 1,
			updatedAt: "2026-07-18T12:00:00.000Z",
		});
		expect(replaced.set.grants).toEqual([
			{
				pluginId: "com.example.permissions",
				installationId: installationId,
				grantId: "grant-projects",
				capability: "query.read.projects",
				scope: { type: "project", id: "project-1" },
				constraints: {
					fields: ["id", "name"],
					resourceIds: ["project-1"],
					maxRatePerSecond: 10,
					maxBytes: 4096,
				},
				expiresAt: "2026-08-18T12:00:00.000Z",
				grantedBy: "admin-user-1",
				revision: 1,
			},
		]);
		expect((await stateStore.getState("com.example.permissions"))?.grants).toEqual({
			count: 1,
			capabilities: ["query.read.projects"],
			revision: 1,
			updatedAt: "2026-07-18T12:00:00.000Z",
		});

		const reloaded = new PluginPermissionStore({ root, stateStore });
		expect(await reloaded.getSet("com.example.permissions", installationId)).toEqual(replaced.set);
		const document = JSON.parse(await readFile(join(root, "permissions.json"), "utf8"));
		expect(document.plugins["com.example.permissions"][installationId].grants[0]).toMatchObject({
			grantId: "grant-projects",
			grantedBy: "admin-user-1",
			revision: 1,
		});
		if (process.platform !== "win32") {
			expect((await stat(join(root, "permissions.json"))).mode & 0o777).toBe(0o600);
		}
	});

	test("enforces revision CAS under concurrency and advances revision when grants are revoked", async () => {
		const { stateStore, permissionStore } = await makeStores();
		const candidates = ["query.read.projects", "query.read.chapters"] as const;
		const results = await Promise.allSettled(
			candidates.map((capability, index) =>
				permissionStore.replace(
					"com.example.permissions",
					installationId,
					[
						{
							grantId: `grant-${index}`,
							capability,
							scope: { type: "global" },
							grantedBy: "admin-user-1",
						},
					],
					{ expectedRevision: 0, grantedBy: "admin-user-1" },
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
			PluginPermissionConflictError,
		);

		const current = await permissionStore.getSet("com.example.permissions", installationId);
		const grantId = current.grants[0]?.grantId;
		if (!grantId) throw new Error("Concurrent grant write did not persist a grant");
		await expect(
			permissionStore.revoke("com.example.permissions", installationId, [grantId], {
				expectedRevision: 0,
				grantedBy: "admin-user-1",
			}),
		).rejects.toMatchObject({
			code: "PERMISSION_REVISION_CONFLICT",
			actualRevision: 1,
		});

		const revoked = await permissionStore.revoke(
			"com.example.permissions",
			installationId,
			[grantId],
			{ expectedRevision: 1, grantedBy: "admin-user-1" },
		);
		expect(revoked.set).toMatchObject({ revision: 2, grants: [] });
		expect((await stateStore.getState("com.example.permissions"))?.grants).toMatchObject({
			count: 0,
			capabilities: [],
			revision: 2,
		});
	});

	test("uses one plugin revision while preserving complete package-specific grant sets", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.replace(
			"com.example.permissions",
			installationId,
			[
				{
					grantId: "grant-old",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: { fields: ["id"], resourceIds: ["project-1"] },
					expiresAt: "2026-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
				},
			],
			{ expectedRevision: 0, grantedBy: "admin-user-1" },
		);
		const copied = await permissionStore.ensureInstallation(
			"com.example.permissions",
			"installation-2",
			installationId,
		);
		expect(copied).toMatchObject({
			revision: 1,
			grants: [
				{
					grantId: "grant-old",
					scope: { type: "project", id: "project-1" },
					constraints: { fields: ["id"], resourceIds: ["project-1"] },
					expiresAt: "2026-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
					revision: 1,
					installationId: "installation-2",
				},
			],
		});
		await permissionStore.replace(
			"com.example.permissions",
			"installation-2",
			[
				{
					grantId: "grant-new",
					capability: "query.read.chapters",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
			{ expectedRevision: 1, grantedBy: "admin-user-1" },
		);

		const oldPackage = await permissionStore.getSet("com.example.permissions", installationId);
		const newPackage = await permissionStore.getSet("com.example.permissions", "installation-2");
		expect(oldPackage.revision).toBe(2);
		expect(oldPackage.grants[0]).toMatchObject({ grantId: "grant-old", revision: 1 });
		expect(newPackage).toMatchObject({
			revision: 2,
			grants: [{ grantId: "grant-new", revision: 2 }],
		});
		await expect(
			permissionStore.replace("com.example.permissions", installationId, oldPackage.grants, {
				expectedRevision: 1,
				grantedBy: "admin-user-1",
			}),
		).rejects.toMatchObject({
			code: "PERMISSION_REVISION_CONFLICT",
			actualRevision: 2,
		});
		expect(await permissionStore.clearPlugin("com.example.permissions")).toBe(true);
		expect(await permissionStore.listSets("com.example.permissions")).toEqual([]);
	});

	test("addPendingRequest creates a pending request with correct fields and persists to file", async () => {
		const { root, permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		const input = {
			capability: "query.read.projects",
			scope: { type: "project" as const, id: "project-1" },
			requestedByRuntimeId: "runtime-abc",
		};
		const request = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			input,
		);

		expect(request).toMatchObject({
			capability: "query.read.projects",
			scope: { type: "project", id: "project-1" },
			requestedByRuntimeId: "runtime-abc",
			status: "pending",
		});
		expect(request.requestId).toBeString();
		expect(request.requestId.length).toBeGreaterThanOrEqual(1);
		expect(request.requestedAt).toBe("2026-07-18T12:00:00.000Z");
		expect(request.resolvedAt).toBeUndefined();

		// Verify via listPendingRequests
		const pending = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toEqual(request);

		// Persisted to file → reload and verify
		const reloaded = new PluginPermissionStore({ root });
		const reloadedPending = await reloaded.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(reloadedPending).toHaveLength(1);
		expect(reloadedPending[0]).toEqual(request);
	});

	test("addPendingRequest is idempotent for same capability + scope with pending status", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		const input = {
			capability: "query.read.chapters",
			scope: { type: "global" as const },
		};
		const first = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			input,
		);
		const second = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			input,
		);

		expect(second.requestId).toBe(first.requestId);
		expect(second).toEqual(first);

		const pending = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pending).toHaveLength(1);
	});

	test("addPendingRequest throws ValidationError when pending count reaches 20", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		// Add 20 pending requests with distinct capabilities
		for (let i = 0; i < 20; i++) {
			await permissionStore.addPendingRequest("com.example.permissions", installationId, {
				capability: `test.capability.c${i}`,
				scope: { type: "global" as const },
			});
		}

		const pending = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pending).toHaveLength(20);

		// 21st should throw
		await expect(
			permissionStore.addPendingRequest("com.example.permissions", installationId, {
				capability: "test.capability.overflow",
				scope: { type: "global" as const },
			}),
		).rejects.toThrow("Too many pending permission requests");
	});

	test("resolvePendingRequest sets status and resolvedAt; resolved requests are excluded from list", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		const input = {
			capability: "query.read.projects",
			scope: { type: "global" as const },
		};
		const request = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			input,
		);

		// Grant it
		const granted = await permissionStore.resolvePendingRequest(
			"com.example.permissions",
			installationId,
			request.requestId,
			"granted",
		);
		expect(granted).not.toBeUndefined();
		expect(granted!.status).toBe("granted");
		expect(granted!.resolvedAt).toBe("2026-07-18T12:00:00.000Z");
		expect(granted!.requestId).toBe(request.requestId);

		// No longer returned by listPendingRequests
		const pending = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pending).toHaveLength(0);

		// Add another and deny it
		const request2 = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			{ capability: "query.read.chapters", scope: { type: "global" as const } },
		);
		const denied = await permissionStore.resolvePendingRequest(
			"com.example.permissions",
			installationId,
			request2.requestId,
			"denied",
		);
		expect(denied!.status).toBe("denied");
		expect(denied!.resolvedAt).toBe("2026-07-18T12:00:00.000Z");

		const pendingAfter = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pendingAfter).toHaveLength(0);
	});

	test("resolvePendingRequest returns undefined for unknown requestId", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		const result = await permissionStore.resolvePendingRequest(
			"com.example.permissions",
			installationId,
			"nonexistent-id",
			"granted",
		);
		expect(result).toBeUndefined();
	});

	test("resolvePendingRequest returns undefined for unknown installation", async () => {
		const { permissionStore } = await makeStores();

		const result = await permissionStore.resolvePendingRequest(
			"com.example.permissions",
			"nonexistent-installation",
			"any-id",
			"granted",
		);
		expect(result).toBeUndefined();
	});

	test("listPendingRequests returns [] for old-format document without pendingRequests field", async () => {
		const { root } = await makeStores();
		// Write an old-format permissions.json that lacks pendingRequests
		const oldDoc = {
			version: 1,
			plugins: {
				"com.example.permissions": {
					[installationId]: {
						pluginId: "com.example.permissions",
						installationId,
						revision: 1,
						grants: [
							{
								grantId: "grant-legacy",
								capability: "query.read.projects",
								scope: { type: "global" },
								grantedBy: "admin",
								pluginId: "com.example.permissions",
								installationId,
								revision: 1,
							},
						],
						updatedAt: "2026-07-18T12:00:00.000Z",
					},
				},
			},
			diagnostics: [],
			updatedAt: "2026-07-18T12:00:00.000Z",
		};
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await writeFile(join(root, "permissions.json"), JSON.stringify(oldDoc, null, 2), "utf8");

		const permissionStore = new PluginPermissionStore({
			root,
			now: () => new Date("2026-07-18T12:00:00.000Z"),
		});

		const result = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(result).toEqual([]);

		// Also non-existent plugin/installation returns []
		const result2 = await permissionStore.listPendingRequests(
			"com.example.nonexistent",
			installationId,
		);
		expect(result2).toEqual([]);
	});

	test("addPendingRequest validates capability and scope via schemas", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		// Invalid capability (empty)
		await expect(
			permissionStore.addPendingRequest("com.example.permissions", installationId, {
				capability: "",
				scope: { type: "global" as const },
			}),
		).rejects.toThrow("Invalid capability");

		// Invalid scope (global with id)
		await expect(
			permissionStore.addPendingRequest("com.example.permissions", installationId, {
				capability: "query.read.projects",
				scope: { type: "global" as const, id: "should-not-have-id" },
			}),
		).rejects.toThrow("Invalid permission scope");

		// Invalid scope (non-global without id)
		await expect(
			permissionStore.addPendingRequest("com.example.permissions", installationId, {
				capability: "query.read.projects",
				scope: { type: "project" as const },
			}),
		).rejects.toThrow("Invalid permission scope");
	});

	test("pending requests survive replace operations", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		const request = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			{
				capability: "query.read.projects",
				scope: { type: "global" as const },
			},
		);

		// Perform a replace (which should preserve pending requests)
		await permissionStore.replace(
			"com.example.permissions",
			installationId,
			[
				{
					grantId: "grant-new",
					capability: "query.read.chapters",
					scope: { type: "global" },
					grantedBy: "admin",
				},
			],
			{ expectedRevision: 0 },
		);

		const pending = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.requestId).toBe(request.requestId);
	});

	test("idempotent add does not count duplicates toward limit", async () => {
		const { permissionStore } = await makeStores();
		await permissionStore.ensureInstallation("com.example.permissions", installationId);

		const sharedInput = {
			capability: "query.read.projects",
			scope: { type: "global" as const },
		};

		// Add the first one
		const first = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			sharedInput,
		);

		// Add 19 more unique pending requests (total 20)
		for (let i = 0; i < 19; i++) {
			await permissionStore.addPendingRequest("com.example.permissions", installationId, {
				capability: `test.capability.c${i}`,
				scope: { type: "global" as const },
			});
		}

		const pending = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pending).toHaveLength(20);

		// Duplicate of the first one should succeed (idempotent, not a new request)
		const dup = await permissionStore.addPendingRequest(
			"com.example.permissions",
			installationId,
			sharedInput,
		);
		expect(dup.requestId).toBe(first.requestId);

		const pendingAfter = await permissionStore.listPendingRequests(
			"com.example.permissions",
			installationId,
		);
		expect(pendingAfter).toHaveLength(20);
	});
});
