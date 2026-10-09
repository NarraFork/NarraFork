import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CiReleasePlan } from "../../scripts/lib/ci-release-types";
import {
	UPDATE_INDEX_FILE,
	type UpdateIndexRelease,
	type UpdateIndexV1,
} from "../../shared/update-index-types";

const plan: CiReleasePlan = {
	schemaVersion: 1,
	repository: "Example/Promoted",
	defaultBranch: "trunk",
	version: "1.2.1",
	tag: "v1.2.1",
	channel: "beta",
	commit: "a".repeat(40),
	workflowCommit: "b".repeat(40),
	bunVersion: "1.4.2",
	runId: 456,
	runAttempt: 1,
	changelog: { version: "1.2.1", date: "2026-01-02", en: "Published notes", "zh-CN": "发布说明" },
	baselines: [],
};
const sourcePlan: CiReleasePlan = { ...plan, runId: 123, runAttempt: 2 };
const publishedAt = "2026-01-02T03:04:05.000Z";
const published: UpdateIndexRelease = {
	version: plan.version,
	tag: plan.tag,
	commit: plan.commit,
	// The approved announcement has been promoted; do not re-infer beta from x.y.1.
	prerelease: false,
	publishedAt,
	files: [
		{
			name: "narrafork-1.2.1-linux-x64",
			platform: "linux-x64",
			size: 16,
			sha256: "c".repeat(64),
			sha512: Buffer.alloc(64, 1).toString("base64"),
			metadata: {
				name: "narrafork-1.2.1-linux-x64.metadata.json",
				size: 256,
				sha256: "d".repeat(64),
			},
			patches: [],
		},
	],
};
const trace: string[] = [];
const revalidate = mock(async (_value: CiReleasePlan, _options: { publish: boolean }) => {
	trace.push("revalidate");
});
const restore = mock(async (options: { sourceRunId: number; destination: string }) => {
	trace.push("restore");
	return { plan: sourcePlan, destination: options.destination };
});
const verify = mock(async (_directory: string, _value: CiReleasePlan) => {
	trace.push("verify-bundle");
	return { schemaVersion: 1, plan: sourcePlan, files: [], smoke: [] };
});
const verifyPublished = mock(async (options: { requireAlreadyPublished?: boolean }) => {
	trace.push("verify-published-assets");
	if (options.requireAlreadyPublished !== true)
		throw new Error("Fixture forbids Release publication");
	return { alreadyPublished: true, dryRun: false, assets: [] };
});
const readPublished = mock(
	async (_options: { repository: string; version: string; commit: string }) => {
		trace.push("read-public-announcement");
		return { release: structuredClone(published) };
	},
);
const localPrepare = mock((..._args: unknown[]) => {
	throw new Error("Index repair must not derive announcement from a local bundle");
});
const indexWriter = mock((..._args: unknown[]) => {
	throw new Error("Preview must not write the metadata branch");
});
const remote = mock((..._args: unknown[]) => {
	throw new Error("Test must not contact real GitHub");
});
const unrelated = mock((..._args: unknown[]) => {
	throw new Error("Unexpected release build/preflight path");
});

// Only side effects and remote trust seams are mocked. The controller, argument parser,
// plan-file read, mergeUpdateIndex, writeIndexPreview and filesystem writes stay real.
mock.module("../../scripts/lib/ci-release-plan", () => ({
	validateCiReleasePlan: (value: CiReleasePlan) => value,
	revalidateCiReleasePlan: revalidate,
	createCiReleasePlan: unrelated,
}));
mock.module("../../scripts/lib/ci-release-restore", () => ({ restoreCiReleaseBundle: restore }));
mock.module("../../scripts/lib/ci-release-bundle", () => ({
	verifyReleaseBundle: verify,
	assembleReleaseBundle: unrelated,
}));
mock.module("../../scripts/lib/github-release", () => ({
	publishGitHubRelease: verifyPublished,
	runGh: remote,
}));
mock.module("../../scripts/lib/github-release-baseline", () => ({
	selectGitHubBaselines: unrelated,
}));
mock.module("../../scripts/lib/update-index", () => ({ prepareUpdateIndexRelease: localPrepare }));
mock.module("../../scripts/lib/update-index-github", () => ({
	preparePublishedUpdateIndexRelease: readPublished,
	publishUpdateIndex: indexWriter,
}));
const { runCiRelease } = await import("../../scripts/ci-release");

let root = "";
let previousSummary: string | undefined;
let previousOutput: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), ".narrafork/ci-index-preview-"));
	writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
	previousSummary = process.env.GITHUB_STEP_SUMMARY;
	previousOutput = process.env.GITHUB_OUTPUT;
	process.env.GITHUB_STEP_SUMMARY = join(root, "summary.txt");
	process.env.GITHUB_OUTPUT = join(root, "actions-output.txt");
	trace.length = 0;
	for (const seam of [
		revalidate,
		restore,
		verify,
		verifyPublished,
		readPublished,
		localPrepare,
		indexWriter,
		remote,
		unrelated,
	])
		seam.mockClear();
});
afterEach(() => {
	if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
	else process.env.GITHUB_STEP_SUMMARY = previousSummary;
	if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
	else process.env.GITHUB_OUTPUT = previousOutput;
	rmSync(root, { recursive: true, force: true });
});
afterAll(() => mock.restore());

describe("CI read-only index repair uses the public announcement", () => {
	for (const withBundle of [true, false]) {
		test(`${withBundle ? "source-run-id bundle" : "without bundle"} preview preserves promotion and original publication time`, async () => {
			const preview = join(root, "preview");
			const bundle = join(root, "restored");
			await runCiRelease([
				"index",
				`--plan=${join(root, "plan.json")}`,
				"--publish=false",
				`--preview-dir=${preview}`,
				...(withBundle ? ["--source-run-id=123", `--bundle-dir=${bundle}`] : []),
			]);
			const index: UpdateIndexV1 = JSON.parse(
				readFileSync(join(preview, UPDATE_INDEX_FILE), "utf8"),
			);
			const release: UpdateIndexRelease = JSON.parse(
				readFileSync(join(preview, "release.json"), "utf8"),
			);
			expect(plan.channel).toBe("beta");
			expect(index.channels).toEqual({ stable: "1.2.1", beta: "1.2.1" });
			expect(index.generatedAt).toBe(publishedAt);
			expect(index.releases[0]?.publishedAt).toBe(publishedAt);
			expect(index.releases[0]?.prerelease).toBe(false);
			expect(release).toEqual(published);
			expect(readPublished).toHaveBeenCalledTimes(1);
			expect(readPublished.mock.calls[0]?.[0]).toMatchObject({
				repository: plan.repository,
				version: plan.version,
				commit: plan.commit,
			});
			expect(revalidate).toHaveBeenCalledTimes(1);
			expect(revalidate.mock.calls[0]?.[1].publish).toBe(false);
			if (withBundle) {
				expect(restore.mock.calls[0]?.[0]).toMatchObject({
					sourceRunId: 123,
					destination: resolve(bundle),
				});
				expect(verify).toHaveBeenCalledWith(resolve(bundle), sourcePlan);
				expect(verifyPublished.mock.calls[0]?.[0]).toMatchObject({
					requireAlreadyPublished: true,
					version: "1.2.1",
				});
				expect(trace).toEqual([
					"revalidate",
					"restore",
					"verify-bundle",
					"verify-published-assets",
					"read-public-announcement",
				]);
			} else {
				expect(restore).not.toHaveBeenCalled();
				expect(verify).not.toHaveBeenCalled();
				expect(verifyPublished).not.toHaveBeenCalled();
				expect(trace).toEqual(["revalidate", "read-public-announcement"]);
			}
			expect(localPrepare).not.toHaveBeenCalled();
			expect(indexWriter).not.toHaveBeenCalled();
			expect(remote).not.toHaveBeenCalled();
			expect(unrelated).not.toHaveBeenCalled();
			expect(existsSync(join(root, "actions-output.txt"))).toBe(false);
			expect(readFileSync(join(root, "summary.txt"), "utf8")).toContain(
				"no Release or ref was changed",
			);
		});
	}
});
