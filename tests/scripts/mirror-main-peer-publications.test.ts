import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	mirrorPublicationReceiptFilename,
	readMirrorPublicationReceiptSet,
	resolveMirrorWorkflowTriggers,
	verifyMirrorPublicationReceipt,
	verifyMirrorPublicationReceiptSet,
} from "../../scripts/lib/mirror-workflow";
import type { PublicationReceipt } from "../../scripts/lib/publication-receipt";
import { UpdateServerMirrorHttp } from "../../scripts/lib/update-server-bridge-http";
import {
	type MirrorPublishedOptions,
	mirrorReceipt,
} from "../../scripts/lib/update-server-main-mirror";
import {
	mirrorPublicationReceiptPath,
	mirrorPublishedGitHubReleaseSet,
} from "../../scripts/mirror-update-server";
import { safeSpawn } from "../../server/lib/spawn";
import {
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
} from "../../shared/remote-peer";
import { commit, config, indexCommit, mirrorFixture, repository, sha } from "./mirror-fixture";

function fixture(withPeer = true) {
	const main = mirrorFixture(false);
	const workflowPath = ".github/workflows/release.yml";
	const peerCommit = "c".repeat(40);
	const version = "0.1.0-alpha.7";
	const tag = `remote-peer-v${version}`;
	const source = {
		id: 123,
		run_attempt: 2,
		event: "workflow_dispatch",
		status: "completed",
		conclusion: "success",
		path: workflowPath,
		head_branch: "main",
		repository: { full_name: repository },
		head_repository: { full_name: repository },
	};
	const event = {
		repository: { full_name: repository, default_branch: "main" },
		workflow_run: source,
	};
	const artifacts = [
		{ id: 81, name: "main-publication-receipt-123-2", expired: false, size_in_bytes: 1024 },
		...(withPeer
			? [
					{
						id: 82,
						name: "remote-peer-publication-receipt-123-2",
						expired: false,
						size_in_bytes: 1024,
					},
				]
			: []),
	];
	const jobs = ["Publish verified release", "Release Gate"].map((name) => ({
		name,
		status: "completed",
		conclusion: "success",
	}));
	const files = new Map<string, Buffer>();
	const artifact = (name: string) => {
		const bytes = Buffer.from(`${name}\n`);
		files.set(name, bytes);
		return { name, size: bytes.length, sha256: sha(bytes) };
	};
	const licenses = [artifact("remote-peer-LICENSES.txt")];
	const manifest = {
		schemaVersion: 1,
		repository,
		tag,
		commit: peerCommit,
		manifest: {
			version,
			protocolVersion: 1,
			releasedAt: "2026-07-01T00:00:00Z",
			platforms: Object.fromEntries(
				REMOTE_PEER_PLATFORMS.map((platform) => {
					const a = artifact(remotePeerPublishedFilename(version, platform));
					return [platform, { filename: a.name, size: a.size, sha256: a.sha256 }];
				}),
			),
		},
		licenses,
	};
	files.set(REMOTE_PEER_MANIFEST_FILENAME, Buffer.from(JSON.stringify(manifest)));
	const assets = [...files].map(([name, bytes], i) => ({
		id: 100 + i,
		name,
		size: bytes.length,
		digest: `sha256:${sha(bytes)}`,
		state: "uploaded",
	}));
	const sourceIdentity = {
		runId: 123,
		runAttempt: 2,
		workflowPath,
		nativeProof: "verified-original-bundle" as const,
	};
	const buildSource = { ...sourceIdentity, runId: 90, runAttempt: 1, bundleArtifactId: 70 };
	const receipts: PublicationReceipt[] = [
		{
			schemaVersion: 1,
			kind: "main",
			repository,
			tag: main.release.tag,
			version: main.release.version,
			commit,
			releaseId: 17,
			assets: main.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })),
			indexCommit,
			generation: 1,
			source: { ...sourceIdentity },
			buildSource: { ...buildSource },
		},
		...(withPeer
			? [
					{
						schemaVersion: 1 as const,
						kind: "remote-peer" as const,
						repository,
						tag,
						version,
						commit: peerCommit,
						releaseId: 19,
						assets: assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })),
						source: { ...sourceIdentity },
						buildSource: { ...buildSource },
					},
				]
			: []),
	];
	const calls: string[][] = [];
	const run = async (args: string[]) => {
		calls.push(args);
		if (args[0] !== "api" || args.some((arg) => ["-X", "-F", "--input"].includes(arg)))
			throw new Error("Only bounded read-only GitHub API is allowed");
		const path = args[1];
		if (!path.startsWith(`repos/${repository}/`)) throw new Error("Repository fallback forbidden");
		if (path.includes("/actions/runs/123/artifacts?"))
			return JSON.stringify({ total_count: artifacts.length, artifacts });
		if (path.includes("/actions/runs/123/attempts/2/jobs?"))
			return JSON.stringify({ total_count: jobs.length, jobs });
		if (path.endsWith("/actions/runs/123/attempts/2")) return JSON.stringify(source);
		if (path.includes("/compare/")) return JSON.stringify({ status: "identical" });
		if (path.includes(`/git/ref/tags/${tag}`))
			return JSON.stringify({
				ref: `refs/tags/${tag}`,
				object: { type: "commit", sha: peerCommit },
			});
		if (path.endsWith(`/releases/tags/${tag}`))
			return JSON.stringify({
				id: 19,
				tag_name: tag,
				draft: false,
				prerelease: true,
				published_at: "2026-07-01T00:00:00Z",
			});
		if (path.includes("/releases/19/assets?")) return JSON.stringify(assets);
		if (path.includes("/releases/assets/")) {
			const asset = assets.find((a) => a.id === Number(path.split("/").at(-1)));
			if (asset) return files.get(asset.name)?.toString("utf8") ?? "";
		}
		return main.run(args);
	};
	let peerCommits = 0;
	const peerHttp = new UpdateServerMirrorHttp(config, {
		fetchImpl: (async (url: unknown, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (init?.method === "PUT") {
				const headers = new Headers(init.headers);
				const name = headers.get("x-mirror-name");
				const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
				expect(bytes.equals(files.get(name ?? "") ?? Buffer.alloc(0))).toBe(true);
				return Response.json({
					schemaVersion: 1,
					verification: "server-sha256",
					name,
					size: bytes.length,
					sha256: sha(bytes),
				});
			}
			expect(path).toBe(`/api/v3/products/narrafork/mirror/tools/remote-peer/${tag}`);
			expect(init?.method).toBe("POST");
			const projection = JSON.parse(String(init?.body));
			peerCommits++;
			return Response.json({
				schemaVersion: 1,
				verification: "server-sha256",
				repository,
				kind: "remote-peer",
				tag,
				verified: [...projection.assets, ...projection.binaries].map(
					({ name, size, sha256 }: { name: string; size: number; sha256: string }) => ({
						name,
						size,
						sha256,
					}),
				),
			});
		}) as typeof fetch,
	});
	const targets = (publications: PublicationReceipt[]): MirrorPublishedOptions[] =>
		publications.map((publication) => ({
			kind: publication.kind,
			repository,
			tag: publication.tag,
			publication,
			config,
			run,
			http: publication.kind === "main" ? main.http : peerHttp,
			downloadAsset: async ({ assetId, outputPath, signal }) => {
				if (publication.kind === "main") return main.downloadAsset({ assetId, outputPath, signal });
				const asset = assets.find((a) => a.id === assetId);
				if (!asset) throw new Error("Only exact frozen peer binary assets may be downloaded");
				await writeFile(outputPath, files.get(asset.name) as Buffer, { flag: "wx" });
			},
		}));
	return {
		main,
		source,
		event,
		artifacts,
		jobs,
		receipts,
		assets,
		run,
		calls,
		targets,
		get peerCommits() {
			return peerCommits;
		},
	};
}
async function verified(f: ReturnType<typeof fixture>) {
	const triggers = await resolveMirrorWorkflowTriggers(f.event, repository, f.run);
	return verifyMirrorPublicationReceiptSet(
		triggers.map((trigger, i) => ({ trigger, value: f.receipts[i] })),
		f.run,
	);
}

describe("one successful main Release mirrors independent main and peer publications", () => {
	test("both real producers bind their exact tag/commit/assets and retry without publishing GitHub", async () => {
		const f = fixture();
		const publications = await verified(f);
		expect(publications.map((r) => [r.kind, r.tag, r.commit])).toEqual([
			["main", "v1.2.0", commit],
			["remote-peer", "remote-peer-v0.1.0-alpha.7", "c".repeat(40)],
		]);
		for (let retry = 0; retry < 2; retry++) {
			const result = await mirrorPublishedGitHubReleaseSet(f.targets(publications));
			expect(result.map((r) => r.status)).toEqual(["MIRRORED", "MIRRORED"]);
			expect(result.map((r) => r.publication?.commit)).toEqual([commit, "c".repeat(40)]);
			expect(result.map((r) => r.publication?.source.runId)).toEqual([123, 123]);
			expect(f.main.committed?.targetVersion).toBe("1.2.0");
		}
		expect(f.peerCommits).toBe(2);
		expect(f.calls.every((args) => args[0] === "api" && !args.includes("-X"))).toBe(true);
		expect(mirrorPublicationReceiptPath("artifacts/mirror/receipt.json", "main", true)).toBe(
			"artifacts/mirror/main/receipt.json",
		);
		expect(mirrorPublicationReceiptPath("artifacts/mirror/receipt.json", "remote-peer", true)).toBe(
			"artifacts/mirror/remote-peer/receipt.json",
		);
	});
	for (const withPeer of [false, true])
		test(`actual workflow CLI dry-run preserves ${withPeer ? "two independent" : "one legacy"} receipts without any live GitHub process`, async () => {
			const f = fixture(withPeer);
			const responses: Record<string, string> = {};
			const run = async (args: string[]) => {
				const response = await f.run(args);
				responses[JSON.stringify(args)] = response;
				return response;
			};
			const triggers = await resolveMirrorWorkflowTriggers(f.event, repository, run);
			const publications = await verifyMirrorPublicationReceiptSet(
				triggers.map((trigger, i) => ({ trigger, value: f.receipts[i] })),
				run,
			);
			await mirrorPublishedGitHubReleaseSet(
				f.targets(publications).map((target) => ({ ...target, run, dryRun: true })),
			);
			const directory = await mkdtemp(join(tmpdir(), "nf-main-peer-cli-"));
			try {
				const responsesPath = join(directory, "responses.json");
				await writeFile(responsesPath, JSON.stringify(responses));
				const preloadPath = join(directory, "preload.ts");
				const transportPath = resolve("scripts/lib/mirror-public-github.ts");
				await writeFile(
					preloadPath,
					`import { mock } from "bun:test";\nimport { readFileSync } from "node:fs";\nconst actual = await import(${JSON.stringify(transportPath)});\nconst originalRunner = actual.mirrorGhRunner;\nconst responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, "utf8"));\nmock.module(${JSON.stringify(transportPath)}, () => ({ ...actual, mirrorGhRunner: (run, signal) => originalRunner(run ?? (async args => { const response = responses[JSON.stringify(args)]; if (response === undefined) throw new Error("Unexpected read-only fixture API"); return response; }), signal) }));\n`,
				);
				const eventPath = join(directory, "event.json");
				const receiptFile = join(directory, "publication-receipt.json");
				const peerReceiptFile = join(directory, "remote-peer-publication-receipt.json");
				const resultPath = join(directory, "result", "receipt.json");
				await writeFile(eventPath, JSON.stringify(f.event));
				await writeFile(receiptFile, JSON.stringify(f.receipts[0]));
				if (withPeer) await writeFile(peerReceiptFile, JSON.stringify(f.receipts[1]));
				const {
					exitCode: code,
					stdout,
					stderr,
				} = await safeSpawn({
					cmd: [
						process.execPath,
						"--preload",
						preloadPath,
						"scripts/mirror-update-server.ts",
						"--dry-run",
						`--event-file=${eventPath}`,
						`--receipt-file=${receiptFile}`,
						`--peer-receipt-file=${peerReceiptFile}`,
						`--receipt-output=${resultPath}`,
					],
					env: {
						...process.env,
						GITHUB_EVENT_NAME: "workflow_run",
						GITHUB_REPOSITORY: repository,
						NF_MIRROR_TRANSPORT: "direct",
						NF_MIRROR_TOTAL_TIMEOUT_MINUTES: "",
						NF_MIRROR_TRANSFER_TIMEOUT_MINUTES: "",
						NF_MIRROR_UPLOAD_CONCURRENCY: "",
					},
					maxOutputBytes: 64 * 1024,
					timeout: 10_000,
				});
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(stdout).toContain("Independent mirror main/v1.2.0: DRY_RUN");
				for (const publication of publications) {
					const outputPath = mirrorPublicationReceiptPath(resultPath, publication.kind, withPeer);
					expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
						kind: publication.kind,
						tag: publication.tag,
						status: "DRY_RUN",
						publication: { commit: publication.commit, source: publication.source },
					});
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}, 15_000);
	test("reuse has only the original main receipt and does not infer peer from today's pin", async () => {
		const f = fixture(false);
		const publications = await verified(f);
		expect(publications.map((r) => r.kind)).toEqual(["main"]);
		expect(
			(await mirrorPublishedGitHubReleaseSet(f.targets(publications))).map((r) => r.status),
		).toEqual(["MIRRORED"]);
		expect(f.peerCommits).toBe(0);
		expect(f.calls.some((args) => args[1].includes("remote-peer"))).toBe(false);
		expect(mirrorPublicationReceiptPath("artifacts/mirror/receipt.json", "main", false)).toBe(
			"artifacts/mirror/receipt.json",
		);
	});
	test("receipt files have separate exact basenames and cannot be substituted or omitted", async () => {
		const f = fixture();
		const triggers = await resolveMirrorWorkflowTriggers(f.event, repository, f.run);
		const directory = await mkdtemp(join(tmpdir(), "nf-main-peer-receipts-"));
		try {
			const receiptFile = join(directory, "publication-receipt.json");
			const peerReceiptFile = join(directory, "remote-peer-publication-receipt.json");
			await writeFile(receiptFile, JSON.stringify(f.receipts[0]));
			await writeFile(peerReceiptFile, JSON.stringify(f.receipts[1]));
			expect(
				(await readMirrorPublicationReceiptSet(triggers, { receiptFile, peerReceiptFile }, f.run))
					.length,
			).toBe(2);
			await expect(
				readMirrorPublicationReceiptSet(triggers, { receiptFile }, f.run),
			).rejects.toThrow("path");
			await expect(
				readMirrorPublicationReceiptSet(
					triggers,
					{ receiptFile, peerReceiptFile: receiptFile },
					f.run,
				),
			).rejects.toThrow("path");
			await writeFile(peerReceiptFile, await readFile(receiptFile));
			await expect(
				readMirrorPublicationReceiptSet(triggers, { receiptFile, peerReceiptFile }, f.run),
			).rejects.toThrow("provenance");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	for (const change of [
		"run",
		"attempt",
		"source-path",
		"build-path",
		"kind",
		"commit",
		"tag",
		"asset",
	])
		test(`rejects peer ${change} without weakening the main receipt`, async () => {
			const f = fixture();
			const receipt = f.receipts[1];
			if (change === "run") receipt.source.runId++;
			if (change === "attempt") receipt.source.runAttempt++;
			if (change === "source-path")
				receipt.source.workflowPath = ".github/workflows/remote-peer-release.yml";
			if (change === "build-path" && receipt.buildSource)
				receipt.buildSource.workflowPath = ".github/workflows/remote-peer-release.yml";
			if (change === "kind") {
				receipt.kind = "executor";
				receipt.tag = `executor-v${receipt.version}`;
			}
			if (change === "commit") receipt.commit = "d".repeat(40);
			if (change === "tag") receipt.tag = "remote-peer-v0.9.0";
			if (change === "asset") receipt.assets[0].digest = `sha256:${"d".repeat(64)}`;
			await expect(verified(f)).rejects.toThrow();
			expect(f.main.httpCalls).toHaveLength(0);
			expect(f.peerCommits).toBe(0);
		});
	test("the peer JSON cannot grant authority to a main/auxiliary/wrong-attempt artifact", async () => {
		const f = fixture();
		const triggers = await resolveMirrorWorkflowTriggers(f.event, repository, f.run);
		for (const artifactName of [
			triggers[0].artifactName,
			"auxiliary-publication-receipt-123-2",
			"remote-peer-publication-receipt-123-1",
			"remote-peer-publication-receipt-999-2",
		])
			await expect(
				verifyMirrorPublicationReceipt(f.receipts[1], { ...triggers[1], artifactName }, f.run),
			).rejects.toThrow("provenance");
		expect(mirrorPublicationReceiptFilename(triggers[1])).toBe(
			"remote-peer-publication-receipt.json",
		);
	});
	for (const name of ["Publish verified release", "Release Gate"])
		for (const conclusion of ["failure", "cancelled", "skipped"])
			test(`a peer receipt cannot authorize ${conclusion} ${name}`, async () => {
				const f = fixture();
				const job = f.jobs.find((j) => j.name === name);
				if (!job) throw new Error("missing job");
				job.conclusion = conclusion;
				await expect(verified(f)).rejects.toThrow("publisher");
			});
	test("a failed source or a forged successful job name cannot use an uploaded peer receipt", async () => {
		const f = fixture();
		f.source.conclusion = "failure";
		await expect(verified(f)).rejects.toThrow("successful trusted");
		f.source.conclusion = "success";
		f.jobs[0].name = "Publish approved remote peer draft";
		await expect(verified(f)).rejects.toThrow("publisher");
	});
	test("main workflow cannot omit the main receipt; duplicates and combined artifact budgets stay bounded", async () => {
		const f = fixture();
		const mainArtifact = f.artifacts.shift();
		await expect(verified(f)).rejects.toThrow("primary receipt");
		if (!mainArtifact) throw new Error("missing artifact");
		f.artifacts.unshift(mainArtifact);
		f.artifacts.push({ ...f.artifacts[1] });
		await expect(verified(f)).rejects.toThrow("Ambiguous");
		f.artifacts.pop();
		for (const artifact of f.artifacts) artifact.size_in_bytes = 65 * 1024;
		await expect(verified(f)).rejects.toThrow("bounds");
	});
	test("receipt collection cannot combine different source runs or double its JSON budget", async () => {
		const f = fixture();
		const triggers = await resolveMirrorWorkflowTriggers(f.event, repository, f.run);
		await expect(
			verifyMirrorPublicationReceiptSet(
				[
					{ trigger: triggers[0], value: f.receipts[0] },
					{ trigger: { ...triggers[1], runId: 999 }, value: f.receipts[1] },
				],
				f.run,
			),
		).rejects.toThrow("collection");
		await expect(
			verifyMirrorPublicationReceiptSet(
				[
					{ trigger: triggers[0], value: { ...f.receipts[0], padding: "x".repeat(64 * 1024) } },
					{ trigger: triggers[1], value: f.receipts[1] },
				],
				f.run,
			),
		).rejects.toThrow("collection");
	});
	test("adding a peer receipt cannot bypass main canonical-index proof or peer original-native proof", async () => {
		for (const invalid of ["index", "generation", "peer-proof"]) {
			const f = fixture();
			if (invalid === "index") f.receipts[0].indexCommit = "invalid";
			if (invalid === "generation") f.receipts[0].generation = 0;
			if (invalid === "peer-proof")
				f.receipts[1].source.nativeProof = "verified-public-index-repair";
			await expect(verified(f)).rejects.toThrow();
			expect(f.main.httpCalls).toHaveLength(0);
			expect(f.peerCommits).toBe(0);
		}
	});
	test("the complete receipt collection keeps the original 200-public-asset limit", async () => {
		const f = fixture();
		const targetMainCount = 201 - f.receipts[1].assets.length;
		for (let i = f.main.assets.length; i < targetMainCount; i++) {
			const asset = {
				id: 1000 + i,
				name: `extra-${i}.txt`,
				size: 1,
				digest: `sha256:${"a".repeat(64)}`,
				state: "uploaded",
			};
			f.main.assets.push(asset);
			f.receipts[0].assets.push({
				id: asset.id,
				name: asset.name,
				size: asset.size,
				digest: asset.digest,
			});
		}
		const run = async (args: string[]) => {
			if (args[1].includes("/releases/17/assets?")) {
				const page = Number(new URL(`https://fixture.invalid/${args[1]}`).searchParams.get("page"));
				return JSON.stringify(f.main.assets.slice((page - 1) * 100, page * 100));
			}
			return f.run(args);
		};
		const triggers = await resolveMirrorWorkflowTriggers(f.event, repository, run);
		await expect(
			verifyMirrorPublicationReceiptSet(
				triggers.map((trigger, i) => ({ trigger, value: f.receipts[i] })),
				run,
			),
		).rejects.toThrow("asset/identity bounds");
	});
	test("a public source drift after receipt verification fails before that producer writes", async () => {
		const f = fixture();
		const publications = await verified(f);
		f.assets[0].digest = `sha256:${"f".repeat(64)}`;
		const result = await mirrorPublishedGitHubReleaseSet(f.targets(publications));
		expect(result.map((r) => r.status)).toEqual(["MIRRORED", "FAILED"]);
		expect(f.peerCommits).toBe(0);
	});
	test("a main mirror failure keeps peer's independent result and both can be retried", async () => {
		const f = fixture();
		const publications = await verified(f);
		f.main.failPath = "/snapshot";
		const partial = await mirrorPublishedGitHubReleaseSet(f.targets(publications));
		expect(partial.map((r) => r.status)).toEqual(["FAILED", "MIRRORED"]);
		expect(partial.map((r) => r.tag)).toEqual(publications.map((r) => r.tag));
		f.main.failPath = "";
		expect(
			(await mirrorPublishedGitHubReleaseSet(f.targets(publications))).map((r) => r.status),
		).toEqual(["MIRRORED", "MIRRORED"]);
		expect(f.peerCommits).toBe(2);
	});
	for (const budget of ["bytes", "count"])
		test(`two producers share the original ${budget} budget instead of resetting it`, async () => {
			const f = fixture();
			const targets = f
				.targets(f.receipts)
				.map((target) => ({ ...target, maxTotalBytes: budget === "bytes" ? 10 : undefined }));
			const result = await mirrorPublishedGitHubReleaseSet(targets, async (options) => {
				options.reserveAssets?.(
					Array.from({ length: budget === "count" ? 101 : 1 }, () => ({ size: 3 })),
				);
				return { ...mirrorReceipt(options), status: "MIRRORED" };
			});
			expect(result.map((r) => r.status)).toEqual(["MIRRORED", "FAILED"]);
		});
	test("two producers use one absolute deadline and cancellation does not reset for peer", async () => {
		const f = fixture();
		const signals: AbortSignal[] = [];
		const result = await mirrorPublishedGitHubReleaseSet(
			f.targets(f.receipts).map((target) => ({ ...target, totalTimeoutMs: 30 })),
			async (options) => {
				if (!options.signal) throw new Error("missing deadline");
				signals.push(options.signal);
				if (options.kind === "main") await new Promise((resolve) => setTimeout(resolve, 45));
				options.signal.throwIfAborted();
				return { ...mirrorReceipt(options), status: "MIRRORED" };
			},
		);
		expect(result.map((r) => r.failureCode)).toEqual(["CANCELLED", "CANCELLED"]);
		expect(signals).toHaveLength(1);
	});
});
