import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWindowsPeFile, matchesWindowsPeArch } from "../../../shared/windows-pe";
import {
	downloadHelperBinary,
	getCachedHelperBinaryPath,
	HELPER_BIN_DIR,
} from "../helper-binaries";
import { getCliHelperSpec, isNativeCliHelper } from "../helper-binary-platform";
import { settings } from "../settings";

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

const originalFetch = globalThis.fetch;
beforeEach(() => {
	settings.update = { ...originalUpdate, source: "update-server", proxy: { mode: "direct" } };
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

describe("helper download architecture validation", () => {
	test("rejects x64 served under ARM64 name, without caching it", async () => {
		globalThis.fetch = (async () =>
			new Response(Uint8Array.from(pe(0x8664)))) as unknown as typeof fetch;
		const spec = getCliHelperSpec("zstd", "win32", "arm64");
		if (!spec) throw new Error("Missing spec");
		expect(
			await downloadHelperBinary(
				{ ...spec, expectedSha256: createHash("sha256").update(pe(0x8664)).digest("hex") },
				{ bypassFailureCache: true },
			),
		).toBeNull();
		expect(existsSync(join(HELPER_BIN_DIR, spec.cachedName))).toBe(false);
	});
	test("downloads native ARM64 even when legacy x64 cache exists", async () => {
		writeFileSync(join(HELPER_BIN_DIR, "zstd.exe"), pe(0x8664));
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(Uint8Array.from(pe(0xaa64)));
		}) as unknown as typeof fetch;
		const spec = getCliHelperSpec("zstd", "win32", "arm64");
		if (!spec) throw new Error("Missing spec");
		spec.expectedSha256 = createHash("sha256").update(pe(0xaa64)).digest("hex");
		const path = await downloadHelperBinary(spec, { bypassFailureCache: true });
		expect(path?.startsWith(join(HELPER_BIN_DIR, "distribution"))).toBe(true);
		expect(path).toEndWith(".exe");
		expect(calls[0]).toEndWith("/api/v2/tools/zstd-win-arm64.exe");
		expect(await downloadHelperBinary(spec)).toBe(path);
		expect(calls.length).toBe(1);
	});
	test("limits chunked downloads without trusting content-length", async () => {
		let cancelled = false;
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(128));
					},
					cancel() {
						cancelled = true;
					},
				}),
			)) as unknown as typeof fetch;
		expect(
			await downloadHelperBinary(
				{ toolName: "bounded-test", cachedName: "bounded-test", displayName: "test" },
				{ maxBytes: 64, bypassFailureCache: true },
			),
		).toBeNull();
		expect(cancelled).toBe(true);
		expect(existsSync(join(HELPER_BIN_DIR, "bounded-test"))).toBe(false);
	});
});
