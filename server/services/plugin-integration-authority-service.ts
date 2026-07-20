import { createHash } from "node:crypto";
import { generateShortId } from "@server/lib/id";
import {
	adaptPluginCapability,
	PLUGIN_CAPABILITY_ADAPTER,
} from "@server/lib/integrations/capability-adapters";
import { logger } from "@server/lib/logger";
import {
	type Capability,
	type PermissionConstraints,
	type PermissionGrant,
	type PermissionScope,
	permissionGrantSchema,
} from "@server/lib/plugins/permissions";
import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import type { ResourceScope } from "@shared/integrations/resources";
import {
	IntegrationAuthorityConflictError,
	type IntegrationAuthorityService,
	type IntegrationAuthoritySnapshot,
	type IntegrationCapabilityGrant,
	type IntegrationCapabilityGrantInput,
	type IntegrationGrantConstraints,
	integrationAuthorityService,
} from "./integration-authority-service";
import {
	type PermissionGrantInput,
	type PermissionMutationResult,
	PluginPermissionConflictError,
	PluginPermissionNotFoundError,
	type PluginPermissionSet,
	type PluginPermissionStore,
	type StoredPermissionGrant,
} from "./plugin-permission-store";
import type { PluginGrantSummary } from "./plugin-state-store";

const AUTHORITY_PREFIX = "plugin-installation:";
const GRANT_ROW_PREFIX = "plugin-grant:";

const PLUGIN_CAPABILITY_BY_CANONICAL = new Map<CanonicalCapabilityId, Capability>();
for (const [capability, entry] of Object.entries(PLUGIN_CAPABILITY_ADAPTER)) {
	const existing = PLUGIN_CAPABILITY_BY_CANONICAL.get(entry.descriptorId);
	if (existing && existing !== capability) {
		throw new Error(`Plugin capability adapter is not reversible: ${entry.descriptorId}`);
	}
	PLUGIN_CAPABILITY_BY_CANONICAL.set(entry.descriptorId, capability as Capability);
}

export interface PluginIntegrationAuthorityServiceOptions {
	authorityService?: IntegrationAuthorityService;
	permissionStore: PluginPermissionStore;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

export function pluginInstallationAuthorityId(pluginId: string, installationId: string): string {
	return `${AUTHORITY_PREFIX}${hash(`${pluginId}\0${installationId}`)}`;
}

function grantRowPrefix(authorityId: string): string {
	return `${GRANT_ROW_PREFIX}${hash(authorityId).slice(0, 16)}:`;
}

function pluginGrantRowId(authorityId: string, revision: number, grantId: string): string {
	return `${grantRowPrefix(authorityId)}${revision}:${grantId}`;
}

function pluginGrantIdFromRow(authorityId: string, rowId: string): string {
	const prefix = grantRowPrefix(authorityId);
	if (!rowId.startsWith(prefix)) return rowId;
	const revisionSeparator = rowId.indexOf(":", prefix.length);
	return revisionSeparator === -1 ? rowId : rowId.slice(revisionSeparator + 1);
}

function authorityMetadata(
	installationId: string,
	current?: Record<string, unknown> | null,
): Record<string, unknown> {
	return { ...(current ?? {}), installationId };
}

function metadataInstallationId(snapshot: IntegrationAuthoritySnapshot): string | undefined {
	const installationId = snapshot.authority.metadataJson?.installationId;
	return typeof installationId === "string" ? installationId : undefined;
}

function toCanonicalScope(scope: PermissionScope): ResourceScope {
	return scope.type === "global"
		? { type: "global" }
		: ({ type: scope.type, id: scope.id as string } as ResourceScope);
}

function toPluginScope(grant: IntegrationCapabilityGrant): PermissionScope {
	return grant.scopeType === "global"
		? { type: "global" }
		: ({ type: grant.scopeType, id: grant.scopeId as string } as PermissionScope);
}

function toCanonicalConstraints(
	constraints: PermissionConstraints | undefined,
): IntegrationGrantConstraints | undefined {
	if (!constraints) return undefined;
	const { providerInstanceIds, ...rest } = constraints;
	return {
		...rest,
		...(providerInstanceIds ? { providerIds: providerInstanceIds } : {}),
	};
}

function toPluginConstraints(
	constraints: Record<string, unknown> | null,
): PermissionConstraints | undefined {
	if (!constraints) return undefined;
	const { providerIds, ...rest } = constraints as IntegrationGrantConstraints;
	const mapped = {
		...rest,
		...(providerIds ? { providerInstanceIds: providerIds } : {}),
	};
	return Object.keys(mapped).length === 0 ? undefined : mapped;
}

function grantFingerprint(grant: PermissionGrantInput | StoredPermissionGrant): string {
	return JSON.stringify({
		capability: grant.capability,
		scope: grant.scope,
		constraints: grant.constraints ?? null,
		expiresAt: grant.expiresAt ?? null,
		grantId: grant.grantId ?? null,
		grantedBy: grant.grantedBy ?? null,
	});
}

function grantsFingerprint(
	grants: readonly (PermissionGrantInput | StoredPermissionGrant)[],
): string {
	return JSON.stringify(grants.map(grantFingerprint).sort());
}

export class PluginIntegrationAuthorityService {
	readonly authorityService: IntegrationAuthorityService;
	readonly permissionStore: PluginPermissionStore;

	constructor(options: PluginIntegrationAuthorityServiceOptions) {
		this.authorityService = options.authorityService ?? integrationAuthorityService;
		this.permissionStore = options.permissionStore;
	}

	async ensureInstallation(
		pluginId: string,
		installationId: string,
		legacySummary: PluginGrantSummary,
		sourceInstallationId?: string,
	): Promise<PluginPermissionSet> {
		const authorityId = pluginInstallationAuthorityId(pluginId, installationId);
		const existing = await this.authorityService.getSnapshot(authorityId, {
			includeExpired: true,
		});
		if (existing) return this.toPermissionSet(existing, pluginId, installationId);

		if (sourceInstallationId) {
			await this.permissionStore.ensureInstallation(pluginId, installationId, sourceInstallationId);
		}
		await this.permissionStore.ensureLegacySummary(pluginId, installationId, legacySummary);
		const legacy = await this.permissionStore.getSet(pluginId, installationId);
		const initialRevision = Math.max(1, legacy.revision);
		try {
			await this.authorityService.create({
				id: authorityId,
				kind: "plugin_installation",
				integrationId: pluginId,
				metadataJson: authorityMetadata(installationId),
				initialRevision,
				grants: this.toAuthorityGrants(authorityId, initialRevision, legacy.grants, "migration"),
			});
			const created = await this.authorityService.requireSnapshot(authorityId, {
				includeExpired: true,
			});
			const set = this.toPermissionSet(created, pluginId, installationId);
			await this.mirrorPermissionSet(set);
			return set;
		} catch (error) {
			if (!(error instanceof IntegrationAuthorityConflictError)) throw error;
			const raced = await this.authorityService.getSnapshot(authorityId, {
				includeExpired: true,
			});
			if (!raced) throw error;
			return this.toPermissionSet(raced, pluginId, installationId);
		}
	}

	async get(pluginId: string, installationId: string): Promise<PluginPermissionSet> {
		const snapshot = await this.requireActiveSnapshot(pluginId, installationId);
		return this.toPermissionSet(snapshot, pluginId, installationId);
	}

	async replace(
		pluginId: string,
		installationId: string,
		grants: readonly PermissionGrantInput[],
		options: { expectedRevision: number; grantedBy: string },
	): Promise<PermissionMutationResult> {
		const snapshot = await this.requireActiveSnapshot(pluginId, installationId);
		const current = this.toPermissionSet(snapshot, pluginId, installationId);
		this.assertExpectedRevision(pluginId, options.expectedRevision, current.revision);
		const normalized = this.normalizeInputs(
			pluginId,
			installationId,
			grants,
			options.grantedBy,
			current.revision + 1,
		);
		if (grantsFingerprint(normalized) === grantsFingerprint(current.grants)) {
			return { set: current, changed: false, idempotent: true };
		}
		const nextRevision = current.revision + 1;
		try {
			await this.authorityService.replaceGrants({
				authorityId: snapshot.authority.id,
				expectedRevision: current.revision,
				metadataJson: authorityMetadata(installationId, snapshot.authority.metadataJson),
				grants: this.toAuthorityGrants(
					snapshot.authority.id,
					nextRevision,
					normalized,
					options.grantedBy,
				),
			});
		} catch (error) {
			await this.rethrowPermissionConflict(
				error,
				pluginId,
				options.expectedRevision,
				snapshot.authority.id,
			);
		}
		const updated = await this.requireActiveSnapshot(pluginId, installationId);
		const set = this.toPermissionSet(updated, pluginId, installationId);
		await this.mirrorPermissionSet(set);
		return { set, changed: true, idempotent: false };
	}

	async revoke(
		pluginId: string,
		installationId: string,
		grantIds: readonly string[],
		options: { expectedRevision: number; grantedBy: string },
	): Promise<PermissionMutationResult> {
		const snapshot = await this.requireActiveSnapshot(pluginId, installationId);
		const current = this.toPermissionSet(snapshot, pluginId, installationId);
		this.assertExpectedRevision(pluginId, options.expectedRevision, current.revision);
		const requested = new Set(grantIds);
		const missing = [...requested].find(
			(grantId) => !current.grants.some((grant) => grant.grantId === grantId),
		);
		if (missing) throw new PluginPermissionNotFoundError(missing);
		if (requested.size === 0) return { set: current, changed: false, idempotent: true };
		const rowIds = snapshot.grants
			.filter((grant) => requested.has(pluginGrantIdFromRow(snapshot.authority.id, grant.id)))
			.map((grant) => grant.id);
		try {
			await this.authorityService.revokeGrants({
				authorityId: snapshot.authority.id,
				expectedRevision: current.revision,
				grantIds: rowIds,
			});
		} catch (error) {
			await this.rethrowPermissionConflict(
				error,
				pluginId,
				options.expectedRevision,
				snapshot.authority.id,
			);
		}
		const updated = await this.requireActiveSnapshot(pluginId, installationId);
		const set = this.toPermissionSet(updated, pluginId, installationId);
		await this.mirrorPermissionSet(set);
		return { set, changed: true, idempotent: false };
	}

	async revokePlugin(pluginId: string, reason: string): Promise<number> {
		const snapshots = await this.authorityService.listForIntegration({
			kind: "plugin_installation",
			integrationId: pluginId,
			includeExpired: true,
		});
		let revoked = 0;
		for (const snapshot of snapshots) {
			let current = snapshot;
			try {
				await this.authorityService.revoke({
					authorityId: current.authority.id,
					expectedRevision: current.authority.revision,
					reason,
				});
				revoked++;
			} catch (error) {
				if (!(error instanceof IntegrationAuthorityConflictError)) throw error;
				const latest = await this.authorityService.getSnapshot(current.authority.id, {
					includeExpired: true,
				});
				if (!latest || latest.authority.state === "revoked") continue;
				current = latest;
				await this.authorityService.revoke({
					authorityId: current.authority.id,
					expectedRevision: current.authority.revision,
					reason,
				});
				revoked++;
			}
		}
		return revoked;
	}

	private async requireActiveSnapshot(
		pluginId: string,
		installationId: string,
	): Promise<IntegrationAuthoritySnapshot> {
		const authorityId = pluginInstallationAuthorityId(pluginId, installationId);
		const snapshot = await this.authorityService.requireSnapshot(authorityId, {
			includeExpired: true,
		});
		this.assertSnapshotIdentity(snapshot, pluginId, installationId);
		return snapshot;
	}

	private toPermissionSet(
		snapshot: IntegrationAuthoritySnapshot,
		pluginId: string,
		installationId: string,
	): PluginPermissionSet {
		this.assertSnapshotIdentity(snapshot, pluginId, installationId);
		const grants = snapshot.grants.map((grant): StoredPermissionGrant => {
			const capability = PLUGIN_CAPABILITY_BY_CANONICAL.get(
				grant.capabilityId as CanonicalCapabilityId,
			);
			if (!capability) {
				throw new IntegrationAuthorityConflictError(
					`Plugin authority contains an unmapped capability: ${grant.capabilityId}`,
				);
			}
			const parsed = permissionGrantSchema.parse({
				capability,
				scope: toPluginScope(grant),
				constraints: toPluginConstraints(grant.constraintsJson),
				expiresAt: grant.expiresAt ?? undefined,
				grantId: pluginGrantIdFromRow(snapshot.authority.id, grant.id),
				grantedBy:
					grant.createdByType === "user" && grant.createdById ? grant.createdById : "system",
			});
			if (!parsed.grantId || !parsed.grantedBy) {
				throw new IntegrationAuthorityConflictError(
					"Plugin authority grant identity is incomplete",
				);
			}
			return {
				...parsed,
				grantId: parsed.grantId,
				grantedBy: parsed.grantedBy,
				pluginId,
				installationId,
				revision: snapshot.authority.revision,
			};
		});
		return {
			pluginId,
			installationId,
			revision: snapshot.authority.revision,
			grants,
			updatedAt: snapshot.authority.updatedAt,
		};
	}

	private assertSnapshotIdentity(
		snapshot: IntegrationAuthoritySnapshot,
		pluginId: string,
		installationId: string,
	): void {
		if (
			snapshot.authority.kind !== "plugin_installation" ||
			snapshot.authority.integrationType !== "plugin" ||
			snapshot.authority.integrationId !== pluginId ||
			metadataInstallationId(snapshot) !== installationId
		) {
			throw new IntegrationAuthorityConflictError(
				"Plugin authority identity does not match installation",
			);
		}
		if (snapshot.authority.state !== "active") {
			throw new IntegrationAuthorityConflictError(
				"Revoked plugin authorities cannot be reactivated",
			);
		}
	}

	private normalizeInputs(
		pluginId: string,
		installationId: string,
		grants: readonly PermissionGrantInput[],
		defaultGrantedBy: string,
		revision: number,
	): StoredPermissionGrant[] {
		const normalized = grants.map((grant): StoredPermissionGrant => {
			const parsed = permissionGrantSchema.parse({
				...grant,
				grantId: grant.grantId ?? `grant_${generateShortId(20)}`,
				grantedBy: grant.grantedBy ?? defaultGrantedBy,
			});
			if (!parsed.grantId || !parsed.grantedBy) {
				throw new IntegrationAuthorityConflictError(
					"Plugin authority grant identity is incomplete",
				);
			}
			return {
				...parsed,
				grantId: parsed.grantId,
				grantedBy: parsed.grantedBy,
				pluginId,
				installationId,
				revision,
			};
		});
		if (new Set(normalized.map((grant) => grant.grantId)).size !== normalized.length) {
			throw new IntegrationAuthorityConflictError("Plugin permission grant ids must be unique");
		}
		return normalized;
	}

	private toAuthorityGrants(
		authorityId: string,
		revision: number,
		grants: readonly (PermissionGrantInput | StoredPermissionGrant)[],
		defaultGrantedBy: string,
	): IntegrationCapabilityGrantInput[] {
		return grants.map((grant) => {
			const adapted = adaptPluginCapability(grant.capability);
			if (!adapted) {
				throw new IntegrationAuthorityConflictError(
					`Plugin capability has no canonical adapter: ${grant.capability}`,
				);
			}
			const grantId = grant.grantId ?? `grant_${generateShortId(20)}`;
			const grantedBy = grant.grantedBy ?? defaultGrantedBy;
			return {
				id: pluginGrantRowId(authorityId, revision, grantId),
				capabilityId: adapted.id as CanonicalCapabilityId,
				scope: toCanonicalScope(grant.scope),
				constraints: toCanonicalConstraints(grant.constraints),
				expiresAt: grant.expiresAt,
				createdBy: { type: "user", id: grantedBy },
			};
		});
	}

	private assertExpectedRevision(pluginId: string, expected: number, actual: number): void {
		if (expected !== actual) throw new PluginPermissionConflictError(pluginId, expected, actual);
	}

	private async rethrowPermissionConflict(
		error: unknown,
		pluginId: string,
		expectedRevision: number,
		authorityId: string,
	): Promise<never> {
		if (error instanceof IntegrationAuthorityConflictError) {
			const latest = await this.authorityService.getSnapshot(authorityId, {
				includeExpired: true,
			});
			throw new PluginPermissionConflictError(
				pluginId,
				expectedRevision,
				latest?.authority.revision ?? expectedRevision,
			);
		}
		throw error;
	}

	private async mirrorPermissionSet(set: PluginPermissionSet): Promise<void> {
		try {
			const current = await this.permissionStore.getSet(set.pluginId, set.installationId);
			if (grantsFingerprint(current.grants) === grantsFingerprint(set.grants)) return;
			if (current.revision >= set.revision) {
				logger.warn("Skipping stale plugin permission compatibility mirror", {
					pluginId: set.pluginId,
					installationId: set.installationId,
					legacyRevision: current.revision,
					authorityRevision: set.revision,
				});
				return;
			}
			await this.permissionStore.replace(
				set.pluginId,
				set.installationId,
				set.grants.map(
					(grant): PermissionGrant => ({
						capability: grant.capability,
						scope: grant.scope,
						constraints: grant.constraints,
						expiresAt: grant.expiresAt,
						grantId: grant.grantId,
						grantedBy: grant.grantedBy,
					}),
				),
				{
					expectedRevision: current.revision,
					targetRevision: set.revision,
					grantedBy: "integration-authority-mirror",
				},
			);
		} catch (error) {
			logger.warn("Unable to update plugin permission compatibility mirror", {
				pluginId: set.pluginId,
				installationId: set.installationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
