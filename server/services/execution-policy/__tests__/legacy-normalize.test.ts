import { describe, expect, test } from "bun:test";
import { normalizeExecutionPolicyRuleSet } from "../normalize";

describe("legacy execution policy normalization", () => {
	test("normalizes unscoped global legacy entries to all", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{
				whitelistDirs: [{ path: "/workspace", accessLevel: "readWrite" }],
				commandBlacklist: [{ pattern: "rm -rf" }],
			},
			"global",
		);
		expect(rules.directoryWhitelist[0]).toMatchObject({
			source: "global",
			selector: { kind: "all" },
			pathFlavor: "posix",
			pathKey: "/workspace",
			enabled: true,
		});
		expect(rules.commandBlacklist[0].selector).toEqual({ kind: "all" });
	});

	test("normalizes legacy narrator device scopes and canonical storage fields", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{
				blacklistDirs: [{ path: "C:\\Secret", deviceScope: "local" }],
				commandWhitelist: [
					{ pattern: "git status", targetKind: "device", targetValue: "device-a" },
				],
			},
			"narrator",
		);
		expect(rules.directoryBlacklist[0]).toMatchObject({
			selector: { kind: "host" },
			pathFlavor: "windows",
			pathKey: "c:/secret",
		});
		expect(rules.commandWhitelist[0].selector).toEqual({
			kind: "device",
			deviceId: "device-a",
		});
	});

	test("canonical selector takes precedence over legacy deviceScope", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{
				commandWhitelist: [
					{
						pattern: "bun test",
						selector: { kind: "oauthGroup", group: "selfRegistered" },
						deviceScope: "device-a",
					},
				],
			},
			"project",
		);
		expect(rules.commandWhitelist[0].selector).toEqual({
			kind: "oauthGroup",
			group: "selfRegistered",
		});
	});
});
