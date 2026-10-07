import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type GithubPatchStep,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
} from "../../../shared/release-patch";
import {
	compareReleaseVersions,
	downloadGithubBinaryToFile,
	downloadGithubPatchToFile,
	fetchGithubAsset,
	type GithubFetch,
	GithubReleaseUpdater,
	validateGithubAssetUrl,
} from "../github-release-update";
import type { ReleaseInfo } from "../update-service";

const repository = "Example/NarraFork";
const input = {
	repository,
	channel: "stable" as const,
	platform: "linux-x64",
	currentVersion: "1.0.0",
};
const payload = Buffer.from("small test executable");
const digest = createHash("sha512").update(payload).digest("base64");
const assetUrl = (version: string, name: string) =>
	`https://github.com/${repository}/releases/download/v${version}/${name}`;
function fixture(version = "2.0.0", suffix = "linux-x64", platform = suffix, prerelease = false) {
	const name = `narrafork-${version}-${suffix}`;
	const metadata = JSON.stringify({
		name,
		version,
		platform,
		size: payload.length,
		sha512: digest,
		sha256: createHash("sha256").update(payload).digest("hex"),
	});
	return {
		release: {
			tag_name: `v${version}`,
			draft: false,
			prerelease,
			published_at: "2026-10-06T00:00:00Z",
			body: "更新说明 / Release notes",
			assets: [
				{
					name,
					size: payload.length,
					state: "uploaded",
					browser_download_url: assetUrl(version, name),
				},
				{
					name: `${name}.metadata.json`,
					size: Buffer.byteLength(metadata),
					state: "uploaded",
					browser_download_url: assetUrl(version, `${name}.metadata.json`),
				},
			],
		},
		metadata,
	};
}
const patchPayload = Buffer.from("patch");
function addPatch(
	item: ReturnType<typeof fixture>,
	fromVersion = "1.0.0",
	options: {
		defaultName?: boolean;
		size?: number;
		oldSize?: number;
		newSize?: number;
		mode?: GithubPatchStep["meta"]["mode"];
		oldHash?: string;
		newHash?: string;
	} = {},
): { step: GithubPatchStep; metadata: string } {
	const toVersion = item.release.tag_name.slice(1);
	const name = `${item.release.assets[0].name}${options.defaultName ? "" : `.from-${fromVersion}`}.zstd-patch`;
	const patchSize = options.size ?? patchPayload.length;
	const meta = {
		fromVersion,
		toVersion,
		oldFileSize: options.oldSize ?? payload.length,
		oldFileSha512: options.oldHash ?? digest,
		newFileSize: options.newSize ?? payload.length,
		newFileSha512: options.newHash ?? digest,
		stableEnd: 0,
		newTailSize: options.newSize ?? payload.length,
		patchSize,
		mode: options.mode,
	};
	const metadata = JSON.stringify(meta);
	const url = assetUrl(toVersion, name);
	const metaUrl = assetUrl(toVersion, `${name}.meta.json`);
	item.release.assets.push(
		{ name, size: patchSize, state: "uploaded", browser_download_url: url },
		{
			name: `${name}.meta.json`,
			size: Buffer.byteLength(metadata),
			state: "uploaded",
			browser_download_url: metaUrl,
		},
	);
	const sha256 = createHash("sha256").update(patchPayload).digest("hex");
	Object.assign(item.release.assets.at(-2) ?? {}, { digest: `sha256:${sha256}` });
	return { step: { fromVersion, toVersion, patchSize, url, metaUrl, sha256, meta }, metadata };
}
function patchGithub(
	items: ReturnType<typeof fixture>[],
	patches: ReturnType<typeof addPatch>[],
	budgets: ConstructorParameters<typeof GithubReleaseUpdater>[2] = {},
) {
	const calls: string[] = [];
	const fetcher: GithubFetch = async (url) => {
		calls.push(url);
		if (url.startsWith("https://api.github.com/"))
			return Response.json(items.map((item) => item.release));
		const patch = patches.find((item) => item.step.metaUrl === url);
		if (patch) return new Response(patch.metadata);
		const full = items.find((item) => item.release.assets[1]?.browser_download_url === url);
		if (full) return new Response(full.metadata);
		throw new Error(`Unexpected fetch: ${url}`);
	};
	return { updater: new GithubReleaseUpdater(fetcher, Date.now, budgets), calls, fetcher };
}
function mockGithub(fixtures: ReturnType<typeof fixture>[]) {
	const calls: string[] = [];
	const fetcher: GithubFetch = async (url) => {
		calls.push(url);
		if (url.startsWith("https://api.github.com/"))
			return Response.json(fixtures.map((f) => f.release));
		const selected = fixtures.find((f) => f.release.assets[1]?.browser_download_url === url);
		if (!selected) throw new Error(`Unexpected fetch: ${url}`);
		return new Response(selected.metadata);
	};
	return { updater: new GithubReleaseUpdater(fetcher), calls };
}
const fixtureDirectory = join(import.meta.dir, `.github-download-fixture-${process.pid}`);
afterEach(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
function downloadPath() {
	mkdirSync(fixtureDirectory, { recursive: true });
	return join(fixtureDirectory, "binary.tmp");
}
function descriptor(): ReleaseInfo {
	const name = "narrafork-2.0.0-linux-x64";
	return {
		source: "github",
		repository,
		version: "2.0.0",
		releaseDate: "2026-10-06",
		path: name,
		sha512: digest,
		files: [{ url: name, size: payload.length, sha512: digest }],
		_github: { repository, downloadUrl: assetUrl("2.0.0", name) },
	};
}

describe("GitHub release selection", () => {
	test("selects semantic version, not API order or timestamp; keeps bilingual notes and full strategy", async () => {
		const { updater } = mockGithub([fixture("1.1.0"), fixture("2.0.0")]);
		const result = await updater.check(input);
		expect(result.updateAvailable).toBe(true);
		expect(result.latestVersion).toBe("2.0.0");
		expect(result.strategy).toBe("full");
		expect(result.releaseInfo?.source).toBe("github");
		expect(result.releaseInfo?.sha512).toBe(digest);
		expect(result.releaseInfo?.releaseNotes).toContain("更新说明");
	});
	test("stable ignores prereleases, drafts and executor/helper tags", async () => {
		const beta = fixture("3.0.1", "linux-x64", "linux-x64", true);
		const draft = fixture("4.0.0");
		draft.release.draft = true;
		const tool = fixture("5.0.0");
		tool.release.tag_name = "executor-v5.0.0";
		const { updater } = mockGithub([beta, draft, tool, fixture()]);
		expect((await updater.check(input)).latestVersion).toBe("2.0.0");
	});
	test("beta considers stable and numeric prerelease precedence", async () => {
		const { updater } = mockGithub([
			fixture("2.0.0-beta.9", "linux-x64", "linux-x64", true),
			fixture("2.0.0-beta.10", "linux-x64", "linux-x64", true),
			fixture("2.0.0"),
		]);
		expect((await updater.check({ ...input, channel: "beta" })).latestVersion).toBe("2.0.0");
		const second = mockGithub([
			fixture("2.0.0-beta.9", "linux-x64", "linux-x64", true),
			fixture("2.0.0-beta.10", "linux-x64", "linux-x64", true),
		]);
		expect((await second.updater.check({ ...input, channel: "beta" })).latestVersion).toBe(
			"2.0.0-beta.10",
		);
	});
	for (const [platform, suffix] of Object.entries({
		"darwin-arm64": "macos-arm64",
		"darwin-x64": "macos-x64",
		"linux-x64": "linux-x64",
		"linux-x64-baseline": "linux-x64-baseline",
		"linux-arm64": "linux-arm64",
		"win-x64": "windows-x64.exe",
		"win-x64-baseline": "windows-x64-baseline.exe",
		"win-arm64": "windows-arm64.exe",
	})) {
		test(`matches exact build platform ${platform}`, async () => {
			const { updater } = mockGithub([fixture("2.0.0", suffix, platform)]);
			expect((await updater.check({ ...input, platform })).releaseInfo?.path).toBe(
				`narrafork-2.0.0-${suffix}`,
			);
		});
	}
	test("no releases is distinguished from an up-to-date executable", async () => {
		expect((await mockGithub([]).updater.check(input)).errorCode).toBe("NO_RELEASE");
		const result = await mockGithub([fixture()]).updater.check({
			...input,
			currentVersion: "2.0.0",
		});
		expect(result.updateAvailable).toBe(false);
		expect(result.errorCode).toBeUndefined();
	});
	test("missing platform is explicit; no cross-platform fallback", async () => {
		expect(
			(await mockGithub([fixture()]).updater.check({ ...input, platform: "win-arm64" })).errorCode,
		).toBe("PLATFORM_UNAVAILABLE");
	});
	test("missing latest sidecar is an error, not a silent downgrade", async () => {
		const latest = fixture("3.0.0");
		latest.release.assets.pop();
		expect((await mockGithub([latest, fixture()]).updater.check(input)).errorCode).toBe(
			"INVALID_METADATA",
		);
	});
	test("an old malformed sidecar does not block a valid latest release", async () => {
		const old = fixture("1.0.0");
		old.release.assets.pop();
		expect((await mockGithub([old, fixture()]).updater.check(input)).latestVersion).toBe("2.0.0");
	});
	for (const change of [
		{ version: "9.0.0" },
		{ platform: "win-x64" },
		{ name: "different-file" },
		{ sha512: "not-a-digest" },
		{ sha256: "0" },
		{ size: 0 },
	]) {
		test(`rejects mismatched sidecar ${Object.keys(change)[0]}`, async () => {
			const item = fixture();
			item.metadata = JSON.stringify({ ...JSON.parse(item.metadata), ...change });
			item.release.assets[1].size = Buffer.byteLength(item.metadata);
			expect((await mockGithub([item]).updater.check(input)).errorCode).toBe("INVALID_METADATA");
		});
	}
	test("rejects cross-repository URLs from release assets", async () => {
		const item = fixture();
		item.release.assets[0].browser_download_url = "https://evil.example/payload";
		expect((await mockGithub([item]).updater.check(input)).errorCode).toBe("INVALID_METADATA");
	});
	test("repository and JSON size are bounded", async () => {
		const calls: string[] = [];
		const updater = new GithubReleaseUpdater(async (url) => {
			calls.push(url);
			return new Response("x".repeat(2 * 1024 * 1024 + 1));
		});
		expect(
			(await updater.check({ ...input, repository: "https://evil.example/repo" })).errorCode,
		).toBe("INVALID_CONFIGURATION");
		expect(calls.length).toBe(0);
		expect((await updater.check(input)).errorCode).toBe("INVALID_METADATA");
	});
	test("follows bounded release pagination but never an untrusted Link URL", async () => {
		const item = fixture();
		const calls: string[] = [];
		const updater = new GithubReleaseUpdater(async (url) => {
			calls.push(url);
			if (url.endsWith("page=1"))
				return Response.json([], { headers: { link: '<https://evil.example>; rel="next"' } });
			if (url.endsWith("page=2")) return Response.json([item.release]);
			return new Response(item.metadata);
		});
		expect((await updater.check(input)).latestVersion).toBe("2.0.0");
		expect(calls.some((url) => url.startsWith("https://evil"))).toBe(false);
	});
	test("page ceiling cannot falsely report that no update exists", async () => {
		let count = 0;
		const updater = new GithubReleaseUpdater(async () => {
			count++;
			return Response.json([], { headers: { link: '<next>; rel="next"' } });
		});
		expect((await updater.check(input)).errorCode).toBe("SCAN_LIMIT_REACHED");
		expect(count).toBe(5);
	});
});

describe("GitHub request cache and limits", () => {
	test("metadata response-body deadline is independent of header arrival", async () => {
		const updater = new GithubReleaseUpdater(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(Buffer.from("["));
						},
					}),
				),
			Date.now,
			{ requestTimeoutMs: 20, checkTimeoutMs: 100 },
		);
		expect((await updater.check(input)).errorCode).toBe("TIMEOUT");
	});
	test("metadata header deadline is enforced even for a hung request", async () => {
		const updater = new GithubReleaseUpdater(() => new Promise(() => {}), Date.now, {
			requestTimeoutMs: 20,
			checkTimeoutMs: 100,
		});
		expect((await updater.check(input)).errorCode).toBe("TIMEOUT");
	});
	test("shares concurrent checks and caches by source identity", async () => {
		const { updater, calls } = mockGithub([fixture()]);
		await Promise.all([updater.check(input), updater.check(input)]);
		expect(calls.length).toBe(2);
		await updater.check(input);
		expect(calls.length).toBe(2);
		await updater.check({ ...input, channel: "beta" });
		expect(calls.length).toBe(4);
	});
	test("forced checks use ETag but re-fetch sidecar metadata", async () => {
		const item = fixture();
		let listCalls = 0;
		let sidecarCalls = 0;
		const updater = new GithubReleaseUpdater(async (url, init) => {
			if (url.startsWith("https://api.github.com/")) {
				listCalls++;
				if (listCalls === 1)
					return Response.json([item.release], { headers: { etag: '"release-v1"' } });
				expect(new Headers(init?.headers).get("if-none-match")).toBe('"release-v1"');
				return new Response(null, { status: 304 });
			}
			sidecarCalls++;
			return new Response(item.metadata);
		});
		await updater.check(input);
		await updater.check(input, { force: true });
		expect(listCalls).toBe(2);
		expect(sidecarCalls).toBe(2);
	});
	test("rate limits cool down without waiting or making more outbound requests", async () => {
		let now = 100_000;
		let calls = 0;
		const updater = new GithubReleaseUpdater(
			async () => {
				calls++;
				return new Response(null, { status: 429, headers: { "retry-after": "120" } });
			},
			() => now,
		);
		expect((await updater.check(input)).retryAfter).toBe(120);
		now += 1000;
		expect((await updater.check(input, { force: true })).retryAfter).toBe(119);
		expect(calls).toBe(1);
	});
	for (const status of [401, 403, 404, 500]) {
		test(`HTTP ${status} is not mistaken for no update`, async () => {
			const updater = new GithubReleaseUpdater(async () => new Response(null, { status }));
			expect((await updater.check(input)).errorCode).toBe(
				status === 500 ? "NETWORK_ERROR" : "REPOSITORY_UNAVAILABLE",
			);
		});
	}
	test("uses rate-limit reset when the primary quota is exhausted", async () => {
		const updater = new GithubReleaseUpdater(
			async () =>
				new Response(null, {
					status: 403,
					headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "300" },
				}),
			() => 100_000,
		);
		expect((await updater.check(input)).retryAfter).toBe(200);
	});
});

describe("GitHub full binary download", () => {
	test("streams and verifies binary before preparation, follows official CDN", async () => {
		const path = downloadPath();
		let calls = 0;
		const progress: number[] = [];
		await downloadGithubBinaryToFile(descriptor(), path, {
			fetcher: async () => {
				calls++;
				return calls === 1
					? new Response(null, {
							status: 302,
							headers: {
								location:
									"https://release-assets.githubusercontent.com/assets/payload?signature=test",
							},
						})
					: new Response(payload, { headers: { "content-length": String(payload.length) } });
			},
			onProgress: (bytes) => {
				progress.push(bytes);
			},
		});
		expect(readFileSync(path)).toEqual(payload);
		expect(progress.at(-1)).toBe(payload.length);
	});
	test("rejects unknown-host and plaintext redirects before fetching them", async () => {
		for (const location of [
			"https://evil.example/binary",
			"http://github.com/binary",
			"https://github.com.evil.example/binary",
			"https://user:pass@github.com/binary",
		]) {
			let calls = 0;
			await expect(
				fetchGithubAsset(
					descriptor()._github?.downloadUrl ?? "",
					AbortSignal.timeout(1000),
					async () => {
						calls++;
						return new Response(null, { status: 302, headers: { location } });
					},
				),
			).rejects.toThrow("Untrusted");
			expect(calls).toBe(1);
		}
	});
	test("caps redirect loops", async () => {
		let calls = 0;
		await expect(
			fetchGithubAsset(
				descriptor()._github?.downloadUrl ?? "",
				AbortSignal.timeout(1000),
				async () => {
					calls++;
					return new Response(null, {
						status: 302,
						headers: { location: "https://github.com/loop" },
					});
				},
			),
		).rejects.toThrow("redirect limit");
		expect(calls).toBe(6);
	});
	for (const data of [
		Buffer.from("too small"),
		Buffer.alloc(payload.length + 1),
		Buffer.alloc(payload.length),
	]) {
		test(`bad size/digest ${data.length} cleans only its own temporary binary`, async () => {
			const path = downloadPath();
			await expect(
				downloadGithubBinaryToFile(descriptor(), path, { fetcher: async () => new Response(data) }),
			).rejects.toThrow();
			expect(existsSync(path)).toBe(false);
		});
	}
	test("an existing file is neither overwritten nor removed", async () => {
		const path = downloadPath();
		writeFileSync(path, "existing");
		await expect(
			downloadGithubBinaryToFile(descriptor(), path, {
				fetcher: async () => new Response(payload),
			}),
		).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("existing");
	});
	test("cancellation and body deadline are enforced after response headers", async () => {
		const path = downloadPath();
		await expect(
			downloadGithubBinaryToFile(descriptor(), path, {
				timeoutMs: 20,
				fetcher: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(payload.subarray(0, 1));
							},
						}),
					),
			}),
		).rejects.toThrow();
		expect(existsSync(path)).toBe(false);
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			downloadGithubBinaryToFile(descriptor(), path, {
				signal: controller.signal,
				fetcher: async () => {
					calls++;
					return new Response(payload);
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});
	test("an oversized or malicious descriptor never starts downloading", async () => {
		const invalid = descriptor();
		invalid.files[0].size = 1024 * 1024 * 1024 + 1;
		let calls = 0;
		await expect(
			downloadGithubBinaryToFile(invalid, downloadPath(), {
				fetcher: async () => {
					calls++;
					return new Response(payload);
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
		expect(() =>
			validateGithubAssetUrl("https://evil.example/binary", repository, "2.0.0", invalid.path),
		).toThrow();
	});
});

describe("GitHub release asset URL spelling", () => {
	test("raw and percent-encoded SemVer plus signs identify the same selected release", () => {
		const version = "2.0.0+ci.123";
		const name = `narrafork-${version}-linux-x64.from-1.0.0+ci.100.zstd-patch`;
		for (const url of [
			assetUrl(version, name),
			assetUrl(version, name).replaceAll("+", "%2B"),
			assetUrl(version, name).replaceAll("+", "%2b"),
		]) {
			expect(() => validateGithubAssetUrl(url, repository, version, name)).not.toThrow();
		}
	});
	test("extra path components and encoded slashes never become equivalent release identities", () => {
		const version = "2.0.0+ci.123";
		const name = `narrafork-${version}-linux-x64`;
		const url = assetUrl(version, name);
		for (const invalid of [
			url.replace(repository, "Example%2FNarraFork"),
			url.replace("/releases/download/", "/releases%2Fdownload/"),
			url.replace(`/v${version}/`, `/v${version}%2F/`),
			url.replace(name, `${name}%2Fpayload`),
			`${url}/payload`,
			url.replace("/releases/download/", "/releases/download/extra/"),
			url.replace(name, `${name}%252Fpayload`),
			url.replace(name, `${name}%ZZ`),
		])
			expect(() => validateGithubAssetUrl(invalid, repository, version, name)).toThrow();
		expect(() => validateGithubAssetUrl(url, repository, version, `${name}/payload`)).toThrow();
	});
	test("build metadata URLs remain valid through discovery and patch transport", async () => {
		for (const encoded of [false, true]) {
			const version = "2.0.0+ci.123";
			const currentVersion = "1.0.0+ci.100";
			const item = fixture(version);
			const patch = addPatch(item, currentVersion);
			if (encoded) {
				for (const asset of item.release.assets)
					asset.browser_download_url = asset.browser_download_url.replaceAll("+", "%2B");
				patch.step.url = patch.step.url.replaceAll("+", "%2B");
				patch.step.metaUrl = patch.step.metaUrl.replaceAll("+", "%2B");
			}
			const result = await patchGithub([item], [patch]).updater.check({ ...input, currentVersion });
			expect(result.strategy).toBe("zstd");
			expect(result.releaseInfo?._github?.patchChain).toEqual([patch.step]);
			const trusted = result.releaseInfo?._github?.patchChain?.[0];
			if (!trusted) throw new Error("Missing trusted build-metadata patch");
			const path = join(fixtureDirectory, `encoded-${encoded}.tmp`);
			mkdirSync(fixtureDirectory, { recursive: true });
			await downloadGithubPatchToFile(trusted, path, {
				fetcher: async () => new Response(patchPayload),
			});
			expect(readFileSync(path)).toEqual(patchPayload);
		}
	});
});

describe("GitHub optional release patches", () => {
	for (const mode of [undefined, "dictionary"] as const) {
		test(`large legacy ${mode ?? "implicit"} patch alone keeps full and cannot hide valid patch-from`, async () => {
			const item = fixture();
			const size = MAX_RELEASE_LEGACY_BYTES + 1;
			item.release.assets[0].size = size;
			item.metadata = JSON.stringify({ ...JSON.parse(item.metadata), size });
			item.release.assets[1].size = Buffer.byteLength(item.metadata);
			const legacy = addPatch(item, "1.0.0", {
				defaultName: true,
				size: 1,
				oldSize: size,
				newSize: size,
				mode,
			});
			const full = await patchGithub([item], [legacy]).updater.check(input);
			expect(full.updateAvailable).toBe(true);
			expect(full.strategy).toBe("full");
			expect(full.downloadSize).toBe(size);
			expect(full.errorCode).toBeUndefined();
			expect(full.releaseInfo?._github?.patchChain).toBeUndefined();
			const streaming = addPatch(item, "1.0.0", {
				size: 10,
				oldSize: size,
				newSize: size,
				mode: "patch-from",
			});
			const mixed = await patchGithub([item], [legacy, streaming]).updater.check(input);
			expect(mixed.strategy).toBe("zstd");
			expect(mixed.downloadSize).toBe(10);
			expect(mixed.releaseInfo?._github?.patchChain).toEqual([streaming.step]);
		});
	}
	for (const defaultName of [true, false]) {
		test(`direct ${defaultName ? "default" : "multibase"} patch carries trusted metadata and matching strategy fields`, async () => {
			const item = fixture();
			const patch = addPatch(item, "1.0.0", { defaultName });
			const result = await patchGithub([item], [patch]).updater.check(input);
			expect(result.updateAvailable).toBe(true);
			expect(result.strategy).toBe("zstd");
			expect(result.downloadSize).toBe(patchPayload.length);
			expect(result.totalSize).toBe(payload.length);
			expect(result.patchChain).toEqual([patch.step]);
			expect(result.releaseInfo?._github?.patchChain).toEqual([patch.step]);
			expect(result.releaseInfo?._github?.downloadUrl).toBe(descriptor()._github?.downloadUrl);
		});
	}
	test("cheaper chain beats direct patch, including stable via beta", async () => {
		const beta = fixture("2.0.0-beta.1", "linux-x64", "linux-x64", true);
		const target = fixture();
		const direct = addPatch(target, "1.0.0", { size: 15 });
		const first = addPatch(beta);
		const final = addPatch(target, "2.0.0-beta.1");
		const result = await patchGithub([target, beta], [direct, first, final]).updater.check(input);
		expect(result.latestVersion).toBe("2.0.0");
		expect(result.strategy).toBe("zstd");
		expect(result.downloadSize).toBe(10);
		expect(result.releaseInfo?._github?.patchChain).toEqual([first.step, final.step]);
	});
	test("exact baseline platform patch never substitutes optimized assets", async () => {
		const optimized = fixture();
		const baseline = fixture("2.0.0", "linux-x64-baseline");
		const wrong = addPatch(optimized);
		const right = addPatch(baseline);
		const result = await patchGithub([optimized, baseline], [wrong, right]).updater.check({
			...input,
			platform: "linux-x64-baseline",
		});
		expect(result.releaseInfo?._github?.patchChain).toEqual([right.step]);
	});
	for (const reason of [
		"final-hash",
		"base-hash",
		"size",
		"hint",
		"missing-meta",
		"missing-binary",
		"url",
		"digest",
		"json",
		"oversized-json",
		"expensive",
	]) {
		test(`bad optional patch ${reason} preserves verified full recommendation`, async () => {
			const middle = fixture("1.5.0");
			const target = fixture();
			const first = addPatch(middle);
			const final = addPatch(target, "1.5.0");
			if (reason === "final-hash") final.step.meta.newFileSha512 = `${"A".repeat(86)}==`;
			if (reason === "base-hash") final.step.meta.oldFileSha512 = `${"A".repeat(86)}==`;
			if (reason === "size") final.step.meta.patchSize++;
			if (reason === "hint") final.step.meta.fromVersion = "1.4.0";
			if (reason === "missing-meta") target.release.assets.pop();
			if (reason === "missing-binary") middle.release.assets.shift();
			if (reason === "url")
				target.release.assets[2].browser_download_url =
					"https://github.com/Other/Repo/releases/download/v2.0.0/patch";
			if (reason === "digest")
				Object.assign(target.release.assets[2], { digest: "sha256:not-a-digest" });
			if (reason === "expensive") final.step.meta.patchSize = payload.length;
			final.metadata = JSON.stringify(final.step.meta);
			if (reason === "json") final.metadata = "{";
			if (reason === "oversized-json") final.metadata = " ".repeat(64 * 1024 + 1);
			const metaAsset = target.release.assets.at(-1);
			if (metaAsset?.name.endsWith(".meta.json"))
				metaAsset.size = Buffer.byteLength(final.metadata);
			if (reason === "expensive") target.release.assets[2].size = payload.length;
			const result = await patchGithub([target, middle], [first, final]).updater.check(input);
			expect(result.updateAvailable).toBe(true);
			expect(result.strategy).toBe("full");
			expect(result.errorCode).toBeUndefined();
			expect(result.releaseInfo?._github?.patchChain).toBeUndefined();
		});
	}
	test("draft and helper releases cannot be patch intermediates", async () => {
		for (const kind of ["draft", "helper"]) {
			const middle = fixture("1.5.0");
			const first = addPatch(middle);
			if (kind === "draft") middle.release.draft = true;
			else middle.release.tag_name = "executor-v1.5.0";
			const target = fixture();
			const final = addPatch(target, "1.5.0");
			expect(
				(await patchGithub([target, middle], [first, final]).updater.check(input)).strategy,
			).toBe("full");
		}
	});
	test("patch probe body timeout and overall check deadline retain full update", async () => {
		for (const budgets of [
			{ patchTimeoutMs: 20, checkTimeoutMs: 1000 },
			{ patchTimeoutMs: 1000, checkTimeoutMs: 20 },
		]) {
			const item = fixture();
			const patch = addPatch(item);
			const { fetcher } = patchGithub([item], [patch]);
			const updater = new GithubReleaseUpdater(
				async (url, init) =>
					url === patch.step.metaUrl
						? new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(Buffer.from("{"));
									},
								}),
							)
						: fetcher(url, init),
				Date.now,
				budgets,
			);
			const result = await updater.check(input);
			expect(result.strategy).toBe("full");
			expect(result.updateAvailable).toBe(true);
			expect(result.errorCode).toBeUndefined();
		}
	});
	test("hung optional metadata headers cannot erase a verified full recommendation", async () => {
		const item = fixture();
		const patch = addPatch(item);
		const { fetcher } = patchGithub([item], [patch]);
		const updater = new GithubReleaseUpdater(
			(url, init) => (url === patch.step.metaUrl ? new Promise(() => {}) : fetcher(url, init)),
			Date.now,
			{ patchTimeoutMs: 20 },
		);
		const result = await updater.check(input);
		expect(result.strategy).toBe("full");
		expect(result.updateAvailable).toBe(true);
		expect(result.errorCode).toBeUndefined();
	});
	test("32 sidecars and four concurrent requests; direct current base takes priority", async () => {
		const target = fixture();
		const patches = Array.from({ length: 40 }, (_, i) => addPatch(target, `1.0.${39 - i}`));
		const { fetcher } = patchGithub([target], patches);
		let active = 0;
		let maximum = 0;
		const probes: string[] = [];
		const updater = new GithubReleaseUpdater(async (url, init) => {
			if (!url.endsWith(".meta.json")) return fetcher(url, init);
			probes.push(url);
			maximum = Math.max(maximum, ++active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return fetcher(url, init);
		});
		const result = await updater.check(input);
		expect(probes.length).toBe(32);
		expect(maximum).toBeLessThanOrEqual(4);
		const direct = patches.at(-1);
		if (!direct) throw new Error("Expected direct patch fixture");
		expect(probes[0]).toBe(direct.step.metaUrl);
		expect(result.releaseInfo?._github?.patchChain).toEqual([direct.step]);
	});
	test("patch metadata shares the release list/full sidecar 10MiB budget", async () => {
		const item = fixture();
		addPatch(item);
		let patchRequests = 0;
		const updater = new GithubReleaseUpdater(async (url) => {
			if (url.startsWith("https://api.github.com/")) {
				const page = Number(new URL(url).searchParams.get("page"));
				const json = JSON.stringify(page === 5 ? [item.release] : []);
				const size = 2 * 1024 * 1024 - (page === 5 ? Buffer.byteLength(item.metadata) + 10 : 0);
				return new Response(json + " ".repeat(size - Buffer.byteLength(json)), {
					headers: page < 5 ? { link: '<next>; rel="next"' } : {},
				});
			}
			if (url.endsWith(".meta.json")) patchRequests++;
			return new Response(item.metadata);
		});
		const result = await updater.check(input);
		expect(result.strategy).toBe("full");
		expect(result.updateAvailable).toBe(true);
		expect(patchRequests).toBe(0);
	});
});

describe("GitHub patch download transport", () => {
	const step = () => addPatch(fixture()).step;
	test("streams official CDN patch with SHA256 and progress", async () => {
		const path = downloadPath();
		const progress: number[] = [];
		let requests = 0;
		await downloadGithubPatchToFile(step(), path, {
			fetcher: async () =>
				++requests === 1
					? new Response(null, {
							status: 302,
							headers: {
								location: "https://release-assets.githubusercontent.com/patch?signature=test",
							},
						})
					: new Response(patchPayload, {
							headers: { "content-length": String(patchPayload.length) },
						}),
			onProgress: (bytes) => {
				progress.push(bytes);
			},
		});
		expect(readFileSync(path)).toEqual(patchPayload);
		expect(progress.at(-1)).toBe(patchPayload.length);
		expect(requests).toBe(2);
	});
	test("missing digest is compatible; exact size is still mandatory", async () => {
		const trusted = step();
		delete trusted.sha256;
		const path = downloadPath();
		await downloadGithubPatchToFile(trusted, path, {
			fetcher: async () => new Response(patchPayload),
		});
		expect(readFileSync(path)).toEqual(patchPayload);
	});
	for (const reason of ["size", "hash", "content-length", "http", "redirect"]) {
		test(`patch ${reason} failure removes only created file`, async () => {
			const path = downloadPath();
			const trusted = step();
			if (reason === "hash") trusted.sha256 = "0".repeat(64);
			await expect(
				downloadGithubPatchToFile(trusted, path, {
					fetcher: async () =>
						reason === "http"
							? new Response(null, { status: 500 })
							: reason === "redirect"
								? new Response(null, {
										status: 302,
										headers: { location: "https://evil.example/patch" },
									})
								: new Response(reason === "size" ? Buffer.alloc(1) : patchPayload, {
										headers: reason === "content-length" ? { "content-length": "999" } : {},
									}),
				}),
			).rejects.toThrow();
			expect(existsSync(path)).toBe(false);
		});
	}
	test("deadline covers hung cancellation and redirect bodies", async () => {
		for (const redirect of [false, true]) {
			const path = downloadPath();
			await expect(
				downloadGithubPatchToFile(step(), path, {
					timeoutMs: 20,
					fetcher: async () =>
						new Response(
							new ReadableStream({
								start(stream) {
									stream.enqueue(patchPayload.subarray(0, 1));
								},
								cancel() {
									return new Promise(() => {});
								},
							}),
							redirect
								? {
										status: 302,
										headers: { location: "https://release-assets.githubusercontent.com/patch" },
									}
								: {},
						),
				}),
			).rejects.toThrow();
			expect(existsSync(path)).toBe(false);
		}
	});
	test("external cancellation after headers removes the owned partial patch", async () => {
		const controller = new AbortController();
		const path = downloadPath();
		await expect(
			downloadGithubPatchToFile(step(), path, {
				signal: controller.signal,
				fetcher: async () =>
					new Response(
						new ReadableStream({
							start(stream) {
								stream.enqueue(patchPayload.subarray(0, 1));
							},
						}),
					),
				onProgress: () => controller.abort(new Error("cancelled by caller")),
			}),
		).rejects.toThrow("cancelled by caller");
		expect(existsSync(path)).toBe(false);
	});
	test("exclusive creation preserves existing file even when transport fails", async () => {
		const path = downloadPath();
		writeFileSync(path, "existing");
		await expect(
			downloadGithubPatchToFile(step(), path, { fetcher: async () => new Response(patchPayload) }),
		).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("existing");
	});
	for (const reason of ["url", "repo", "tag", "name", "hint", "meta", "oversize", "digest"]) {
		test(`untrusted descriptor ${reason} never fetches`, async () => {
			const trusted = step();
			if (reason === "url") trusted.url = "https://github.com/Owner/Repo/arbitrary";
			if (reason === "repo") trusted.metaUrl = trusted.metaUrl.replace(repository, "Other/Repo");
			if (reason === "tag") trusted.url = trusted.url.replace("/v2.0.0/", "/v9.0.0/");
			if (reason === "name") trusted.url = trusted.url.replace("linux-x64", "linux-unknown");
			if (reason === "hint") trusted.fromVersion = trusted.meta.fromVersion = "1.5.0";
			if (reason === "meta") trusted.meta.newTailSize++;
			if (reason === "oversize")
				trusted.patchSize = trusted.meta.patchSize = MAX_RELEASE_PATCH_BYTES + 1;
			if (reason === "digest") trusted.sha256 = "invalid";
			let calls = 0;
			await expect(
				downloadGithubPatchToFile(trusted, downloadPath(), {
					fetcher: async () => {
						calls++;
						return new Response(patchPayload);
					},
				}),
			).rejects.toThrow();
			expect(calls).toBe(0);
		});
	}
	test("cancel before fetch, body timeout and callback timeout all cleanly terminate", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			downloadGithubPatchToFile(step(), downloadPath(), {
				signal: controller.signal,
				fetcher: async () => {
					calls++;
					return new Response(patchPayload);
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
		for (const hungCallback of [false, true]) {
			const path = downloadPath();
			await expect(
				downloadGithubPatchToFile(step(), path, {
					timeoutMs: 20,
					onProgress: hungCallback ? () => new Promise(() => {}) : undefined,
					fetcher: async () =>
						hungCallback
							? new Response(patchPayload)
							: new Response(
									new ReadableStream({
										start(stream) {
											stream.enqueue(patchPayload.subarray(0, 1));
										},
									}),
								),
				}),
			).rejects.toThrow();
			expect(existsSync(path)).toBe(false);
		}
	});
});

test("SemVer precedence supports large numeric identifiers and rejects invalid numeric prereleases", () => {
	expect(compareReleaseVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBeGreaterThan(0);
	expect(
		compareReleaseVersions("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"),
	).toBeGreaterThan(0);
	expect(compareReleaseVersions("1.0.0", "1.0.0-beta.10")).toBeGreaterThan(0);
	expect(() => compareReleaseVersions("1.0.0-beta.01", "1.0.0")).toThrow();
});
