import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatChecksumsReport,
	formatMetadataJson,
	formatSha256Sums,
} from "../../scripts/lib/binary-metadata";
import {
	DEFAULT_GITHUB_REPOSITORY,
	GH_MAX_OUTPUT_BYTES,
	GH_TIMEOUT_MS,
	type GitHubReleaseOptions,
	githubReleaseBody,
	publishGitHubRelease,
	releaseChannel,
	validateGitHubRepository,
} from "../../scripts/lib/github-release";
import { MAX_RELEASE_PATCH_BYTES, type ReleasePatchMetadata } from "../../shared/release-patch";

const roots: string[] = [];
const commit = "a".repeat(40);
const changelog = { en: "- Added updates", "zh-CN": "- 新增更新" };

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "1.2.0", all: boolean | "all-platforms" = false) {
	const root = mkdtempSync(join(tmpdir(), "narrafork-github-test-"));
	roots.push(root);
	const suffixes = new Map([["linux-x64", "linux-x64"]]);
	const distSuffixes = new Map(suffixes);
	if (all) distSuffixes.set("win-x64", "windows-x64.exe");
	if (all === "all-platforms") {
		for (const platform of [
			"linux-x64-baseline",
			"linux-arm64",
			"darwin-x64",
			"darwin-arm64",
			"win-x64-baseline",
			"win-arm64",
		]) {
			const suffix =
				platform.replace(/^darwin-/, "macos-").replace(/^win-/, "windows-") +
				(platform.startsWith("win-") ? ".exe" : "");
			distSuffixes.set(platform, suffix);
		}
		for (const [platform, suffix] of distSuffixes) suffixes.set(platform, suffix);
	}
	const metadata = [...distSuffixes].map(([platform, suffix]) => {
		const name = `narrafork-${version}-${suffix}`;
		const bytes = Buffer.from(`binary-${platform}`);
		const entry = computeBinaryMetadataFromBuffer(name, bytes, {
			version,
			platformId: platform,
			target: `bun-${platform.replace(/^win-/, "windows-")}`,
			commit: commit.slice(0, 12),
			buildDate: "2026-06-01T00:00:00.000Z",
		});
		writeFileSync(join(root, name), bytes);
		writeFileSync(join(root, `${name}.metadata.json`), formatMetadataJson(entry));
		return entry;
	});
	writeFileSync(join(root, `narrafork-${version}-SHA256SUMS`), formatSha256Sums(metadata));
	writeFileSync(
		join(root, `narrafork-${version}-checksums.txt`),
		formatChecksumsReport(version, metadata),
	);
	const options: GitHubReleaseOptions = {
		distDir: root,
		version,
		platformSuffixes: suffixes,
		commit,
		changelog,
	};
	return { root, options, metadata };
}

function addPatch(
	data: ReturnType<typeof fixture>,
	fromVersion = "1.1.0",
	named = false,
	platformIndex = 0,
) {
	const binary = data.metadata[platformIndex];
	const name = `${binary.name}${named ? `.from-${fromVersion}` : ""}.zstd-patch`;
	const bytes = Buffer.from(`patch-${fromVersion}-${binary.platform}`);
	const base = Buffer.from(`base-${fromVersion}`);
	const meta: ReleasePatchMetadata = {
		fromVersion,
		toVersion: data.options.version,
		oldFileSize: base.length,
		oldFileSha512: createHash("sha512").update(base).digest("base64"),
		newFileSize: binary.size,
		newFileSha512: binary.sha512,
		patchSize: bytes.length,
		stableEnd: 0,
		newTailSize: binary.size,
		mode: "patch-from",
	};
	const path = join(data.root, name);
	const metadataPath = `${path}.meta.json`;
	writeFileSync(path, bytes);
	writeFileSync(metadataPath, JSON.stringify(meta));
	return { name, path, metadataPath, meta, bytes, base };
}

interface FakeAsset {
	name: string;
	size: number;
	state: string;
	digest?: string;
}
interface FakeRelease {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	body: string;
	assets: FakeAsset[];
}

function fakeGitHub(options: GitHubReleaseOptions) {
	const calls: string[][] = [];
	const contents = new Map<string, Buffer>();
	const server = {
		calls,
		contents,
		release: null as FakeRelease | null,
		tagCommit: commit,
		annotated: false,
		digests: true,
		failUpload: false,
		corruptUpload: false,
		corruptDownload: false,
		authFailure: false,
		async run(args: string[]) {
			calls.push(args);
			if (args[0] === "api" && args[1].includes("/git/ref/tags/")) {
				return JSON.stringify({
					object: { type: server.annotated ? "tag" : "commit", sha: server.tagCommit },
				});
			}
			if (args[0] === "api" && args[1].includes("/git/tags/")) {
				return JSON.stringify({ object: { type: "commit", sha: server.tagCommit } });
			}
			if (args[0] === "api") {
				if (server.authFailure) throw new Error("gh failed: HTTP 401");
				if (args[1].includes("/releases?")) {
					return JSON.stringify(
						server.release ? [{ id: server.release.id, tag_name: server.release.tag_name }] : [],
					);
				}
				if (!server.release || (server.release.draft && args[1].includes("/releases/tags/"))) {
					throw new Error("gh failed: HTTP 404");
				}
				return JSON.stringify(server.release);
			}
			if (args[1] === "create") {
				expect(args).toContain("--draft");
				expect(args).toContain("--verify-tag");
				expect(args[args.indexOf("--target") + 1]).toBe(commit);
				server.release = {
					id: 1,
					tag_name: `v${options.version}`,
					draft: true,
					prerelease: args.includes("--prerelease"),
					body: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"),
					assets: [],
				};
				return "";
			}
			if (args[1] === "upload") {
				if (server.failUpload) throw new Error("simulated upload failure");
				expect(server.release?.draft).toBe(true);
				expect(args).not.toContain("--clobber");
				const name = basename(args[3]);
				const bytes = readFileSync(args[3]);
				contents.set(name, bytes);
				server.release?.assets.push({
					name,
					size: bytes.length,
					state: "uploaded",
					...(server.digests
						? {
								digest: `sha256:${server.corruptUpload ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex")}`,
							}
						: {}),
				});
				return "";
			}
			if (args[1] === "download") {
				const name = args[args.indexOf("--pattern") + 1];
				const bytes = contents.get(name);
				if (!bytes) throw new Error("missing simulated bytes");
				writeFileSync(
					args[args.indexOf("--output") + 1],
					server.corruptDownload ? Buffer.alloc(bytes.length) : bytes,
				);
				return "";
			}
			if (args[1] === "edit") {
				expect(args).toContain("--draft=false");
				if (server.release) server.release.draft = false;
				return "";
			}
			throw new Error(`Unexpected gh call: ${args.join(" ")}`);
		},
	};
	return server;
}

describe("GitHub release assets and lifecycle", () => {
	test.each([
		"01.2.0",
		"1.02.0",
		"1.2.0-beta.01",
		"1.2.0-beta_one",
	])("rejects versions the updater cannot recognize: %s", async (version) => {
		const { options } = fixture();
		await expect(publishGitHubRelease({ ...options, version, dryRun: true })).rejects.toThrow(
			"Invalid release version",
		);
	});
	test.each([
		"owner/repo..name",
		"owner-/repo",
		"two--hyphens/repo",
		`${"a".repeat(40)}/repo`,
	])("publisher uses the same repository validation as settings: %s", (repository) => {
		expect(() => validateGitHubRepository(repository)).toThrow("Invalid GitHub repository");
	});
	test("stages selected full binaries and sidecars only, leaving dist aggregates unchanged", async () => {
		const { root, options } = fixture("1.2.0", true);
		const original = readFileSync(join(root, "narrafork-1.2.0-SHA256SUMS"), "utf8");
		// Unselected-platform patch corruption does not affect this filtered publication.
		writeFileSync(join(root, "narrafork-1.2.0-windows-x64.exe.zstd-patch"), "patch");
		const gh = fakeGitHub(options);
		const result = await publishGitHubRelease({ ...options, run: gh.run });
		expect(result.assets).toHaveLength(4);
		expect(result.assets).not.toContain("narrafork-1.2.0-windows-x64.exe");
		expect(result.assets.some((name) => name.includes("patch"))).toBe(false);
		expect(readFileSync(join(root, "narrafork-1.2.0-SHA256SUMS"), "utf8")).toBe(original);
		expect(gh.contents.get("narrafork-1.2.0-SHA256SUMS")?.toString()).not.toContain("windows");
		expect(gh.contents.get("narrafork-1.2.0-checksums.txt")?.toString()).not.toContain("windows");
		expect(gh.calls.filter((args) => args[1] === "upload")).toHaveLength(4);
		const createIndex = gh.calls.findIndex((args) => args[1] === "create");
		const publishIndex = gh.calls.findIndex((args) => args[1] === "edit");
		expect(createIndex).toBeLessThan(publishIndex);
		expect(
			gh.calls.slice(createIndex + 1, publishIndex).filter((args) => args[1] === "upload"),
		).toHaveLength(4);
		expect(gh.calls[publishIndex - 1][1]).toContain("/git/ref/tags/");
		expect(gh.calls[publishIndex]).toContain("--latest=true");
		expect(gh.release?.draft).toBe(false);
		expect(gh.release?.body).toContain(changelog.en);
		expect(gh.release?.body).toContain(changelog["zh-CN"]);
	});

	test("uploads every requested platform including Windows .exe to an explicit repository", async () => {
		const { options } = fixture("1.2.0", true);
		options.platformSuffixes = new Map([
			["linux-x64", "linux-x64"],
			["win-x64", "windows-x64.exe"],
		]);
		options.repository = "example/releases";
		const gh = fakeGitHub(options);
		const result = await publishGitHubRelease({ ...options, run: gh.run });
		expect(result.assets).toHaveLength(6);
		expect(result.assets).toContain("narrafork-1.2.0-windows-x64.exe.metadata.json");
		expect(
			gh.calls
				.filter((args) => args[0] === "api")
				.every((args) => args[1].startsWith("repos/example/releases/")),
		).toBe(true);
		expect(gh.calls.find((args) => args[1] === "create")).toContain("example/releases");
	});

	test("dry run validates assets but makes no gh calls", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		const result = await publishGitHubRelease({ ...options, dryRun: true, run: gh.run });
		expect(result.dryRun).toBe(true);
		expect(gh.calls).toEqual([]);
	});

	for (const missing of ["linux-x64", "linux-x64.metadata.json", "SHA256SUMS", "checksums.txt"]) {
		test(`fails before any gh calls when mandatory ${missing} is absent`, async () => {
			const { root, options } = fixture();
			rmSync(join(root, `narrafork-1.2.0-${missing}`));
			const gh = fakeGitHub(options);
			await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow();
			expect(gh.calls).toEqual([]);
		});
	}

	for (const [field, value] of [
		["name", "wrong-name"],
		["version", "9.9.9"],
		["platform", "win-x64"],
		["target", "bun-windows-x64"],
		["commit", "b".repeat(12)],
		["commit", ""],
		["size", 999],
		["sha256", "0".repeat(64)],
		["sha512", "bad"],
		["buildDate", "invalid"],
	] as const) {
		test(`rejects mismatched metadata ${field}=${value}`, async () => {
			const { root, options, metadata } = fixture();
			writeFileSync(
				join(root, `${metadata[0].name}.metadata.json`),
				JSON.stringify({ ...metadata[0], [field]: value }),
			);
			const gh = fakeGitHub(options);
			await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow();
			expect(gh.calls).toEqual([]);
		});
	}

	test("rejects empty/corrupt binaries and invalid aggregate checksums", async () => {
		for (const corrupt of ["binary", "sums", "report"]) {
			const { root, options, metadata } = fixture();
			const name =
				corrupt === "binary"
					? metadata[0].name
					: `narrafork-1.2.0-${corrupt === "sums" ? "SHA256SUMS" : "checksums.txt"}`;
			writeFileSync(join(root, name), "corrupt");
			const gh = fakeGitHub(options);
			await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow();
			expect(gh.calls).toEqual([]);
		}
	});

	test("upload failure retains draft, and retry never clobbers matching assets", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		gh.failUpload = true;
		await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow(
			"simulated upload failure",
		);
		expect(gh.release?.draft).toBe(true);
		expect(gh.calls.some((args) => args[1] === "edit")).toBe(false);
		gh.failUpload = false;
		await publishGitHubRelease({ ...options, run: gh.run });
		expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(1);
		expect(gh.calls.some((args) => args.includes("--clobber"))).toBe(false);
	});

	test("discovers drafts when tag lookup returns 404 and resumes already uploaded assets", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		let uploads = 0;
		await expect(
			publishGitHubRelease({
				...options,
				run: (args) => {
					if (args[1] === "upload" && ++uploads === 2) throw new Error("interrupted second upload");
					return gh.run(args);
				},
			}),
		).rejects.toThrow("interrupted second upload");
		expect(gh.release?.assets).toHaveLength(1);
		await publishGitHubRelease({ ...options, run: gh.run });
		expect(
			gh.calls.filter(
				(args) => args[1] === "upload" && basename(args[3]) === "narrafork-1.2.0-linux-x64",
			),
		).toHaveLength(1);
		expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(1);
		expect(gh.calls.some((args) => args[1].includes("/releases?per_page=100&page=1"))).toBe(true);
		expect(gh.calls.some((args) => args[1].endsWith("/releases/1"))).toBe(true);
	});

	test("draft discovery is bounded and never creates when the lookup is incomplete", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		const unrelated = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			tag_name: `v0.1.${index}`,
		}));
		let pages = 0;
		await expect(
			publishGitHubRelease({
				...options,
				run: (args) => {
					if (args[1].includes("/releases?")) {
						pages++;
						return JSON.stringify(unrelated);
					}
					return gh.run(args);
				},
			}),
		).rejects.toThrow("page limit reached");
		expect(pages).toBe(10);
		expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
	});

	test("remote hash verification must succeed before publishing", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		gh.corruptUpload = true;
		await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow(
			"hash mismatch",
		);
		expect(gh.release?.draft).toBe(true);
		expect(gh.calls.some((args) => args[1] === "edit")).toBe(false);
		gh.corruptUpload = false;
		const uploadCount = gh.calls.filter((args) => args[1] === "upload").length;
		await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow(
			"hash mismatch",
		);
		expect(gh.calls.filter((args) => args[1] === "upload")).toHaveLength(uploadCount);
	});

	test("older assets without digest are downloaded and stream verified", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		gh.digests = false;
		await publishGitHubRelease({ ...options, run: gh.run });
		expect(gh.calls.filter((args) => args[1] === "download")).toHaveLength(4);
		gh.corruptDownload = true;
		await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow(
			"Downloaded asset hash mismatch",
		);
	});

	test("already-public identical release succeeds without any mutations", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		await publishGitHubRelease({ ...options, run: gh.run });
		gh.calls.length = 0;
		const result = await publishGitHubRelease({ ...options, run: gh.run });
		expect(result.alreadyPublished).toBe(true);
		expect(gh.calls.every((args) => args[0] === "api")).toBe(true);
	});

	for (const mutation of ["notes", "channel", "missing", "extra", "size", "commit"] as const) {
		test(`already-public ${mutation} mismatch fails without mutations`, async () => {
			const { options } = fixture();
			const gh = fakeGitHub(options);
			await publishGitHubRelease({ ...options, run: gh.run });
			const release = gh.release;
			if (!release) throw new Error("Missing fake release");
			if (mutation === "notes") release.body = "Changed";
			if (mutation === "channel") release.prerelease = true;
			if (mutation === "missing") release.assets.pop();
			if (mutation === "extra") release.assets.push({ name: "extra", size: 1, state: "uploaded" });
			if (mutation === "size") release.assets[0].size++;
			if (mutation === "commit") gh.tagCommit = "b".repeat(40);
			gh.calls.length = 0;
			await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow();
			expect(gh.calls.every((args) => args[0] === "api")).toBe(true);
		});
	}

	test("does not turn authentication failures into release creation", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		gh.authFailure = true;
		await expect(publishGitHubRelease({ ...options, run: gh.run })).rejects.toThrow("HTTP 401");
		expect(gh.calls.some((args) => args[1] === "create")).toBe(false);
	});

	test("checks annotated tags and marks non-x.y.0 as prerelease", async () => {
		const { options } = fixture("1.2.1");
		const gh = fakeGitHub(options);
		gh.annotated = true;
		await publishGitHubRelease({ ...options, run: gh.run });
		expect(gh.release?.prerelease).toBe(true);
		expect(gh.calls.some((args) => args[1]?.includes("/git/tags/"))).toBe(true);
		expect(gh.calls.find((args) => args[1] === "edit")).toContain("--latest=false");
	});

	test("rejects unknown platform and malformed repository before contacting gh", async () => {
		const { options } = fixture();
		const gh = fakeGitHub(options);
		await expect(
			publishGitHubRelease({ ...options, platformSuffixes: new Map(), run: gh.run }),
		).rejects.toThrow("No valid release platforms");
		await expect(
			publishGitHubRelease({ ...options, repository: "../escape", run: gh.run }),
		).rejects.toThrow("Invalid GitHub repository");
		expect(gh.calls).toEqual([]);
	});
});

describe("GitHub optional incremental patch assets", () => {
	test("uploads full plus patches for all eight platforms before publishing (more than 32 assets)", async () => {
		const data = fixture("1.2.0", "all-platforms");
		const patches = data.metadata.map((_, index) => addPatch(data, "1.1.0", false, index));
		const gh = fakeGitHub(data.options);
		const result = await publishGitHubRelease({ ...data.options, run: gh.run });
		expect(result.assets).toHaveLength(34);
		for (const patch of patches) {
			expect(result.assets).toContain(patch.name);
			expect(result.assets).toContain(`${patch.name}.meta.json`);
			expect(gh.contents.get(patch.name)).toEqual(patch.bytes);
		}
		expect(gh.release?.draft).toBe(false);
		expect(gh.calls.filter((args) => args[1] === "upload")).toHaveLength(34);
		const publish = gh.calls.findIndex((args) => args[1] === "edit");
		expect(gh.calls.slice(publish + 1).every((args) => args[0] === "api")).toBe(true);
	});

	test("accepts the maximum 64 patch pairs across eight platforms (146 assets)", async () => {
		const data = fixture("1.2.0", "all-platforms");
		for (let platform = 0; platform < 8; platform++) {
			for (let base = 0; base < 8; base++) addPatch(data, `1.1.${base}`, true, platform);
		}
		const gh = fakeGitHub(data.options);
		const result = await publishGitHubRelease({ ...data.options, run: gh.run });
		expect(result.assets).toHaveLength(146);
		expect(gh.release?.assets).toHaveLength(146);
		expect(gh.release?.draft).toBe(false);
	});

	test("upload uses the verified snapshot even if dist is edited after staging", async () => {
		const data = fixture();
		const patch = addPatch(data);
		const rawMetadata = readFileSync(patch.metadataPath);
		const gh = fakeGitHub(data.options);
		await publishGitHubRelease({
			...data.options,
			run: (args) => {
				if (args[1] === "create") {
					writeFileSync(patch.path, Buffer.alloc(patch.bytes.length));
					writeFileSync(patch.metadataPath, "invalid after staging");
				}
				return gh.run(args);
			},
		});
		expect(gh.contents.get(patch.name)).toEqual(patch.bytes);
		expect(gh.contents.get(`${patch.name}.meta.json`)).toEqual(rawMetadata);
		expect(gh.release?.draft).toBe(false);
	});

	test("supports multiple direct base versions and snapshots all assets without modifying dist", async () => {
		const data = fixture();
		const patches = [addPatch(data), addPatch(data, "1.0.0", true), addPatch(data, "1.1.1", true)];
		const before = new Map(
			readdirSync(data.root).map((name) => [name, readFileSync(join(data.root, name))]),
		);
		const gh = fakeGitHub(data.options);
		const result = await publishGitHubRelease({
			...data.options,
			run: (args) => {
				if (args[1] === "upload") expect(args[3].startsWith(`${data.root}/`)).toBe(false);
				return gh.run(args);
			},
		});
		expect(result.assets).toHaveLength(10);
		for (const patch of patches) expect(result.assets).toContain(patch.name);
		expect(readdirSync(data.root).sort()).toEqual([...before.keys()].sort());
		for (const [name, bytes] of before) expect(readFileSync(join(data.root, name))).toEqual(bytes);
	});

	test.each(["patch", "metadata"])("rejects an orphaned %s before any gh call", async (missing) => {
		const data = fixture();
		const patch = addPatch(data);
		rmSync(missing === "patch" ? patch.path : patch.metadataPath);
		const gh = fakeGitHub(data.options);
		await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow(
			"Unpaired patch",
		);
		expect(gh.calls).toEqual([]);
	});

	for (const [field, value] of [
		["fromVersion", "invalid"],
		["fromVersion", "1.2.0"],
		["toVersion", "1.3.0"],
		["oldFileSize", undefined],
		["oldFileSha512", undefined],
		["oldFileSha512", "bad"],
		["newFileSize", 1000],
		["newFileSha512", createHash("sha512").update("other").digest("base64")],
		["patchSize", 1000],
		["stableEnd", -1],
		["newTailSize", 0],
		["mode", "unknown"],
	] as const) {
		test(`rejects patch metadata ${field}=${value} before any gh call`, async () => {
			const data = fixture();
			const patch = addPatch(data);
			writeFileSync(patch.metadataPath, JSON.stringify({ ...patch.meta, [field]: value }));
			const gh = fakeGitHub(data.options);
			await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow();
			expect(gh.calls).toEqual([]);
		});
	}

	test("checks named source version hints and rejects malformed related filenames", async () => {
		for (const malformed of [false, true]) {
			const data = fixture();
			const patch = addPatch(data, "1.0.0", true);
			if (malformed) {
				const name = `${data.metadata[0].name}.from-bad.zstd-patch`;
				writeFileSync(join(data.root, name), patch.bytes);
				writeFileSync(join(data.root, `${name}.meta.json`), JSON.stringify(patch.meta));
			} else {
				writeFileSync(patch.metadataPath, JSON.stringify({ ...patch.meta, fromVersion: "1.1.0" }));
			}
			const gh = fakeGitHub(data.options);
			await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow();
			expect(gh.calls).toEqual([]);
		}
	});

	test("optional local source verifies old identity, without requiring a source file or network", async () => {
		const data = fixture();
		const patch = addPatch(data);
		const gh = fakeGitHub(data.options);
		await publishGitHubRelease({ ...data.options, dryRun: true, run: gh.run });
		const basePath = join(data.root, "narrafork-1.1.0-linux-x64");
		writeFileSync(basePath, patch.base);
		await publishGitHubRelease({ ...data.options, dryRun: true, run: gh.run });
		writeFileSync(basePath, Buffer.alloc(patch.base.length));
		await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow(
			"source identity mismatch",
		);
		expect(gh.calls).toEqual([]);
	});

	test.each([
		"corrupt",
		"empty",
		"oversized",
		"metadata-size",
		"metadata-json",
	])("rejects %s patch pair before GitHub activity", async (kind) => {
		const data = fixture();
		const patch = addPatch(data);
		if (kind === "corrupt") writeFileSync(patch.path, "corrupt");
		if (kind === "empty") writeFileSync(patch.path, "");
		if (kind === "oversized") truncateSync(patch.path, MAX_RELEASE_PATCH_BYTES + 1);
		if (kind === "metadata-size") writeFileSync(patch.metadataPath, " ".repeat(64 * 1024 + 1));
		if (kind === "metadata-json") writeFileSync(patch.metadataPath, "{");
		const gh = fakeGitHub(data.options);
		await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow();
		expect(gh.calls).toEqual([]);
	});

	test("patch pair count is bounded independently of byte size", async () => {
		const data = fixture("2.0.0");
		for (let index = 0; index < 65; index++) addPatch(data, `1.0.${index}`, true);
		const gh = fakeGitHub(data.options);
		await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow(
			"pair limit",
		);
		expect(gh.calls).toEqual([]);
	});

	test("a partial draft resumes patch pairs without reuploading or clobbering verified assets", async () => {
		const data = fixture();
		const patch = addPatch(data);
		const gh = fakeGitHub(data.options);
		await expect(
			publishGitHubRelease({
				...data.options,
				run: (args) => {
					if (args[1] === "upload" && basename(args[3]) === `${patch.name}.meta.json`)
						throw new Error("interrupted metadata upload");
					return gh.run(args);
				},
			}),
		).rejects.toThrow("interrupted metadata upload");
		expect(gh.release?.assets).toHaveLength(3);
		expect(gh.release?.draft).toBe(true);
		await publishGitHubRelease({ ...data.options, run: gh.run });
		expect(
			gh.calls.filter((args) => args[1] === "upload" && basename(args[3]) === patch.name),
		).toHaveLength(1);
		expect(gh.calls.filter((args) => args[1] === "create")).toHaveLength(1);
		expect(gh.calls.some((args) => args.includes("--clobber"))).toBe(false);
	});

	test("patch remote hash corruption prevents publication", async () => {
		const data = fixture();
		const patch = addPatch(data);
		const gh = fakeGitHub(data.options);
		await expect(
			publishGitHubRelease({
				...data.options,
				run: async (args) => {
					const result = await gh.run(args);
					if (args[1] === "upload" && basename(args[3]) === patch.name) {
						const remote = gh.release?.assets.find((asset) => asset.name === patch.name);
						if (remote) remote.digest = `sha256:${"0".repeat(64)}`;
					}
					return result;
				},
			}),
		).rejects.toThrow("hash mismatch");
		expect(gh.release?.draft).toBe(true);
		expect(gh.calls.some((args) => args[1] === "edit")).toBe(false);
	});

	test.each([
		"missing",
		"changed",
		"added",
	])("never overwrites or appends %s public patch assets", async (kind) => {
		const data = fixture();
		const patch = addPatch(data);
		const gh = fakeGitHub(data.options);
		await publishGitHubRelease({ ...data.options, run: gh.run });
		if (kind === "missing" && gh.release)
			gh.release.assets = gh.release.assets.filter((asset) => asset.name !== patch.name);
		if (kind === "changed") writeFileSync(patch.path, Buffer.alloc(patch.bytes.length));
		if (kind === "added") addPatch(data, "1.0.0", true);
		gh.calls.length = 0;
		await expect(publishGitHubRelease({ ...data.options, run: gh.run })).rejects.toThrow();
		expect(gh.calls.every((args) => args[0] === "api")).toBe(true);
	});
});

describe("release target compatibility", () => {
	test("full GitHub dry-run never reads update credentials or queries the legacy baseline", () => {
		const home = mkdtempSync(join(tmpdir(), "narrafork-release-preload-"));
		roots.push(home);
		const guard = join(home, "guard.ts");
		writeFileSync(
			guard,
			`
import { mock } from "bun:test";
import * as fs from "node:fs";
const original = { ...fs };
mock.module("node:fs", () => ({ ...original, existsSync(path: unknown) {
	if (String(path).endsWith("update-server.json")) throw new Error("FORBIDDEN_UPDATE_CREDENTIAL_READ");
	return original.existsSync(path as string);
} }));
globalThis.fetch = async () => { throw new Error("FORBIDDEN_LEGACY_BASELINE_FETCH"); };
`,
		);
		const version = JSON.parse(
			readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
		).version;
		const result = Bun.spawnSync(
			[
				"bun",
				"--preload",
				guard,
				"scripts/release.ts",
				version,
				"--target=github",
				"--dry-run",
				"--skip-build",
				"--platform=linux-x64",
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: { ...process.env, HOME: home, NF_UPDATE_TOKEN: "" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = `${result.stdout.toString()}${result.stderr.toString()}`;
		expect(output).not.toContain("FORBIDDEN_");
		// An author's checkout directory may be named ci-baseline. Only diagnostics,
		// not the project-path prefix, can indicate an attempted legacy baseline query.
		const diagnostics = output.replaceAll(join(import.meta.dir, "../.."), "<project>");
		expect(diagnostics).not.toContain("baseline");
		expect(output).toMatch(/GitHub release failed|Dry run complete/);
	});

	test("preserves stable rule and bilingual body", () => {
		expect(releaseChannel("1.2.0")).toBe("stable");
		for (const version of ["1.2.1", "1.2.0-beta.1", "1.2.0-fix1"])
			expect(releaseChannel(version)).toBe("beta");
		expect(githubReleaseBody(changelog)).toContain("## 简体中文");
		expect(DEFAULT_GITHUB_REPOSITORY).toBe("NarraFork/NarraFork");
		expect(GH_TIMEOUT_MS).toBeGreaterThan(0);
		expect(GH_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(1024 * 1024);
		validateGitHubRepository(DEFAULT_GITHUB_REPOSITORY);
	});

	test("GitHub CLI dry-run bypasses update token/config/baseline, and legacy default keeps token gate", () => {
		const home = mkdtempSync(join(tmpdir(), "narrafork-release-home-"));
		roots.push(home);
		mkdirSync(join(home, ".narrafork"));
		// Reading this directory as the token configuration would fail; no legacy token is available.
		mkdirSync(join(home, ".narrafork", "update-server.json"));
		const currentVersion = JSON.parse(
			readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
		).version;
		const env = {
			...process.env,
			HOME: home,
			NF_UPDATE_TOKEN: "",
			NF_UPDATE_SERVER: "http://127.0.0.1:1",
		};
		const args = [
			"bun",
			"scripts/release.ts",
			currentVersion,
			"--upload-only",
			"--platform=unknown",
		];
		const github = Bun.spawnSync([...args, "--target=github", "--dry-run"], {
			cwd: join(import.meta.dir, "../.."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${github.stdout.toString()}${github.stderr.toString()}`;
		expect(github.exitCode).not.toBe(0);
		expect(output).toContain("No valid release platforms selected");
		expect(output).not.toContain("Update server token not found");
		expect(output).not.toContain("baseline verification");
		const legacy = Bun.spawnSync(args, {
			cwd: join(import.meta.dir, "../.."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(legacy.stderr.toString()).toContain("Update server token not found");
	});
});
