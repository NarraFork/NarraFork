import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatMetadataJson,
} from "../../scripts/lib/binary-metadata";
import {
	type PreparedUpdateNotes,
	prepareUpdateIndexRelease,
	textIdentity,
} from "../../scripts/lib/update-index";
import {
	preparePublishedUpdateIndexRelease,
	publishUpdateIndex,
} from "../../scripts/lib/update-index-github";
import { mergeUpdateIndex, UPDATE_INDEX_FILE, type UpdateIndexV1 } from "../../shared/update-index";

const repository = "fork-owner/fork-repo";
const commit = "a".repeat(40);
const publishedAt = "2026-07-01T00:00:00.000Z";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(version = "1.2.0", patch = false, changelog = "更新日志") {
	const root = mkdtempSync(join(tmpdir(), "narrafork-update-index-test-"));
	roots.push(root);
	const name = `narrafork-${version}-linux-x64`;
	const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
	const metadata = computeBinaryMetadataFromBuffer(name, bytes, {
		version,
		platformId: "linux-x64",
		target: "bun-linux-x64",
		commit: commit.slice(0, 12),
		buildDate: publishedAt,
	});
	const raw = formatMetadataJson(metadata);
	writeFileSync(join(root, name), bytes);
	writeFileSync(join(root, `${name}.metadata.json`), raw);
	const sidecars = new Map([[`${name}.metadata.json`, raw]]);
	if (patch) {
		const patchName = `${name}.from-1.0.0.zstd-patch`;
		const patchBytes = Buffer.from("real fixture patch bytes");
		const raw = JSON.stringify({
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
		});
		writeFileSync(join(root, patchName), patchBytes);
		writeFileSync(join(root, `${patchName}.meta.json`), raw);
		sidecars.set(`${patchName}.meta.json`, raw);
	}
	const options = {
		distDir: root,
		repository,
		version,
		commit,
		publishedAt,
		changelog,
		platformSuffixes: new Map([["linux-x64", "linux-x64"]]),
	};
	const prepared = await prepareUpdateIndexRelease(options);
	return { root, name, bytes, metadata, sidecars, options, ...prepared };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type RemoteAsset = { id: number; name: string; size: number; digest: string | null; state: string };
type StoredRelease = {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	published_at: string;
	body: string;
	commit: string;
	assets: RemoteAsset[];
	sidecars: Map<number, string>;
};
function fakeGitHub(fixtures: Fixture[]) {
	let sequence = 0;
	const nextSha = () => (++sequence).toString(16).padStart(40, "0");
	const releases = new Map<string, StoredRelease>();
	for (const [index, fixture] of fixtures.entries()) {
		const assets: RemoteAsset[] = [];
		const sidecars = new Map<number, string>();
		for (const file of fixture.release.files) {
			const identities = [file, file.metadata, ...file.patches.flatMap((p) => [p, p.metadata])];
			for (const identity of identities) {
				const id = index * 1000 + assets.length + 1;
				assets.push({
					id,
					name: identity.name,
					size: identity.size,
					state: "uploaded",
					digest: `sha256:${identity.sha256}`,
				});
				const content = fixture.sidecars.get(identity.name);
				if (content !== undefined) sidecars.set(id, content);
			}
		}
		releases.set(fixture.release.tag, {
			id: index + 1,
			tag_name: fixture.release.tag,
			draft: false,
			prerelease: fixture.release.prerelease,
			published_at: fixture.release.publishedAt,
			body: fixture.options.changelog,
			commit: fixture.release.commit,
			assets,
			sidecars,
		});
	}
	const blobs = new Map<string, string>();
	const trees = new Map<string, Map<string, string>>();
	const commits = new Map<string, { tree: string; parents: string[] }>();
	const calls: { args: string[]; body?: Record<string, unknown> }[] = [];
	const inputs: string[] = [];
	let head: string | null = null;
	let conflicts = 0;
	let onConflict: (() => void) | undefined;
	let corruptReadback = false;
	const repositoryMetadata = { full_name: repository, default_branch: "main" };
	function seed(index: UpdateIndexV1 | string, notes?: PreparedUpdateNotes) {
		const tree = new Map<string, string>();
		const indexBlob = nextSha();
		blobs.set(indexBlob, typeof index === "string" ? index : JSON.stringify(index));
		tree.set(UPDATE_INDEX_FILE, indexBlob);
		const untouched = nextSha();
		blobs.set(untouched, "unrelated preserved content");
		tree.set("unrelated.json", untouched);
		if (notes) {
			const sha = nextSha();
			blobs.set(sha, notes.content);
			tree.set(notes.path, sha);
		}
		const treeSha = nextSha();
		trees.set(treeSha, tree);
		const sha = nextSha();
		commits.set(sha, { tree: treeSha, parents: head ? [head] : [] });
		head = sha;
		return sha;
	}
	const run = async (args: string[]) => {
		const endpoint = args[1];
		const input = args.indexOf("--input");
		const body = input < 0 ? undefined : JSON.parse(readFileSync(args[input + 1], "utf8"));
		if (input >= 0) inputs.push(args[input + 1]);
		calls.push({ args, body });
		if (endpoint === "graphql") {
			expect(args.join(" ")).not.toContain("body");
			expect(args).toContain("owner=fork-owner");
			expect(args).toContain("name=fork-repo");
			return JSON.stringify({
				data: {
					repository: {
						nameWithOwner: repository,
						releases: {
							nodes: [...releases.values()].map((r) => ({
								databaseId: r.id,
								tagName: r.tag_name,
								isDraft: r.draft,
								isPrerelease: r.prerelease,
								publishedAt: r.published_at,
								releaseAssets: { totalCount: r.assets.length },
							})),
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			});
		}
		if (endpoint === `repos/${repository}`) {
			expect(args).toContain("{full_name,default_branch}");
			return JSON.stringify(repositoryMetadata);
		}
		expect(endpoint.startsWith(`repos/${repository}/`)).toBe(true);
		const path = endpoint.slice(`repos/${repository}/`.length);
		const json = (value: unknown) => JSON.stringify(value);
		const notFound = () => {
			throw new Error("gh: Not Found (HTTP 404)");
		};
		if (path === "git/ref/heads/narrafork-updates")
			return head
				? json({ ref: "refs/heads/narrafork-updates", object: { type: "commit", sha: head } })
				: notFound();
		if (path.startsWith("releases/tags/")) {
			const release = releases.get(decodeURIComponent(path.slice(14)));
			if (!release) return notFound();
			if (args.includes("{body}")) return json({ body: release.body });
			expect(args).toContain("{id,tag_name,draft,prerelease,published_at}");
			return json(release);
		}
		if (path.startsWith("git/ref/tags/")) {
			const tag = decodeURIComponent(path.slice(13));
			const release = releases.get(tag);
			return release
				? json({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: release.commit } })
				: notFound();
		}
		const assetList = /^releases\/(\d+)\/assets\?per_page=100&page=(\d+)$/.exec(path);
		if (assetList) {
			const release = [...releases.values()].find((r) => r.id === Number(assetList[1]));
			expect(args).toContain("map({id,name,size,state,digest})");
			return json(
				release?.assets.slice((Number(assetList[2]) - 1) * 100, Number(assetList[2]) * 100),
			);
		}
		if (path.startsWith("releases/assets/")) {
			const id = Number(path.slice(16));
			for (const release of releases.values()) {
				const raw = release.sidecars.get(id);
				if (raw !== undefined) return raw;
			}
			return notFound();
		}
		if (path.startsWith("git/commits/") && !body) {
			const sha = path.slice(12);
			const value = commits.get(sha);
			return value
				? json({ sha, tree: { sha: value.tree }, parents: value.parents.map((sha) => ({ sha })) })
				: notFound();
		}
		if (path.startsWith("contents/")) {
			const [file, sha] = path.slice(9).split("?ref=");
			const commit = commits.get(sha);
			const blob = commit && trees.get(commit.tree)?.get(file);
			const raw = blob && blobs.get(blob);
			if (raw === undefined) return notFound();
			const content =
				corruptReadback &&
				calls.some((c) => c.args[1].endsWith("git/refs")) &&
				file === UPDATE_INDEX_FILE
					? "{}"
					: raw;
			if (args.includes("Accept: application/vnd.github.raw+json")) return content;
			return json({
				type: "file",
				path: file,
				size: Buffer.byteLength(content),
				encoding: "base64",
				content: Buffer.from(content).toString("base64"),
			});
		}
		if (path === "git/blobs") {
			expect(body.encoding).toBe("utf-8");
			const sha = nextSha();
			blobs.set(sha, body.content);
			return json({ sha });
		}
		if (path === "git/trees") {
			const sha = nextSha();
			const tree = new Map<string, string>(body.base_tree ? trees.get(body.base_tree) : []);
			for (const entry of body.tree) {
				expect(entry.mode).toBe("100644");
				expect(entry.type).toBe("blob");
				expect(entry.path === UPDATE_INDEX_FILE || entry.path.startsWith("notes/")).toBe(true);
				tree.set(entry.path, entry.sha);
			}
			trees.set(sha, tree);
			return json({ sha });
		}
		if (path === "git/commits") {
			const sha = nextSha();
			commits.set(sha, { tree: body.tree, parents: body.parents });
			return json({ sha });
		}
		if (path === "git/refs" || path === "git/refs/heads/narrafork-updates") {
			if (conflicts > 0) {
				conflicts--;
				onConflict?.();
				throw new Error("gh: Reference update failed (HTTP 422)");
			}
			if (path === "git/refs") {
				expect(head).toBeNull();
				expect(body.ref).toBe("refs/heads/narrafork-updates");
				expect(commits.get(body.sha)?.parents).toEqual([]);
			} else {
				expect(body.force).toBe(false);
				expect(commits.get(body.sha)?.parents).toEqual([head as string]);
			}
			head = body.sha;
			return json({ ref: "refs/heads/narrafork-updates", object: { type: "commit", sha: head } });
		}
		throw new Error(`Unexpected mock gh path: ${path}`);
	};
	return {
		run,
		calls,
		inputs,
		repositoryMetadata,
		releases,
		trees,
		commits,
		blobs,
		seed,
		get head() {
			return head;
		},
		set conflicts(n: number) {
			conflicts = n;
		},
		set onConflict(fn: () => void) {
			onConflict = fn;
		},
		set corruptReadback(value: boolean) {
			corruptReadback = value;
		},
		index() {
			if (!head) return null;
			const blob = trees.get(commits.get(head)?.tree ?? "")?.get(UPDATE_INDEX_FILE);
			return JSON.parse(blobs.get(blob ?? "") ?? "null") as UpdateIndexV1;
		},
		writes() {
			return calls.filter((c) => c.body);
		},
	};
}

describe("local update index producer", () => {
	test("streams real binary/patch hashes, uses canonical names and external content-addressed notes", async () => {
		const f = await fixture("1.2.0", true);
		expect(f.release.files[0].sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
		expect(f.release.files[0].patches[0].fromVersion).toBe("1.0.0");
		expect(JSON.stringify(f.release)).not.toContain("更新日志");
		expect(f.notes.path).toBe(`notes/1.2.0-${textIdentity(f.notes.content).sha256}.json`);
		expect(f.notes.content).toContain("更新日志");
		expect(f.release.prerelease).toBe(false);
	});
	test("sidecar hashes describe exact UTF-8 bytes rather than replacement-decoded text", async () => {
		const f = await fixture();
		const original = f.sidecars.get(`${f.name}.metadata.json`);
		if (!original) throw new Error("fixture");
		writeFileSync(
			join(f.root, `${f.name}.metadata.json`),
			Buffer.concat([
				Buffer.from(`${original.trim().slice(0, -1)},"comment":"`),
				Buffer.from([255]),
				Buffer.from('"}'),
			]),
		);
		await expect(prepareUpdateIndexRelease(f.options)).rejects.toThrow("UTF-8");
	});
	test("does not trust sidecar hash, altered patch/base, orphan metadata, wrong suffix or symlink", async () => {
		const f = await fixture("1.2.1", true);
		expect(f.release.prerelease).toBe(true);
		writeFileSync(join(f.root, f.name), "different bytes");
		await expect(prepareUpdateIndexRelease(f.options)).rejects.toThrow("identity");
		writeFileSync(join(f.root, f.name), f.bytes);
		const patch = f.release.files[0].patches[0];
		writeFileSync(join(f.root, patch.name), "wrong size");
		await expect(prepareUpdateIndexRelease(f.options)).rejects.toThrow();
		rmSync(join(f.root, patch.name));
		await expect(prepareUpdateIndexRelease(f.options)).rejects.toThrow("unpaired");
		rmSync(join(f.root, `${patch.name}.meta.json`));
		await expect(
			prepareUpdateIndexRelease({
				...f.options,
				platformSuffixes: new Map([["linux-x64", "macos-x64"]]),
			}),
		).rejects.toThrow("canonical");
		rmSync(join(f.root, f.name));
		symlinkSync(join(f.root, `${f.name}.metadata.json`), join(f.root, f.name));
		await expect(prepareUpdateIndexRelease(f.options)).rejects.toThrow("size/type");
	});
});

describe("published Release index-only repair", () => {
	test("reads public identities and existing patches only, without fetching body or writing anything", async () => {
		const f = await fixture("1.2.0", true);
		const gh = fakeGitHub([f]);
		const prepared = await preparePublishedUpdateIndexRelease({
			repository,
			version: f.release.version,
			commit,
			run: gh.run,
		});
		expect(prepared.release.files).toEqual(f.release.files);
		expect(prepared.release.notes).toBeUndefined();
		expect(prepared.notes).toBeUndefined();
		expect(gh.writes()).toHaveLength(0);
		expect(gh.calls.every((call) => !call.args.includes("{body}"))).toBe(true);
		const result = await publishUpdateIndex({ repository, ...prepared, run: gh.run });
		expect(result.unchanged).toBe(false);
		expect(gh.writes().filter((call) => call.args[1].endsWith("git/blobs"))).toHaveLength(1);
	});
	test("repair preserves existing notes and remains idempotent; provided notes require published body equality", async () => {
		const f = await fixture("1.2.0", true);
		const gh = fakeGitHub([f]);
		gh.seed(mergeUpdateIndex(null, f.release, repository, publishedAt), f.notes);
		const prepared = await preparePublishedUpdateIndexRelease({
			repository,
			version: f.release.version,
			commit,
			run: gh.run,
		});
		expect((await publishUpdateIndex({ repository, ...prepared, run: gh.run })).unchanged).toBe(
			true,
		);
		expect(gh.index()?.releases[0].notes).toEqual(f.release.notes);
		expect(gh.writes()).toHaveLength(0);
		const withNotes = await preparePublishedUpdateIndexRelease({
			repository,
			version: f.release.version,
			commit,
			changelog: f.options.changelog,
			run: gh.run,
		});
		expect(withNotes.notes).toEqual(f.notes);
		await expect(
			preparePublishedUpdateIndexRelease({
				repository,
				version: f.release.version,
				commit,
				changelog: "invented notes",
				run: gh.run,
			}),
		).rejects.toThrow("published body");
		await expect(
			preparePublishedUpdateIndexRelease({
				repository,
				version: f.release.version,
				commit: "b".repeat(40),
				run: gh.run,
			}),
		).rejects.toThrow("commit mismatch");
		expect(gh.writes()).toHaveLength(0);
	});
});

describe("atomic metadata branch publication (fake gh only)", () => {
	test("refuses default-branch collision or redirected repository before any remote write", async () => {
		const f = await fixture();
		for (const metadata of [
			{ full_name: repository, default_branch: "narrafork-updates" },
			{ full_name: "upstream/other", default_branch: "main" },
			{ full_name: repository, default_branch: "" },
		]) {
			const gh = fakeGitHub([f]);
			Object.assign(gh.repositoryMetadata, metadata);
			await expect(publishUpdateIndex({ repository, ...f, run: gh.run })).rejects.toThrow();
			expect(gh.writes()).toHaveLength(0);
		}
	});
	test("rechecks default branch after a CAS conflict and immediately before moving a ref", async () => {
		const f = await fixture();
		const conflict = fakeGitHub([f]);
		conflict.conflicts = 1;
		conflict.onConflict = () => {
			conflict.repositoryMetadata.default_branch = "narrafork-updates";
		};
		await expect(publishUpdateIndex({ repository, ...f, run: conflict.run })).rejects.toThrow(
			"default branch",
		);
		expect(conflict.writes().filter((call) => call.args[1].endsWith("git/blobs"))).toHaveLength(2);
		expect(conflict.calls.filter((call) => call.args[1] === `repos/${repository}`)).toHaveLength(3);
		expect(conflict.head).toBeNull();
		const renamed = fakeGitHub([f]);
		const run = async (args: string[]) => {
			const result = await renamed.run(args);
			if (args[1].endsWith("git/commits") && args.includes("--input"))
				renamed.repositoryMetadata.default_branch = "narrafork-updates";
			return result;
		};
		await expect(publishUpdateIndex({ repository, ...f, run })).rejects.toThrow("default branch");
		expect(renamed.writes().some((call) => call.args[1].endsWith("git/refs"))).toBe(false);
		expect(renamed.head).toBeNull();
	});
	test("creates orphan branch using blobs/tree/one commit; keeps large notes out of argv; repeats idempotently", async () => {
		const f = await fixture("1.2.0", true, "Long notes ".repeat(50000));
		const gh = fakeGitHub([f]);
		const result = await publishUpdateIndex({ repository, ...f, run: gh.run });
		expect(result.unchanged).toBe(false);
		expect(gh.writes().map((c) => c.args[1].split("/").slice(-2).join("/"))).toEqual([
			"git/blobs",
			"git/blobs",
			"git/trees",
			"git/commits",
			"git/refs",
		]);
		expect(gh.writes().every((c) => c.args.join(" ").length < 1000)).toBe(true);
		expect(gh.inputs.every((path) => !existsSync(path))).toBe(true);
		const count = gh.writes().length;
		const repeated = await publishUpdateIndex({ repository, ...f, run: gh.run });
		expect(repeated).toEqual({ ...result, unchanged: true });
		expect(gh.writes()).toHaveLength(count);
	});
	test("near-limit UTF-8 notes read back under a one-MiB caller output budget", async () => {
		const f = await fixture("1.2.0", false, "界".repeat(300000));
		const gh = fakeGitHub([f]);
		const run = async (args: string[]) => {
			const result = await gh.run(args);
			if (Buffer.byteLength(result) > 1024 * 1024) throw new Error("Caller gh output limit");
			return result;
		};
		expect(f.notes.size).toBeGreaterThan(800000);
		await publishUpdateIndex({ repository, ...f, run });
		expect((await publishUpdateIndex({ repository, ...f, run })).unchanged).toBe(true);
		expect(
			gh.calls
				.filter((call) => call.args[1].includes("/contents/notes/"))
				.every((call) => call.args.includes("Accept: application/vnd.github.raw+json")),
		).toBe(true);
	});
	test("existing base_tree and parent retain unrelated files with non-force fixed ref update", async () => {
		const old = await fixture("1.2.0");
		const next = await fixture("1.2.1");
		const gh = fakeGitHub([old, next]);
		const head = gh.seed(mergeUpdateIndex(null, old.release, repository, publishedAt), old.notes);
		const previousTree = gh.commits.get(head)?.tree;
		const result = await publishUpdateIndex({ repository, ...next, run: gh.run });
		expect(gh.writes().find((c) => c.args[1].endsWith("git/trees"))?.body?.base_tree).toBe(
			previousTree,
		);
		expect(gh.commits.get(result.commit)?.parents).toEqual([head]);
		expect(gh.trees.get(gh.commits.get(result.commit)?.tree ?? "")?.get("unrelated.json")).toBe(
			gh.trees.get(previousTree ?? "")?.get("unrelated.json"),
		);
		expect(gh.index()?.channels).toEqual({ stable: "1.2.0", beta: "1.2.1" });
		expect(gh.calls.some((c) => c.args[1] === "graphql")).toBe(false);
	});
	test("bootstrap full-only historical targets can be repaired or promoted without dropping patch identities", async () => {
		const historical = await fixture("9.0.1", true);
		const current = await fixture("8.0.0");
		for (const promote of [false, true]) {
			for (const useOriginalBundle of [false, true]) {
				const gh = fakeGitHub([historical, current]);
				await publishUpdateIndex({ repository, ...current, run: gh.run });
				expect(
					gh.index()?.releases.find((entry) => entry.version === "9.0.1")?.files[0].patches,
				).toEqual([]);
				const remote = gh.releases.get(historical.release.tag);
				if (!remote) throw new Error("fixture");
				remote.prerelease = !promote;
				const prepared = useOriginalBundle
					? historical
					: await preparePublishedUpdateIndexRelease({
							repository,
							version: "9.0.1",
							commit,
							run: gh.run,
						});
				await publishUpdateIndex({ repository, ...prepared, run: gh.run });
				expect(gh.index()?.releases.find((entry) => entry.version === "9.0.1")?.files).toEqual(
					historical.release.files,
				);
				expect(gh.index()?.channels).toEqual({
					stable: promote ? "9.0.1" : "8.0.0",
					beta: "9.0.1",
				});
				expect((await publishUpdateIndex({ repository, ...prepared, run: gh.run })).unchanged).toBe(
					true,
				);
				const writes = gh.writes().length;
				const dropped = structuredClone(prepared.release);
				dropped.files[0].patches = [];
				await expect(
					publishUpdateIndex({ repository, ...prepared, release: dropped, run: gh.run }),
				).rejects.toThrow("immutable release patch identity");
				expect(gh.writes()).toHaveLength(writes);
			}
		}
	});
	test("bootstrap protects old high stable and highest beta while incoming is older", async () => {
		const stable = await fixture("8.0.0", true);
		const beta = await fixture("9.0.1");
		const current = await fixture("1.2.0");
		const gh = fakeGitHub([stable, beta, current]);
		await publishUpdateIndex({ repository, ...current, run: gh.run });
		expect(gh.index()?.channels).toEqual({ stable: "8.0.0", beta: "9.0.1" });
		expect(gh.index()?.releases).toHaveLength(3);
		expect(gh.index()?.releases.find((r) => r.version === "8.0.0")?.files[0].patches).toEqual([]);
		expect(gh.calls.filter((c) => c.args[1] === "graphql")).toHaveLength(1);
		expect(gh.writes().every((c) => c.args[1].includes("/git/"))).toBe(true);
	});
	test("untrustworthy historical target fails before any writes rather than hiding higher stable", async () => {
		const stable = await fixture("8.0.0");
		const current = await fixture("1.2.1");
		const gh = fakeGitHub([stable, current]);
		const remote = gh.releases.get(stable.release.tag);
		if (!remote) throw new Error("fixture");
		remote.assets[0].digest = null;
		await expect(publishUpdateIndex({ repository, ...current, run: gh.run })).rejects.toThrow(
			"identity",
		);
		expect(gh.writes()).toEqual([]);
		expect(gh.head).toBeNull();
	});
	test("uses remote prerelease and publication time; rejects draft, tag, binary and sidecar mismatches", async () => {
		const f = await fixture("1.2.1");
		const gh = fakeGitHub([f]);
		const remote = gh.releases.get(f.release.tag);
		if (!remote) throw new Error("fixture");
		remote.prerelease = false;
		remote.published_at = "2026-08-01T00:00:00.000Z";
		await publishUpdateIndex({ repository, ...f, run: gh.run });
		expect(gh.index()?.channels.stable).toBe("1.2.1");
		expect(gh.index()?.releases[0].publishedAt).toBe(remote.published_at);
		for (const mutate of [
			(r: StoredRelease) => {
				r.draft = true;
			},
			(r: StoredRelease) => {
				r.commit = "b".repeat(40);
			},
			(r: StoredRelease) => {
				r.assets[0].digest = `sha256:${"c".repeat(64)}`;
			},
			(r: StoredRelease) => {
				r.sidecars.set(r.assets[1].id, "{}");
			},
		]) {
			const gh = fakeGitHub([f]);
			const remote = gh.releases.get(f.release.tag);
			if (!remote) throw new Error("fixture");
			mutate(remote);
			await expect(publishUpdateIndex({ repository, ...f, run: gh.run })).rejects.toThrow();
			expect(gh.writes()).toHaveLength(0);
		}
	});
	test("CAS retries cannot delete a patch announced by the winning concurrent writer", async () => {
		const f = await fixture("1.2.0", true);
		const gh = fakeGitHub([f]);
		const fullOnly = structuredClone(f.release);
		fullOnly.files[0].patches = [];
		gh.seed(mergeUpdateIndex(null, fullOnly, repository, publishedAt), f.notes);
		const concurrent = structuredClone(f.release);
		const extraName = `${f.name}.from-0.9.0.zstd-patch`;
		concurrent.files[0].patches.push({
			...concurrent.files[0].patches[0],
			name: extraName,
			fromVersion: "0.9.0",
			metadata: { ...concurrent.files[0].patches[0].metadata, name: `${extraName}.meta.json` },
		});
		gh.conflicts = 1;
		gh.onConflict = () => {
			gh.seed(mergeUpdateIndex(gh.index(), concurrent, repository, publishedAt), f.notes);
		};
		await expect(publishUpdateIndex({ repository, ...f, run: gh.run })).rejects.toThrow(
			"immutable release patch identity",
		);
		expect(gh.index()?.releases[0].files[0].patches).toHaveLength(2);
		expect(gh.writes().filter((call) => call.args.includes("PATCH"))).toHaveLength(1);
	});
	test("CAS conflict rereads and merges higher concurrent target; no force and max three attempts", async () => {
		const old = await fixture("1.2.0");
		const current = await fixture("1.2.1");
		const concurrent = await fixture("9.0.0");
		const gh = fakeGitHub([old, current, concurrent]);
		gh.seed(mergeUpdateIndex(null, old.release, repository, publishedAt), old.notes);
		gh.conflicts = 1;
		gh.onConflict = () => {
			gh.seed(
				mergeUpdateIndex(gh.index(), concurrent.release, repository, publishedAt),
				concurrent.notes,
			);
		};
		await publishUpdateIndex({ repository, ...current, run: gh.run });
		expect(gh.index()?.channels).toEqual({ stable: "9.0.0", beta: "9.0.0" });
		expect(gh.writes().filter((c) => c.args.includes("PATCH"))).toHaveLength(2);
		const failing = fakeGitHub([current]);
		failing.conflicts = 3;
		await expect(publishUpdateIndex({ repository, ...current, run: failing.run })).rejects.toThrow(
			"422",
		);
		expect(failing.writes().filter((c) => c.args[1].endsWith("git/refs"))).toHaveLength(3);
	});
	test("corrupt index, occupied notes hash path and failed readback are detected", async () => {
		const f = await fixture();
		const gh = fakeGitHub([f]);
		gh.seed("{}");
		await expect(publishUpdateIndex({ repository, ...f, run: gh.run })).rejects.toThrow();
		expect(gh.writes()).toHaveLength(0);
		const occupied = fakeGitHub([f]);
		occupied.seed(mergeUpdateIndex(null, f.release, repository), {
			...f.notes,
			content: "wrong bytes",
		});
		await expect(publishUpdateIndex({ repository, ...f, run: occupied.run })).rejects.toThrow(
			"different bytes",
		);
		expect(occupied.writes()).toHaveLength(0);
		const readback = fakeGitHub([f]);
		readback.corruptReadback = true;
		await expect(publishUpdateIndex({ repository, ...f, run: readback.run })).rejects.toThrow();
		expect(readback.head).not.toBeNull();
	});
	test("asset paging is bounded and projected without Release bodies", async () => {
		const f = await fixture();
		const gh = fakeGitHub([f]);
		const remote = gh.releases.get(f.release.tag);
		if (!remote) throw new Error("fixture");
		while (remote.assets.length < 200)
			remote.assets.push({
				id: 10000 + remote.assets.length,
				name: `extra-${remote.assets.length}`,
				size: 1,
				state: "uploaded",
				digest: `sha256:${"a".repeat(64)}`,
			});
		await publishUpdateIndex({ repository, ...f, run: gh.run });
		expect(
			gh.calls.filter((call) => call.args[1].includes("assets?per_page=100&page=")),
		).toHaveLength(3);
		expect(gh.calls.every((call) => !call.args[1].endsWith("/releases"))).toBe(true);
		const oversized = fakeGitHub([f]);
		const over = oversized.releases.get(f.release.tag);
		if (!over) throw new Error("fixture");
		over.assets = [
			...remote.assets,
			{ id: 20000, name: "overflow", size: 1, state: "uploaded", digest: null },
		];
		await expect(publishUpdateIndex({ repository, ...f, run: oversized.run })).rejects.toThrow(
			"count exceeded",
		);
		expect(oversized.writes()).toHaveLength(0);
	});
	test("bootstrap Release changes after summary discovery fail closed", async () => {
		const stable = await fixture("8.0.0");
		const current = await fixture("1.2.1");
		const gh = fakeGitHub([stable, current]);
		const run = async (args: string[]) => {
			const response = await gh.run(args);
			if (args[1] === "graphql") {
				const remote = gh.releases.get(stable.release.tag);
				if (!remote) throw new Error("fixture");
				remote.prerelease = true;
			}
			return response;
		};
		await expect(publishUpdateIndex({ repository, ...current, run })).rejects.toThrow(
			"changed after summary",
		);
		expect(gh.writes()).toHaveLength(0);
	});
	test("one-MiB raw notes and sidecar response budgets cannot be bypassed", async () => {
		const f = await fixture();
		await expect(
			prepareUpdateIndexRelease({ ...f.options, changelog: "中".repeat(400000) }),
		).rejects.toThrow("byte limit");
		const gh = fakeGitHub([f]);
		const run = async (args: string[]) =>
			args.includes("Accept: application/octet-stream") ? " ".repeat(65537) : gh.run(args);
		await expect(publishUpdateIndex({ repository, ...f, run })).rejects.toThrow("output limit");
		expect(gh.writes()).toHaveLength(0);
	});
	test("invalid repository, notes tamper and cancelled publication make zero gh calls", async () => {
		const f = await fixture();
		const gh = fakeGitHub([f]);
		await expect(
			publishUpdateIndex({ ...f, repository: "../upstream", run: gh.run }),
		).rejects.toThrow("repository");
		await expect(
			publishUpdateIndex({ repository, ...f, notes: { ...f.notes, content: "{}" }, run: gh.run }),
		).rejects.toThrow("notes identity");
		await expect(
			publishUpdateIndex({ repository, ...f, signal: AbortSignal.abort(), run: gh.run }),
		).rejects.toThrow();
		expect(gh.calls).toHaveLength(0);
	});
});
