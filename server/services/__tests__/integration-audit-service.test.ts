import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { integrationAuditEvents } from "../../db/schema";
import { generateId } from "../../lib/id";
import { integrationAuditService } from "../integration-audit-service";

const authorityId = generateId();

afterEach(async () => {
	await db
		.delete(integrationAuditEvents)
		.where(eq(integrationAuditEvents.authorityId, authorityId));
});

describe("IntegrationAuditService", () => {
	test("records bounded redacted authorization context", async () => {
		const row = await integrationAuditService.record({
			principal: { type: "oauth_client", id: generateId() },
			credential: { type: "oauth_token", id: authorityId },
			authorityId,
			transport: "external-v1",
			operationId: "device.rotate",
			capabilityId: "device.rotate",
			resource: { type: "device", id: generateId() },
			scope: { type: "project", id: generateId() },
			outcome: "denied",
			reasonCode: "scope_not_granted",
			requestBytes: 128,
			metadata: { safe: "summary" },
		});
		expect(row).toMatchObject({
			authorityId,
			principalType: "oauth_client",
			credentialType: "oauth_token",
			operationId: "device.rotate",
			outcome: "denied",
			metadataJson: { safe: "summary" },
		});
		await expect(
			integrationAuditService.record({
				principal: { type: "system" },
				authorityId,
				transport: "server",
				operationId: "oversized.metadata",
				outcome: "failed",
				metadata: { value: "x".repeat(5_000) },
			}),
		).rejects.toThrow(/metadata is too large/);
	});

	test("paginates by stable createdAt and id cursors", async () => {
		for (let index = 0; index < 3; index++) {
			await integrationAuditService.record({
				principal: { type: "system" },
				authorityId,
				transport: "server",
				operationId: `audit.page.${index}`,
				outcome: "succeeded",
				createdAt: new Date(Date.parse("2026-07-19T00:00:00.000Z") + index).toISOString(),
			});
		}
		const first = await integrationAuditService.listByAuthority({ authorityId, limit: 2 });
		expect(first.items.map((item) => item.operationId)).toEqual(["audit.page.2", "audit.page.1"]);
		expect(first.nextCursor).toBeString();
		const second = await integrationAuditService.listByAuthority({
			authorityId,
			limit: 2,
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.items.map((item) => item.operationId)).toEqual(["audit.page.0"]);
		expect(second.nextCursor).toBeNull();
	});
});
