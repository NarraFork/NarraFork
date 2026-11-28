import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import { integrationAuthorities } from "@server/db/schema";
import {
	adaptPluginCapability,
	requiresFreshPluginGrant,
} from "@server/lib/integrations/capability-adapters";
import { integrationAuthorityService } from "@server/services/integration-authority-service";
import {
	PluginIntegrationAuthorityService,
	pluginInstallationAuthorityId,
} from "@server/services/plugin-integration-authority-service";
import { seedGrantsFromManifest } from "@server/services/plugin-manager";
import { PluginPermissionStore, permissionSummary } from "@server/services/plugin-permission-store";
import { eq } from "drizzle-orm";

const paths: string[] = [];
const authorities: string[] = [];
const capabilities = ["provider.settings.read_self", "provider.settings.connection.use"];
afterEach(async () => {
	for (const id of authorities.splice(0))
		await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, id));
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(label: string) {
	const pluginId = `com.example.settings-${label}`,
		installationId = `settings-${label}-installation`;
	const id = pluginInstallationAuthorityId(pluginId, installationId);
	authorities.push(id);
	await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, id));
	const root = await mkdtemp(join(tmpdir(), "nf-settings-grants-"));
	paths.push(root);
	const mirror = new PluginPermissionStore({ root });
	await mirror.initialize();
	const service = new PluginIntegrationAuthorityService({ permissionStore: mirror });
	const declarations = capabilities.map((capability, i) => ({
		capability,
		grantId: `legacy-name-${i}`,
		scope: { type: "provider" as const, id: "provider-1" },
		grantedBy: "system",
	}));
	return { pluginId, installationId, id, mirror, service, declarations };
}

describe("new provider settings capability boundary", () => {
	test("adapters describe intent, but installation/enable seeding cannot grant the new methods", () => {
		const summary = { count: 0, capabilities: [], revision: 0 };
		for (const cap of capabilities) {
			expect(adaptPluginCapability(cap)?.id).toBe(cap);
			expect(requiresFreshPluginGrant(cap)).toBe(true);
			expect(seedGrantsFromManifest(summary, [cap])).toBe(summary);
		}
		expect(
			seedGrantsFromManifest(summary, [...capabilities, "diagnostics.readOwnLogs"]).capabilities,
		).toEqual(["diagnostics.readOwnLogs"]);
		const existing = { count: 1, capabilities: ["config.read_self"], revision: 4 };
		expect(seedGrantsFromManifest(existing, [...capabilities, "config.read_self"])).toBe(existing);
		expect(requiresFreshPluginGrant("config.read_self")).toBe(false);
	});
	test("old mirror strings do not acquire new authority during first canonical migration", async () => {
		const f = await fixture("migration");
		const legacy = await f.mirror.replace(
			f.pluginId,
			f.installationId,
			[
				...f.declarations,
				{
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
					grantId: "legacy-diagnostics",
					grantedBy: "system",
				},
			],
			{ expectedRevision: 0, targetRevision: 4, grantedBy: "legacy-admin" },
		);
		const result = await f.service.ensureInstallation(
			f.pluginId,
			f.installationId,
			permissionSummary(legacy.set),
		);
		expect(result.revision).toBe(4);
		expect(result.grants.map((g) => g.capability)).toEqual(["diagnostics.readOwnLogs"]);
		expect(
			(await integrationAuthorityService.requireSnapshot(f.id)).grants.map((g) => g.capabilityId),
		).toEqual(["diagnostics.read"]);
		expect((await f.mirror.getSet(f.pluginId, f.installationId)).grants).toEqual(result.grants);
	});
	test.each([
		false,
		true,
	])("an empty canonical authority cannot be repaired into new permissions (old valid grant=%s)", async (withExisting) => {
		const f = await fixture(withExisting ? "mixed-mirror" : "only-new-mirror");
		await integrationAuthorityService.create({
			id: f.id,
			kind: "plugin_installation",
			integrationId: f.pluginId,
			metadataJson: { installationId: f.installationId },
			initialRevision: 1,
			grants: [],
		});
		const grants = [
			...f.declarations,
			...(withExisting
				? [
						{
							capability: "diagnostics.readOwnLogs",
							scope: { type: "global" as const },
							grantId: "legacy-kept",
							grantedBy: "system",
						},
					]
				: []),
		];
		const legacy = await f.mirror.replace(f.pluginId, f.installationId, grants, {
			expectedRevision: 0,
			targetRevision: 2,
			grantedBy: "legacy-admin",
		});
		const result = await f.service.ensureInstallation(
			f.pluginId,
			f.installationId,
			permissionSummary(legacy.set),
		);
		expect(result.grants.map((g) => g.capability)).toEqual(
			withExisting ? ["diagnostics.readOwnLogs"] : [],
		);
		expect((await f.mirror.getSet(f.pluginId, f.installationId)).grants).toEqual(result.grants);
		expect(
			(await integrationAuthorityService.requireSnapshot(f.id)).grants.some((g) =>
				String(g.capabilityId).startsWith("provider.settings."),
			),
		).toBe(false);
	});
	test("authority projection preserves monotonic file CAS, complete grants and administrator decisions", async () => {
		const f = await fixture("projection-cas");
		const old = await f.mirror.replace(f.pluginId, f.installationId, f.declarations, {
			expectedRevision: 0,
			targetRevision: 5,
			grantedBy: "old-file",
		});
		const pending = await f.mirror.addPendingRequest(f.pluginId, f.installationId, {
			capability: "config.read_self",
			scope: { type: "global" },
		});
		await f.mirror.addPermanentDenial(f.pluginId, f.installationId, {
			capability: "diagnostics.readOwnLogs",
			scope: { type: "global" },
			deniedBy: "fixture-admin",
		});
		const denials = await f.mirror.listPermanentDenials(f.pluginId, f.installationId);
		const authority = {
			...old.set,
			revision: 2,
			grants: [
				{
					...old.set.grants[0],
					revision: 2,
					constraints: { resourceIds: ["provider-1"], maxBytes: 1024 },
					expiresAt: "2099-01-01T00:00:00.000Z",
					grantedBy: "current-admin",
				},
			],
		};
		await f.mirror.mirrorAuthorityGrants(f.pluginId, f.installationId, async () => authority);
		const projected = await f.mirror.getSet(f.pluginId, f.installationId);
		expect(projected.revision).toBe(6);
		expect(projected.grants).toEqual(authority.grants);
		await expect(
			f.mirror.replace(f.pluginId, f.installationId, [], {
				expectedRevision: 5,
				grantedBy: "stale-write",
			}),
		).rejects.toMatchObject({ code: "PERMISSION_REVISION_CONFLICT" });
		await expect(
			f.mirror.replace(f.pluginId, f.installationId, [], {
				expectedRevision: 6,
				targetRevision: 6,
				grantedBy: "same-revision",
			}),
		).rejects.toMatchObject({ code: "PERMISSION_REVISION_CONFLICT" });
		await expect(
			f.mirror.mirrorAuthorityGrants(f.pluginId, f.installationId, async () => ({
				...authority,
				revision: 1,
				grants: [],
			})),
		).rejects.toMatchObject({ code: "PERMISSION_REVISION_CONFLICT" });
		const reloaded = new PluginPermissionStore({ root: f.mirror.root });
		expect(await reloaded.getSet(f.pluginId, f.installationId)).toEqual(projected);
		expect(await reloaded.listPendingRequests(f.pluginId, f.installationId)).toEqual([pending]);
		expect(await reloaded.listPermanentDenials(f.pluginId, f.installationId)).toEqual(denials);
		await reloaded.mirrorAuthorityGrants(f.pluginId, f.installationId, async () => authority);
		expect(await reloaded.getSet(f.pluginId, f.installationId)).toEqual(projected);
	});

	test("projection reads current authority under the file lock and never rolls back another installation", async () => {
		const f = await fixture("projection-concurrency");
		const otherId = "other-installation";
		const other = await f.mirror.replace(f.pluginId, otherId, f.declarations, {
			targetRevision: 50,
			grantedBy: "other-admin",
		});
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const empty = {
			pluginId: f.pluginId,
			installationId: f.installationId,
			revision: 2,
			grants: [],
			updatedAt: new Date().toISOString(),
		};
		const first = f.mirror.mirrorAuthorityGrants(f.pluginId, f.installationId, async () => {
			entered();
			await gate;
			return empty;
		});
		await ready;
		let secondRead = false;
		const second = f.mirror.mirrorAuthorityGrants(f.pluginId, f.installationId, async () => {
			secondRead = true;
			return { ...empty, revision: 3 };
		});
		expect(secondRead).toBe(false);
		release();
		await Promise.all([first, second]);
		expect((await f.mirror.getSet(f.pluginId, f.installationId)).revision).toBe(52);
		expect((await f.mirror.getSet(f.pluginId, otherId)).grants).toEqual(other.set.grants);
		await expect(
			f.mirror.replace(f.pluginId, otherId, [], { expectedRevision: 50, grantedBy: "stale-other" }),
		).rejects.toMatchObject({ code: "PERMISSION_REVISION_CONFLICT" });
	});

	test("a delayed authority caller projects the latest revoked state rather than its captured grants", async () => {
		const f = await fixture("delayed-snapshot");
		const initial = await f.service.ensureInstallation(f.pluginId, f.installationId, {
			count: 0,
			capabilities: [],
			revision: 0,
		});
		const approved = await f.service.replace(f.pluginId, f.installationId, f.declarations, {
			expectedRevision: initial.revision,
			grantedBy: "current-admin",
		});
		const original = f.mirror.mirrorAuthorityGrants.bind(f.mirror);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const spy = spyOn(f.mirror, "mirrorAuthorityGrants").mockImplementationOnce(async (...args) => {
			entered();
			await gate;
			await original(...args);
		});
		try {
			const delayed = f.service.ensureInstallation(
				f.pluginId,
				f.installationId,
				permissionSummary(approved.set),
			);
			await ready;
			await f.service.revoke(
				f.pluginId,
				f.installationId,
				approved.set.grants.map((g) => g.grantId),
				{ expectedRevision: approved.set.revision, grantedBy: "current-admin" },
			);
			release();
			await delayed;
			expect((await f.mirror.getSet(f.pluginId, f.installationId)).grants).toEqual([]);
		} finally {
			release();
			spy.mockRestore();
		}
	});

	test("current explicit grants persist, and a stale mirror cannot resurrect them after revocation", async () => {
		const f = await fixture("explicit");
		const initial = await f.service.ensureInstallation(f.pluginId, f.installationId, {
			count: 0,
			capabilities: [],
			revision: 0,
		});
		const approved = await f.service.replace(
			f.pluginId,
			f.installationId,
			f.declarations.map((g) => ({ ...g, grantedBy: "current-admin" })),
			{ expectedRevision: initial.revision, grantedBy: "current-admin" },
		);
		expect(approved.set.grants.map((g) => g.capability).sort()).toEqual([...capabilities].sort());
		expect(
			await f.service.ensureInstallation(f.pluginId, f.installationId, {
				count: 0,
				capabilities: [],
				revision: 0,
			}),
		).toEqual(approved.set);
		const revoked = await f.service.revoke(
			f.pluginId,
			f.installationId,
			approved.set.grants.map((g) => g.grantId),
			{ expectedRevision: approved.set.revision, grantedBy: "current-admin" },
		);
		expect(revoked.set.grants).toEqual([]);
		await f.mirror.replace(f.pluginId, f.installationId, f.declarations, {
			expectedRevision: revoked.set.revision,
			grantedBy: "stale-file",
		});
		const reloaded = await new PluginIntegrationAuthorityService({
			permissionStore: f.mirror,
		}).ensureInstallation(f.pluginId, f.installationId, { count: 2, capabilities, revision: 1 });
		expect(reloaded.grants).toEqual([]);
		expect(reloaded.revision).toBe(revoked.set.revision);
		expect((await f.mirror.getSet(f.pluginId, f.installationId)).grants).toEqual([]);
	});
});
