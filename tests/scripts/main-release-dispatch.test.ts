import { describe, expect, test } from "bun:test";
import type { GhRunner } from "../../scripts/lib/github-release";
import {
	dispatchMainRelease,
	releaseSourceDeclaresRemotePeer,
} from "../../scripts/lib/main-release-dispatch";

const commit = "a".repeat(40);
const control = "c".repeat(40);
function fixture(
	options: {
		missingRunId?: boolean;
		wrongReturnedId?: boolean;
		wrongActor?: boolean;
		missingTag?: boolean;
		failed?: boolean;
		wrongPublicTag?: boolean;
		private?: boolean;
		annotated?: boolean;
	} = {},
) {
	const calls: string[][] = [];
	const runObject = (id: number) => ({
		id: options.wrongReturnedId ? 12 : id,
		event: "workflow_dispatch",
		path: ".github/workflows/release.yml",
		head_branch: "main",
		head_sha: control,
		display_title: "Release v1.2.0 (publish)",
		actor: { login: options.wrongActor ? "someone-else" : "operator" },
		head_repository: { full_name: "fixture/nf" },
		status: "completed",
		conclusion: options.failed ? "failure" : "success",
	});
	const run: GhRunner = async (args) => {
		calls.push(args);
		if (args[0] === "api" && args.includes("POST")) {
			if (!args.includes("repos/fixture/nf/actions/workflows/release.yml/dispatches"))
				throw new Error("Unexpected mutation endpoint");
			return JSON.stringify(options.missingRunId ? {} : { workflow_run_id: 11 });
		}
		const path = args[1];
		if (path === "repos/fixture/nf")
			return JSON.stringify({
				full_name: "fixture/nf",
				private: options.private ?? false,
				default_branch: "main",
			});
		if (path === "user") return JSON.stringify({ login: "operator" });
		if (path === "repos/fixture/nf/actions/workflows/release.yml")
			return JSON.stringify({ id: 1, path: ".github/workflows/release.yml", state: "active" });
		if (path === "repos/fixture/nf/git/ref/heads/main")
			return JSON.stringify({ object: { type: "commit", sha: control } });
		if (path === "repos/fixture/nf/git/ref/tags/v1.2.0") {
			if (options.missingTag) throw new Error("HTTP404");
			return JSON.stringify({
				object: {
					type: options.annotated ? "tag" : "commit",
					sha: options.annotated ? "d".repeat(40) : commit,
				},
			});
		}
		if (path === `repos/fixture/nf/git/tags/${"d".repeat(40)}`)
			return JSON.stringify({ object: { type: "commit", sha: commit } });
		if (path === "repos/fixture/nf/actions/runs/11") return JSON.stringify(runObject(11));
		if (path === "repos/fixture/nf/releases/tags/v1.2.0")
			return JSON.stringify({
				id: 20,
				tag_name: options.wrongPublicTag ? "v9.9.9" : "v1.2.0",
				draft: false,
			});
		throw new Error(`Unexpected mock call ${args.join(" ")}`);
	};
	return { calls, run };
}
const common = { repository: "fixture/nf", version: "1.2.0", commit, sleep: async () => {} };
describe("normal local release delegates peer to the same protected main CI", () => {
	test("uses the server-returned run ID without racing concurrent run listings", async () => {
		const f = fixture();
		expect(await dispatchMainRelease({ ...common, run: f.run })).toEqual({ runId: 11, commit });
		const posts = f.calls.filter((args) => args.includes("POST"));
		expect(posts).toHaveLength(1);
		expect(posts[0]).toContain("return_run_details=true");
		expect(posts[0]).toContain("inputs[publish]=true");
		expect(posts[0]).toContain("inputs[tag]=v1.2.0");
		expect(posts[0]).toContain("X-GitHub-Api-Version: 2022-11-28");
		expect(f.calls.some((args) => args.join(" ").includes("remote-peer-release.yml"))).toBe(false);
		expect(f.calls.some((args) => args.join(" ").includes("/runs?"))).toBe(false);
	});
	test("peels a pushed annotated NF tag without creating or moving refs", async () => {
		const f = fixture({ annotated: true });
		await dispatchMainRelease({ ...common, run: f.run });
		expect(
			f.calls
				.filter((args) => args.includes("POST"))
				.every((args) => args.some((arg) => arg.endsWith("/dispatches"))),
		).toBe(true);
	});
	for (const change of [{ missingTag: true }, { private: true }])
		test(`rejects before dispatch ${JSON.stringify(change)}`, async () => {
			const f = fixture(change);
			await expect(dispatchMainRelease({ ...common, run: f.run })).rejects.toThrow();
			expect(f.calls.some((args) => args.includes("POST"))).toBe(false);
		});
	for (const change of [
		{ missingRunId: true },
		{ wrongReturnedId: true },
		{ wrongActor: true },
		{ failed: true },
		{ wrongPublicTag: true },
	])
		test(`never declares success for ${JSON.stringify(change)}`, async () => {
			const f = fixture(change);
			await expect(dispatchMainRelease({ ...common, run: f.run })).rejects.toThrow();
			expect(f.calls.filter((args) => args.includes("POST"))).toHaveLength(1);
		});
	test("cancellation before dispatch does no network or mutations", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			dispatchMainRelease({ ...common, run: f.run, signal: controller.signal }),
		).rejects.toThrow(/cancelled/);
		expect(f.calls).toHaveLength(0);
	});
	test("inspects component declaration from exactly the frozen source commit", () => {
		const calls: string[][] = [];
		const read = (args: string[]) => {
			calls.push(args);
			return args[0] === "ls-tree"
				? "shared/component-versions.json"
				: JSON.stringify({
						executor: { version: "0.9.4", protocolVersion: 1 },
						remotePeer: { version: "0.1.0-alpha.1", protocolVersion: 1 },
					});
		};
		expect(releaseSourceDeclaresRemotePeer("/fixture", commit, read)).toBe(true);
		expect(calls.every((args) => args.some((arg) => arg.includes(commit)))).toBe(true);
		expect(releaseSourceDeclaresRemotePeer("/fixture", commit, () => "")).toBe(false);
		expect(
			releaseSourceDeclaresRemotePeer("/fixture", commit, (args) =>
				args[0] === "ls-tree"
					? "shared/component-versions.json"
					: '{"executor":{"version":"0.9.4","protocolVersion":1}}',
			),
		).toBe(false);
		expect(() =>
			releaseSourceDeclaresRemotePeer("/fixture", commit, () => "unexpected.json"),
		).toThrow();
	});
});
