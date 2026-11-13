import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	REMOTE_PEER_LICENSE_FILES,
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	remotePeerPublishedFilename,
	resolveRemotePeerPlatform,
} from "../../../shared/remote-peer";
import { REMOTE_PEER_DISTRIBUTION } from "../../../shared/remote-peer-distribution";
import {
	captureHelperSource,
	type DistributionFetch,
	distributionPath,
} from "../helper-distribution-runtime";
import {
	ensureRemotePeerBinary,
	freezeRemotePeerArtifact,
	getInstalledRemotePeerBinary,
	getRemotePeerManifest,
	RemotePeerDistributionError,
	resetRemotePeerManifestCache,
} from "../remote-peer-binaries";
import { settings } from "../settings";

const pin = (() => {
	if (!REMOTE_PEER_DISTRIBUTION) throw new Error("Test build must declare the remote peer pin");
	return REMOTE_PEER_DISTRIBUTION;
})();
const configuredUpdate = settings.update;
if (!configuredUpdate) throw new Error("Test settings must include update defaults");
const original = structuredClone(configuredUpdate);
const binary = Buffer.alloc(256);
binary.writeUInt32BE(0x7f454c46, 0);
binary[4] = 2;
binary[5] = 1;
binary.writeUInt16LE(62, 18);
const hash = createHash("sha256").update(binary).digest("hex");
const source = { source: "github", repository: "fixture/remote-peer-tests" } as const;
const manifestPath = distributionPath(
	source,
	`${pin.tag}\0${pin.version}\0${pin.protocolVersion}\0manifest`,
);
const filename = remotePeerPublishedFilename(pin.version, "linux-amd64");
const binaryPath = distributionPath(
	source,
	`${pin.tag}\0${pin.tag}\0linux-x64\0${filename}\0${hash}`,
);
const paths = new Set([manifestPath, binaryPath]);
function envelope() {
	return {
		schemaVersion: 1,
		repository: String(source.repository),
		tag: pin.tag,
		commit: "a".repeat(40),
		manifest: {
			version: pin.version,
			protocolVersion: pin.protocolVersion,
			releasedAt: "2026-10-27T00:00:00Z",
			platforms: Object.fromEntries(
				REMOTE_PEER_PLATFORMS.map((platform) => [
					platform,
					{
						filename: remotePeerPublishedFilename(pin.version, platform),
						size: binary.length,
						sha256: hash,
					},
				]),
			),
		},
		licenses: REMOTE_PEER_LICENSE_FILES.map((name) => ({ name, size: 1, sha256: "c".repeat(64) })),
	};
}
function fetcher(
	options: {
		mutate?: (value: ReturnType<typeof envelope>) => void;
		body?: Uint8Array;
		missing?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const fetch: DistributionFetch = async (url) => {
		calls.push(url);
		if (options.missing) return new Response(null, { status: 404 });
		if (url.endsWith(REMOTE_PEER_MANIFEST_FILENAME)) {
			const value = envelope();
			options.mutate?.(value);
			return Response.json(value);
		}
		return new Response(Uint8Array.from(options.body ?? binary));
	};
	return { fetch, calls };
}
beforeEach(() => {
	settings.update = {
		...original,
		source: "github",
		githubRepository: source.repository,
		proxy: { mode: "direct" },
	};
	resetRemotePeerManifestCache();
	for (const path of paths) rmSync(path, { force: true });
});
afterEach(() => {
	settings.update = original;
	resetRemotePeerManifestCache();
	for (const path of paths) rmSync(path, { force: true });
});
describe("optional remote peer binary acquisition", () => {
	test("explicitly selects an immutable prerelease, verifies architecture/hash and reuses cache", async () => {
		const f = fetcher();
		const result = await ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch });
		paths.add(result.path);
		expect(result.version).toBe(pin.version);
		expect(result.protocolVersion).toBe(pin.protocolVersion);
		expect(result.path).toBe(binaryPath);
		expect(readFileSync(result.path)).toEqual(binary);
		expect(f.calls).toEqual([
			`https://github.com/${source.repository}/releases/download/${pin.tag}/${REMOTE_PEER_MANIFEST_FILENAME}`,
			`https://github.com/${source.repository}/releases/download/${pin.tag}/${filename}`,
		]);
		await ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch });
		expect(f.calls).toHaveLength(2);
	});
	test("installed lookup stays offline both before and after explicit acquisition", async () => {
		const f = fetcher();
		const preconnect = globalThis.fetch.preconnect;
		const network = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					throw new Error("Installed lookup must not access the network");
				},
				{ preconnect },
			),
		);
		try {
			expect(await getInstalledRemotePeerBinary()).toBeNull();
			const installed = await ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch });
			paths.add(installed.path);
			const cached = await getInstalledRemotePeerBinary();
			if (resolveRemotePeerPlatform(process.platform, process.arch) === "linux-amd64") {
				expect(cached?.path).toBe(installed.path);
				expect(cached?.protocolVersion).toBe(pin.protocolVersion);
			} else {
				// A cached artifact for another architecture must never become executable here.
				expect(cached).toBeNull();
			}
			expect(f.calls).toHaveLength(2);
			expect(network).not.toHaveBeenCalled();
		} finally {
			network.mockRestore();
		}
	});
	test("manifest requests coalesce and bounded local manifest supports offline reads", async () => {
		const f = fetcher();
		const [a, b] = await Promise.all([
			getRemotePeerManifest({ fetcher: f.fetch }),
			getRemotePeerManifest({ fetcher: f.fetch }),
		]);
		expect(a).toBe(b);
		expect(f.calls).toHaveLength(1);
		expect(Object.isFrozen(a)).toBe(true);
		expect(existsSync(manifestPath)).toBe(true);
		resetRemotePeerManifestCache();
		const cached = await getRemotePeerManifest({ fetcher: fetcher({ missing: true }).fetch });
		expect(cached?.version).toBe(pin.version);
	});
	test("unpublished component fails only the explicit acquisition and never switches upstream", async () => {
		const f = fetcher({ missing: true });
		await expect(ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch })).rejects.toThrow(
			/not been published/,
		);
		expect(f.calls.every((url) => url.startsWith(`https://github.com/${source.repository}/`))).toBe(
			true,
		);
	});
	for (const [name, mutate] of [
		[
			"repository",
			(x: ReturnType<typeof envelope>) => {
				x.repository = "foreign/peer";
			},
		],
		[
			"protocol",
			(x: ReturnType<typeof envelope>) => {
				x.manifest.protocolVersion = pin.protocolVersion + 1;
			},
		],
		[
			"version",
			(x: ReturnType<typeof envelope>) => {
				x.manifest.version = "9.9.9";
			},
		],
		[
			"platform",
			(x: ReturnType<typeof envelope>) => {
				delete x.manifest.platforms["windows-arm64"];
			},
		],
	] as const)
		test(`refuses wrong ${name} without downloading a binary`, async () => {
			const f = fetcher({ mutate });
			await expect(ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch })).rejects.toThrow(
				RemotePeerDistributionError,
			);
			expect(f.calls).toHaveLength(1);
		});
	test("damaged cache is replaced only by a verified download", async () => {
		const f = fetcher();
		const first = await ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch });
		paths.add(first.path);
		writeFileSync(first.path, Buffer.alloc(256));
		await ensureRemotePeerBinary("linux-amd64", { fetcher: f.fetch });
		expect(readFileSync(first.path)).toEqual(binary);
		expect(f.calls).toHaveLength(3);
	});
	test("refuses substituted payload and does not leave a selected cache artifact", async () => {
		await expect(
			ensureRemotePeerBinary("linux-amd64", {
				fetcher: fetcher({ body: Buffer.alloc(256) }).fetch,
			}),
		).rejects.toThrow();
		expect(existsSync(binaryPath)).toBe(false);
	});
	test("refuses forged or stale-source artifact bindings", async () => {
		const f = fetcher();
		const manifest = await getRemotePeerManifest({ fetcher: f.fetch });
		if (!manifest) throw new Error("Expected verified manifest");
		const binding = freezeRemotePeerArtifact(manifest, "linux-amd64");
		await expect(
			ensureRemotePeerBinary("linux-amd64", { binding: { ...binding }, fetcher: f.fetch }),
		).rejects.toThrow(/binding mismatch/);
		settings.update = { ...original, ...settings.update, githubRepository: "foreign/peer" };
		await expect(
			ensureRemotePeerBinary("linux-amd64", { binding, fetcher: f.fetch }),
		).rejects.toThrow(/binding mismatch/);
		expect(f.calls).toHaveLength(1);
		expect(captureHelperSource()).not.toEqual(source);
	});
	test("aborted request does no network I/O", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const f = fetcher();
		await expect(
			ensureRemotePeerBinary("linux-amd64", { signal: controller.signal, fetcher: f.fetch }),
		).rejects.toThrow(/cancelled/);
		expect(f.calls).toHaveLength(0);
	});
	test("cancelling one manifest waiter does not cancel an independent waiter", async () => {
		const controller = new AbortController();
		const f: DistributionFetch = async (_url, init) => {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 30);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
			return Response.json(envelope());
		};
		const cancelled = getRemotePeerManifest({ signal: controller.signal, fetcher: f });
		const independent = getRemotePeerManifest({ fetcher: f });
		controller.abort(new Error("one_waiter_cancelled"));
		await expect(cancelled).rejects.toThrow(/one_waiter_cancelled/);
		expect((await independent)?.version).toBe(pin.version);
	});
	test("enforces the manifest deadline on a stalled network request", async () => {
		const f: DistributionFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		expect(await getRemotePeerManifest({ fetcher: f })).toBeNull();
	}, 15_000);
});
