import { describe, expect, test } from "bun:test";
import {
	type ExecutorPathRule,
	isAbsoluteExecutorPath,
	MAX_EXECUTOR_PATH_RULES,
	normalizeExecutorPathRules,
	previewExecutorPathDecision,
	validateExecutorPathRules,
} from "./executor-path-rules";

describe("isAbsoluteExecutorPath", () => {
	test("accepts both POSIX and Windows shapes regardless of host OS", () => {
		expect(isAbsoluteExecutorPath("/srv/work")).toBe(true);
		expect(isAbsoluteExecutorPath("C:\\work")).toBe(true);
		expect(isAbsoluteExecutorPath("c:/work")).toBe(true);
		expect(isAbsoluteExecutorPath("\\\\fileserver\\share")).toBe(true);
	});

	test("rejects relative and drive-relative paths", () => {
		expect(isAbsoluteExecutorPath("work/projects")).toBe(false);
		expect(isAbsoluteExecutorPath("./work")).toBe(false);
		// "C:rel" resolves against the drive's current directory, which is not a
		// stable guard root.
		expect(isAbsoluteExecutorPath("C:rel")).toBe(false);
		expect(isAbsoluteExecutorPath("")).toBe(false);
	});
});

describe("validateExecutorPathRules", () => {
	test("accepts a well-formed ordered list", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work/secrets" },
		];
		expect(validateExecutorPathRules(rules).ok).toBe(true);
	});

	test("reports the index of each bad rule so the UI can mark the right row", () => {
		const { ok, problems } = validateExecutorPathRules([
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "relative/path" },
			{ action: "allow", path: "" },
		]);
		expect(ok).toBe(false);
		expect(problems.map((p) => p.index)).toEqual([1, 2]);
	});

	test("rejects control characters, which must never reach a config file", () => {
		expect(validateExecutorPathRules([{ action: "allow", path: "/srv/wo\nrk" }]).ok).toBe(false);
		expect(validateExecutorPathRules([{ action: "allow", path: "/srv/wo\u0000rk" }]).ok).toBe(
			false,
		);
	});

	test("rejects a list longer than the executor would accept", () => {
		const rules = Array.from({ length: MAX_EXECUTOR_PATH_RULES + 1 }, () => ({
			action: "allow" as const,
			path: "/srv/work",
		}));
		expect(validateExecutorPathRules(rules).ok).toBe(false);
	});

	test("duplicate paths are legal because the later rule wins", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work" },
		];
		expect(validateExecutorPathRules(rules).ok).toBe(true);
	});
});

describe("normalizeExecutorPathRules", () => {
	test("trims without reordering or deduping, because order is the policy", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "deny", path: "  /srv/z  " },
			{ action: "allow", path: "/srv/a" },
			{ action: "deny", path: "/srv/z" },
		];
		expect(normalizeExecutorPathRules(rules)).toEqual([
			{ action: "deny", path: "/srv/z" },
			{ action: "allow", path: "/srv/a" },
			{ action: "deny", path: "/srv/z" },
		]);
	});
});

describe("previewExecutorPathDecision", () => {
	test("an empty list is unrestricted", () => {
		expect(previewExecutorPathDecision([], "/anywhere")).toEqual({
			decision: "allow",
			ruleIndex: null,
		});
	});

	test("last match wins through nested exceptions", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work/secrets" },
			{ action: "allow", path: "/srv/work/secrets/public" },
		];
		expect(previewExecutorPathDecision(rules, "/srv/work/readme.md").decision).toBe("allow");
		expect(previewExecutorPathDecision(rules, "/srv/work/secrets/key.pem").decision).toBe("deny");
		expect(previewExecutorPathDecision(rules, "/srv/work/secrets/public/notice.txt").decision).toBe(
			"allow",
		);
	});

	test("reversing the order reverses the outcome", () => {
		const path = "/srv/work/secrets/key.pem";
		expect(
			previewExecutorPathDecision(
				[
					{ action: "allow", path: "/srv/work" },
					{ action: "deny", path: "/srv/work/secrets" },
				],
				path,
			).decision,
		).toBe("deny");
		expect(
			previewExecutorPathDecision(
				[
					{ action: "deny", path: "/srv/work/secrets" },
					{ action: "allow", path: "/srv/work" },
				],
				path,
			).decision,
		).toBe("allow");
	});

	test("a path matching no rule is unmatched, not allowed", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/work" }];
		expect(previewExecutorPathDecision(rules, "/etc/passwd").decision).toBe("unmatched");
	});

	test("sibling directories with a shared prefix are not treated as nested", () => {
		// "/srv/workshop" must not be considered inside "/srv/work".
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/work" }];
		expect(previewExecutorPathDecision(rules, "/srv/workshop/file").decision).toBe("unmatched");
	});

	test("a rule matches the directory itself, not only its children", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/work" }];
		expect(previewExecutorPathDecision(rules, "/srv/work").decision).toBe("allow");
		expect(previewExecutorPathDecision(rules, "/srv/work/").decision).toBe("allow");
	});

	test("windows matching folds case and separators", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "allow", path: "C:\\Work" },
			{ action: "deny", path: "C:\\Work\\Secrets" },
		];
		expect(
			previewExecutorPathDecision(rules, "c:/work/readme.md", { windows: true }).decision,
		).toBe("allow");
		expect(
			previewExecutorPathDecision(rules, "C:\\WORK\\SECRETS\\key.pem", { windows: true }).decision,
		).toBe("deny");
	});

	test("case folding does not apply to POSIX paths", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/Work" }];
		expect(previewExecutorPathDecision(rules, "/srv/work/file").decision).toBe("unmatched");
	});

	test("reports which rule decided so the UI can highlight it", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work/secrets" },
		];
		expect(previewExecutorPathDecision(rules, "/srv/work/secrets/x").ruleIndex).toBe(1);
		expect(previewExecutorPathDecision(rules, "/srv/work/x").ruleIndex).toBe(0);
	});

	// The executor cleans a path before matching it, so a preview that matched the
	// unclean text would claim allow for paths the device refuses. Nothing surfaces
	// that disagreement to the operator, hence these cases.
	test("a path that climbs back out of an allowed root is not allowed", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/work" }];
		expect(previewExecutorPathDecision(rules, "/srv/work/../etc/passwd").decision).toBe(
			"unmatched",
		);
		expect(previewExecutorPathDecision(rules, "/srv/work/sub/../../etc").decision).toBe(
			"unmatched",
		);
	});

	test("a path that climbs back INTO an allowed root is still allowed", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/work" }];
		expect(previewExecutorPathDecision(rules, "/srv/work/sub/../file").decision).toBe("allow");
	});

	test("`..` cannot escape a deny that carves a hole out of an allow", () => {
		const rules: ExecutorPathRule[] = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work/secrets" },
		];
		// Walking out of "public" and into "secrets" must land on the deny.
		expect(previewExecutorPathDecision(rules, "/srv/work/public/../secrets/key").decision).toBe(
			"deny",
		);
	});

	test("`.` segments are inert", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv/work" }];
		expect(previewExecutorPathDecision(rules, "/srv/./work/./file").decision).toBe("allow");
	});

	test("`..` at the root is dropped rather than escaping above it", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "/srv" }];
		expect(previewExecutorPathDecision(rules, "/../srv/file").decision).toBe("allow");
	});

	test("windows previews clean `..` too", () => {
		const rules: ExecutorPathRule[] = [{ action: "allow", path: "C:\\Work" }];
		expect(
			previewExecutorPathDecision(rules, "C:\\Work\\..\\Windows\\system32", { windows: true })
				.decision,
		).toBe("unmatched");
	});
});
