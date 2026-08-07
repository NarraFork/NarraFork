import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import { integrationAuthorities, integrationCapabilityGrants } from "@server/db/schema";
import { integrationAuthorityService } from "@server/services/integration-authority-service";
import { CapabilityBroker, type HostCallContext } from "@server/services/plugin-capability-broker";
import {
	PluginIntegrationAuthorityService,
	pluginInstallationAuthorityId,
} from "@server/services/plugin-integration-authority-service";
import { PluginPermissionStore, permissionSummary } from "@server/services/plugin-permission-store";
import { eq } from "drizzle-orm";

const roots: string[] = [];
const authorityIds = new Set<string>();

async function cleanupAuthority(authorityId: string): Promise<void> {
	await db
		.delete(integrationCapabilityGrants)
		.where(eq(integrationCapabilityGrants.authorityId, authorityId));
	await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, authorityId));
}

afterEach(async () => {
	for (const authorityId of authorityIds) await cleanupAuthority(authorityId);
	authorityIds.clear();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginIntegrationAuthorityService", () => {
	test("migrates once, uses authority CAS, and never revives revoked installations", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-authority-"));
		roots.push(root);
		const pluginId = "com.example.authoritymigration";
		const installationId = "installation-hash-authority-migration";
		const authorityId = pluginInstallationAuthorityId(pluginId, installationId);
		authorityIds.add(authorityId);
		await cleanupAuthority(authorityId);

		const permissionStore = new PluginPermissionStore({ root });
		await permissionStore.initialize();
		const legacy = await permissionStore.replace(
			pluginId,
			installationId,
			[
				{
					grantId: "legacy-project-read",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: {
						fields: ["id", "name"],
						providerInstanceIds: ["provider-1"],
						resourceIds: ["project-1"],
					},
					expiresAt: "2027-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
				},
			],
			{ expectedRevision: 0, targetRevision: 4, grantedBy: "admin-user-1" },
		);
		const service = new PluginIntegrationAuthorityService({ permissionStore });
		const migrated = await service.ensureInstallation(
			pluginId,
			installationId,
			permissionSummary(legacy.set),
		);

		expect(authorityId.length).toBeLessThanOrEqual(128);
		expect(migrated).toMatchObject({
			pluginId,
			installationId,
			revision: 4,
			grants: [
				{
					grantId: "legacy-project-read",
					capability: "query.read.projects",
					scope: { type: "project", id: "project-1" },
					constraints: {
						fields: ["id", "name"],
						providerInstanceIds: ["provider-1"],
						resourceIds: ["project-1"],
					},
					expiresAt: "2027-08-18T12:00:00.000Z",
					grantedBy: "admin-user-1",
				},
			],
		});
		const authority = await service.authorityService.requireSnapshot(authorityId, {
			includeExpired: true,
		});
		expect(authority.authority).toMatchObject({
			id: authorityId,
			kind: "plugin_installation",
			integrationType: "plugin",
			integrationId: pluginId,
			revision: 4,
			metadataJson: { installationId },
		});
		expect(authority.grants[0]).toMatchObject({
			capabilityId: "project.read",
			scopeType: "project",
			scopeId: "project-1",
			constraintsJson: {
				fields: ["id", "name"],
				providerIds: ["provider-1"],
				resourceIds: ["project-1"],
			},
			expiresAt: "2027-08-18T12:00:00.000Z",
			createdById: "admin-user-1",
		});

		await permissionStore.replace(pluginId, installationId, [], {
			expectedRevision: 4,
			targetRevision: 5,
			grantedBy: "legacy-file-editor",
		});
		const authorityWins = await service.ensureInstallation(pluginId, installationId, {
			count: 0,
			capabilities: [],
			revision: 5,
			updatedAt: new Date().toISOString(),
		});
		expect(authorityWins).toEqual(migrated);

		const replaced = await service.replace(
			pluginId,
			installationId,
			[
				{
					grantId: "diagnostics-grant",
					capability: "diagnostics.readOwnLogs",
					scope: { type: "global" },
				},
			],
			{ expectedRevision: 4, grantedBy: "admin-user-2" },
		);
		expect(replaced.set).toMatchObject({
			revision: 5,
			grants: [{ grantId: "diagnostics-grant", grantedBy: "admin-user-2" }],
		});
		await expect(
			service.replace(pluginId, installationId, [], {
				expectedRevision: 4,
				grantedBy: "stale-admin",
			}),
		).rejects.toMatchObject({ code: "PERMISSION_REVISION_CONFLICT" });

		const revokedGrant = await service.revoke(pluginId, installationId, ["diagnostics-grant"], {
			expectedRevision: 5,
			grantedBy: "admin-user-2",
		});
		expect(revokedGrant.set).toMatchObject({ revision: 6, grants: [] });
		await service.revokePlugin(pluginId, "test uninstall");
		expect((await service.authorityService.requireSnapshot(authorityId)).authority).toMatchObject({
			state: "revoked",
			revision: 7,
		});
		await expect(
			service.ensureInstallation(pluginId, installationId, permissionSummary(revokedGrant.set)),
		).rejects.toThrow(/cannot be reactivated/i);

		const reinstalled = await service.ensureInstallation(
			pluginId,
			installationId,
			{
				count: 1,
				capabilities: ["diagnostics.readOwnLogs"],
				revision: 1,
			},
			undefined,
			{ replaceRevoked: true },
		);
		expect(reinstalled.installationId).not.toBe(installationId);
		expect(reinstalled.grants.map((grant) => grant.capability)).toEqual([
			"diagnostics.readOwnLogs",
		]);
		const replacementAuthorityId = pluginInstallationAuthorityId(
			pluginId,
			reinstalled.installationId,
		);
		authorityIds.add(replacementAuthorityId);
		expect((await service.authorityService.requireSnapshot(authorityId)).authority.state).toBe(
			"revoked",
		);
		expect(
			(await service.authorityService.requireSnapshot(replacementAuthorityId)).authority.state,
		).toBe("active");
	});

	test("requires the live authority final gate even when the legacy broker cache allows", async () => {
		const pluginId = "com.example.kernelfinalgate";
		const installationId = "installation-kernel-final-gate";
		const authorityId = pluginInstallationAuthorityId(pluginId, installationId);
		authorityIds.add(authorityId);
		await cleanupAuthority(authorityId);
		await integrationAuthorityService.create({
			id: authorityId,
			kind: "plugin_installation",
			integrationType: "plugin",
			integrationId: pluginId,
			metadataJson: { installationId },
			grants: [
				{
					capabilityId: "diagnostics.read",
					scope: { type: "global" },
					createdBy: { type: "system" },
				},
			],
		});

		const principal = {
			pluginId,
			packageVersion: "1.0.0",
			runtimeId: "runtime-kernel-final-gate",
			runtimeGeneration: 1,
			installationId,
		} as const;
		const legacyCapability = "diagnostics.readOwnLogs" as const;
		const broker = new CapabilityBroker({
			kernelEnforcement: true,
			cacheTtlMs: 60_000,
			bindings: [
				{
					plugin: principal,
					desiredState: "enabled",
					compatibilityState: "compatible",
					runtimeState: "active",
					manifestRequested: [legacyCapability],
					installationGrants: [{ capability: legacyCapability, scope: { type: "global" } }],
					hostPolicy: [legacyCapability],
					currentUserAuthority: [legacyCapability],
					contributionPolicy: [legacyCapability],
					runnerEnforcement: [legacyCapability],
					grantRevision: 1,
				},
			],
		});
		const context: HostCallContext = {
			requestId: "request-kernel-final-gate",
			correlationId: "correlation-kernel-final-gate",
			deadlineAt: "2099-01-01T00:00:00.000Z",
			plugin: principal,
			invocation: { kind: "user", userId: "user-kernel", userRole: "user", source: "ui" },
			scope: {},
		};

		expect(await broker.authorize(context, legacyCapability)).toMatchObject({ allowed: true });
		await integrationAuthorityService.setState({
			authorityId,
			expectedRevision: 1,
			state: "suspended",
		});
		const denied = await broker.authorize(context, legacyCapability);
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.error.reason).toBe("INVALID_GRANT");
	});

	test("passes concrete resource constraints to the live kernel without duplicates", async () => {
		const pluginId = "com.example.kernelresources";
		const installationId = "installation-kernel-resources";
		const authorityId = pluginInstallationAuthorityId(pluginId, installationId);
		authorityIds.add(authorityId);
		await cleanupAuthority(authorityId);
		await integrationAuthorityService.create({
			id: authorityId,
			kind: "plugin_installation",
			integrationType: "plugin",
			integrationId: pluginId,
			metadataJson: { installationId },
			grants: [
				{
					capabilityId: "project.read",
					scope: { type: "global" },
					constraints: { resourceIds: ["project-allowed"] },
					createdBy: { type: "system" },
				},
				{
					capabilityId: "provider.use",
					scope: { type: "global" },
					constraints: {
						providerIds: ["provider-allowed"],
						resourceIds: ["provider-allowed"],
					},
					createdBy: { type: "system" },
				},
			],
		});

		const principal = {
			pluginId,
			packageVersion: "1.0.0",
			runtimeId: "runtime-kernel-resources",
			runtimeGeneration: 1,
			installationId,
		} as const;
		const projectCapability = "query.read.projects" as const;
		const providerCapability = "provider.use" as const;
		const capabilities = [projectCapability, providerCapability];
		const broker = new CapabilityBroker({
			kernelEnforcement: true,
			bindings: [
				{
					plugin: principal,
					desiredState: "enabled",
					compatibilityState: "compatible",
					runtimeState: "active",
					manifestRequested: capabilities,
					installationGrants: capabilities.map((capability) => ({
						capability,
						scope: { type: "global" as const },
					})),
					hostPolicy: capabilities,
					currentUserAuthority: capabilities,
					contributionPolicy: capabilities,
					runnerEnforcement: capabilities,
					grantRevision: 1,
				},
			],
		});
		const context: HostCallContext = {
			requestId: "request-kernel-resources",
			correlationId: "correlation-kernel-resources",
			deadlineAt: "2099-01-01T00:00:00.000Z",
			plugin: principal,
			invocation: { kind: "user", userId: "user-kernel", userRole: "user", source: "ui" },
			scope: {},
		};

		const matching = await broker.authorize({
			context,
			capability: projectCapability,
			resource: { type: "project", id: "project-allowed" },
		});
		expect(matching).toMatchObject({ allowed: true });

		const mismatching = await broker.authorize({
			context,
			capability: projectCapability,
			resource: { type: "project", id: "project-denied" },
		});
		expect(mismatching.allowed).toBe(false);
		if (!mismatching.allowed) expect(mismatching.error.reason).toBe("CONSTRAINT_MISMATCH");

		const provider = await broker.authorize({
			context,
			capability: providerCapability,
			resource: { type: "provider", id: "provider-allowed" },
		});
		expect(provider).toMatchObject({ allowed: true });

		const deduplicated = await broker.authorize({
			context,
			capability: providerCapability,
			resource: { type: "provider", id: "provider-allowed" },
			constraints: {
				resourceId: "provider-allowed",
				resourceIds: ["provider-allowed"],
				providerInstanceId: "provider-allowed",
				providerInstanceIds: ["provider-allowed"],
			},
		});
		expect(deduplicated).toMatchObject({ allowed: true });
	});
});
