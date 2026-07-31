import { describe, expect, test } from "bun:test";
import {
	ruleTargetMatches,
	selectorFromLegacyDeviceScope,
	selectorFromStorage,
	selectorToStorage,
} from "../selector";
import { executionContext } from "./fixtures";

describe("execution policy target selector", () => {
	test("normalizes legacy deviceScope values", () => {
		expect(selectorFromLegacyDeviceScope(null)).toEqual({ kind: "all" });
		expect(selectorFromLegacyDeviceScope("local")).toEqual({ kind: "host" });
		expect(selectorFromLegacyDeviceScope("host")).toEqual({ kind: "host" });
		expect(selectorFromLegacyDeviceScope("device-a")).toEqual({
			kind: "device",
			deviceId: "device-a",
		});
	});

	test("round-trips canonical storage fields while retaining legacy mirror", () => {
		const stored = selectorToStorage({ kind: "oauthGroup", group: "selfRegistered" });
		expect(stored).toEqual({
			targetKind: "oauthGroup",
			targetValue: "selfRegistered",
			deviceScope: "selfRegistered",
		});
		expect(selectorFromStorage(stored.targetKind, stored.targetValue, stored.deviceScope)).toEqual({
			kind: "oauthGroup",
			group: "selfRegistered",
		});
	});

	test("does not match scoped rules without target context", () => {
		expect(ruleTargetMatches({ kind: "all" }, undefined)).toBe(true);
		expect(ruleTargetMatches({ kind: "host" }, undefined)).toBe(false);
		expect(ruleTargetMatches({ kind: "device", deviceId: "device-a" }, undefined)).toBe(false);
		expect(ruleTargetMatches({ kind: "oauthGroup", group: "global" }, undefined)).toBe(false);
	});

	test("matches each selector only against its explicit context axis", () => {
		const context = executionContext({
			deviceId: "device-a",
			kind: "local",
			deviceClass: "global",
		});
		expect(ruleTargetMatches({ kind: "host" }, context)).toBe(false);
		expect(ruleTargetMatches({ kind: "device", deviceId: "device-a" }, context)).toBe(true);
		expect(ruleTargetMatches({ kind: "device", deviceId: "device-b" }, context)).toBe(false);
		expect(ruleTargetMatches({ kind: "oauthGroup", group: "global" }, context)).toBe(true);
		expect(ruleTargetMatches({ kind: "host" }, executionContext())).toBe(true);
	});
});
