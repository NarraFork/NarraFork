import { describe, expect, test } from "bun:test";
import { posixPathSemantics } from "@server/lib/agent/execution/path-semantics";
import { normalizeExecutionPolicyRuleSet } from "../normalize";
import { detectPathFlavor, normalizePathKey } from "../path";
import { evaluatePathPolicy } from "../path-policy";

describe("execution policy path flavor", () => {
	test("creates stable POSIX and Windows path keys", () => {
		expect(detectPathFlavor("/var/lib/app")).toBe("posix");
		expect(normalizePathKey("/var/lib/app/", "posix")).toBe("/var/lib/app");
		expect(detectPathFlavor("C:\\Work\\Repo")).toBe("windows");
		expect(normalizePathKey("C:\\Work\\Repo\\", "windows")).toBe("c:/work/repo");
	});

	test("does not compare paths across different flavors", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{ whitelistDirs: [{ path: "C:\\Work", accessLevel: "full" }] },
			"global",
		);
		expect(
			evaluatePathPolicy({
				path: "/c/Work/file.txt",
				paths: posixPathSemantics,
				operation: "read",
				whitelist: rules.directoryWhitelist,
				blacklist: [],
			}),
		).toEqual({ decision: "unmatched" });
	});

	test("gives matching blacklist rules priority over whitelist rules", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{
				whitelistDirs: [{ path: "/workspace", accessLevel: "full" }],
				blacklistDirs: [{ path: "/workspace/secrets", denyLevel: "denyAll" }],
			},
			"project",
		);
		const result = evaluatePathPolicy({
			path: "/workspace/secrets/token.txt",
			paths: posixPathSemantics,
			operation: "read",
			whitelist: rules.directoryWhitelist,
			blacklist: rules.directoryBlacklist,
		});
		expect(result.decision).toBe("deny");
	});
});
