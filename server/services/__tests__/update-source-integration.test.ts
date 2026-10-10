import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GithubPatchStep } from "../../../shared/release-patch";
import { settings } from "../../lib/settings";
import { APP_VERSION } from "../../lib/version";
import { githubReleaseUpdater } from "../github-release-update";
import { resetUpdateCoordinationForTests, scheduleUpdate } from "../update-coordinator";
import {
	checkForUpdate,
	downloadUpdate,
	getCurrentUpdateSourceIdentity,
	getUpdateDirectory,
	getUpdateNotes,
	getUpdateStatus,
	isUpdateSourceCurrent,
	type ReleaseInfo,
	type UpdateProgress,
} from "../update-service";

const originalFetch = globalThis.fetch;
let requested: string[] = [];
let requestOptions: (RequestInit & { proxy?: string })[] = [];
const originalProxy = structuredClone(settings.proxy);
const originalUpdate = structuredClone(settings.update);
const version = `${Number(APP_VERSION.split(".")[0]) + 1}.0.0`;
const payload = Buffer.from("integration test binary (never executed)");
const sha512 = createHash("sha512").update(payload).digest("base64");
const platform =
	process.platform === "darwin"
		? `darwin-${process.arch}`
		: process.platform === "win32"
			? `win-${process.arch}`
			: `linux-${process.arch}`;
const suffix =
	platform.replace("darwin-", "macos-").replace("win-", "windows-") +
	(process.platform === "win32" ? ".exe" : "");
const filename = `narrafork-${version}-${suffix}`;
const repository = "Integration/Updates";
const binaryUrl = `https://github.com/${repository}/releases/download/v${version}/${filename}`;
const sidecarUrl = `${binaryUrl}.metadata.json`;
const metadata = JSON.stringify({
	version,
	platform,
	name: filename,
	size: payload.length,
	sha512,
	sha256: createHash("sha256").update(payload).digest("hex"),
});
const release = {
	tag_name: `v${version}`,
	draft: false,
	prerelease: false,
	published_at: "2026-10-06T00:00:00Z",
	body: "integration notes",
	assets: [
		{ name: filename, size: payload.length, state: "uploaded", browser_download_url: binaryUrl },
		{
			name: `${filename}.metadata.json`,
			size: Buffer.byteLength(metadata),
			state: "uploaded",
			browser_download_url: sidecarUrl,
		},
	],
};

function fixtureReleaseInfo(patchChain?: GithubPatchStep[]): ReleaseInfo {
	return {
		source: "github",
		sourceIdentity: getCurrentUpdateSourceIdentity() ?? undefined,
		repository,
		version,
		path: filename,
		releaseDate: "2026-10-06",
		sha512,
		files: [{ url: filename, size: payload.length, sha512 }],
		_github: { repository, downloadUrl: binaryUrl, patchChain },
	};
}
function selectGithub() {
	settings.update = {
		...settings.update,
		source: "github",
		githubRepository: repository,
		serverUrl: "https://legacy.integration.example",
		product: "narrafork",
		channel: "stable",
		checkIntervalMinutes: 60,
		autoDownload: false,
	};
	return settings.update;
}
function expectNoTemporaryArtifacts() {
	expect(
		readdirSync(getUpdateDirectory()).filter(
			(name) => name.endsWith(".tmp") || name.startsWith(".github-patch-"),
		),
	).toEqual([]);
}

function installFetch(handler: (url: string) => Response | Promise<Response>) {
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof fetch>) => {
			const url = String(args[0]);
			requested.push(url);
			requestOptions.push(args[1] ?? {});
			// Legacy fixtures explicitly advertise that the new metadata branch is absent.
			if (url.startsWith("https://raw.githubusercontent.com/"))
				return new Response(null, { status: 404 });
			return handler(url);
		},
		{ preconnect: originalFetch.preconnect },
	);
}
beforeEach(() => {
	requested = [];
	requestOptions = [];
	resetUpdateCoordinationForTests();
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	settings.proxy = structuredClone(originalProxy);
	settings.update = structuredClone(originalUpdate);
	resetUpdateCoordinationForTests();
});

describe("release notes source snapshots", () => {
	test("mismatched old prepared source makes no notes request", async () => {
		selectGithub();
		const sourceIdentity = getCurrentUpdateSourceIdentity();
		if (!sourceIdentity || sourceIdentity.source !== "github") throw new Error("Expected GitHub");
		await expect(
			getUpdateNotes({
				version,
				sha512,
				sourceIdentity: { ...sourceIdentity, repository: "old/repo" },
			}),
		).rejects.toThrow("source changed");
		expect(requested).toHaveLength(0);
	});
	test.each([
		"repository",
		"channel",
		"source",
	])("a %s change during notes read discards the result", async (field) => {
		const update = selectGithub();
		const sourceIdentity = getCurrentUpdateSourceIdentity();
		if (!sourceIdentity) throw new Error("Expected source");
		const original = githubReleaseUpdater.getNotes;
		try {
			githubReleaseUpdater.getNotes = async () => {
				if (field === "repository") update.githubRepository = "changed/repo";
				else if (field === "channel") update.channel = "beta";
				else update.source = "update-server";
				return { notes: "Must never reach the old artifact" };
			};
			await expect(getUpdateNotes({ version, sha512, sourceIdentity })).rejects.toThrow(
				"source changed",
			);
		} finally {
			githubReleaseUpdater.getNotes = original;
		}
	});
});

describe("selected update source integration", () => {
	test.each([
		undefined,
		{ mode: "default" as const },
	])("legacy update detection inherits global proxy with override %j and proxy edits preserve provenance", async (proxy) => {
		const serverUrl = "https://updates.proxy-fixture.example";
		settings.proxy = { mode: "custom", url: "http://global.proxy-fixture.example:8080" };
		settings.update = {
			source: "update-server",
			serverUrl,
			product: "private-product",
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
			proxy,
		};
		const identity = getCurrentUpdateSourceIdentity();
		installFetch((url) => {
			expect(url).toContain(`${serverUrl}/api/v2/products/private-product/releases/latest`);
			return Response.json({
				updateAvailable: true,
				version,
				releaseDate: "2026-10-06",
				file: { filename, size: payload.length, sha512 },
			});
		});
		const checked = await checkForUpdate({ force: true });
		expect(checked.releaseInfo?.sourceIdentity).toEqual(identity ?? undefined);
		expect(requestOptions[0]?.proxy).toBe("http://global.proxy-fixture.example:8080/");
		if (!checked.releaseInfo) throw new Error("Expected legacy update descriptor");
		settings.update.proxy = { mode: "custom", url: "http://dedicated.proxy-fixture.example:3128" };
		const after = await checkForUpdate({ force: true });
		expect(requestOptions[1]?.proxy).toBe("http://dedicated.proxy-fixture.example:3128/");
		expect(after.releaseInfo?.sourceIdentity).toEqual(identity ?? undefined);
		expect(getCurrentUpdateSourceIdentity()).toEqual(identity);
		expect(isUpdateSourceCurrent(checked.releaseInfo)).toBe(true);
		expect(requested.every((url) => url.startsWith(serverUrl))).toBe(true);
	});

	test("beta-to-stable change during forced GitHub detection refuses the captured result", async () => {
		const update = selectGithub();
		update.channel = "beta";
		installFetch((url) => {
			if (url.startsWith(`https://api.github.com/repos/${repository}/`)) {
				update.channel = "stable";
				return Response.json([{ ...release, prerelease: true }]);
			}
			if (url === sidecarUrl) return new Response(metadata);
			throw new Error(`Unexpected payload download after settings change: ${url}`);
		});
		const checked = await checkForUpdate({ force: true });
		if (!checked.releaseInfo) throw new Error("Missing checked beta release");
		expect(isUpdateSourceCurrent(checked.releaseInfo)).toBe(false);
		const before = [...requested];
		expect((await downloadUpdate(checked.releaseInfo)).success).toBe(false);
		expect(requested).toEqual(before);
	});

	test.each([
		"product",
		"channel",
	] as const)("legacy %s change during detection refuses the captured result", async (field) => {
		const serverUrl = "https://updates.integration.example";
		settings.update = {
			...settings.update,
			source: "update-server",
			serverUrl,
			product: "first",
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
		};
		const update = settings.update;
		installFetch((url) => {
			expect(url).toContain(`${serverUrl}/api/v2/products/first/releases/latest`);
			if (field === "product") update.product = "second";
			else update.channel = "beta";
			return Response.json({
				updateAvailable: true,
				version,
				releaseDate: "2026-10-06",
				file: { filename, size: payload.length, sha512 },
			});
		});
		const checked = await checkForUpdate({ force: true });
		if (!checked.releaseInfo) throw new Error("Missing checked legacy release");
		expect(isUpdateSourceCurrent(checked.releaseInfo)).toBe(false);
		const before = [...requested];
		expect((await downloadUpdate(checked.releaseInfo)).success).toBe(false);
		expect(requested).toEqual(before);
	});
	test("GitHub prepares a verified full binary without contacting update-server or helpers", async () => {
		settings.update = {
			...settings.update,
			source: "github",
			githubRepository: repository,
			serverUrl: "http://untrusted.example",
			product: "narrafork",
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
		};
		installFetch((url) => {
			if (url.startsWith(`https://api.github.com/repos/${repository}/`))
				return Response.json([release]);
			if (url === sidecarUrl) return new Response(metadata);
			if (url === binaryUrl) return new Response(payload);
			throw new Error(`Unexpected origin ${url}`);
		});
		const result = await checkForUpdate({ force: true });
		expect(result.updateAvailable).toBe(true);
		expect(result.source).toBe("github");
		if (!result.releaseInfo) throw new Error("Missing trusted releaseInfo");
		const progress: UpdateProgress[] = [];
		const downloaded = await downloadUpdate(result.releaseInfo, (value) => {
			progress.push(value);
		});
		expect(downloaded.success).toBe(true);
		expect(progress.every((value) => value.strategy === "full" && value.fallback === false)).toBe(
			true,
		);
		expect(progress.at(-1)?.phase).toBe("complete");
		if (!downloaded.updatePath) throw new Error("No prepared binary");
		expect(readFileSync(downloaded.updatePath)).toEqual(payload);
		expect((await getUpdateStatus(version)).ready).toBe(true);
		expect(requested).toHaveLength(4);
		expect(requested.some((url) => url.includes("/api/v2/"))).toBe(false);
	});
	test("GitHub delta without a compiled base falls back to GitHub full, ignoring legacy descriptors", async () => {
		selectGithub();
		const patchUrl = `${binaryUrl}.zstd-patch`;
		const info = fixtureReleaseInfo([
			{
				fromVersion: APP_VERSION,
				toVersion: version,
				patchSize: 4,
				url: patchUrl,
				metaUrl: `${patchUrl}.meta.json`,
				meta: {
					fromVersion: APP_VERSION,
					toVersion: version,
					oldFileSize: payload.length,
					oldFileSha512: sha512,
					stableEnd: 0,
					newTailSize: payload.length,
					patchSize: 4,
					newFileSize: payload.length,
					newFileSha512: sha512,
					mode: "patch-from",
				},
			},
		]);
		info._v2 = {
			serverUrl: "https://legacy.integration.example",
			patchChain: [
				{
					fromVersion: APP_VERSION,
					toVersion: version,
					patchSize: 4,
					url: "https://legacy.integration.example/patch",
					metaUrl: "https://legacy.integration.example/meta",
				},
			],
		};
		installFetch((url) => {
			expect(url).toBe(binaryUrl);
			return new Response(payload);
		});
		const progress: UpdateProgress[] = [];
		const downloaded = await downloadUpdate(info, (value) => {
			progress.push(value);
		});
		expect(downloaded.success).toBe(true);
		expect(progress[0]?.strategy).toBe("zstd");
		expect(progress[0]?.fallback).toBe(false);
		const fallbackIndex = progress.findIndex(
			(value) => value.strategy === "full" && value.fallback === true,
		);
		expect(fallbackIndex).toBeGreaterThan(0);
		expect(
			progress
				.slice(fallbackIndex)
				.every((value) => value.strategy === "full" && value.fallback === true),
		).toBe(true);
		expect(progress.at(-1)).toMatchObject({
			phase: "complete",
			strategy: "full",
			fallback: true,
			bytesDownloaded: payload.length,
			totalBytes: payload.length,
		});
		expect(requested).toEqual([binaryUrl]);
		expectNoTemporaryArtifacts();
	});
	test("GitHub cancellation during full body progress preserves placed state and removes owned temp", async () => {
		selectGithub();
		const manifest = join(getUpdateDirectory(), "placed-update.json");
		const before = existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined;
		const controller = new AbortController();
		const progress: UpdateProgress[] = [];
		installFetch((url) => {
			expect(url).toBe(binaryUrl);
			return new Response(payload);
		});
		const downloaded = await downloadUpdate(
			fixtureReleaseInfo(),
			(value) => {
				progress.push(value);
				if (value.phase === "downloading" && value.bytesDownloaded > 0) {
					controller.abort(new Error("integration user cancellation"));
				}
			},
			{ signal: controller.signal },
		);
		expect(downloaded.success).toBe(false);
		expect(downloaded.error).toContain("integration user cancellation");
		expect(progress.at(-1)?.phase).toBe("error");
		expect(requested).toEqual([binaryUrl]);
		expect(existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined).toBe(before);
		expectNoTemporaryArtifacts();
	});
	test("GitHub bad full checksum cleans temp and does not ask a legacy origin", async () => {
		selectGithub();
		installFetch((url) => {
			expect(url).toBe(binaryUrl);
			return new Response(Buffer.alloc(payload.length, 42));
		});
		const downloaded = await downloadUpdate(fixtureReleaseInfo());
		expect(downloaded.success).toBe(false);
		expect(requested).toEqual([binaryUrl]);
		expectNoTemporaryArtifacts();
	});
	test("pre-aborted GitHub update never opens any origin", async () => {
		selectGithub();
		installFetch(() => {
			throw new Error("must not fetch after cancellation");
		});
		const controller = new AbortController();
		controller.abort(new Error("cancel before update"));
		const downloaded = await downloadUpdate(fixtureReleaseInfo(), undefined, {
			signal: controller.signal,
		});
		expect(downloaded.success).toBe(false);
		expect(downloaded.error).toContain("cancel before update");
		expect(requested).toEqual([]);
		expectNoTemporaryArtifacts();
	});
	test("self-deployed v2 source retains patch descriptors and never calls GitHub", async () => {
		const serverUrl = "https://updates.integration.example";
		settings.update = {
			...settings.update,
			source: "update-server",
			serverUrl,
			product: "custom-product",
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
		};
		installFetch((url) => {
			expect(url).toContain(`${serverUrl}/api/v2/products/custom-product/releases/latest`);
			return Response.json({
				updateAvailable: true,
				version,
				releaseDate: "2026-10-06",
				file: { filename, size: payload.length, sha512 },
				zstdPatch: {
					fromVersion: APP_VERSION,
					patchSize: 4,
					url: "/patch",
					metaUrl: "/patch.meta.json",
				},
			});
		});
		const result = await checkForUpdate();
		expect(result.source).toBe("update-server");
		expect(result.strategy).toBe("zstd");
		expect(result.releaseInfo?._v2?.zstdPatchUrl).toBe(`${serverUrl}/patch`);
		expect(result.releaseInfo?._v2?.serverUrl).toBe(serverUrl);
		expect(requested.some((url) => url.includes("github"))).toBe(false);
		if (!result.releaseInfo) throw new Error("Missing v2 releaseInfo");
		expect(isUpdateSourceCurrent(result.releaseInfo)).toBe(true);
		settings.update.serverUrl = "https://other.integration.example";
		expect(isUpdateSourceCurrent(result.releaseInfo)).toBe(false);
	});
	test.each([
		"source-policy",
		"scheduled",
	] as const)("a %s change during payload transfer cannot replace the prepared artifact", async (change) => {
		const update = selectGithub();
		installFetch(() => new Response(payload));
		const initial = await downloadUpdate(fixtureReleaseInfo());
		expect(initial.success).toBe(true);
		if (!initial.preparedIdentity) throw new Error("Missing original prepared selector");
		const manifest = join(getUpdateDirectory(), "placed-update.json");
		const originalMetadata = readFileSync(manifest, "utf8");
		let changed = false;
		const next = await downloadUpdate(fixtureReleaseInfo(), (progress) => {
			if (!changed && progress.phase === "downloading" && progress.bytesDownloaded > 0) {
				changed = true;
				if (change === "source-policy") update.channel = "beta";
				else scheduleUpdate(version);
			}
		});
		expect(changed).toBe(true);
		expect(next.success).toBe(false);
		expect(readFileSync(manifest, "utf8")).toBe(originalMetadata);
		expect((await getUpdateStatus(version)).preparedIdentity?.id).toBe(initial.preparedIdentity.id);
		expect(readFileSync(initial.updatePath as string)).toEqual(payload);
		expectNoTemporaryArtifacts();
	});
	test("failed GitHub checks never fall back to the configured legacy server", async () => {
		settings.update = {
			...settings.update,
			source: "github",
			githubRepository: repository,
			serverUrl: "https://legacy.integration.example",
			product: "narrafork",
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
		};
		installFetch(() => new Response(null, { status: 404 }));
		const result = await checkForUpdate({ force: true });
		expect(result.errorCode).toBe("REPOSITORY_UNAVAILABLE");
		expect(requested).toHaveLength(2);
		expect(requested[0]).toContain("raw.githubusercontent.com");
		expect(requested[1]).toContain("api.github.com");
	});
});
