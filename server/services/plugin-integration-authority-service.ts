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
	type IntegrationAuthorityState,
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

export interface EnsurePluginInstallationOptions {
	/** Explicit reinstall only: preserve the revoked tombstone and issue a fresh authority identity. */
	replaceRevoked?: boolean;
	/** Upgrade path: append newly declared capabilities without resurrecting revoked grants. */
	mergeMissingCapabilities?: boolean;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

export function pluginInstallationAuthorityId(pluginId: string, installationId: string): string {
	return `${AUTHORITY_PREFIX}${hash(`${pluginId}\0${installationId}`)}`;
}

function replacementInstallationId(): string {
	return `installation_${generateShortId(24)}`;
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

export interface PluginAuthorityCandidate {
	authorityId: string;
	installationId?: string;
	revision: number;
	state: IntegrationAuthorityState;
	createdAt: string;
}

/**
 * Matches a stable plugin installation UUID (v4). Legacy state files predating
 * the UUID carry the package hash as installation id; distinguishing the two
 * forms is what lets migration keep exactly one canonical authority.
 */
export function isStableInstallationId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface PluginAuthorizationInspection {
	pluginId: string;
	packageHash?: string;
	stateInstallationId?: string | null;
	canonicalInstallationId?: string;
	canonicalAuthorityId?: string;
	canonicalRevision?: number;
	ambiguous: boolean;
	authorities: Array<{
		authorityId: string;
		installationId?: string;
		revision: number;
		state: IntegrationAuthorityState;
		createdAt: string;
		grants: string[];
	}>;
	mirror: {
		installationId?: string;
		revision: number;
		grants: string[];
	};
	drift: {
		mirrorRevision: number;
		authorityRevision: number;
		mirrorOnlyGrants: string[];
		authorityOnlyGrants: string[];
		identityDrift: boolean;
	};
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
		options: EnsurePluginInstallationOptions = {},
	): Promise<PluginPermissionSet> {
		let targetInstallationId = installationId;
		let authorityId = pluginInstallationAuthorityId(pluginId, targetInstallationId);
		let existing = await this.authorityService.getSnapshot(authorityId, {
			includeExpired: true,
		});
		if (existing) {
			if (existing.authority.state === "revoked") {
				if (!options.replaceRevoked) {
					return this.toPermissionSet(existing, pluginId, targetInstallationId);
				}
				// Reinstall never reactivates a revoked authority. It receives a fresh internal
				// generation while the old authority remains an immutable audit tombstone.
				for (let attempt = 0; attempt < 5; attempt += 1) {
					const candidateInstallationId = replacementInstallationId();
					const candidateAuthorityId = pluginInstallationAuthorityId(
						pluginId,
						candidateInstallationId,
					);
					const candidate = await this.authorityService.getSnapshot(candidateAuthorityId, {
						includeExpired: true,
					});
					if (candidate) continue;
					targetInstallationId = candidateInstallationId;
					authorityId = candidateAuthorityId;
					existing = null;
					break;
				}
				if (existing) {
					throw new IntegrationAuthorityConflictError(
						"Unable to allocate a fresh plugin authority generation",
					);
				}
			} else {
				const set = this.toPermissionSet(existing, pluginId, targetInstallationId);
				// Self-healing: an authority that exists but carries NO grants while
				// the compatibility mirror still has them (a crash or partial
				// migration can leave an empty authority row) would otherwise deny
				// every capability forever — the authority short-circuit below would
				// return an empty grant set. Rebuild the authority from the mirror so
				// existing approvals keep working. Mirror grants preserve scope,
				// constraints, expiry, grantId and grantor, so nothing is flattened.
				if (set.grants.length === 0) {
					try {
						const mirror = await this.permissionStore.getSet(pluginId, targetInstallationId);
						if (mirror.grants.length > 0) {
							logger.warn("Rebuilding empty plugin authority from compatibility mirror", {
								pluginId,
								installationId: targetInstallationId,
								authorityRevision: set.revision,
								mirrorRevision: mirror.revision,
								restored: mirror.grants.length,
							});
							const repaired = await this.replace(
								pluginId,
								targetInstallationId,
								mirror.grants.map(
									(grant): PermissionGrantInput => ({
										capability: grant.capability,
										scope: grant.scope,
										...(grant.constraints === undefined ? {} : { constraints: grant.constraints }),
										...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
										grantId: grant.grantId,
										grantedBy: grant.grantedBy,
									}),
								),
								{ expectedRevision: set.revision, grantedBy: "authority-repair" },
							);
							return repaired.set;
						}
					} catch (error) {
						logger.warn("Unable to rebuild empty plugin authority from mirror", {
							pluginId,
							installationId: targetInstallationId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				// Upgrade path: the caller's `legacySummary` already includes capabilities
				// the new manifest declares that were never granted (seedGrantsFromManifest
				// merge mode). The existing authority record short-circuits normal seeding,
				// so without this merge the new capabilities would never reach the
				// runtime authority record and every call against them would be denied.
				// Append-only: existing grants are preserved verbatim (revocations stay
				// revoked), only the missing declared capabilities are added.
				if (options.mergeMissingCapabilities) {
					const missing = (legacySummary.capabilities ?? []).filter((capability) => {
						const adapted = adaptPluginCapability(capability);
						const canonical = adapted?.id;
						return !set.grants.some(
							(grant) =>
								grant.capability === capability ||
								(canonical !== undefined && grant.capability === canonical),
						);
					});
					if (missing.length > 0) {
						logger.info("Merging newly-declared plugin capabilities into existing grant set", {
							pluginId,
							installationId: targetInstallationId,
							added: missing,
						});
						// Append-only: existing grants are preserved VERBATIM (including
						// constraints, expiry and the original grantor), only the missing
						// declared capabilities are added. Dropping those fields would
						// silently widen or rewrite old grants on every upgrade.
						const merged = await this.replace(
							pluginId,
							targetInstallationId,
							[
								...set.grants.map(
									(grant): PermissionGrantInput => ({
										capability: grant.capability,
										scope: grant.scope,
										...(grant.constraints === undefined ? {} : { constraints: grant.constraints }),
										...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
										grantId: grant.grantId,
										grantedBy: grant.grantedBy,
									}),
								),
								...missing.map((capability) => ({
									capability,
									scope: { type: "global" } as const,
								})),
							],
							{ expectedRevision: set.revision, grantedBy: "system" },
						);
						return merged.set;
					}
				}
				return set;
			}
		}

		if (sourceInstallationId && sourceInstallationId !== targetInstallationId) {
			await this.permissionStore.ensureInstallation(
				pluginId,
				targetInstallationId,
				sourceInstallationId,
			);
		}
		await this.permissionStore.ensureLegacySummary(pluginId, targetInstallationId, legacySummary);
		const legacy = await this.permissionStore.getSet(pluginId, targetInstallationId);
		const initialRevision = Math.max(1, legacy.revision);
		try {
			await this.authorityService.create({
				id: authorityId,
				kind: "plugin_installation",
				integrationId: pluginId,
				metadataJson: authorityMetadata(targetInstallationId),
				initialRevision,
				grants: this.toAuthorityGrants(authorityId, initialRevision, legacy.grants, "migration"),
			});
			const created = await this.authorityService.requireSnapshot(authorityId, {
				includeExpired: true,
			});
			const set = this.toPermissionSet(created, pluginId, targetInstallationId);
			await this.mirrorPermissionSet(set);
			return set;
		} catch (error) {
			if (!(error instanceof IntegrationAuthorityConflictError)) throw error;
			const raced = await this.authorityService.getSnapshot(authorityId, {
				includeExpired: true,
			});
			if (!raced) throw error;
			return this.toPermissionSet(raced, pluginId, targetInstallationId);
		}
	}

	async get(pluginId: string, installationId: string): Promise<PluginPermissionSet> {
		const snapshot = await this.requireActiveSnapshot(pluginId, installationId);
		return this.toPermissionSet(snapshot, pluginId, installationId);
	}

	/**
	 * Produce a sanitized authorization health report for diagnostics: every
	 * authority row for the plugin, the canonical one, and drift between the
	 * DB authority (source of truth) and the compatibility mirror. Never
	 * exposes token/sensitive data — only capability names, identities and
	 * revisions.
	 */
	async inspectAuthorization(
		pluginId: string,
		options: { installationId?: string; packageHash?: string } = {},
	): Promise<PluginAuthorizationInspection> {
		const snapshots = await this.authorityService.listForIntegration({
			kind: "plugin_installation",
			integrationId: pluginId,
			includeRevoked: true,
			includeExpired: true,
		});
		const authorities = snapshots.map((snapshot) => ({
			authorityId: snapshot.authority.id,
			installationId: metadataInstallationId(snapshot),
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			createdAt: snapshot.authority.createdAt,
			grants: snapshot.grants
				.filter((grant) => !grant.revokedAt)
				.map((grant) => grant.capabilityId),
		}));
		const active = authorities.filter((authority) => authority.state === "active");
		const uuidActive = active.filter(
			(authority) =>
				authority.installationId !== undefined && isStableInstallationId(authority.installationId),
		);
		const canonical = uuidActive.length === 1 ? uuidActive[0] : undefined;

		let mirror: PluginPermissionSet | undefined;
		if (options.installationId) {
			try {
				mirror = await this.permissionStore.getSet(pluginId, options.installationId);
			} catch {
				mirror = undefined;
			}
		}
		const authorityCapabilities = new Set(canonical?.grants ?? []);
		const mirrorGrants = mirror?.grants ?? [];
		return {
			pluginId,
			packageHash: options.packageHash,
			stateInstallationId: options.installationId ?? null,
			canonicalInstallationId: canonical?.installationId,
			canonicalAuthorityId: canonical?.authorityId,
			canonicalRevision: canonical?.revision,
			ambiguous: uuidActive.length > 1,
			authorities,
			mirror: {
				installationId: mirror?.installationId,
				revision: mirror?.revision ?? 0,
				grants: mirrorGrants.map((grant) => grant.capability),
			},
			drift: {
				mirrorRevision: mirror?.revision ?? 0,
				authorityRevision: canonical?.revision ?? 0,
				mirrorOnlyGrants: mirrorGrants
					.filter((grant) => !authorityCapabilities.has(grant.capability))
					.map((grant) => grant.capability),
				authorityOnlyGrants: [...authorityCapabilities].filter(
					(capability) => !mirrorGrants.some((grant) => grant.capability === capability),
				),
				identityDrift:
					!!mirror &&
					options.installationId !== undefined &&
					mirror.installationId !== options.installationId,
			},
		};
	}

	/**
	 * List every authority row ever created for a plugin, including revoked and
	 * expired ones. Used by the identity resolver to recover a stable UUID after
	 * a host restart or to detect legacy hash-keyed authorities that must be
	 * migrated away.
	 */
	async listAuthorities(pluginId: string): Promise<PluginAuthorityCandidate[]> {
		const snapshots = await this.authorityService.listForIntegration({
			kind: "plugin_installation",
			integrationId: pluginId,
			includeRevoked: true,
			includeExpired: true,
		});
		return snapshots.map((snapshot) => ({
			authorityId: snapshot.authority.id,
			installationId: metadataInstallationId(snapshot),
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			createdAt: snapshot.authority.createdAt,
		}));
	}

	/**
	 * Revoke a single plugin authority (used to retire legacy hash-keyed
	 * authorities once their grants have been migrated to a stable UUID).
	 * Returns false when the authority was already revoked or no longer exists.
	 */
	async revokeAuthority(authorityId: string, reason: string): Promise<boolean> {
		let current: IntegrationAuthoritySnapshot | null = null;
		try {
			current = await this.authorityService.getSnapshot(authorityId, { includeExpired: true });
		} catch {
			return false;
		}
		if (!current || current.authority.state === "revoked") return false;
		try {
			await this.authorityService.revoke({
				authorityId,
				expectedRevision: current.authority.revision,
				reason,
			});
			return true;
		} catch (error) {
			if (!(error instanceof IntegrationAuthorityConflictError)) throw error;
			const latest = await this.authorityService.getSnapshot(authorityId, {
				includeExpired: true,
			});
			if (!latest || latest.authority.state === "revoked") return false;
			await this.authorityService.revoke({
				authorityId,
				expectedRevision: latest.authority.revision,
				reason,
			});
			return true;
		}
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
				// Preserve the original grantor: system actor stays a system grant so
				// round-trips back to `grantedBy: "system"` instead of a fake user id.
				createdBy:
					grantedBy === "system" ? { type: "system" } : ({ type: "user", id: grantedBy } as const),
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
			// The DB authority is the single source of truth. The compatibility
			// mirror is rebuilt from it unconditionally — even when the mirror's
			// stale revision is numerically higher (e.g. grants that were written
			// only to the mirror by an older buggy approval path). Those grants
			// never existed in the authority and are not enforceable, so the
			// mirror must converge onto the authority instead of the reverse.
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
