import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkI18nResources,
	checkLocaleSensitiveFormatting,
} from "../../server/scripts/check-i18n";

describe("frontend i18n resources", () => {
	test("keep locale resources structurally compatible", () => {
		const report = checkI18nResources();
		expect(report.errors).toEqual([]);
		expect(report.stats.length).toBeGreaterThan(0);
	});

	test("rejects formatting that falls back to the system locale", () => {
		const directory = mkdtempSync(join(tmpdir(), "narrafork-i18n-format-"));
		try {
			writeFileSync(join(directory, "bad.ts"), "const value = (1234).toLocaleString();\n");
			writeFileSync(join(directory, "good.ts"), "const value = (1234).toLocaleString('en');\n");
			const errors = checkLocaleSensitiveFormatting(directory);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("bad.ts:1");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
