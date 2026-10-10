import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { HELPER_RELEASE_TAG } from "../../../shared/helper-distribution";
import type { GithubPatchStep } from "../../../shared/release-patch";
import type { DownloadHelperBinaryOptions, HelperBinarySpec } from "../../lib/helper-binaries";
import { distributionAssetUrl } from "../../lib/helper-distribution-runtime";
import { settings } from "../../lib/settings";
import { APP_VERSION } from "../../lib/version";
import type { GithubUpdateDependencies } from "../github-release-patch-apply";
import type { ReleaseInfo } from "../update-service";

// Only the pipeline seam and helper install are mocked. The actual service,
// frozen transport, download wrappers and source context remain in the path.
const { createGithubUpdateDeadline, downloadGithubUpdateToFile: realPipeline } = await import(
	"../github-release-patch-apply"
);
const helperExports = { ...(await import("../../lib/helper-binaries")) };
type PipelineOptions = Parameters<typeof realPipeline>[0];
type HelperCall = { spec: HelperBinarySpec; options: DownloadHelperBinaryOptions };
let helpers: HelperCall[] = [];
let seam:
	| ((
			options: PipelineOptions,
			dependencies: GithubUpdateDependencies,
	  ) => ReturnType<typeof realPipeline>)
	| undefined;
let helperMode: "ready" | "missing" | "cancel" = "ready";
let parent: AbortController;
let captured: PipelineOptions | undefined;
let dependenciesUsed: GithubUpdateDependencies | undefined;
let wireRequests: { url: string; init: RequestInit & { proxy?: string } }[] = [];
const repository = "fixture/helper-wiring";
const version = `${Number(APP_VERSION.split(".")[0]) + 8}.0.0`;
const payload = Buffer.from("verified mock application bytes; never executed");
const patchPayload = Buffer.from([1, 2]);
const sha512 = createHash("sha512").update(payload).digest("base64");
const originalFetch = globalThis.fetch;
const originalProxy = structuredClone(settings.proxy);
const originalUpdate = structuredClone(settings.update);

mock.module("../github-release-patch-apply", () => ({
	createGithubUpdateDeadline,
	downloadGithubUpdateToFile: async (
		options: PipelineOptions,
		dependencies: GithubUpdateDependencies,
	) => {
		captured = options;
		dependenciesUsed = dependencies;
		if (!seam) throw new Error("Pipeline test seam missing");
		return seam(options, dependencies);
	},
}));
mock.module("../../lib/helper-binaries", () => ({
	...helperExports,
	downloadHelperBinary: async (spec: HelperBinarySpec, options: DownloadHelperBinaryOptions) => {
		helpers.push({ spec, options });
		expect(options.signal).toBe(captured?.signal);
		expect(options.context?.source).toEqual({ source: "github", repository });
		if (!options.context || !options.signal) throw new Error("Helper context/signal was dropped");
		options.signal.throwIfAborted();
		if (helperMode === "cancel") {
			parent.abort(new Error("parent cancelled during helper preparation"));
			options.signal.throwIfAborted();
		}
		const response = await options.context.fetcher(
			distributionAssetUrl(options.context.source, HELPER_RELEASE_TAG, spec.toolName),
			{ signal: options.signal },
		);
		await response.arrayBuffer();
		return helperMode === "missing" ? null : "/mock/verified/zstd";
	},
}));
const { downloadUpdate, getCurrentUpdateSourceIdentity, getUpdateDirectory } = await import(
	"../update-service"
);
const { resetUpdateCoordinationForTests } = await import("../update-coordinator");
let whichSpy: ReturnType<typeof spyOn<typeof Bun, "which">>;
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
const updateDir = getUpdateDirectory();
const basePath = join(updateDir, "wiring-base.fixture");

function assertIsolatedDirectory() {
	const home = process.env.NARRAFORK_HOME;
	const child = home ? relative(home, updateDir) : "";
	if (
		process.env.NARRAFORK_TEST !== "1" ||
		!child ||
		isAbsolute(child) ||
		child === ".." ||
		child.startsWith(`..${sep}`)
	)
		throw new Error("Requires isolated test preload HOME");
}
function fixtureRelease(): ReleaseInfo {
	const suffix = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
	const path = `narrafork-${version}-${suffix}`;
	const url = `https://github.com/${repository}/releases/download/v${version}/${path}`;
	const step: GithubPatchStep = {
		fromVersion: APP_VERSION,
		toVersion: version,
		patchSize: patchPayload.length,
		url: `${url}.zstd-patch`,
		metaUrl: `${url}.zstd-patch.meta.json`,
		meta: {
			fromVersion: APP_VERSION,
			toVersion: version,
			oldFileSize: payload.length,
			oldFileSha512: sha512,
			stableEnd: 0,
			newTailSize: payload.length,
			patchSize: patchPayload.length,
			newFileSize: payload.length,
			newFileSha512: sha512,
			mode: "patch-from",
		},
	};
	return {
		source: "github",
		repository,
		sourceIdentity: getCurrentUpdateSourceIdentity() ?? undefined,
		version,
		path,
		releaseDate: "2026-10-09",
		sha512,
		files: [{ url: path, size: payload.length, sha512 }],
		_github: { repository, downloadUrl: url, patchChain: [step] },
	};
}

beforeEach(() => {
	assertIsolatedDirectory();
	resetUpdateCoordinationForTests();
	rmSync(updateDir, { recursive: true, force: true });
	mkdirSync(updateDir, { recursive: true });
	writeFileSync(basePath, payload);
	settings.proxy = { mode: "custom", url: "http://global.proxy-fixture.example:8080" };
	settings.update = {
		source: "github",
		githubRepository: repository,
		serverUrl: "https://must-not-use-legacy.example",
		product: "narrafork",
		channel: "stable",
		autoDownload: false,
		checkIntervalMinutes: 60,
		proxy: { mode: "custom", url: "http://user:secret@update.proxy-fixture.example:3128" },
	};
	helpers = [];
	captured = undefined;
	dependenciesUsed = undefined;
	wireRequests = [];
	helperMode = "ready";
	parent = new AbortController();
	whichSpy = spyOn(Bun, "which").mockReturnValue(null);
	spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("Real spawn forbidden in update wiring tests");
	});
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof fetch>) => {
			const url = String(args[0]);
			wireRequests.push({ url, init: args[1] ?? {} });
			if (!url.startsWith(`https://github.com/${repository}/releases/download/`))
				throw new Error("Unexpected source or real network call");
			return new Response(url.endsWith(".zstd-patch") ? patchPayload : payload);
		},
		{ preconnect: originalFetch.preconnect },
	);
});
afterEach(() => {
	expect(spawnSpy).not.toHaveBeenCalled();
	spawnSpy.mockRestore();
	whichSpy.mockRestore();
	globalThis.fetch = originalFetch;
	settings.proxy = structuredClone(originalProxy);
	settings.update = structuredClone(originalUpdate);
	resetUpdateCoordinationForTests();
	assertIsolatedDirectory();
	rmSync(updateDir, { recursive: true, force: true });
});
afterAll(() => mock.restore());

describe("main downloadUpdate helper/transport wiring", () => {
	test.each([
		false,
		true,
	])("missing PATH zstd uses one frozen GitHub helper context and proxy (force=%s)", async (forceDownload) => {
		const info = fixtureRelease();
		seam = async (options, dependencies) => {
			expect(options.currentVersion).toBe(APP_VERSION);
			expect(options.release.sourceIdentity).toEqual(info.sourceIdentity);
			expect(await dependencies.resolveZstd(options.signal)).toBe("/mock/verified/zstd");
			if (!settings.update) throw new Error("Missing update settings");
			settings.update.proxy = { mode: "direct" };
			expect(await dependencies.resolveZstd(options.signal)).toBe("/mock/verified/zstd");
			expect(helpers[1]?.options.context).toBe(helpers[0]?.options.context);
			expect(helpers[0]?.options.context?.isCurrent()).toBe(true);
			expect(helpers[0]?.options.context?.isTransportCurrent?.()).toBe(false);
			const patchPath = `${options.outputPath}.probe-patch`;
			try {
				await dependencies.downloadPatch(
					info._github?.patchChain?.[0] as GithubPatchStep,
					patchPath,
					{ signal: options.signal, timeoutMs: 2000 },
				);
				expect(readFileSync(patchPath)).toEqual(patchPayload);
			} finally {
				rmSync(patchPath, { force: true });
			}
			await dependencies.downloadFull(info, options.outputPath, {
				signal: options.signal,
				timeoutMs: 2000,
			});
			return "full";
		};
		const result = await downloadUpdate(info, undefined, { forceDownload, signal: parent.signal });
		expect(result.success).toBe(true);
		expect(helpers).toHaveLength(2);
		expect(
			helpers.every(
				({ spec, options }) => spec.tool === "zstd" && options.bypassFailureCache === forceDownload,
			),
		).toBe(true);
		expect(wireRequests).toHaveLength(4);
		expect(
			wireRequests.every(
				({ init }) => init.proxy === "http://user:secret@update.proxy-fixture.example:3128/",
			),
		).toBe(true);
		expect(wireRequests.every(({ init }) => init.signal && !init.signal.aborted)).toBe(true);
		expect(result.preparedIdentity?.sourceIdentity).toEqual(info.sourceIdentity ?? null);
		expect(JSON.stringify(result.preparedIdentity)).not.toContain("secret");
	});

	test("helper unavailability reaches real patch executor's same-GitHub full fallback", async () => {
		helperMode = "missing";
		seam = async (options, dependencies) => {
			// Dev builds have no compiled base: force lookup once, then supply only a
			// harmless fixture base to the real executor to exercise its fallback.
			expect(await dependencies.resolveZstd(options.signal)).toBeNull();
			return realPipeline({ ...options, basePath }, dependencies);
		};
		const result = await downloadUpdate(fixtureRelease(), undefined, { signal: parent.signal });
		expect(result.success).toBe(true);
		expect(helpers).toHaveLength(2);
		expect(
			wireRequests.every(({ url }) => url.startsWith(`https://github.com/${repository}/`)),
		).toBe(true);
		expect(wireRequests.some(({ url }) => url.endsWith(".zstd-patch"))).toBe(false);
		expect(wireRequests.at(-1)?.url).toBe(fixtureRelease()._github?.downloadUrl);
	});

	test("parent cancellation reaches helper's exact deadline signal and prevents any full request", async () => {
		helperMode = "cancel";
		seam = async (options, dependencies) => {
			await dependencies.resolveZstd(options.signal);
			throw new Error("Must not pass cancelled helper lookup");
		};
		const result = await downloadUpdate(fixtureRelease(), undefined, { signal: parent.signal });
		expect(result.success).toBe(false);
		expect(result.error).toContain("parent cancelled during helper preparation");
		expect(helpers).toHaveLength(1);
		expect(helpers[0]?.options.signal).toBe(captured?.signal);
		expect(captured?.signal.aborted).toBe(true);
		expect(helpers[0]?.options.context?.source.source).toBe("github");
		expect(dependenciesUsed?.downloadFull).toBeDefined();
		expect(wireRequests).toEqual([]);
	});
});
