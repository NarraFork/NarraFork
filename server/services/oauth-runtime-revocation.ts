import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	integrationAuthorities,
	integrationResourceBindings,
	narrators,
	oauthGrants,
	remoteDevices,
} from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { recordOAuthSecurityEvent } from "../lib/oauth-security-observability";
import { backgroundTaskService } from "./background-task-service";
import { disconnectDevice } from "./device-connection-service";
import { integrationAuthorizationService } from "./integration-authorization-service";
import { integrationEventDispatcher } from "./integration-event-dispatcher";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { clearBufferedMessages } from "./narrator-buffer";
import { interruptManualBash, narratorService } from "./narrator-service";
import { interruptNarrator } from "./narrator-session";

const REVOCATION_PAGE_SIZE = 100;

/**
 * Hard-stop all work owned by one OAuth narrator. Clearing the durable/in-memory
 * buffer happens synchronously before abort so the normal interrupt finalizer
 * cannot auto-resume the next queued message.
 */
export async function stopOAuthNarratorForAuthorizationLoss(
	narratorId: string,
	reason: string,
): Promise<void> {
	const binding = await integrationResourceBindingService.get("narrator", narratorId);
	const grant =
		binding?.sourceType === "oauth_client" && binding.authorityType === "oauth_grant"
			? await db.query.oauthGrants.findFirst({
					where: eq(oauthGrants.id, binding.authorityId),
					columns: { id: true, userId: true, oauthClientId: true },
				})
			: null;
	await clearBufferedMessages(narratorId);
	interruptManualBash(narratorId);
	const interrupted = interruptNarrator(narratorId);
	await backgroundTaskService.cancelRunningByParent(narratorId);
	if (!interrupted) {
		const narrator = await narratorService.getById(narratorId).catch(() => null);
		if (narrator && (narrator.status === "working" || narrator.status === "waiting")) {
			await narratorService.updateStatus(narratorId, "idle", {
				substatus: ["authorization_revoked"],
				errorMessage: reason,
			});
		}
	}
	await recordOAuthSecurityEvent({
		event: "runtime_authorization_lost",
		grantId: grant?.id,
		userId: grant?.userId,
		oauthClientId: grant?.oauthClientId,
		metadata: { narratorId, reason: reason.slice(0, 256) },
	});
	logger.warn("OAuth narrator stopped after authorization loss", { narratorId, reason });
}

async function stopNarratorsByGrantPage(
	grantIds: readonly string[],
	reason: string,
): Promise<number> {
	if (grantIds.length === 0) return 0;
	let cursor: string | null = null;
	let stopped = 0;
	for (;;) {
		const rows = await db
			.select({ id: narrators.id })
			.from(integrationResourceBindings)
			.innerJoin(narrators, eq(narrators.id, integrationResourceBindings.resourceId))
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "narrator"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.authorityType, "oauth_grant"),
					inArray(integrationResourceBindings.authorityId, [...grantIds]),
					eq(integrationResourceBindings.state, "active"),
					cursor ? gt(narrators.id, cursor) : undefined,
				),
			)
			.orderBy(asc(narrators.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		for (const row of page) {
			await stopOAuthNarratorForAuthorizationLoss(row.id, reason);
			stopped++;
		}
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return stopped;
}

async function disconnectDevicesByGrantPage(
	grantIds: readonly string[],
	reason: string,
	projectIds?: readonly string[],
): Promise<number> {
	if (grantIds.length === 0 || projectIds?.length === 0) return 0;
	let cursor: string | null = null;
	let disconnected = 0;
	for (;;) {
		const rows = await db
			.select({ id: remoteDevices.id })
			.from(integrationResourceBindings)
			.innerJoin(remoteDevices, eq(remoteDevices.id, integrationResourceBindings.resourceId))
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "device"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.authorityType, "oauth_grant"),
					inArray(integrationResourceBindings.authorityId, [...grantIds]),
					eq(integrationResourceBindings.state, "active"),
					projectIds ? inArray(remoteDevices.projectId, [...projectIds]) : undefined,
					cursor ? gt(remoteDevices.id, cursor) : undefined,
				),
			)
			.orderBy(asc(remoteDevices.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		for (const row of page) {
			disconnectDevice(row.id, reason);
			disconnected++;
		}
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return disconnected;
}

async function disconnectDevicesByProjectPage(projectId: string, reason: string): Promise<number> {
	let cursor: string | null = null;
	let disconnected = 0;
	for (;;) {
		const rows = await db
			.select({ id: remoteDevices.id })
			.from(integrationResourceBindings)
			.innerJoin(remoteDevices, eq(remoteDevices.id, integrationResourceBindings.resourceId))
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "device"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.authorityType, "oauth_grant"),
					eq(integrationResourceBindings.state, "active"),
					eq(remoteDevices.projectId, projectId),
					cursor ? gt(remoteDevices.id, cursor) : undefined,
				),
			)
			.orderBy(asc(remoteDevices.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		for (const row of page) {
			disconnectDevice(row.id, reason);
			disconnected++;
		}
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return disconnected;
}

export async function propagateOAuthGrantRevocation(
	grantIds: readonly string[],
	reason = "OAuth grant revoked",
): Promise<number> {
	const uniqueGrantIds = [...new Set(grantIds)];
	for (const grantId of uniqueGrantIds) {
		integrationAuthorizationService.invalidateAuthority(grantId);
		integrationEventDispatcher.revokeAuthority(grantId, "oauth-grant-revoked");
	}
	const disconnected = await disconnectDevicesByGrantPage(uniqueGrantIds, reason);
	return disconnected + (await stopNarratorsByGrantPage(uniqueGrantIds, reason));
}

/** Stop runtime ownership and preserve provenance before grant rows are hard-deleted. */
export async function prepareOAuthGrantHardDeletion(
	grantIds: readonly string[],
	reason = "OAuth grant deleted",
): Promise<number> {
	const uniqueGrantIds = [...new Set(grantIds)].filter(Boolean);
	if (uniqueGrantIds.length === 0) return 0;
	for (const grantId of uniqueGrantIds) {
		eventBus.emit({
			type: "oauth:grant_changed",
			grantId,
			change: "revoked",
			reasonCode: "grant_deleted",
		});
	}
	let affected = await propagateOAuthGrantRevocation(uniqueGrantIds, reason);
	for (const grantId of uniqueGrantIds) {
		affected += await integrationResourceBindingService.markOrphaned("oauth_grant", grantId);
	}
	return affected;
}

/** Bounded scan used by the admin user hard-delete path before FK cascades remove grants. */
export async function prepareOAuthUserHardDeletion(
	userId: string,
	reason = "OAuth grant owner deleted",
): Promise<number> {
	let cursor: string | null = null;
	let affected = 0;
	for (;;) {
		const rows = await db
			.select({ id: oauthGrants.id })
			.from(oauthGrants)
			.where(and(eq(oauthGrants.userId, userId), cursor ? gt(oauthGrants.id, cursor) : undefined))
			.orderBy(asc(oauthGrants.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		affected += await prepareOAuthGrantHardDeletion(
			page.map((row) => row.id),
			reason,
		);
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return affected;
}

export async function propagateOAuthGrantRestriction(input: {
	grantId: string;
	removedScopes?: readonly string[];
	removedProjectIds?: readonly string[];
}): Promise<number> {
	integrationAuthorizationService.invalidateAuthority(input.grantId);
	integrationEventDispatcher.revokeAuthority(input.grantId, "oauth-grant-restricted");
	const projects = [...new Set(input.removedProjectIds ?? [])];
	let affected = 0;
	const narratorScopeRemoved = input.removedScopes?.includes("narrator.send_message") ?? false;
	if (narratorScopeRemoved) {
		affected += await stopNarratorsByGrantPage(
			[input.grantId],
			"OAuth narrator execution scope removed",
		);
	}
	if (projects.length === 0) return affected;
	affected += await disconnectDevicesByGrantPage(
		[input.grantId],
		"OAuth device project access removed",
		projects,
	);
	if (narratorScopeRemoved) return affected;
	let cursor: string | null = null;
	let stopped = 0;
	for (;;) {
		const rows = await db
			.select({ id: narrators.id })
			.from(integrationResourceBindings)
			.innerJoin(narrators, eq(narrators.id, integrationResourceBindings.resourceId))
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "narrator"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.authorityType, "oauth_grant"),
					eq(integrationResourceBindings.authorityId, input.grantId),
					eq(integrationResourceBindings.state, "active"),
					inArray(narrators.contextProjectId, projects),
					cursor ? gt(narrators.id, cursor) : undefined,
				),
			)
			.orderBy(asc(narrators.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		for (const row of page) {
			await stopOAuthNarratorForAuthorizationLoss(row.id, "OAuth narrator project access removed");
			stopped++;
		}
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return affected + stopped;
}

export async function propagateOAuthClientRestriction(
	oauthClientId: string,
	reason = "OAuth client authorization removed",
): Promise<number> {
	let cursor: string | null = null;
	let stopped = 0;
	for (;;) {
		const rows = await db
			.select({ id: integrationAuthorities.id })
			.from(integrationAuthorities)
			.where(
				and(
					eq(integrationAuthorities.kind, "oauth_grant"),
					eq(integrationAuthorities.integrationType, "oauth_client"),
					eq(integrationAuthorities.integrationId, oauthClientId),
					cursor ? gt(integrationAuthorities.id, cursor) : undefined,
				),
			)
			.orderBy(asc(integrationAuthorities.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		const grantIds = page.map((row) => row.id);
		for (const grantId of grantIds) {
			integrationAuthorizationService.invalidateAuthority(grantId);
			integrationEventDispatcher.revokeAuthority(grantId, "oauth-client-restricted");
		}
		stopped += await disconnectDevicesByGrantPage(grantIds, reason);
		stopped += await stopNarratorsByGrantPage(grantIds, reason);
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return stopped;
}

export async function propagateOAuthProjectRemoval(projectId: string): Promise<number> {
	let cursor: string | null = null;
	let stopped = await disconnectDevicesByProjectPage(projectId, "OAuth device project deleted");
	for (;;) {
		const rows = await db
			.select({ id: narrators.id })
			.from(integrationResourceBindings)
			.innerJoin(narrators, eq(narrators.id, integrationResourceBindings.resourceId))
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "narrator"),
					eq(integrationResourceBindings.sourceType, "oauth_client"),
					eq(integrationResourceBindings.authorityType, "oauth_grant"),
					eq(integrationResourceBindings.state, "active"),
					eq(narrators.contextProjectId, projectId),
					cursor ? gt(narrators.id, cursor) : undefined,
				),
			)
			.orderBy(asc(narrators.id))
			.limit(REVOCATION_PAGE_SIZE + 1);
		const page = rows.slice(0, REVOCATION_PAGE_SIZE);
		for (const row of page) {
			await stopOAuthNarratorForAuthorizationLoss(row.id, "OAuth narrator project deleted");
			stopped++;
		}
		if (rows.length <= REVOCATION_PAGE_SIZE || page.length === 0) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return stopped;
}
