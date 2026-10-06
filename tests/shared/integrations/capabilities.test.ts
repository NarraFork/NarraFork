import { describe, expect, test } from "bun:test";
import {
	CANONICAL_CAPABILITY_DESCRIPTORS,
	CAPABILITY_ACTIONS,
	CAPABILITY_RESOURCE_TYPES,
	CAPABILITY_RISK_LEVELS,
	canonicalCapabilityDescriptorSchema,
} from "@shared/integrations/capabilities";

describe("canonical integration capability descriptors", () => {
	test("keeps every descriptor strict, unique, and self-identifying", () => {
		const entries = Object.entries(CANONICAL_CAPABILITY_DESCRIPTORS);
		expect(entries.length).toBeGreaterThan(0);
		expect(new Set(entries.map(([id]) => id)).size).toBe(entries.length);

		for (const [id, descriptor] of entries) {
			expect(canonicalCapabilityDescriptorSchema.parse(descriptor)).toEqual(descriptor);
			expect(descriptor.id).toBe(id);
			expect(descriptor.i18nKey).toBe(`integrations.capabilities.${id}`);
			expect(CAPABILITY_RESOURCE_TYPES).toContain(descriptor.resourceType);
			expect(CAPABILITY_ACTIONS).toContain(descriptor.action);
			expect(CAPABILITY_RISK_LEVELS).toContain(descriptor.riskLevel);
		}
	});

	test("rejects unknown fields and remote execution on non-execution actions", () => {
		const valid = CANONICAL_CAPABILITY_DESCRIPTORS["project.read"];
		expect(canonicalCapabilityDescriptorSchema.safeParse({ ...valid, extra: true }).success).toBe(
			false,
		);
		expect(
			canonicalCapabilityDescriptorSchema.safeParse({ ...valid, remoteExecution: true }).success,
		).toBe(false);
	});
});
