import { describe, expect, test } from "bun:test";
import { formatLatestYmlFiles } from "../latest-yml";

const RELEASE_DATE = "2026-07-16T12:34:56.000Z";

describe("latest*.yml aggregation", () => {
	test("keeps every architecture in a shared manifest with a trailing LF", () => {
		const files = formatLatestYmlFiles([
			{
				name: "latest.yml",
				version: "0.5.11",
				releaseDate: RELEASE_DATE,
				file: {
					url: "narrafork-0.5.11-windows-x64.exe",
					size: 123,
					sha512: "sha-x64",
				},
			},
			{
				name: "latest.yml",
				version: "0.5.11",
				releaseDate: RELEASE_DATE,
				file: {
					url: "narrafork-0.5.11-windows-x64-baseline.exe",
					size: 456,
					sha512: "sha-baseline",
				},
			},
		]);

		const content = files.get("latest.yml");
		expect(content).toBeDefined();
		expect(content?.endsWith("\n")).toBe(true);
		expect(content?.endsWith("\n\n")).toBe(false);
		expect(content).toContain("  - url: narrafork-0.5.11-windows-x64-baseline.exe");
		expect(content).toContain("    size: 456");
		expect(content).toContain("    sha512: sha-baseline");
		expect(content).toContain("  - url: narrafork-0.5.11-windows-x64.exe");
		expect(content).toContain("    size: 123");
		expect(content).toContain("    sha512: sha-x64");
		expect(content).not.toContain("\\n");
		expect(content?.match(/^ {2}- url:/gm)).toHaveLength(2);
	});
});
