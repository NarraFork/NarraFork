import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_TARGETS,
	type CiReleasePlan,
} from "../../scripts/lib/ci-release-types";
import type { GhRunner } from "../../scripts/lib/github-release";
import { selectGitHubBaselines } from "../../scripts/lib/github-release-baseline";

function plan(version = "2.0.0"): Omit<CiReleasePlan, "baselines"> {
	return {
		schemaVersion: 1,
		repository: "NarraFork/NarraFork",
		tag: `v${version}`,
		version,
		commit: "a".repeat(40),
		workflowCommit: "b".repeat(40),
		bunVersion: CI_RELEASE_BUN,
		channel: version.endsWith(".0") ? "stable" : "beta",
		changelog: { version, date: "2026-10-08", en: "Release", "zh-CN": "发布" },
		runId: 1,
		runAttempt: 1,
	};
}
function fixture() {
	let nextId = 1;
	const releases: { id: number; tag_name: string; draft: boolean; prerelease: boolean }[] = [];
	const assets = new Map<number, { id: number; name: string; size: number; state: string }[]>();
	const contents = new Map<number, string>();
	const calls: string[][] = [];
	function release(
		version: string,
		targets: readonly (typeof CI_RELEASE_TARGETS)[number][] = CI_RELEASE_TARGETS,
		draft = false,
	) {
		const id = nextId++;
		releases.push({ id, tag_name: `v${version}`, draft, prerelease: !version.endsWith(".0") });
		const files = [];
		for (const target of targets) {
			const name = `narrafork-${version}-${target.suffix}`;
			const meta = computeBinaryMetadataFromBuffer(name, Buffer.from("fixture binary"), {
				version,
				platformId: target.platform,
				target: `bun-${target.target}`,
				commit: "b".repeat(40),
				buildDate: "2026-10-08T00:00:00.000Z",
			});
			const raw = formatMetadataJson(meta);
			files.push({ id: nextId++, name, size: meta.size, state: "uploaded" });
			const metadataId = nextId++;
			files.push({
				id: metadataId,
				name: `${name}.metadata.json`,
				size: Buffer.byteLength(raw),
				state: "uploaded",
			});
			contents.set(metadataId, raw);
		}
		assets.set(id, files);
		return id;
	}
	const run: GhRunner = (args) => {
		calls.push(args);
		const endpoint = args[1] ?? "";
		if (/\/releases\?/.test(endpoint)) return JSON.stringify(releases);
		const list = /\/releases\/(\d+)\/assets\?/.exec(endpoint);
		if (list) return JSON.stringify(assets.get(Number(list[1])));
		const content = /\/releases\/assets\/(\d+)$/.exec(endpoint);
		if (content) return contents.get(Number(content[1])) ?? "missing";
		throw new Error(`Unexpected API call: ${args.join(" ")}`);
	};
	return { release, releases, assets, contents, calls, run };
}

describe("CI GitHub baseline selection", () => {
	test("first release is legitimately full-only", async () => {
		const f = fixture();
		expect(await selectGitHubBaselines(plan(), { run: f.run })).toEqual([]);
		expect(f.calls).toHaveLength(1);
	});
	test("selects semantic nearest and stable per platform, regardless of API order", async () => {
		const f = fixture();
		f.release("1.9.0");
		f.release("1.10.2");
		f.release("1.8.0");
		f.release("3.0.0");
		f.release("2.0.0");
		f.release("1.99.0", CI_RELEASE_TARGETS, true);
		const result = await selectGitHubBaselines(plan(), { run: f.run });
		expect(result).toHaveLength(16);
		for (const target of CI_RELEASE_TARGETS)
			expect(
				result.filter((base) => base.platform === target.platform).map((base) => base.version),
			).toEqual(["1.10.2", "1.9.0"]);
		const first = result[0];
		expect(first?.metadataSha256).toBe(
			createHash("sha256")
				.update(f.contents.get(first?.metadataAsset.id ?? 0) ?? "")
				.digest("hex"),
		);
	});
	test("beta takes one baseline and a stable nearest is deduplicated", async () => {
		const f = fixture();
		f.release("1.9.0");
		f.release("1.8.0");
		expect(await selectGitHubBaselines(plan("1.9.1"), { run: f.run })).toHaveLength(8);
		expect(await selectGitHubBaselines(plan(), { run: f.run })).toHaveLength(8);
	});
	test("finds an older matching platform when the latest genuinely lacks it", async () => {
		const f = fixture();
		f.release("1.9.2", [CI_RELEASE_TARGETS[0]]);
		f.release("1.8.0");
		const result = await selectGitHubBaselines(plan("1.9.3"), { run: f.run });
		expect(result.find((base) => base.platform === "linux-x64")?.version).toBe("1.9.2");
		expect(result.find((base) => base.platform === "win-arm64")?.version).toBe("1.8.0");
	});
	test("API errors and invalid JSON do not become no baseline", async () => {
		await expect(
			selectGitHubBaselines(plan(), {
				run: () => {
					throw new Error("rate limited");
				},
			}),
		).rejects.toThrow("rate limited");
		await expect(selectGitHubBaselines(plan(), { run: () => "{" })).rejects.toThrow();
	});
	test("full tenth page fails closed, including when matching versions appeared earlier", async () => {
		let calls = 0;
		await expect(
			selectGitHubBaselines(plan(), {
				run: () => {
					calls++;
					return JSON.stringify(
						Array.from({ length: 100 }, (_, i) => ({
							id: calls * 100 + i,
							tag_name: `v1.${i}.0`,
							draft: false,
							prerelease: false,
						})),
					);
				},
			}),
		).rejects.toThrow("pagination limit");
		expect(calls).toBe(10);
	});
	test("paginates release asset lists and fails closed at their page limit", async () => {
		const f = fixture();
		f.release("1.0.0");
		let assets = 0;
		await expect(
			selectGitHubBaselines(plan(), {
				run: (args) => {
					if ((args[1] ?? "").includes("/1/assets?")) {
						assets++;
						return JSON.stringify(
							Array.from({ length: 100 }, (_, id) => ({
								id: assets * 100 + id,
								name: `x-${assets}-${id}`,
								size: 1,
								state: "uploaded",
							})),
						);
					}
					return f.run(args);
				},
			}),
		).rejects.toThrow("pagination limit");
		expect(assets).toBe(10);
	});
	test("missing sidecar is corrupt rather than a missing platform", async () => {
		const f = fixture();
		const id = f.release("1.0.0");
		f.assets.get(id)?.splice(1, 1);
		await expect(selectGitHubBaselines(plan(), { run: f.run })).rejects.toThrow(
			"Incomplete baseline",
		);
	});
	test("rejects duplicate names and duplicate release identities", async () => {
		const f = fixture();
		const id = f.release("1.0.0");
		const asset = f.assets.get(id)?.[0];
		if (!asset) throw new Error("fixture");
		f.assets.get(id)?.push({ ...asset, id: 999 });
		await expect(selectGitHubBaselines(plan(), { run: f.run })).rejects.toThrow(
			"duplicate baseline asset",
		);
		const first = f.releases[0];
		if (!first) throw new Error("fixture");
		f.releases.push(first);
		await expect(selectGitHubBaselines(plan(), { run: f.run })).rejects.toThrow(
			"duplicate GitHub release",
		);
	});
	test("rejects bad metadata identity and bounded metadata size", async () => {
		const f = fixture();
		const id = f.release("1.0.0");
		const sidecar = f.assets.get(id)?.[1];
		if (!sidecar) throw new Error("fixture");
		const raw = (f.contents.get(sidecar.id) ?? "").replace(
			'"platform": "linux-x64"',
			'"platform": "wrong-x64"',
		);
		f.contents.set(sidecar.id, raw);
		await expect(selectGitHubBaselines(plan(), { run: f.run })).rejects.toThrow(
			"metadata/provenance",
		);
		sidecar.size = 65537;
		await expect(selectGitHubBaselines(plan(), { run: f.run })).rejects.toThrow("size limit");
	});
	test("cancelled and foreign-repository selection issues no API calls", async () => {
		const f = fixture();
		await expect(
			selectGitHubBaselines(plan(), { run: f.run, signal: AbortSignal.abort() }),
		).rejects.toThrow();
		await expect(
			selectGitHubBaselines({ ...plan(), repository: "other/repo" }, { run: f.run }),
		).rejects.toThrow("Invalid baseline release plan");
		expect(f.calls).toHaveLength(0);
	});
});
