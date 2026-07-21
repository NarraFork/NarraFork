import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { integrationAuditEvents, integrationAuthorities } from "../../db/schema";
import { generateId } from "../../lib/id";
import { integrationAuthorityService } from "../integration-authority-service";
import { integrationAuthorizationService } from "../integration-authorization-service";

const authorityIds = new Set<string>();

afterEach(async () => {
	integrationAuthorizationService.clear();
	for (const authorityId of authorityIds) {
		await db
			.delete(integrationAuditEvents)
			.where(eq(integrationAuditEvents.authorityId, authorityId));
		await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, authorityId));
	}
	authorityIds.clear();
});

describe("IntegrationAuthorizationService", () => {
	test("binds decisions to authority revision and invalidates cached allows immediately", async () => {
		const authorityId = generateId();
		const projectId = generateId();
		const deviceId = generateId();
		authorityIds.add(authorityId);
		const created = await integrationAuthorityService.create({
			id: authorityId,
			kind: "oauth_grant",
			integrationId: generateId(),
			grants: [
				{
					capabilityId: "device.read",
					scope: { type: "project", id: projectId },
					createdBy: { type: "system" },
				},
			],
		});
		const request = {
			authorityId,
			authorityRevision: created.authority.revision,
			operation: "device.read",
			capability: "device.read" as const,
			scope: { type: "project" as const, id: projectId },
			resource: { type: "device" as const, id: deviceId },
			resourceProjectId: projectId,
			boundScopes: [{ type: "project" as const, id: projectId }],
			runtime: { type: "server" as const, id: "external-v1", generation: 1 },
			permittedCapabilities: ["device.read" as const],
			transport: "external-v1",
		};

		const first = await integrationAuthorizationService.authorize(request);
		expect(first.decision.allowed).toBe(true);
		expect(first.cacheHit).toBe(false);
		const cached = await integrationAuthorizationService.authorize(request);
		expect(cached.decision.allowed).toBe(true);
		expect(cached.cacheHit).toBe(true);

		const replaced = await integrationAuthorityService.replaceGrants({
			authorityId,
			expectedRevision: created.authority.revision,
			grants: [],
		});
		const stale = await integrationAuthorizationService.authorize(request);
		expect(stale.decision).toMatchObject({
			allowed: false,
			stage: "revision",
			code: "authority_revision_mismatch",
		});
		expect(stale.cacheHit).toBe(false);

		const suspended = await integrationAuthorityService.setState({
			authorityId,
			expectedRevision: replaced.authority.revision,
			state: "suspended",
		});
		const inactive = await integrationAuthorizationService.authorize({
			...request,
			authorityRevision: suspended.authority.revision,
		});
		expect(inactive.decision).toMatchObject({
			allowed: false,
			stage: "state",
			code: "authority_inactive",
		});

		const audit = await db.query.integrationAuditEvents.findMany({
			where: eq(integrationAuditEvents.authorityId, authorityId),
		});
		expect(
			audit.some((event) => event.operationId === "device.read" && event.outcome === "allowed"),
		).toBe(true);
		expect(
			audit.some((event) => event.operationId === "device.read" && event.outcome === "denied"),
		).toBe(true);
	});

	test("fails closed when token capabilities or grant constraints do not cover the operation", async () => {
		const authorityId = generateId();
		authorityIds.add(authorityId);
		const created = await integrationAuthorityService.create({
			id: authorityId,
			kind: "oauth_grant",
			integrationId: generateId(),
			grants: [
				{
					capabilityId: "event.subscribe",
					scope: { type: "integration", id: authorityId },
					constraints: { topics: ["narrafork.narrator.lifecycle"] },
					createdBy: { type: "system" },
				},
			],
		});
		const base = {
			authorityId,
			authorityRevision: created.authority.revision,
			operation: "event.subscribe",
			capability: "event.subscribe" as const,
			scope: { type: "integration" as const, id: authorityId },
			resource: { type: "event" as const, id: "narrafork.narrator.lifecycle" },
			resourceContainerScope: { type: "integration" as const, id: authorityId },
			boundScopes: [{ type: "integration" as const, id: authorityId }],
			runtime: { type: "server" as const, id: "oauth-ws", generation: 1 },
		};
		const missingCapability = await integrationAuthorizationService.authorize({
			...base,
			permittedCapabilities: ["narrator.read"],
			constraints: { topics: ["narrafork.narrator.lifecycle"] },
		});
		expect(missingCapability.decision).toMatchObject({
			allowed: false,
			code: "capability_not_granted",
		});
		const deniedTopic = await integrationAuthorizationService.authorize({
			...base,
			permittedCapabilities: ["event.subscribe"],
			constraints: { topics: ["narrafork.permission.requested"] },
		});
		expect(deniedTopic.decision).toMatchObject({
			allowed: false,
			code: "constraints_not_satisfied",
		});
	});
});
