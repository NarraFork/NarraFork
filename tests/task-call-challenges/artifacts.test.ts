import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	artifactReference,
	readArtifactJson,
	resolveArtifactPath,
	verifyFrozenBaseline,
	writeNewArtifact,
} from "./artifacts";
import { challenges, GRADER_VERSION } from "./fixtures";
import { FROZEN_V4 } from "./profiles";

const temporary: string[] = [];
afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "task-artifacts-"));
	temporary.push(path);
	return path;
}

describe("portable experiment artifacts", () => {
	test("writes relative references and resolves against the manifest, not cwd", async () => {
		const root = await directory();
		const manifest = join(root, "trial-manifest.json");
		const result = join(root, "trial-1.json");
		expect(artifactReference(manifest, result)).toBe("trial-1.json");
		expect(resolveArtifactPath(manifest, "trial-1.json")).toBe(result);
		expect(resolveArtifactPath(manifest, "nested/result.json")).toBe(
			join(root, "nested", "result.json"),
		);
	});

	test("relocates historical paths even when a different old checkout still exists", async () => {
		const old = await directory();
		const relocated = await directory();
		await writeFile(join(old, "trial.json"), '{"checkout":"old"}');
		await writeFile(join(relocated, "trial.json"), '{"checkout":"new"}');
		const manifest = join(relocated, "trial-manifest.json");
		const path = resolveArtifactPath(manifest, join(old, "trial.json"));
		expect(await readArtifactJson<{ checkout: string }>(path)).toEqual({ checkout: "new" });
		expect(resolveArtifactPath(manifest, "C:\\old-checkout\\results\\trial.json")).toBe(path);
	});

	test("a missing relocated artifact never falls back to the original checkout", async () => {
		const old = await directory();
		const relocated = await directory();
		await writeFile(join(old, "trial.json"), "{}");
		await expect(
			readArtifactJson(
				resolveArtifactPath(join(relocated, "trial-manifest.json"), join(old, "trial.json")),
			),
		).rejects.toThrow("artifact is missing");
	});

	test("rejects path traversal and invalid references", async () => {
		const root = await directory();
		const manifest = join(root, "trial-manifest.json");
		for (const reference of ["../secret", "nested/../../secret", "..\\secret", "", "x\0y"]) {
			expect(() => resolveArtifactPath(manifest, reference)).toThrow();
		}
		expect(() => artifactReference(manifest, join(root, "..", "outside.json"))).toThrow();
	});

	test("a regrade cannot overwrite a historical artifact", async () => {
		const path = join(await directory(), "analysis.json");
		await writeNewArtifact(path, { original: true });
		await expect(writeNewArtifact(path, { replacement: true })).rejects.toThrow();
		expect(await readArtifactJson<{ original: boolean }>(path)).toEqual({ original: true });
	});
});

test("a corrected grader preserves frozen evidence, challenge prose and initial fixture data", async () => {
	const root = await directory();
	const results = join(root, "results");
	await mkdir(results);
	const manifestPath = join(results, "old-manifest.json");
	const source = "original immutable grader";
	const graderHash = createHash("sha256").update(source).digest("hex");
	await writeNewArtifact(join(results, "source.json"), { sources: { "fixtures.ts": source } });
	await writeNewArtifact(join(results, "input.json"), {
		challenges: { "one.md": "original task" },
	});
	await writeNewArtifact(join(results, "trial.json"), {
		challengeId: "1",
		fixtureHash: "seed-hash",
	});
	await writeNewArtifact(manifestPath, {
		graderHash,
		sourceSnapshot: "/old/checkout/source.json",
		inputSnapshot: "/old/checkout/input.json",
		files: ["/old/checkout/trial.json"],
	});
	const current = [{ id: "1", file: "one.md", text: "original task", fixtureHash: "seed-hash" }];
	expect(await verifyFrozenBaseline(manifestPath, current)).toEqual({
		originalGraderHash: graderHash,
	});
	await expect(
		verifyFrozenBaseline(manifestPath, [{ ...current[0], text: "changed task" }]),
	).rejects.toThrow("Public challenge changed");
	await expect(
		verifyFrozenBaseline(manifestPath, [{ ...current[0], fixtureHash: "changed-seed" }]),
	).rejects.toThrow("Initial fixture changed");
	await writeFile(
		join(results, "source.json"),
		JSON.stringify({ sources: { "fixtures.ts": "tampered" } }),
	);
	await expect(verifyFrozenBaseline(manifestPath, current)).rejects.toThrow("snapshot is corrupt");
});

test("all current challenge seeds still match the immutable V4 evidence", async () => {
	const docs = new URL("../../docs/task-call-challenges/", import.meta.url);
	const current = await Promise.all(
		challenges.map(async (challenge) => ({
			id: challenge.id,
			file: challenge.file,
			text: await Bun.file(new URL(challenge.file, docs)).text(),
			fixtureHash: createHash("sha256").update(JSON.stringify(challenge.makeState())).digest("hex"),
		})),
	);
	const verified = await verifyFrozenBaseline(
		fileURLToPath(new URL(`results/${FROZEN_V4}-manifest.json`, docs)),
		current,
	);
	expect(verified.originalGraderHash).toHaveLength(64);
});

test("the analyzer CLI reads a relocated legacy result and refuses to replace its analysis", async () => {
	const root = await directory();
	const sourceDirectory = new URL("../../docs/task-call-challenges/results/", import.meta.url);
	const originalManifest = await readArtifactJson<{ files: string[] }>(
		fileURLToPath(new URL(`${FROZEN_V4}-manifest.json`, sourceDirectory)),
	);
	const recordName = `${FROZEN_V4}-luna-1.json`;
	await copyFile(fileURLToPath(new URL(recordName, sourceDirectory)), join(root, recordName));
	const manifestPath = join(root, "relocated-manifest.json");
	await writeNewArtifact(manifestPath, { ...originalManifest, files: [originalManifest.files[0]] });
	const command = [
		process.execPath,
		fileURLToPath(new URL("./analyze.ts", import.meta.url)),
		manifestPath,
	];
	const first = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 5000 });
	expect(first.exitCode).toBe(0);
	const analysisPath = join(root, `relocated-analysis-${GRADER_VERSION}.json`);
	const originalAnalysis = await Bun.file(analysisPath).text();
	const report = JSON.parse(originalAnalysis) as { currentGraderVersion: string; rows: unknown[] };
	expect(report.currentGraderVersion).toBe(GRADER_VERSION);
	expect(report.rows).toHaveLength(1);
	const repeated = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 5000 });
	expect(repeated.exitCode).not.toBe(0);
	expect(repeated.stderr.toString()).toContain("EEXIST");
	expect(await Bun.file(analysisPath).text()).toBe(originalAnalysis);
});
