import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getHelperAssetName,
	HELPER_CATALOG_VERSION,
	HELPER_EXECUTOR_PROTOCOL_VERSION,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
	type HelperManifest,
	type HelperPlatform,
} from "../../../shared/helper-distribution";
import { EXECUTOR_PLATFORMS, executorPublishedFilename } from "../../../shared/remote-executor";
import { DEVICE_PROTOCOL_VERSION } from "../agent/execution/rpc-types";
import {
	ensureExecutorBinary,
	freezeExecutorArtifact,
	getExecutorManifest,
	resetExecutorManifestCache,
} from "../executor-binaries";
import {
	issueExecutorTicket,
	redeemExecutorTicket,
	resetExecutorTickets,
} from "../executor-bootstrap-ticket";
import {
	downloadHelperBinary,
	getVerifiedCachedHelperBinaryPath,
	HELPER_BIN_DIR,
	resetHelperBinaryDownloadCache,
} from "../helper-binaries";
import { getCliHelperSpec } from "../helper-binary-platform";
import {
	createDistributionContext,
	DISTRIBUTION_CACHE_DIR,
	fetchDistributionAsset,
	resetHelperDistributionCache,
} from "../helper-distribution-runtime";
import { settings } from "../settings";
import { APP_VERSION } from "../version";

function binary(platform: HelperPlatform): Buffer<ArrayBuffer> {
	const bytes = Buffer.alloc(256);
	const arm = platform.endsWith("arm64");
	if (platform.startsWith("windows")) {
		bytes.write("MZ");
		bytes.writeUInt32LE(128, 60);
		bytes.writeUInt32LE(0x4550, 128);
		bytes.writeUInt16LE(arm ? 0xaa64 : 0x8664, 132);
	} else if (platform.startsWith("linux")) {
		bytes.writeUInt32BE(0x7f454c46, 0);
		bytes[4] = 2;
		bytes[5] = 1;
		bytes.writeUInt16LE(arm ? 183 : 62, 18);
	} else {
		bytes.writeUInt32LE(0xfeedfacf, 0);
		bytes.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4);
	}
	return bytes;
}
function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function manifest(repository = "fork/repo"): HelperManifest {
	return {
		schemaVersion: 1,
		repository,
		tag: HELPER_RELEASE_TAG,
		commit: "a".repeat(40),
		catalogVersion: HELPER_CATALOG_VERSION,
		files: HELPER_TOOLS.flatMap((tool) =>
			HELPER_PLATFORMS.map((platform) => ({
				tool,
				platform,
				toolVersion: HELPER_TOOL_VERSIONS[tool],
				name: getHelperAssetName(tool, platform),
				size: 256,
				sha256: digest(binary(platform)),
			})),
		),
		licenses: [{ name: "LICENSE.txt", size: 20, sha256: "c".repeat(64) }],
	};
}
const originalUpdate = settings.update ?? {
	serverUrl: "https://legacy.example",
	product: "narrafork",
	channel: "stable" as const,
	checkIntervalMinutes: 60,
	autoDownload: false,
};
const originalProxy = settings.proxy;
beforeEach(() => {
	settings.update = {
		...originalUpdate,
		source: "github",
		githubRepository: "fork/repo",
		serverUrl: "https://personal.example",
		proxy: { mode: "direct" },
	};
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
	resetHelperBinaryDownloadCache();
	resetHelperDistributionCache();
	resetExecutorManifestCache();
	resetExecutorTickets();
});
afterEach(() => {
	settings.update = originalUpdate;
	settings.proxy = originalProxy;
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
});
function spec() {
	const value = getCliHelperSpec("zstd", "linux", "x64");
	if (!value) throw new Error("Missing spec");
	return value;
}
function routes(
	calls: string[],
	overrides: { catalog?: unknown; bytes?: Uint8Array<ArrayBuffer> } = {},
) {
	return async (url: string) => {
		calls.push(url);
		return url.endsWith(".json")
			? Response.json(overrides.catalog ?? manifest())
			: new Response(overrides.bytes ?? binary("linux-x64"));
	};
}
describe("source-bound helper runtime", () => {
	test("shared distribution protocol agrees with the existing executor wire protocol", () => {
		expect(HELPER_EXECUTOR_PROTOCOL_VERSION).toBe(DEVICE_PROTOCOL_VERSION);
	});
	test("independent parent operations cannot cancel each other's downloads", async () => {
		let binaryRequests = 0;
		let readyResolve: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			readyResolve = resolve;
		});
		const fetcher = async (url: string) => {
			if (url.endsWith(".json")) return Response.json(manifest());
			let canceled = false;
			binaryRequests++;
			if (binaryRequests === 2) readyResolve?.();
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						setTimeout(() => {
							if (!canceled) {
								controller.enqueue(binary("linux-x64"));
								controller.close();
							}
						}, 20);
					},
					cancel() {
						canceled = true;
					},
				}),
			);
		};
		const firstSignal = new AbortController();
		const secondSignal = new AbortController();
		const first = downloadHelperBinary(spec(), { fetcher, signal: firstSignal.signal });
		const second = downloadHelperBinary(spec(), { fetcher, signal: secondSignal.signal });
		await ready;
		firstSignal.abort(new Error("cancel first operation"));
		await expect(first).rejects.toThrow("cancel first operation");
		expect(await second).not.toBeNull();
	});
	test("a proxy change preserves a verified artifact's source identity", async () => {
		const context = createDistributionContext(undefined, async (url) => {
			if (url.endsWith(".json")) return Response.json(manifest());
			settings.update = {
				...(settings.update ?? originalUpdate),
				proxy: { mode: "custom", url: "http://user:secret@localhost:8080" },
			};
			return new Response(binary("linux-x64"));
		});
		expect(await downloadHelperBinary(spec(), { context })).not.toBeNull();
		expect(context.isCurrent()).toBe(true);
		expect(context.isTransportCurrent?.()).toBe(false);
	});
	test("GitHub default and forks never access retained personal server", async () => {
		const calls: string[] = [];
		const path = await downloadHelperBinary(spec(), { fetcher: routes(calls) });
		expect(path).not.toBeNull();
		expect(calls).toHaveLength(2);
		expect(
			calls.every((url) =>
				url.startsWith(`https://github.com/fork/repo/releases/download/${HELPER_RELEASE_TAG}/`),
			),
		).toBe(true);
		if (!path) throw new Error("Missing binary");
		expect(await Bun.file(path).bytes()).toEqual(binary("linux-x64"));
		expect(await downloadHelperBinary(spec(), { fetcher: routes(calls) })).toBe(path);
		expect(calls).toHaveLength(2);
	});
	test("missing helper tag fails closed without old-server fallback", async () => {
		const calls: string[] = [];
		expect(
			await downloadHelperBinary(spec(), {
				fetcher: async (url) => {
					calls.push(url);
					return new Response(null, { status: 404 });
				},
			}),
		).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("github.com/fork/repo");
	});
	test("source cache isolation, corruption re-verification and trusted-only legacy migration", async () => {
		const calls: string[] = [];
		writeFileSync(join(HELPER_BIN_DIR, "zstd"), binary("linux-arm64"));
		const first = await downloadHelperBinary(spec(), { fetcher: routes(calls) });
		if (!first) throw new Error("Missing binary");
		expect(existsSync(join(HELPER_BIN_DIR, "zstd"))).toBe(true);
		writeFileSync(first, "corrupt");
		expect(await downloadHelperBinary(spec(), { fetcher: routes(calls) })).toBe(first);
		expect(calls).toHaveLength(3);
		settings.update = { ...(settings.update ?? originalUpdate), githubRepository: "other/repo" };
		const otherCalls: string[] = [];
		const second = await downloadHelperBinary(spec(), {
			fetcher: routes(otherCalls, { catalog: manifest("other/repo") }),
		});
		expect(second).not.toBe(first);
		expect(otherCalls).toHaveLength(2);
	});
	test("matching legacy cache is copied without executing or deleting it", async () => {
		const legacy = join(HELPER_BIN_DIR, "zstd");
		writeFileSync(legacy, binary("linux-x64"));
		const calls: string[] = [];
		const path = await getVerifiedCachedHelperBinaryPath(spec(), { fetcher: routes(calls) });
		expect(path).not.toBeNull();
		expect(path).not.toBe(legacy);
		expect(calls).toHaveLength(1);
		expect(existsSync(legacy)).toBe(true);
	});
	test("wrong size, digest and architecture are all rejected with temp cleanup", async () => {
		for (const mode of ["size", "digest", "arch"]) {
			resetHelperDistributionCache();
			resetHelperBinaryDownloadCache();
			rmSync(DISTRIBUTION_CACHE_DIR, { recursive: true, force: true });
			const catalog = manifest();
			const entry = catalog.files.find((entry) => entry.name === spec().toolName);
			if (!entry) throw new Error("Missing entry");
			const bytes = mode === "arch" ? binary("linux-arm64") : binary("linux-x64");
			if (mode === "size") entry.size++;
			if (mode === "digest") entry.sha256 = "b".repeat(64);
			if (mode === "arch") entry.sha256 = digest(bytes);
			expect(
				await downloadHelperBinary(spec(), { fetcher: routes([], { catalog, bytes }) }),
			).toBeNull();
			expect(readdirSync(DISTRIBUTION_CACHE_DIR).some((name) => name.endsWith(".tmp"))).toBe(false);
		}
	});
	test("unbounded manifest and binary streams are canceled within byte limits", async () => {
		let canceled = 0;
		const endless = () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(40_000));
					},
					cancel() {
						canceled++;
					},
				}),
			);
		expect(await downloadHelperBinary(spec(), { fetcher: async () => endless() })).toBeNull();
		expect(canceled).toBe(1);
		resetHelperDistributionCache();
		expect(
			await downloadHelperBinary(spec(), {
				maxBytes: 200,
				fetcher: async (url) => (url.endsWith(".json") ? Response.json(manifest()) : endless()),
			}),
		).toBeNull();
		expect(canceled).toBe(2);
	});
	test("timeout and parent cancellation abort hanging bodies, leaving no own temps", async () => {
		let canceled = false;
		const fetcher = async (url: string) =>
			url.endsWith(".json")
				? Response.json(manifest())
				: new Response(
						new ReadableStream({
							pull() {},
							cancel() {
								canceled = true;
							},
						}),
					);
		expect(await downloadHelperBinary(spec(), { fetcher, timeoutMs: 20 })).toBeNull();
		expect(canceled).toBe(true);
		resetHelperBinaryDownloadCache();
		canceled = false;
		const controller = new AbortController();
		const pending = downloadHelperBinary(spec(), { fetcher, signal: controller.signal });
		setTimeout(() => controller.abort(new Error("parent cancel")), 20);
		await expect(pending).rejects.toThrow("parent cancel");
		expect(canceled).toBe(true);
		expect(readdirSync(DISTRIBUTION_CACHE_DIR).some((name) => name.endsWith(".tmp"))).toBe(false);
	});
	test("late source change never returns old result as a new source artifact", async () => {
		const path = await downloadHelperBinary(spec(), {
			fetcher: async (url) => {
				if (url.endsWith(".json")) return Response.json(manifest());
				settings.update = {
					...(settings.update ?? originalUpdate),
					githubRepository: "other/repo",
				};
				return new Response(binary("linux-x64"));
			},
		});
		expect(path).toBeNull();
	});
	test("concurrent same-key helper calls share manifest and binary downloads", async () => {
		const calls: string[] = [];
		const fetcher = routes(calls);
		const [first, second] = await Promise.all([
			downloadHelperBinary(spec(), { fetcher }),
			downloadHelperBinary(spec(), { fetcher }),
		]);
		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(calls).toHaveLength(2);
	});
	test("proxy changes immediately retry failures without leaking proxy credentials to paths", async () => {
		settings.update = {
			...(settings.update ?? originalUpdate),
			proxy: { mode: "custom", url: "http://user:secret@localhost:8080" },
		};
		const calls: string[] = [];
		await downloadHelperBinary(spec(), { fetcher: routes(calls, { bytes: new Uint8Array(1) }) });
		expect(await downloadHelperBinary(spec(), { fetcher: routes(calls) })).toBeNull();
		expect(calls).toHaveLength(2);
		settings.update = { ...(settings.update ?? originalUpdate), proxy: { mode: "direct" } };
		const path = await downloadHelperBinary(spec(), { fetcher: routes(calls) });
		expect(path).not.toBeNull();
		expect(calls).toHaveLength(4);
		expect(path).not.toContain("secret");
	});
	test("redirects accept GitHub CDN but reject foreign host, HTTP downgrade and excessive hops", async () => {
		const calls: string[] = [];
		const context = createDistributionContext(undefined, async (url) => {
			calls.push(url);
			return calls.length === 1
				? new Response(null, {
						status: 302,
						headers: { location: "https://release-assets.githubusercontent.com/asset" },
					})
				: new Response(binary("linux-x64"));
		});
		expect(
			(
				await fetchDistributionAsset(
					context,
					HELPER_RELEASE_TAG,
					spec().toolName,
					new AbortController().signal,
				)
			).ok,
		).toBe(true);
		for (const location of [
			"https://evil.example/a",
			"http://github.com/a",
			"https://user:secret@github.com/a",
		])
			await expect(
				fetchDistributionAsset(
					createDistributionContext(
						undefined,
						async () => new Response(null, { status: 302, headers: { location } }),
					),
					HELPER_RELEASE_TAG,
					spec().toolName,
					new AbortController().signal,
				),
			).rejects.toThrow();
		await expect(
			fetchDistributionAsset(
				createDistributionContext(
					undefined,
					async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
				),
				HELPER_RELEASE_TAG,
				spec().toolName,
				new AbortController().signal,
			),
		).rejects.toThrow("limit");
	});
	test("legacy update-server tools paths remain compatible without cross-origin redirects", async () => {
		settings.update = {
			...(settings.update ?? originalUpdate),
			source: "update-server",
			serverUrl: "https://legacy.example",
		};
		const value = { ...spec(), expectedSha256: digest(binary("linux-x64")), expectedSize: 256 };
		const calls: string[] = [];
		const path = await downloadHelperBinary(value, { fetcher: routes(calls) });
		expect(path).not.toBeNull();
		expect(calls).toEqual(["https://legacy.example/api/v2/tools/zstd-linux-x64"]);
	});
});
describe("executor pinned ticket distribution", () => {
	test("ticket retains exact source/version/tag/platform/size/digest, never refreshes manifest", async () => {
		const executorManifest = {
			version: APP_VERSION,
			protocolVersion: 1,
			releasedAt: "2026-01-01T00:00:00Z",
			platforms: Object.fromEntries(
				EXECUTOR_PLATFORMS.map((platform) => [
					platform,
					{
						filename: executorPublishedFilename(APP_VERSION, platform),
						size: 256,
						sha256: digest(binary(platform.replace("amd64", "x64") as HelperPlatform)),
					},
				]),
			),
		};
		const calls: string[] = [];
		const resolved = await getExecutorManifest({
			fetcher: async (url) => {
				calls.push(url);
				return Response.json({
					schemaVersion: 1,
					repository: "fork/repo",
					tag: `executor-v${APP_VERSION}`,
					commit: "a".repeat(40),
					manifest: executorManifest,
					licenses: manifest().licenses,
				});
			},
		});
		if (!resolved) throw new Error("Missing executor manifest");
		const binding = freezeExecutorArtifact(resolved, "linux-amd64");
		const ticket = issueExecutorTicket("linux-amd64", { artifact: binding });
		binding.sha256 = "d".repeat(64);
		settings.update = { ...(settings.update ?? originalUpdate), githubRepository: "other/repo" };
		const redemption = redeemExecutorTicket(ticket.ticket, "linux-amd64", "binary");
		expect(redemption.artifact?.sha256).toBe(digest(binary("linux-x64")));
		if (!redemption.artifact) throw new Error("Missing ticket binding");
		const result = await ensureExecutorBinary("linux-amd64", {
			binding: redemption.artifact,
			fetcher: async (url) => {
				calls.push(url);
				return new Response(binary("linux-x64"));
			},
		});
		expect(result.sha256).toBe(digest(binary("linux-x64")));
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain(`/fork/repo/releases/download/executor-v${APP_VERSION}/`);
	});
});
