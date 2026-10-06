import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnexpectedReleaseChanges, resolveGitCommit } from "../../scripts/lib/release-git";

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
}

function createRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "narrafork-release-git-"));
	roots.push(root);
	git(root, "init", "--quiet");
	writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}\n');
	writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
	git(root, "add", "package.json", "src.ts");
	git(
		root,
		"-c",
		"user.name=NarraFork Tests",
		"-c",
		"user.email=tests@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"initial",
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release git safety", () => {
	test("allows only package.json and the version changelog before a release commit", () => {
		const root = createRepo();
		mkdirSync(join(root, "changelogs"));
		writeFileSync(join(root, "package.json"), '{"version":"1.0.1"}\n');
		writeFileSync(join(root, "changelogs", "v1.0.1.json"), "{}\n");
		writeFileSync(join(root, "src.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "notes.txt"), "untracked\n");

		const changes = getUnexpectedReleaseChanges(root, ["package.json", "changelogs/v1.0.1.json"]);
		const output = changes.join("\n");
		expect(output).toContain("src.ts");
		expect(output).toContain("notes.txt");
		expect(output).not.toContain("package.json");
		expect(output).not.toContain("changelogs/v1.0.1.json");
	});

	test("resolves exact tag commits and returns null for missing refs", () => {
		const root = createRepo();
		git(root, "tag", "v1.0.0");

		expect(resolveGitCommit(root, "refs/tags/v1.0.0")).toBe(resolveGitCommit(root, "HEAD"));
		expect(resolveGitCommit(root, "refs/tags/v1.0.1")).toBeNull();
	});
});
