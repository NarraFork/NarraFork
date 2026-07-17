import { describe, expect, test } from "bun:test";
import {
	forcesRelaxedPlan,
	legacyPermissionModeSchema,
	normalizeLegacyPermissionMode,
	normalizeLegacyPlanPreviousPermissionMode,
	resolveEffectiveRelaxedPlan,
	resolveInitialRelaxedPlan,
} from "../permission-modes";

describe("permission mode normalization", () => {
	test("preserves current permission modes", () => {
		expect(normalizeLegacyPermissionMode("acceptEdits")).toBe("acceptEdits");
		expect(normalizeLegacyPermissionMode("bypassPermissions")).toBe("bypassPermissions");
	});

	test("maps legacy permission modes without escalating to bypass", () => {
		expect(normalizeLegacyPermissionMode("allowByDefault")).toBe("acceptEdits");
		expect(normalizeLegacyPermissionMode("denyByDefault")).toBe("dontAsk");
		expect(normalizeLegacyPermissionMode("plan")).toBe("default");
		expect(normalizeLegacyPermissionMode("unknown")).toBe("default");
		expect(normalizeLegacyPermissionMode(undefined, "bypassPermissions")).toBe("bypassPermissions");
	});

	test("compat schema accepts legacy wire values and rejects unrelated strings", () => {
		expect(legacyPermissionModeSchema.parse("allowByDefault")).toBe("acceptEdits");
		expect(legacyPermissionModeSchema.parse("denyByDefault")).toBe("dontAsk");
		expect(legacyPermissionModeSchema.parse("plan")).toBe("default");
		expect(legacyPermissionModeSchema.parse("readOnly")).toBe("readOnly");
		expect(() => legacyPermissionModeSchema.parse("unknown")).toThrow();
	});

	test("legacy plan migration preserves restrictive previous modes", () => {
		expect(normalizeLegacyPlanPreviousPermissionMode("readOnly")).toBe("readOnly");
		expect(normalizeLegacyPlanPreviousPermissionMode("dontAsk")).toBe("dontAsk");
		expect(normalizeLegacyPlanPreviousPermissionMode("bypassPermissions")).toBe(
			"bypassPermissions",
		);
		expect(normalizeLegacyPlanPreviousPermissionMode("plan")).toBe("default");
		expect(normalizeLegacyPlanPreviousPermissionMode(null)).toBe("default");
		expect(normalizeLegacyPlanPreviousPermissionMode("unknown")).toBe("default");
	});
});

describe("bypassPermissions always forces relaxed plan", () => {
	test("forcesRelaxedPlan is true only for bypassPermissions", () => {
		expect(forcesRelaxedPlan("bypassPermissions")).toBe(true);
		expect(forcesRelaxedPlan("acceptEdits")).toBe(false);
		expect(forcesRelaxedPlan("default")).toBe(false);
		expect(forcesRelaxedPlan(undefined)).toBe(false);
	});

	test("effective relaxed plan ignores stored false under bypass", () => {
		expect(resolveEffectiveRelaxedPlan("bypassPermissions", false)).toBe(true);
		expect(resolveEffectiveRelaxedPlan("bypassPermissions", true)).toBe(true);
		expect(resolveEffectiveRelaxedPlan("acceptEdits", false)).toBe(false);
		expect(resolveEffectiveRelaxedPlan("acceptEdits", true)).toBe(true);
	});

	test("initial relaxed plan ignores user default under bypass", () => {
		expect(
			resolveInitialRelaxedPlan({
				permissionMode: "bypassPermissions",
				explicit: false,
				defaultRelaxedPlan: false,
			}),
		).toBe(true);
		expect(
			resolveInitialRelaxedPlan({
				permissionMode: "acceptEdits",
				explicit: false,
				defaultRelaxedPlan: true,
			}),
		).toBe(false);
		expect(
			resolveInitialRelaxedPlan({
				permissionMode: "acceptEdits",
				defaultRelaxedPlan: true,
			}),
		).toBe(true);
	});
});
