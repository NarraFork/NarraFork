import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	downloadWatcher,
	extractWatcherTar,
	lockedWatcherIdentity,
	NATIVE_MAX_BYTES,
	nativeTarget,
	readBoundedStream,
	validateNativeBytes,
	validatePtyDependency,
	verifyIntegrity,
	watcherCacheMatches,
} from "../../scripts/lib/ci-build-native";

const dirs: string[] = [];
function temp() {
	const path = mkdtempSync(join(process.cwd(), ".narrafork/ci-native-"));
	dirs.push(path);
	return path;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const name = "@parcel/watcher-linux-x64-glibc";
const version = "2.5.6";
function integrity(bytes: Uint8Array) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
function elf(arm = false) {
	const bytes = Buffer.alloc(64);
	bytes.set([0x7f, 69, 76, 70, 2, 1]);
	bytes.writeUInt16LE(arm ? 183 : 62, 18);
	return bytes;
}
function entry(path: string, data = Buffer.alloc(0), type = "0") {
	const header = Buffer.alloc(512);
	header.write(path);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.fill(32, 148, 156);
	header.write(type, 156);
	header.write("ustar\0", 257);
	const sum = header.reduce((a, b) => a + b, 0);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function archive(extra: Buffer[] = [], packageVersion = version) {
	return Buffer.concat([
		entry("package/package.json", Buffer.from(JSON.stringify({ name, version: packageVersion }))),
		entry("package/watcher.node", elf()),
		...extra,
		Buffer.alloc(1024),
	]);
}

describe("CI native dependency validation", () => {
	test("all eight build targets map to the correct native architecture", () => {
		for (const [target, watcher, pty] of [
			["linux-x64", "linux-x64-glibc", "librust_pty.so"],
			["linux-x64-baseline", "linux-x64-glibc", "librust_pty.so"],
			["linux-arm64", "linux-arm64-glibc", "librust_pty_arm64.so"],
			["windows-x64", "win32-x64", "rust_pty.dll"],
			["windows-x64-baseline", "win32-x64", "rust_pty.dll"],
			["windows-arm64", "win32-arm64", "rust_pty_arm64.dll"],
			["darwin-x64", "darwin-x64", "librust_pty.dylib"],
			["darwin-arm64", "darwin-arm64", "librust_pty_arm64.dylib"],
		])
			expect(nativeTarget(`bun-${target}`)).toEqual({ watcher, pty });
		expect(() => nativeTarget("arm64")).toThrow();
	});
	test("requires exact installed/locked watcher version and sha512", () => {
		const sha = integrity(elf());
		const lock = `  "${name}": ["${name}@${version}", "", {}, "${sha}"],`;
		expect(lockedWatcherIdentity(lock, name, version)).toBe(sha);
		expect(() => lockedWatcherIdentity(lock, name, "1.0.0")).toThrow("version");
		expect(() => lockedWatcherIdentity(lock.replace(sha, "sha1-a"), name, version)).toThrow(
			"integrity",
		);
		expect(() => lockedWatcherIdentity(`${lock}\n${lock}`, name, version)).toThrow("ambiguous");
		expect(() => verifyIntegrity(Buffer.from("tampered"), sha)).toThrow("integrity");
		const actualLock = readFileSync("bun.lock", "utf8");
		const installed = JSON.parse(readFileSync("node_modules/@parcel/watcher/package.json", "utf8"));
		expect(lockedWatcherIdentity(actualLock, "@parcel/watcher", installed.version)).toStartWith(
			"sha512-",
		);
	});
	test("rejects missing, symlinked and wrong-architecture PTY, never arm64 fallback to x64", () => {
		const root = temp();
		expect(() => validatePtyDependency(root, "bun-windows-arm64")).toThrow();
		const lib = join(root, "node_modules/bun-pty/rust-pty/target/release");
		mkdirSync(lib, { recursive: true });
		writeFileSync(join(lib, "rust_pty.dll"), elf());
		expect(() => validatePtyDependency(root, "bun-windows-arm64")).toThrow();
		writeFileSync(join(lib, "librust_pty.so"), elf(true));
		expect(() => validatePtyDependency(root, "bun-linux-x64")).toThrow("architecture");
		rmSync(join(lib, "librust_pty.so"));
		symlinkSync(join(lib, "rust_pty.dll"), join(lib, "librust_pty.so"));
		expect(() => validatePtyDependency(root, "bun-linux-x64")).toThrow("Invalid native");
	});
	test("checks native ELF, Mach-O and PE machine fields", () => {
		validateNativeBytes(elf(), "linux-x64-glibc");
		expect(() => validateNativeBytes(elf(), "linux-arm64-glibc")).toThrow();
		const mach = Buffer.alloc(32);
		mach.writeUInt32LE(0xfeedfacf);
		mach.writeUInt32LE(0x100000c, 4);
		validateNativeBytes(mach, "darwin-arm64");
		expect(() => validateNativeBytes(mach, "darwin-x64")).toThrow();
		const pe = Buffer.alloc(128);
		pe.writeUInt16LE(0x5a4d);
		pe.writeUInt32LE(64, 60);
		pe.writeUInt32LE(0x4550, 64);
		pe.writeUInt16LE(0xaa64, 68);
		validateNativeBytes(pe, "win32-arm64");
		expect(() => validateNativeBytes(pe, "win32-x64")).toThrow();
	});
	test("extracts only exact package contents and verifies manifest version", () => {
		expect(Buffer.from(extractWatcherTar(archive(), name, version))).toEqual(elf());
		expect(() => extractWatcherTar(archive([], "9.0.0"), name, version)).toThrow("identity");
		for (const bad of [
			entry("../watcher.node"),
			entry("package/../watcher.node"),
			entry("/package/watcher.node"),
			entry("package/link", Buffer.alloc(0), "2"),
			entry("package/hardlink", Buffer.alloc(0), "1"),
			entry("package/pax", Buffer.alloc(0), "x"),
			entry("package/watcher.node", elf()),
		]) {
			expect(() => extractWatcherTar(archive([bad]), name, version)).toThrow();
		}
		const broken = archive();
		broken[0] ^= 1;
		expect(() => extractWatcherTar(broken, name, version)).toThrow("checksum");
		expect(() => extractWatcherTar(archive().subarray(0, 1024), name, version)).toThrow();
	});
	test("downloads authenticated fixture and rejects HTTP/integrity/size failures", async () => {
		const compressed = gzipSync(archive());
		const fetcher = async () => new Response(compressed);
		expect(
			Buffer.from(await downloadWatcher(name, version, integrity(compressed), fetcher)),
		).toEqual(elf());
		await expect(downloadWatcher(name, version, integrity(elf()), fetcher)).rejects.toThrow(
			"integrity",
		);
		await expect(
			downloadWatcher(
				name,
				version,
				integrity(compressed),
				async () => new Response(null, { status: 404 }),
			),
		).rejects.toThrow("404");
		await expect(
			downloadWatcher(
				name,
				version,
				integrity(compressed),
				async () =>
					new Response("x", { headers: { "content-length": String(NATIVE_MAX_BYTES + 1) } }),
			),
		).rejects.toThrow("size");
	});
	test("enforces decompression, streaming and stall budgets", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(9));
				c.close();
			},
		});
		await expect(readBoundedStream(stream, new AbortController().signal, 8)).rejects.toThrow(
			"limit",
		);
		const stalled = new ReadableStream<Uint8Array>();
		await expect(readBoundedStream(stalled, AbortSignal.timeout(20))).rejects.toThrow();
		const bomb = gzipSync(Buffer.alloc(NATIVE_MAX_BYTES + 1024));
		await expect(
			downloadWatcher(name, version, integrity(bomb), async () => new Response(bomb)),
		).rejects.toThrow("limit");
	});
	test("cache requires version, lock integrity, regular file, and native digest", async () => {
		const file = join(temp(), "watcher.node");
		const bytes = elf();
		const tarball = gzipSync(archive());
		const sha = integrity(tarball);
		writeFileSync(file, bytes);
		writeFileSync(`${file}.tgz`, tarball);
		expect(await watcherCacheMatches(file, "linux-x64-glibc", name, version, sha)).toBe(false);
		writeFileSync(
			`${file}.json`,
			JSON.stringify({
				name,
				version,
				integrity: sha,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			}),
		);
		expect(await watcherCacheMatches(file, "linux-x64-glibc", name, version, sha)).toBe(true);
		expect(await watcherCacheMatches(file, "linux-x64-glibc", name, "9.0.0", sha)).toBe(false);
		expect(
			await watcherCacheMatches(
				file,
				"linux-x64-glibc",
				name,
				version,
				integrity(Buffer.from("new tar")),
			),
		).toBe(false);
		const changed = Buffer.concat([bytes, Buffer.from("changed")]);
		writeFileSync(file, changed);
		expect(await watcherCacheMatches(file, "linux-x64-glibc", name, version, sha)).toBe(false);
		// Forging both the native file and receipt still cannot forge the lock's tarball integrity.
		writeFileSync(
			`${file}.json`,
			JSON.stringify({
				name,
				version,
				integrity: sha,
				sha256: createHash("sha256").update(changed).digest("hex"),
			}),
		);
		expect(await watcherCacheMatches(file, "linux-x64-glibc", name, version, sha)).toBe(false);
	});
});
