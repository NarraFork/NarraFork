import { describe, expect, test } from "bun:test";
import { CANONICAL_CAPABILITY_DESCRIPTORS } from "@shared/integrations/capabilities";
import {
	eventSubscriptionSchema,
	integrationEventMetadataSchema,
} from "@shared/integrations/events";
import {
	credentialRefSchema,
	PRINCIPAL_TYPES,
	principalRefSchema,
} from "@shared/integrations/principals";
import {
	resolveResourceContainment,
	resourceRefSchema,
	resourceScopeSchema,
} from "@shared/integrations/resources";

describe("shared integration foundation", () => {
	test("keeps credentials separate from every canonical principal kind", () => {
		expect(PRINCIPAL_TYPES).toEqual([
			"user",
			"oauth_client",
			"oauth_grant",
			"plugin",
			"plugin_installation",
			"plugin_runtime",
			"device",
			"system",
		]);
		for (const type of PRINCIPAL_TYPES) {
			const value = type === "system" ? { type } : { type, id: `${type}-1` };
			expect(principalRefSchema.safeParse(value).success).toBe(true);
		}
		expect(principalRefSchema.safeParse({ type: "credential", id: "credential-1" }).success).toBe(
			false,
		);
		expect(credentialRefSchema.safeParse({ type: "oauth_token", id: "token-1" }).success).toBe(
			true,
		);
		expect(principalRefSchema.safeParse({ type: "system", id: "root" }).success).toBe(false);
	});

	test("uses exact resource scopes and fails closed for unknown cross-type relations", () => {
		const project = { type: "project" as const, id: "project-1" };
		const chapter = { type: "chapter" as const, id: "chapter-1" };
		expect(resourceRefSchema.safeParse(project).success).toBe(true);
		expect(resourceScopeSchema.safeParse({ type: "global", id: "nope" }).success).toBe(false);
		expect(resolveResourceContainment(project, chapter)).toBe("unknown");
		expect(
			resolveResourceContainment(project, chapter, {
				resolve: () => "contains",
			}),
		).toBe("contains");
		expect(
			resolveResourceContainment(project, chapter, {
				resolve: () => "not_contains",
			}),
		).toBe("not_contains");
	});

	test("defines canonical event.subscribe without removing legacy event capability ids", () => {
		expect(CANONICAL_CAPABILITY_DESCRIPTORS["event.subscribe"]).toMatchObject({
			resourceType: "event",
			defaultRedaction: "sensitive",
			defaultRateClass: "standard",
		});
		expect(CANONICAL_CAPABILITY_DESCRIPTORS["event.chapter.subscribe"]).toBeDefined();
		expect(CANONICAL_CAPABILITY_DESCRIPTORS["event.public.subscribe"]).toBeDefined();
	});

	test("bounds event subscriptions and keeps metadata strict", () => {
		expect(
			eventSubscriptionSchema.safeParse({
				topics: ["chapter.updated"],
				scope: { type: "project", id: "project-1" },
			}).success,
		).toBe(true);
		expect(
			eventSubscriptionSchema.safeParse({
				topics: Array.from({ length: 33 }, (_, index) => `chapter.event_${index}`),
				scope: { type: "global" },
			}).success,
		).toBe(false);
		expect(
			integrationEventMetadataSchema.safeParse({
				id: "event-1",
				topic: "chapter.updated",
				occurredAt: 1,
				extra: true,
			}).success,
		).toBe(false);
	});
});
