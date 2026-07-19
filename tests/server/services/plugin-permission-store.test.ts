import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PluginPermissionConflictError,
	PluginPermissionStore,
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
});
