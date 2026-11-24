import { describe, expect, mock, test } from "bun:test";
import {
	type PluginSource,
	type PluginUpdateErrorCode,
	type PluginWebsiteUpdateResponse,
	pluginSourceSchema,
} from "@shared/plugin-source";
import {
	assertPluginReleaseCompatible,
	comparePluginVersions,
	PluginSourceFailure,
	type PluginSourceResolverOptions,
	type PluginSourceTransport,
	readPluginSourceText,
	resolvePluginSourceRelease,
	sourceAllowsAutomaticUpdate,
	sourceDownloadPolicy,
} from "../plugin-source-resolvers";

const PLUGIN_ID = "io.example.plugin";
const SHA = "a".repeat(64);
const environment = { hostVersion: "0.9.14", hostApiVersion: "1.0", os: "win32", arch: "x64" };
const website = pluginSourceSchema.parse({
	type: "website",
	updateApi: "https://plugins.example/v1/latest",
	downloadOrigins: ["https://cdn.example/"],
});
const github = pluginSourceSchema.parse({
	type: "github",
	owner: "example",
	repo: "plugins",
	assetName: "plugin-{version}.nfplugin",
});
const feed = (
	overrides: Partial<NonNullable<PluginWebsiteUpdateResponse["latest"]>> = {},
): PluginWebsiteUpdateResponse => ({
	schemaVersion: 1,
	pluginId: PLUGIN_ID,
	latest: {
		version: "1.2.3",
		artifact: { url: "https://plugins.example/package.nfplugin", sha256: SHA, size: 1234 },
		compatibility: { hostApi: ">=1.0 <2", os: ["win32"], arch: ["x64"] },
		...overrides,
	},
});
const GITHUB_ASSET = {
	name: "plugin-1.2.3.nfplugin",
	size: 1234,
	digest: `sha256:${SHA}`,
	browser_download_url:
		"https://github.com/example/plugins/releases/download/v1.2.3/plugin-1.2.3.nfplugin",
};
const release = (overrides: Record<string, unknown> = {}) => ({
	draft: false,
	prerelease: false,
	tag_name: "v1.2.3",
	published_at: "2026-11-13T00:00:00Z",
	assets: [GITHUB_ASSET],
	...overrides,
});
function options(
	responses: Array<Response | (() => Promise<Response>)>,
): PluginSourceResolverOptions & { fetch: ReturnType<typeof mock> } {
	const fetch = mock(async (_url: string, _init?: RequestInit) => {
		const item = responses.shift();
		if (!item) throw new Error("Unexpected source request");
		return typeof item === "function" ? item() : item;
	});
	const transport: PluginSourceTransport = {
		isCurrent: () => true,
		fetch,
	};
	return {
		transport,
		signal: new AbortController().signal,
		environment,
		getBuiltin: () => undefined,
		fetch,
	};
}
async function failure(promise: Promise<unknown>, code: PluginUpdateErrorCode): Promise<void> {
	try {
		await promise;
		throw new Error("Expected failure");
	} catch (error) {
		expect(error).toBeInstanceOf(PluginSourceFailure);
		expect((error as PluginSourceFailure).code).toBe(code);
	}
}

describe("plugin source release resolution", () => {
	test("website uses strict DTO and public parameters without NF/provider authentication", async () => {
		const ctx = options([Response.json(feed())]);
		const resolved = await resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", website, ctx);
		expect(resolved).toMatchObject({ version: "1.2.3", sha256: SHA, size: 1234 });
		const call = ctx.fetch.mock.calls[0];
		if (!call) throw new Error("Expected a public request");
		const [url, init] = call;
		const query = new URL(url).searchParams;
		expect(Object.fromEntries(query)).toEqual({
			pluginId: PLUGIN_ID,
			currentVersion: "1.0.0",
			hostVersion: "0.9.14",
			hostApiVersion: "1.0",
			os: "win32",
			arch: "x64",
			channel: "stable",
		});
		expect(init).toMatchObject({ credentials: "omit", redirect: "manual", method: "GET" });
		expect(JSON.stringify(init)).not.toMatch(/Authorization|nug|Bearer|Cookie|nfs_/i);
	});

	test("website latest null stays absent and does not claim an update", async () => {
		expect(
			await resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				website,
				options([Response.json({ schemaVersion: 1, pluginId: PLUGIN_ID, latest: null })]),
			),
		).toBeNull();
	});

	test("website rejects wrong IDs, remote flags, bad hashes, size and prereleases", async () => {
		for (const dto of [
			{ ...feed(), pluginId: "io.wrong.plugin" },
			{ ...feed(), updateAvailable: true },
			feed({ artifact: { url: "https://plugins.example/p.nfplugin", sha256: "bad", size: 123 } }),
			feed({
				artifact: {
					url: "https://plugins.example/p.nfplugin",
					sha256: SHA,
					size: 100 * 1024 * 1024 + 1,
				},
			}),
			feed({ version: "v1.2.3" }),
			feed({ version: "1.2.3-rc.1" }),
		]) {
			await failure(
				resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", website, options([Response.json(dto)])),
				"pluginId" in dto && dto.pluginId !== PLUGIN_ID ? "identity_mismatch" : "invalid_release",
			);
		}
	});

	test("website rejects unapproved artifact origins, credentials and HTTPS downgrade", async () => {
		for (const url of [
			"https://evil.example/p.nfplugin",
			"http://plugins.example/p.nfplugin",
			"https://user:password@plugins.example/p.nfplugin",
		]) {
			await failure(
				resolvePluginSourceRelease(
					PLUGIN_ID,
					"1.0.0",
					website,
					options([Response.json(feed({ artifact: { url, sha256: SHA, size: 1 } }))]),
				),
				url.includes("user:") ? "invalid_release" : "unsafe_url",
			);
		}
	});

	test("only approved redirects are followed, never implicit fetch redirects", async () => {
		const redirected = options([
			new Response(null, { status: 302, headers: { Location: "https://evil.example/latest" } }),
		]);
		await failure(
			resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", website, redirected),
			"unsafe_url",
		);
		expect(redirected.fetch).toHaveBeenCalledTimes(1);
		const response = Response.json(feed());
		Object.defineProperty(response, "redirected", { value: true });
		await failure(
			resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", website, options([response])),
			"unsafe_url",
		);
	});

	test("GitHub stable release requires exact matching asset and verifiable digest", async () => {
		const ctx = options([Response.json(release())]);
		const result = await resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", github, ctx);
		expect(result).toMatchObject({ version: "1.2.3", sha256: SHA, size: 1234 });
		expect(ctx.fetch.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/repos/example/plugins/releases/latest",
		);
		await failure(
			resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				github,
				options([Response.json(release({ assets: [] }))]),
			),
			"invalid_release",
		);
		await failure(
			resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				github,
				options([Response.json(release({ tag_name: "release-latest" }))]),
			),
			"invalid_release",
		);
		await failure(
			resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				github,
				options([Response.json(release({ assets: [{ ...GITHUB_ASSET, digest: null }] }))]),
			),
			"manual_required",
		);
	});

	test("GitHub ignores drafts/prereleases and 404 without guessing a package", async () => {
		for (const flags of [{ draft: true }, { prerelease: true }])
			await failure(
				resolvePluginSourceRelease(
					PLUGIN_ID,
					"1.0.0",
					github,
					options([Response.json(release(flags))]),
				),
				"no_release",
			);
		expect(
			await resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				github,
				options([new Response(null, { status: 404 })]),
			),
		).toBeNull();
	});

	test("GitHub supports checksums from the same stable release only for the chosen filename", async () => {
		const source = pluginSourceSchema.parse({ ...github, checksumAsset: "checksums.txt" });
		const assets = [
			{ ...GITHUB_ASSET, digest: null },
			{
				name: "checksums.txt",
				size: 100,
				browser_download_url:
					"https://github.com/example/plugins/releases/download/v1.2.3/checksums.txt",
			},
		];
		const result = await resolvePluginSourceRelease(
			PLUGIN_ID,
			"1.0.0",
			source,
			options([
				Response.json(release({ assets })),
				new Response(`${SHA} *plugin-1.2.3.nfplugin\r\n`),
			]),
		);
		expect(result?.sha256).toBe(SHA);
		await failure(
			resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				source,
				options([Response.json(release({ assets })), new Response(`${SHA} other.nfplugin\n`)]),
			),
			"invalid_release",
		);
	});

	test("monorepo GitHub metadata declares a stable plugin version but cannot redirect the chosen asset", async () => {
		const source = pluginSourceSchema.parse({ ...github, metadataAsset: "plugin-release.json" });
		const packageUrl = GITHUB_ASSET.browser_download_url;
		const assets = [
			{ ...GITHUB_ASSET, digest: null },
			{
				name: "plugin-release.json",
				size: 123,
				browser_download_url:
					"https://github.com/example/plugins/releases/download/plugin-release/plugin-release.json",
			},
		];
		const metadata = feed({ artifact: { url: packageUrl, sha256: SHA, size: 1234 } });
		const result = await resolvePluginSourceRelease(
			PLUGIN_ID,
			"1.0.0",
			source,
			options([
				Response.json(release({ tag_name: "plugin-release", assets })),
				Response.json(metadata),
			]),
		);
		expect(result?.version).toBe("1.2.3");
		await failure(
			resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				source,
				options([
					Response.json(release({ assets })),
					Response.json(
						feed({
							artifact: { url: "https://github.com/other/p.nfplugin", sha256: SHA, size: 1234 },
						}),
					),
				]),
			),
			"identity_mismatch",
		);
	});

	test("GitHub rate limits preserve bounded Retry-After rather than hot-looping", async () => {
		try {
			await resolvePluginSourceRelease(
				PLUGIN_ID,
				"1.0.0",
				github,
				options([new Response(null, { status: 429, headers: { "retry-after": "120" } })]),
			);
		} catch (error) {
			expect((error as PluginSourceFailure).code).toBe("rate_limited");
			expect((error as PluginSourceFailure).retryAfterMs).toBe(120_000);
		}
	});

	test("metadata byte limit includes declared, streamed, invalid UTF-8 and stalled bodies", async () => {
		const signal = new AbortController().signal;
		await failure(
			readPluginSourceText(
				new Response("{}", { headers: { "content-length": String(64 * 1024 + 1) } }),
				signal,
			),
			"invalid_release",
		);
		await failure(
			readPluginSourceText(new Response("x".repeat(64 * 1024 + 1)), signal),
			"invalid_release",
		);
		await failure(
			readPluginSourceText(new Response(Uint8Array.of(0xff)), signal),
			"invalid_release",
		);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new PluginSourceFailure("cancelled")), 10);
		await failure(
			readPluginSourceText(
				new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
				controller.signal,
			),
			"cancelled",
		);
		clearTimeout(timer);
	});

	test("local latest comes solely from the host descriptor, not an arbitrary disk path", async () => {
		const source = pluginSourceSchema.parse({ type: "local", builtinId: PLUGIN_ID });
		if (source.type !== "local") throw new Error("Expected local source");
		const ctx = options([]);
		ctx.getBuiltin = () => ({
			pluginId: PLUGIN_ID,
			version: "1.0.3",
			displayName: "Built-in",
			source,
			load: async () => ({ bytes: new Uint8Array(123), sha256: SHA }),
		});
		const result = await resolvePluginSourceRelease(PLUGIN_ID, "9.0.0", source, ctx);
		expect(result).toMatchObject({
			version: "1.0.3",
			size: 123,
			artifact: { type: "local", builtinId: PLUGIN_ID },
		});
		expect(ctx.fetch).not.toHaveBeenCalled();
		await failure(
			resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", source, options([])),
			"local_missing",
		);
	});

	test("HTTP website sources are manual-only, even when explicitly permitted", () => {
		const insecure = pluginSourceSchema.parse({
			type: "website",
			updateApi: "http://127.0.0.1:1234/latest",
			allowInsecureHttp: true,
		});
		expect(sourceAllowsAutomaticUpdate(insecure)).toBe(false);
		expect(sourceAllowsAutomaticUpdate(website)).toBe(true);
		expect(() => sourceDownloadPolicy(website, "http://cdn.example/a.nfplugin")).toThrow();
	});

	test("strict semantic ordering never downgrades and build metadata is not an upgrade", () => {
		expect(comparePluginVersions("1.10.0", "1.9.0")).toBe(1);
		expect(comparePluginVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
		expect(comparePluginVersions("1.0.0-alpha-beta.2", "1.0.0-alpha-beta.10")).toBe(-1);
		expect(comparePluginVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
		expect(() => comparePluginVersions("1.0.0-01", "1.0.0")).toThrow();
	});

	test("compatibility respects the unmodified host API version mechanism and platform limits", () => {
		const artifact = { type: "local" as const, builtinId: PLUGIN_ID };
		const base = { pluginId: PLUGIN_ID, version: "1.2.3", sha256: SHA, size: 1, artifact };
		expect(() =>
			assertPluginReleaseCompatible(
				{ ...base, compatibility: { hostApi: ">=1.0 <2", os: ["win32"] } },
				environment,
			),
		).not.toThrow();
		expect(() =>
			assertPluginReleaseCompatible({ ...base, compatibility: { hostApi: ">=2" } }, environment),
		).toThrow();
		expect(() =>
			assertPluginReleaseCompatible({ ...base, compatibility: { arch: ["arm64"] } }, environment),
		).toThrow();
	});

	test("actual loopback website request carries only public query fields", async () => {
		let observed: URL | undefined;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				observed = new URL(request.url);
				expect(request.headers.get("authorization")).toBeNull();
				expect(request.headers.get("cookie")).toBeNull();
				return Response.json({
					...feed(),
					latest: {
						...feed().latest,
						artifact: {
							url: `${new URL(request.url).origin}/package.nfplugin`,
							sha256: SHA,
							size: 1234,
						},
					},
				});
			},
		});
		try {
			const source: PluginSource = pluginSourceSchema.parse({
				type: "website",
				updateApi: `${server.url}latest`,
				allowInsecureHttp: true,
			});
			const ctx = options([]);
			ctx.transport.fetch = (url, init) => fetch(url, init);
			const result = await resolvePluginSourceRelease(PLUGIN_ID, "1.0.0", source, ctx);
			expect(result?.version).toBe("1.2.3");
			expect(observed?.searchParams.get("pluginId")).toBe(PLUGIN_ID);
		} finally {
			await server.stop(true);
		}
	});
});
