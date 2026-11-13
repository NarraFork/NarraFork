import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getHelperAssetName,
	HELPER_CATALOG_VERSION,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
} from "../../../shared/helper-distribution";
import { isWindowsPeFile, matchesWindowsPeArch } from "../../../shared/windows-pe";
import {
	downloadHelperBinary,
	getCachedHelperBinaryPath,
	HELPER_BIN_DIR,
	resetHelperBinaryDownloadCache,
} from "../helper-binaries";
import { getCliHelperSpec, isNativeCliHelper } from "../helper-binary-platform";
import { resetHelperDistributionCache } from "../helper-distribution-runtime";
import { settings } from "../settings";

const repository = "fixture/helper-platform";
const releaseBase = `https://github.com/${repository}/releases/download/${HELPER_RELEASE_TAG}/`;
const mirrorOrigin = "https://component-mirror.example";
const mirrorBase = `${mirrorOrigin}/api/v3/products/narrafork/mirror/tools/helpers/${HELPER_RELEASE_TAG}/assets/`;
function selectDelivery(source: "github" | "update-server") {
	if (!settings.update) throw new Error("Missing fixture update settings");
	settings.update.source = source;
}

const originalUpdate = settings.update ?? {
	serverUrl: "https://legacy.example",
	product: "narrafork",
	channel: "stable" as const,
	checkIntervalMinutes: 60,
	autoDownload: false,
};

function pe(machine: number): Buffer {
	const bytes = Buffer.alloc(256);
	bytes.write("MZ");
	bytes.writeUInt32LE(128, 0x3c);
	bytes.writeUInt32LE(0x4550, 128);
	bytes.writeUInt16LE(machine, 132);
	return bytes;
}

function catalog(payload: Uint8Array) {
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
				size: payload.byteLength,
				sha256: createHash("sha256").update(payload).digest("hex"),
			})),
		),
		licenses: [{ name: "LICENSE.txt", size: 10, sha256: "b".repeat(64) }],
	};
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
	settings.update = {
		...originalUpdate,
		source: "update-server",
		githubRepository: repository,
		serverUrl: mirrorOrigin,
		product: "narrafork",
		proxy: { mode: "direct" },
	};
	resetHelperBinaryDownloadCache();
	resetHelperDistributionCache();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
});
afterEach(() => {
	settings.update = originalUpdate;
	globalThis.fetch = originalFetch;
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
});

describe("native helper platform selection", () => {
	for (const tool of ["rg", "zstd"] as const) {
		test(`${tool}: ARM64 uses a distinct tool and cache name, x64 keeps compatibility`, () => {
			const arm = getCliHelperSpec(tool, "win32", "arm64");
			const x64 = getCliHelperSpec(tool, "win32", "x64");
			expect(arm?.toolName).toBe(`${tool}-win-arm64.exe`);
			expect(arm?.cachedName).toBe(`${tool}-win-arm64.exe`);
			expect(arm?.windowsArch).toBe("arm64");
			expect(x64?.toolName).toBe(`${tool}-win64.exe`);
			expect(x64?.cachedName).toBe(`${tool}.exe`);
		});
		test(`${tool}: Linux helpers retain existing paths`, () => {
			expect(getCliHelperSpec(tool, "linux", "arm64")?.toolName).toBe(`${tool}-linux-arm64`);
			expect(getCliHelperSpec(tool, "linux", "x64")?.toolName).toBe(`${tool}-linux-x64`);
			expect(getCliHelperSpec(tool, "linux", "arm64")?.cachedName).toBe(tool);
		});
	}
	test("macOS rg and zstd use catalog native filenames", () => {
		expect(getCliHelperSpec("rg", "darwin", "arm64")?.toolName).toBe("rg-darwin-arm64");
		expect(getCliHelperSpec("zstd", "darwin", "arm64")?.toolName).toBe("zstd-darwin-arm64");
	});
	test("unsupported CPU/OS never defaults to an x64 binary", () => {
		expect(getCliHelperSpec("rg", "win32", "ia32")).toBeNull();
		expect(getCliHelperSpec("zstd", "linux", "riscv64")).toBeNull();
		expect(getCliHelperSpec("rg", "freebsd", "x64")).toBeNull();
	});
	test("historical x64 generic cache cannot satisfy ARM64", () => {
		for (const tool of ["rg", "zstd"] as const) {
			writeFileSync(join(HELPER_BIN_DIR, `${tool}.exe`), pe(0x8664));
			const spec = getCliHelperSpec(tool, "win32", "arm64");
			expect(spec).not.toBeNull();
			if (!spec) throw new Error("Missing spec");
			expect(getCachedHelperBinaryPath(spec.cachedName, spec.windowsArch)).toBeNull();
		}
	});
	test("mislabelled ARM64 cache and x64 PATH candidates are rejected", () => {
		const path = join(HELPER_BIN_DIR, "zstd-win-arm64.exe");
		writeFileSync(path, pe(0x8664));
		expect(getCachedHelperBinaryPath("zstd-win-arm64.exe", "arm64")).toBeNull();
		expect(isNativeCliHelper(path, "win32", "arm64")).toBe(false);
		writeFileSync(path, pe(0xaa64));
		expect(getCachedHelperBinaryPath("zstd-win-arm64.exe", "arm64")).toBe(path);
		expect(isNativeCliHelper(path, "win32", "arm64")).toBe(true);
	});
});

describe("bounded PE architecture validation", () => {
	test("ARM64/x64 machine tags and truncated or corrupt headers", () => {
		expect(matchesWindowsPeArch(pe(0xaa64), "arm64")).toBe(true);
		expect(matchesWindowsPeArch(pe(0x8664), "x64")).toBe(true);
		expect(matchesWindowsPeArch(pe(0x8664), "arm64")).toBe(false);
		expect(matchesWindowsPeArch(pe(0xaa64).subarray(0, 130), "arm64")).toBe(false);
		const corrupt = pe(0xaa64);
		corrupt.writeUInt32LE(0xffffffff, 0x3c);
		expect(matchesWindowsPeArch(corrupt, "arm64")).toBe(false);
		const path = join(HELPER_BIN_DIR, "corrupt.exe");
		writeFileSync(path, corrupt);
		expect(isWindowsPeFile(path, "arm64")).toBe(false);
		expect(isWindowsPeFile(`${path}.missing`, "arm64")).toBe(false);
	});
});

for (const delivery of ["github", "update-server"] as const) {
	describe(`${delivery} helper download architecture validation`, () => {
		test("rejects x64 served under ARM64 name, without caching it", async () => {
			selectDelivery(delivery);
			// Its digest matches the canonical fixture: rejection must reach PE architecture validation.
			const payload = pe(0x8664);
			const calls: string[] = [];
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				const url = String(input);
				calls.push(url);
				return url.endsWith(HELPER_MANIFEST_FILENAME)
					? Response.json(catalog(payload))
					: new Response(Uint8Array.from(payload));
			}) as unknown as typeof fetch;
			const spec = getCliHelperSpec("zstd", "win32", "arm64");
			if (!spec) throw new Error("Missing spec");
			expect(
				await downloadHelperBinary(
					{ ...spec, expectedSha256: createHash("sha256").update(pe(0x8664)).digest("hex") },
					{ bypassFailureCache: true },
				),
			).toBeNull();
			expect(existsSync(join(HELPER_BIN_DIR, spec.cachedName))).toBe(false);
			expect(
				readdirSync(join(HELPER_BIN_DIR, "distribution")).filter(
					(name) => name.endsWith(".exe") || name.endsWith(".tmp"),
				),
			).toEqual([]);
			const selectedBase = delivery === "update-server" ? mirrorBase : releaseBase;
			expect(calls).toEqual([
				`${selectedBase}${HELPER_MANIFEST_FILENAME}`,
				`${selectedBase}${spec.toolName}`,
			]);
		});
		test("downloads native ARM64 even when legacy x64 cache exists", async () => {
			selectDelivery(delivery);
			writeFileSync(join(HELPER_BIN_DIR, "zstd.exe"), pe(0x8664));
			const calls: string[] = [];
			globalThis.fetch = (async (url: string | URL | Request) => {
				calls.push(String(url));
				return String(url).endsWith(HELPER_MANIFEST_FILENAME)
					? Response.json(catalog(pe(0xaa64)))
					: new Response(Uint8Array.from(pe(0xaa64)));
			}) as unknown as typeof fetch;
			const spec = getCliHelperSpec("zstd", "win32", "arm64");
			if (!spec) throw new Error("Missing spec");
			spec.expectedSha256 = createHash("sha256").update(pe(0xaa64)).digest("hex");
			const path = await downloadHelperBinary(spec, { bypassFailureCache: true });
			expect(path?.startsWith(join(HELPER_BIN_DIR, "distribution"))).toBe(true);
			if (!path) throw new Error("Native ARM64 helper must be downloaded");
			expect(path).toEndWith(".exe");
			expect(await Bun.file(path).bytes()).toEqual(Uint8Array.from(pe(0xaa64)));
			const selectedBase = delivery === "update-server" ? mirrorBase : releaseBase;
			expect(calls).toEqual([
				`${selectedBase}${HELPER_MANIFEST_FILENAME}`,
				`${selectedBase}${spec.toolName}`,
			]);
			expect(await downloadHelperBinary(spec)).toBe(path);
			expect(calls.length).toBe(2);
			expect(existsSync(join(HELPER_BIN_DIR, "zstd.exe"))).toBe(true);
		});
		test("limits chunked downloads without trusting content-length", async () => {
			selectDelivery(delivery);
			const cancelled: string[] = [];
			const calls: string[] = [];
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith(HELPER_MANIFEST_FILENAME)) return Response.json(catalog(pe(0xaa64)));
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(128));
						},
						cancel() {
							cancelled.push(url);
						},
					}),
				);
			}) as unknown as typeof fetch;
			const spec = getCliHelperSpec("zstd", "win32", "arm64");
			if (!spec) throw new Error("Missing spec");
			expect(
				await downloadHelperBinary(spec, { maxBytes: 64, bypassFailureCache: true }),
			).toBeNull();
			expect(cancelled).toEqual([
				`${delivery === "update-server" ? mirrorBase : releaseBase}${spec.toolName}`,
			]);
			const selectedBase = delivery === "update-server" ? mirrorBase : releaseBase;
			expect(calls).toEqual([
				`${selectedBase}${HELPER_MANIFEST_FILENAME}`,
				`${selectedBase}${spec.toolName}`,
			]);
			expect(existsSync(join(HELPER_BIN_DIR, spec.cachedName))).toBe(false);
			expect(
				readdirSync(join(HELPER_BIN_DIR, "distribution")).filter(
					(name) => name.endsWith(".exe") || name.endsWith(".tmp"),
				),
			).toEqual([]);
		});
	});
}

for (const failure of ["manifest-missing", "missing", "corrupt"] as const) {
	test(`native ARM64 rejects a ${failure} mirror response without GitHub fallback or cached binaries`, async () => {
		selectDelivery("update-server");
		const payload = pe(0xaa64);
		const damaged = Uint8Array.from(payload);
		damaged[200] = 1;
		const calls: string[] = [];
		const spec = getCliHelperSpec("zstd", "win32", "arm64");
		if (!spec) throw new Error("Missing spec");
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url === `${mirrorBase}${HELPER_MANIFEST_FILENAME}`)
				return failure === "manifest-missing"
					? new Response(null, { status: 404 })
					: Response.json(catalog(payload));
			if (url === `${mirrorBase}${spec.toolName}`)
				return failure === "missing" ? new Response(null, { status: 404 }) : new Response(damaged);
			throw new Error("Selected mirror must never contact GitHub or another component endpoint");
		}) as unknown as typeof fetch;
		expect(await downloadHelperBinary(spec, { bypassFailureCache: true })).toBeNull();
		expect(calls).toEqual([
			`${mirrorBase}${HELPER_MANIFEST_FILENAME}`,
			...(failure === "manifest-missing" ? [] : [`${mirrorBase}${spec.toolName}`]),
		]);
		expect(calls.some((url) => new URL(url).hostname === "github.com")).toBe(false);
		expect(existsSync(join(HELPER_BIN_DIR, spec.cachedName))).toBe(false);
		const directory = join(HELPER_BIN_DIR, "distribution");
		expect(
			existsSync(directory)
				? readdirSync(directory).filter((name) => name.endsWith(".exe") || name.endsWith(".tmp"))
				: [],
		).toEqual([]);
	});
}
