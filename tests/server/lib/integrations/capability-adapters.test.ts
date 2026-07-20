import { describe, expect, test } from "bun:test";
import {
	adaptOAuthScope,
	adaptPluginCapability,
	OAUTH_SCOPE_CAPABILITY_ADAPTER,
	PLUGIN_CAPABILITY_ADAPTER,
} from "@server/lib/integrations/capability-adapters";
import { OAUTH_SUPPORTED_SCOPES } from "@server/lib/oauth-provider";
import { CAPABILITIES } from "@server/lib/plugins/permissions";
import { CANONICAL_CAPABILITY_DESCRIPTORS } from "@shared/integrations/capabilities";

function sorted(values: readonly string[]): string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

describe("integration capability adapter parity", () => {
	test("maps every canonical OAuth scope by identity", () => {
		expect(sorted(Object.keys(OAUTH_SCOPE_CAPABILITY_ADAPTER))).toEqual(
			sorted(OAUTH_SUPPORTED_SCOPES),
		);

		for (const scope of OAUTH_SUPPORTED_SCOPES) {
			const entry = OAUTH_SCOPE_CAPABILITY_ADAPTER[scope];
			const adapted = adaptOAuthScope(scope);
			expect(adapted).toBeDefined();
			expect(adapted?.source).toBe("oauth");
			expect(adapted?.sourceId).toBe(scope);
			expect(entry.descriptorId).toBe(scope);
			expect(adapted?.deprecated).toBe(false);
			expect(adapted).toMatchObject(CANONICAL_CAPABILITY_DESCRIPTORS[entry.descriptorId]);
		}
	});

	test("covers every plugin capability and makes internal-only status explicit", () => {
		expect(sorted(Object.keys(PLUGIN_CAPABILITY_ADAPTER))).toEqual(sorted(CAPABILITIES));

		for (const capability of CAPABILITIES) {
			const entry = PLUGIN_CAPABILITY_ADAPTER[capability];
			expect(CANONICAL_CAPABILITY_DESCRIPTORS[entry.descriptorId]).toBeDefined();
			expect(["integration", "internal-only"]).toContain(entry.visibility);
			const adapted = adaptPluginCapability(capability);
			expect(adapted?.source).toBe("plugin");
			expect(adapted?.sourceId).toBe(capability);
		}

		expect(
			Object.values(PLUGIN_CAPABILITY_ADAPTER).some(
				(entry) => entry.visibility === "internal-only",
			),
		).toBe(true);
	});

	test("fails closed for unknown protocol strings", () => {
		expect(adaptOAuthScope("project.write")).toBeUndefined();
		expect(adaptPluginCapability("query.read.everything")).toBeUndefined();
	});
});
