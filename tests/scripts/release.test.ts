import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function decode(output: Uint8Array | undefined): string {
	return output ? new TextDecoder().decode(output) : "";
}

describe("release upload validation", () => {
	test("exits non-zero when there are no upload entries", () => {
		const result = Bun.spawnSync(
			["bun", "scripts/release.ts", "0.5.11", "--upload-only", "--platform=not-a-real-platform"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NF_UPDATE_SERVER: "http://127.0.0.1:1",
					NF_UPDATE_TOKEN: "test-token",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const output = `${decode(result.stdout)}${decode(result.stderr)}`;
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("No release artifacts were uploaded");
	});
});
