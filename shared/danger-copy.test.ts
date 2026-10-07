import { describe, expect, test } from "bun:test";
import {
	DANGER_COPY_KEYS,
	dangerCopyEnglishFallbacks,
	dangerCopyLabels,
	lookupDangerCopy,
	lookupDangerDetail,
} from "./danger-copy";

describe("danger-copy catalog", () => {
	test("maps known summary lines to stable keys", () => {
		expect(lookupDangerCopy("Git reset may rewrite the current worktree/index state.")).toEqual({
			key: "dangerCopy_gitResetSummary",
		});
		expect(lookupDangerCopy("rm deletes files recursively.")).toEqual({
			key: "dangerCopy_deleteFilesRecursiveSummary",
			params: { name: "rm" },
		});
		expect(lookupDangerCopy("Git rebase rewrites commit history.")).toEqual({
			key: "dangerCopy_gitHistoryRewriteSummary",
			params: { sub: "rebase" },
		});
	});

	test("maps detail chrome while preserving the dynamic value", () => {
		expect(lookupDangerDetail("Command: rm -rf /tmp/x")).toEqual({
			key: "dangerDetail_command",
			params: { value: "rm -rf /tmp/x" },
		});
		expect(lookupDangerDetail("External paths: /etc/hosts, /var/log")).toEqual({
			key: "dangerDetail_externalPaths",
			params: { value: "/etc/hosts, /var/log" },
		});
	});

	test("leaves custom content alone", () => {
		expect(lookupDangerCopy("Model-written free-form reflection text")).toBeNull();
		expect(lookupDangerDetail("just a sentence without chrome")).toBeNull();
	});

	test("every catalog key has an English fallback template", () => {
		const en = dangerCopyEnglishFallbacks();
		for (const key of DANGER_COPY_KEYS) {
			expect(en[key], key).toBeTruthy();
		}
		expect(Object.keys(en).sort()).toEqual([...DANGER_COPY_KEYS].sort());
	});

	test("labels generator covers every catalog key", () => {
		const labels = dangerCopyLabels((key) => `L:${key}`);
		expect(Object.keys(labels).sort()).toEqual([...DANGER_COPY_KEYS].sort());
		expect(labels.dangerCopy_gitResetSummary).toBe("L:dangerCopy_gitResetSummary");
	});
});
