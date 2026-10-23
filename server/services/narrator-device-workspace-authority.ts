import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	aclGrants,
	chapters,
	integrationAuthorities,
	integrationCapabilityGrants,
	integrationResourceBindings,
	narrators,
	oauthClients,
	projects,
	remoteDevices,
	users,
} from "../db/schema";
import { oauthNarratorProvisionSnapshotSchema } from "../lib/oauth-client-policy";
import { workspaceConflict } from "./workspace-context-transition";

function narratorAuthorityRow(id: string, includeCurrentSelection = true) {
	const row =
		db
			.select({
				id: narrators.id,
				ownerUserId: narrators.ownerUserId,
				visibility: narrators.visibility,
				writeAudience: narrators.writeAudience,
				type: narrators.type,
				aclRootNarratorId: narrators.aclRootNarratorId,
				chapterId: narrators.chapterId,
				contextProjectId: narrators.contextProjectId,
				defaultDeviceId: narrators.defaultDeviceId,
				selectedProjectId: includeCurrentSelection
					? sql<string | null>`json_extract(${narrators.workspaceContext}, '$.contextProjectId')`
					: sql<string | null>`null`,
				oauthSnapshot: sql<string | null>`substr(${narrators.oauthPolicySnapshotJson}, 1, 65537)`,
			})
			.from(narrators)
			.where(eq(narrators.id, id))
			.get() ?? null;
	// Ordinary original resources do not depend on default device selection. OAuth's
	// default device remains an actual runtime-policy dependency and is still fenced.
	return row && !includeCurrentSelection && row.oauthSnapshot === null
		? { ...row, defaultDeviceId: null }
		: row;
}

export function endpointDeviceAuthorityRow(deviceId: string) {
	return (
		db
			.select({
				id: remoteDevices.id,
				scope: remoteDevices.scope,
				projectId: remoteDevices.projectId,
				ownerScope: remoteDevices.ownerScope,
				createdBy: remoteDevices.createdBy,
				revokedAt: remoteDevices.revokedAt,
			})
			.from(remoteDevices)
			.where(eq(remoteDevices.id, deviceId))
			.get() ?? null
	);
}

/** Bounded indexed identity fence, not a replacement for asynchronous ACL/OAuth authorization. */
export function endpointDeviceAuthorityFingerprint(
	narratorId: string,
	deviceId: string,
	actor: string,
	original?: { originalProjectId: string | null },
): string {
	const user =
		db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, actor)).get() ??
		null;
	const narrator = narratorAuthorityRow(narratorId, original === undefined);
	const root =
		narrator?.aclRootNarratorId && narrator.aclRootNarratorId !== narratorId
			? narratorAuthorityRow(narrator.aclRootNarratorId, original === undefined)
			: null;
	const narratorRows = [narrator, root].filter((row) => row !== null);
	if (narratorRows.some((row) => (row.oauthSnapshot?.length ?? 0) > 65536))
		throw workspaceConflict("Endpoint authority snapshot exceeds its bound");
	const chapterIds = [
		...new Set(narratorRows.flatMap((row) => (row.chapterId ? [row.chapterId] : []))),
	];
	const chapterRows = chapterIds.map(
		(id) =>
			db
				.select({ id: chapters.id, projectId: chapters.projectId })
				.from(chapters)
				.where(eq(chapters.id, id))
				.get() ?? null,
	);
	const projectIds = [
		...new Set([
			...narratorRows.flatMap((row) =>
				[row.contextProjectId, row.selectedProjectId].filter((id): id is string => !!id),
			),
			...chapterRows.flatMap((row) => (row?.projectId ? [row.projectId] : [])),
			...(original?.originalProjectId ? [original.originalProjectId] : []),
		]),
	];
	const projectRows = projectIds.map(
		(id) =>
			db
				.select({
					id: projects.id,
					ownerUserId: projects.ownerUserId,
					visibility: projects.visibility,
				})
				.from(projects)
				.where(eq(projects.id, id))
				.get() ?? null,
	);
	const scopeIds = [
		...new Set([narratorId, ...narratorRows.map((row) => row.id), ...chapterIds, ...projectIds]),
	];
	// At most two principals × three capabilities × the finite ancestor chain.
	const grants = db
		.select({
			id: aclGrants.id,
			scopeType: aclGrants.scopeType,
			scopeId: aclGrants.scopeId,
			principalType: aclGrants.principalType,
			principalId: aclGrants.principalId,
			capability: aclGrants.capability,
		})
		.from(aclGrants)
		.where(
			and(
				isNull(aclGrants.domainKind),
				isNull(aclGrants.domainValue),
				or(
					and(eq(aclGrants.principalType, "user"), eq(aclGrants.principalId, actor)),
					and(eq(aclGrants.principalType, "role"), eq(aclGrants.principalId, user?.role ?? "")),
				),
				or(
					and(eq(aclGrants.scopeType, "global"), isNull(aclGrants.scopeId)),
					and(
						inArray(aclGrants.scopeType, ["project", "chapter", "narrator"]),
						inArray(aclGrants.scopeId, scopeIds),
					),
				),
			),
		)
		.orderBy(asc(aclGrants.id))
		.limit(65)
		.all();
	if (grants.length > 64) throw workspaceConflict("Endpoint authority grants exceed their bound");
	// Runtime OAuth authorization validates every provisioned device, not just this endpoint.
	// Parse the same capped schema before doing any dependency lookups; no unbounded IN/all scan.
	let snapshotDeviceIds: string[] = [];
	if (narrator?.oauthSnapshot) {
		let value: unknown;
		try {
			value = JSON.parse(narrator.oauthSnapshot);
		} catch {
			throw workspaceConflict("Endpoint OAuth provision snapshot is invalid");
		}
		const parsed = oauthNarratorProvisionSnapshotSchema.safeParse(value);
		if (!parsed.success)
			throw workspaceConflict("Endpoint OAuth provision snapshot is invalid or exceeds its bound");
		snapshotDeviceIds = parsed.data.deviceIds;
	}
	const dependencyDeviceIds = [
		...new Set([...snapshotDeviceIds, ...(deviceId !== "local" ? [deviceId] : [])]),
	].sort();
	const dependencyDevices = dependencyDeviceIds.map(endpointDeviceAuthorityRow);
	const resourceTargets = [
		{ resourceType: "narrator" as const, resourceId: narratorId },
		...dependencyDeviceIds.map((resourceId) => ({ resourceType: "device" as const, resourceId })),
	];
	const provenance = resourceTargets.map(
		(target) =>
			db
				.select({
					id: integrationResourceBindings.id,
					resourceType: integrationResourceBindings.resourceType,
					resourceId: integrationResourceBindings.resourceId,
					sourceType: integrationResourceBindings.sourceType,
					sourceId: integrationResourceBindings.sourceId,
					authorityType: integrationResourceBindings.authorityType,
					authorityId: integrationResourceBindings.authorityId,
					state: integrationResourceBindings.state,
					revision: integrationResourceBindings.revision,
				})
				.from(integrationResourceBindings)
				.where(
					and(
						eq(integrationResourceBindings.resourceType, target.resourceType),
						eq(integrationResourceBindings.resourceId, target.resourceId),
					),
				)
				.get() ?? null,
	);
	const oauthIds = [
		...new Set(
			provenance.flatMap((row) =>
				row?.sourceType === "oauth_client" && row.authorityType === "oauth_grant"
					? [row.authorityId]
					: [],
			),
		),
	];
	const authorities = oauthIds.map(
		(id) =>
			db
				.select({
					id: integrationAuthorities.id,
					kind: integrationAuthorities.kind,
					integrationType: integrationAuthorities.integrationType,
					integrationId: integrationAuthorities.integrationId,
					ownerUserId: integrationAuthorities.ownerUserId,
					state: integrationAuthorities.state,
					revision: integrationAuthorities.revision,
					expiresAt: integrationAuthorities.expiresAt,
					policy: sql<string | null>`substr(${integrationAuthorities.policyJson}, 1, 8193)`,
				})
				.from(integrationAuthorities)
				.where(eq(integrationAuthorities.id, id))
				.get() ?? null,
	);
	const clientIds = [...new Set(authorities.flatMap((row) => (row ? [row.integrationId] : [])))];
	const clients = clientIds.map(
		(id) =>
			db
				.select({
					id: oauthClients.id,
					publicClient: oauthClients.publicClient,
					revokedAt: oauthClients.revokedAt,
					policy: sql<string | null>`substr(${oauthClients.policyJson}, 1, 8193)`,
					scopes: sql<string>`substr(${oauthClients.scopes}, 1, 8193)`,
				})
				.from(oauthClients)
				.where(eq(oauthClients.id, id))
				.get() ?? null,
	);
	if (
		[...authorities, ...clients].some((row) => (row?.policy?.length ?? 0) > 8192) ||
		clients.some((row) => (row?.scopes.length ?? 0) > 8192)
	)
		throw workspaceConflict("Endpoint OAuth policy exceeds its bound");
	const executionGrants = oauthIds.map(
		(id) =>
			db
				.select({
					id: integrationCapabilityGrants.id,
					expiresAt: integrationCapabilityGrants.expiresAt,
				})
				.from(integrationCapabilityGrants)
				.where(
					and(
						eq(integrationCapabilityGrants.authorityId, id),
						eq(integrationCapabilityGrants.capabilityId, "narrator.send_message"),
						isNull(integrationCapabilityGrants.revokedAt),
						or(
							isNull(integrationCapabilityGrants.expiresAt),
							sql`julianday(${integrationCapabilityGrants.expiresAt}) > julianday('now')`,
						),
					),
				)
				.orderBy(asc(integrationCapabilityGrants.id))
				.limit(1)
				.get() ?? null,
	);
	const now = Date.now();
	const expired = (expiresAt: string | null | undefined) => {
		if (!expiresAt) return false;
		const time = Date.parse(expiresAt);
		return !Number.isFinite(time) || time <= now;
	};
	if (
		authorities.some((row) => expired(row?.expiresAt)) ||
		executionGrants.some((row) => expired(row?.expiresAt))
	)
		throw workspaceConflict("Endpoint OAuth authority expired");
	return createHash("sha256")
		.update(
			JSON.stringify({
				original,
				user,
				narrator,
				root,
				chapterRows,
				projectRows,
				grants,
				provenance,
				authorities,
				clients,
				executionGrants,
				dependencyDeviceIds,
				devices: dependencyDevices,
			}),
		)
		.digest("hex");
}
