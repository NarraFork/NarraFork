import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import type { GhRunner } from "../../scripts/lib/github-release";
import { UpdateServerMirrorHttp } from "../../scripts/lib/update-server-bridge-http";
import type { MirrorSnapshotV2 } from "../../shared/independent-update-mirror";
import { mergeUpdateIndex, parseUpdateIndexRelease } from "../../shared/update-index";
export const repository = "fixture-owner/fork-product";
export const commit = "a".repeat(40);
export const indexCommit = "b".repeat(40);
export const config = { serverUrl: "https://fixture-mirror.invalid", token: "fixture-only-token" };
export const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function mirrorFixture(withPatch = true, withNotes = true, version = "1.2.0") {
	const name = `narrafork-${version}-linux-x64`;
	const bytes = Buffer.alloc(128, 7);
	const publishedAt = "2026-07-01T00:00:00.000Z";
	const metadata = computeBinaryMetadataFromBuffer(name, bytes, {
		version,
		platformId: "linux-x64",
		target: "bun-linux-x64",
		commit,
		buildDate: publishedAt,
	});
	const metadataRaw = formatMetadataJson(metadata);
	const raw = new Map<string, Buffer>([
		[name, bytes],
		[`${name}.metadata.json`, Buffer.from(metadataRaw)],
	]);
	const identity = (name: string, content: Buffer) => ({
		name,
		size: content.length,
		sha256: sha(content),
	});
	const patches = [];
	if (withPatch) {
		const patchName = `${name}.from-1.0.0.zstd-patch`;
		const patchBytes = Buffer.from("unchanged canonical GitHub patch raw bytes");
		const patchRaw = Buffer.from(
			JSON.stringify({
				fromVersion: "1.0.0",
				toVersion: version,
				oldFileSize: 10,
				oldFileSha512: Buffer.alloc(64, 2).toString("base64"),
				stableEnd: 0,
				newTailSize: bytes.length,
				patchSize: patchBytes.length,
				newFileSize: bytes.length,
				newFileSha512: metadata.sha512,
				mode: "patch-from",
			}),
		);
		raw.set(patchName, patchBytes);
		raw.set(`${patchName}.meta.json`, patchRaw);
		patches.push({
			...identity(patchName, patchBytes),
			fromVersion: "1.0.0",
			metadata: identity(`${patchName}.meta.json`, patchRaw),
		});
	}
	const notesRaw = JSON.stringify({
		schemaVersion: 1,
		repository,
		version,
		notes: { en: "exact notes\n", "zh-CN": "原始说明\n" },
	});
	const notes = {
		path: `notes/${version}-${sha(notesRaw)}.json`,
		size: Buffer.byteLength(notesRaw),
		sha256: sha(notesRaw),
	};
	const release = parseUpdateIndexRelease({
		version,
		tag: `v${version}`,
		commit,
		prerelease: false,
		publishedAt,
		files: [
			{
				...identity(name, bytes),
				platform: "linux-x64",
				sha512: metadata.sha512,
				metadata: identity(`${name}.metadata.json`, Buffer.from(metadataRaw)),
				patches,
			},
		],
		...(withNotes ? { notes } : {}),
	});
	let index = mergeUpdateIndex(null, release, repository, publishedAt);
	let indexHead = indexCommit;
	const assets = [...raw]
		.map(([name, value]) => identity(name, value))
		.map((a, i) => ({
			id: i + 1,
			name: a.name,
			size: a.size,
			digest: `sha256:${a.sha256}`,
			state: "uploaded",
		}));
	const publicRelease = {
		id: 17,
		tag_name: release.tag,
		draft: false,
		prerelease: false,
		published_at: publishedAt,
		assets,
	};
	const ghCalls: string[][] = [];
	let reads = 0;
	let onIndexRead: (() => void) | undefined;
	const run: GhRunner = async (args) => {
		ghCalls.push(args);
		if (args[0] !== "api" || args.some((a) => ["-X", "-F", "--input"].includes(a)))
			throw new Error("Read-only spy: GitHub mutation forbidden");
		const path = args[1];
		if (!path.startsWith(`repos/${repository}/`))
			throw new Error("Read-only spy: official repository fallback forbidden");
		if (path.includes("git/ref/tags/"))
			return JSON.stringify({
				ref: `refs/tags/${release.tag}`,
				object: { type: "commit", sha: commit },
			});
		if (path.endsWith(`/releases/tags/${encodeURIComponent(release.tag)}`))
			return JSON.stringify(publicRelease);
		if (path.includes("/releases/17/assets?")) return JSON.stringify(assets);
		if (path.includes("git/ref/heads/")) return JSON.stringify({ object: { sha: indexHead } });
		if (path.includes("/contents/notes/")) return notesRaw;
		if (path.includes("/contents/")) {
			reads++;
			onIndexRead?.();
			return JSON.stringify(index);
		}
		const id = Number(path.split("/").at(-1));
		if (path.includes("/releases/assets/")) {
			const a = assets.find((a) => a.id === id);
			if (!a || a.name === name || a.name.endsWith("zstd-patch"))
				throw new Error("Read-only spy: full/patch must not use text buffering");
			return raw.get(a.name)?.toString("utf8") ?? "";
		}
		throw new Error(`Unexpected GitHub fixture endpoint ${path}`);
	};
	const stored = new Map<string, Buffer>();
	let committed: MirrorSnapshotV2 | undefined;
	const httpCalls: { path: string; method: string; headers: Headers }[] = [];
	let failPath = "";
	let snapshotConflicts = 0;
	let onSnapshotConflict: (() => void) | undefined;
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		httpCalls.push({ path, method, headers });
		if (!path.startsWith("/api/v3/products/narrafork/mirror/"))
			throw new Error("Read-only spy: historical list/latest/frommeta/basebinary forbidden");
		if (method === "GET") throw new Error("Producer asset/index/availability GET is forbidden");
		if (failPath && path.includes(failPath)) return new Response("failure", { status: 503 });
		if (method === "PUT") {
			if (headers.get("x-mirror-name") === name && headers.get("x-mirror-kind") !== "main-binary")
				throw new Error("Full binary requires the explicit main-binary kind");
			if (!(init?.body instanceof ReadableStream)) throw new Error("Raw PUT must stream");
			const body = await new Response(init.body).arrayBuffer();
			stored.set(path.split("/").at(-1) as string, Buffer.from(body));
			return Response.json({
				schemaVersion: 1,
				verification: "server-sha256",
				name: headers.get("x-mirror-name"),
				size: Number(headers.get("x-mirror-size")),
				sha256: path.split("/").at(-1),
			});
		}
		if (method === "POST" && path.endsWith("/snapshot")) {
			if (snapshotConflicts > 0) {
				snapshotConflicts--;
				onSnapshotConflict?.();
				return Response.json({ code: "STALE_CANONICAL_SNAPSHOT" }, { status: 409 });
			}
			committed = JSON.parse(String(init?.body));
			if (!committed) throw new Error("Fixture missing commit");
			return Response.json({
				schemaVersion: 1,
				verification: "server-sha256",
				repository,
				indexCommit: committed.indexCommit,
				generation: committed.index.generation,
				targetVersion: committed.targetVersion,
				verified: committed.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
			});
		}
		throw new Error("Unexpected mirror endpoint");
	}) as unknown as typeof fetch;
	const http = new UpdateServerMirrorHttp(config, { fetchImpl });
	const downloaded: number[] = [];
	const downloadAsset = async (o: {
		assetId: number;
		outputPath: string;
		signal?: AbortSignal;
	}) => {
		o.signal?.throwIfAborted();
		downloaded.push(o.assetId);
		const asset = assets.find((a) => a.id === o.assetId);
		if (
			!asset ||
			(!asset.name.endsWith("zstd-patch") &&
				!release.files.some((file) => file.name === asset.name))
		)
			throw new Error("Only original patch or main binary uses the payload downloader");
		await writeFile(o.outputPath, raw.get(asset.name) as Buffer, { flag: "wx" });
	};
	return {
		name,
		release,
		assets,
		raw,
		notesRaw,
		publicRelease,
		run,
		http,
		ghCalls,
		httpCalls,
		stored,
		downloadAsset,
		downloaded,
		get committed() {
			return committed;
		},
		get indexReads() {
			return reads;
		},
		get indexCommit() {
			return indexHead;
		},
		get index() {
			return index;
		},
		set index(value) {
			index = value;
			indexHead = createHash("sha1").update(JSON.stringify(value)).digest("hex");
		},
		set failPath(value: string) {
			failPath = value;
		},
		set snapshotConflicts(value: number) {
			snapshotConflicts = value;
		},
		set onSnapshotConflict(value: (() => void) | undefined) {
			onSnapshotConflict = value;
		},
		set onIndexRead(value: (() => void) | undefined) {
			onIndexRead = value;
		},
	};
}
