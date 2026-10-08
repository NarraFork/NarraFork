import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const WATCHER_PACKAGES: Record<string, string> = Object.fromEntries(
	[
		"darwin-arm64",
		"darwin-x64",
		"linux-x64-glibc",
		"linux-x64-musl",
		"linux-arm64-glibc",
		"linux-arm64-musl",
		"win32-x64",
		"win32-arm64",
	].map((key) => [key, `@parcel/watcher-${key}`]),
);
export const NATIVE_MAX_BYTES = 64 * 1024 * 1024;
export const NATIVE_TIMEOUT_MS = 60_000;

export function nativeTarget(target: string): { watcher: string; pty: string } {
	const key = target.replace(/^bun-/, "").replace(/-baseline$/, "");
	const targets: Record<string, { watcher: string; pty: string }> = {
		"darwin-arm64": { watcher: "darwin-arm64", pty: "librust_pty_arm64.dylib" },
		"darwin-x64": { watcher: "darwin-x64", pty: "librust_pty.dylib" },
		"linux-arm64": { watcher: "linux-arm64-glibc", pty: "librust_pty_arm64.so" },
		"linux-x64": { watcher: "linux-x64-glibc", pty: "librust_pty.so" },
		"windows-arm64": { watcher: "win32-arm64", pty: "rust_pty_arm64.dll" },
		"windows-x64": { watcher: "win32-x64", pty: "rust_pty.dll" },
	};
	const result = targets[key];
	if (!result) throw new Error(`Unsupported native target: ${target}`);
	return result;
}

/** Refuse wrong-architecture, empty, or text masquerading as native code. */
export function validateNativeBytes(bytes: Uint8Array, key: string): void {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const arm = key.includes("arm64");
	let valid = false;
	if (key.startsWith("linux-")) {
		valid =
			b.length >= 64 &&
			b.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) &&
			b[4] === 2 &&
			b[5] === 1 &&
			b.readUInt16LE(18) === (arm ? 183 : 62);
	} else if (key.startsWith("darwin-")) {
		valid =
			b.length >= 32 &&
			b.readUInt32LE(0) === 0xfeedfacf &&
			b.readUInt32LE(4) === (arm ? 0x100000c : 0x1000007);
	} else if (key.startsWith("win32-")) {
		if (b.length >= 64 && b.readUInt16LE(0) === 0x5a4d) {
			const pe = b.readUInt32LE(0x3c);
			valid =
				pe >= 64 &&
				pe + 6 <= b.length &&
				b.readUInt32LE(pe) === 0x4550 &&
				b.readUInt16LE(pe + 4) === (arm ? 0xaa64 : 0x8664);
		}
	}
	if (!valid) throw new Error(`Native binary format/architecture mismatch: ${key}`);
}

export function readNativeFile(path: string, key: string): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size === 0 || stat.size > NATIVE_MAX_BYTES) {
		throw new Error(`Invalid native file or size: ${path}`);
	}
	const bytes = readFileSync(path);
	validateNativeBytes(bytes, key);
	return bytes;
}

export function validatePtyDependency(root: string, target: string): void {
	const { watcher, pty } = nativeTarget(target);
	readNativeFile(join(root, "node_modules/bun-pty/rust-pty/target/release", pty), watcher);
	// The installed package must retain its compile-time embedding branch, not only
	// a runtime disk fallback (which cannot work on a clean smoke runner).
	const source = readFileSync(join(root, "node_modules/bun-pty/src/terminal.ts"), "utf8");
	if (!source.includes(`"${pty}"`) || !source.includes("require(`../rust-pty/target/release/")) {
		throw new Error(`bun-pty does not embed the selected native library: ${pty}`);
	}
}

/** Bun's text lock stores each package tuple on one line; reject ambiguity. */
export function lockedWatcherIdentity(lock: string, name: string, version: string): string {
	const prefix = `${JSON.stringify(name)}:`;
	const rows = lock
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) => line.startsWith(prefix) && line.slice(prefix.length).trimStart().startsWith("["),
		);
	if (rows.length !== 1) throw new Error(`Missing or ambiguous lock entry: ${name}`);
	const tuple: unknown = JSON.parse(rows[0].slice(prefix.length).replace(/,\s*$/, ""));
	if (!Array.isArray(tuple) || tuple[0] !== `${name}@${version}`) {
		throw new Error(`Watcher lock version mismatch: ${name}@${version}`);
	}
	const integrity = tuple.at(-1);
	if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
		throw new Error(`Missing SHA-512 lock integrity: ${name}`);
	}
	return integrity;
}

export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
	if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
		throw new Error("Watcher tarball integrity mismatch");
	}
}

export async function readBoundedStream(
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	limit = NATIVE_MAX_BYTES,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error(`Watcher stream exceeds ${limit} byte limit`);
			chunks.push(value);
		}
		return Buffer.concat(chunks, size);
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Restricted npm tar: only regular files/directories beneath package/. No links/PAX. */
export function extractWatcherTar(tar: Uint8Array, name: string, version: string): Uint8Array {
	if (tar.length > NATIVE_MAX_BYTES || tar.length % 512 !== 0) throw new Error("Invalid tar size");
	const b = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
	const files = new Map<string, Uint8Array>();
	const seen = new Set<string>();
	let offset = 0;
	let ended = false;
	for (let count = 0; offset + 512 <= b.length; count++) {
		if (count >= 256) throw new Error("Watcher tar entry limit exceeded");
		const h = b.subarray(offset, offset + 512);
		if (h.every((v) => v === 0)) {
			if (offset + 1024 > b.length || !b.subarray(offset).every((v) => v === 0)) {
				throw new Error("Malformed tar terminator");
			}
			ended = true;
			break;
		}
		const text = (start: number, length: number) =>
			h
				.subarray(start, start + length)
				.toString("utf8")
				.split("\0")[0];
		const octal = (start: number, length: number) => {
			const field = text(start, length).trim();
			if (!/^[0-7]+$/.test(field)) throw new Error("Invalid tar numeric field");
			return Number.parseInt(field, 8);
		};
		const checksum = h.reduce(
			(sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
			0,
		);
		if (checksum !== octal(148, 8)) throw new Error("Invalid tar checksum");
		const prefix = text(345, 155);
		const path = `${prefix ? `${prefix}/` : ""}${text(0, 100)}`;
		const normalized = path.replace(/\/$/, "");
		if (
			!/^package(?:\/[A-Za-z0-9_.@+-]+)*$/.test(normalized) ||
			normalized.split("/").some((part) => part === "." || part === "..") ||
			seen.has(normalized)
		) {
			throw new Error(`Unsafe or duplicate tar path: ${path}`);
		}
		seen.add(normalized);
		const size = octal(124, 12);
		const type = h[156];
		if (type !== 0 && type !== 48 && type !== 53) throw new Error(`Unsupported tar entry: ${path}`);
		if (type === 53 && size !== 0) throw new Error("Nonempty tar directory");
		const start = offset + 512;
		const end = start + size;
		if (end > b.length || size > NATIVE_MAX_BYTES) throw new Error("Truncated tar entry");
		if (type !== 53 && (path === "package/watcher.node" || path === "package/package.json")) {
			files.set(path, b.subarray(start, end));
		}
		offset = start + Math.ceil(size / 512) * 512;
	}
	if (!ended) throw new Error("Missing tar terminator");
	const manifest = files.get("package/package.json");
	const binary = files.get("package/watcher.node");
	if (!manifest || manifest.length > 64 * 1024 || !binary?.length)
		throw new Error("Missing watcher package contents");
	const pkg = JSON.parse(Buffer.from(manifest).toString("utf8"));
	if (pkg.name !== name || pkg.version !== version)
		throw new Error("Watcher package identity mismatch");
	return binary;
}

export async function downloadWatcher(
	name: string,
	version: string,
	integrity: string,
	fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
	timeoutMs = NATIVE_TIMEOUT_MS,
	onVerifiedTarball?: (tarball: Uint8Array) => void,
): Promise<Uint8Array> {
	const signal = AbortSignal.timeout(timeoutMs);
	const url = `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`;
	const response = await fetcher(url, { signal, redirect: "error" });
	if (!response.ok || !response.body)
		throw new Error(`Watcher download failed: ${response.status}`);
	const length = response.headers.get("content-length");
	if (length && (!/^\d+$/.test(length) || Number(length) > NATIVE_MAX_BYTES)) {
		await response.body.cancel();
		throw new Error("Watcher download exceeds size limit");
	}
	const compressed = await readBoundedStream(response.body, signal);
	verifyIntegrity(compressed, integrity);
	const raw = await readBoundedStream(
		new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(new DecompressionStream("gzip")),
		signal,
	);
	const binary = extractWatcherTar(raw, name, version);
	signal.throwIfAborted();
	onVerifiedTarball?.(compressed);
	return binary;
}

export async function watcherCacheMatches(
	path: string,
	key: string,
	name: string,
	version: string,
	integrity: string,
): Promise<boolean> {
	try {
		const receiptPath = `${path}.json`;
		const stat = lstatSync(receiptPath);
		if (!stat.isFile() || stat.size > 4096) return false;
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		const bytes = readNativeFile(path, key);
		if (
			receipt.name !== name ||
			receipt.version !== version ||
			receipt.integrity !== integrity ||
			receipt.sha256 !== createHash("sha256").update(bytes).digest("hex")
		)
			return false;
		// A mutable receipt alone is not proof that the binary came from the locked tarball.
		// Reauthenticate the cached archive, then compare its exact extracted bytes.
		const tarPath = `${path}.tgz`;
		const tarStat = lstatSync(tarPath);
		if (!tarStat.isFile() || tarStat.size > NATIVE_MAX_BYTES) return false;
		const compressed = readFileSync(tarPath);
		verifyIntegrity(compressed, integrity);
		const signal = AbortSignal.timeout(NATIVE_TIMEOUT_MS);
		const raw = await readBoundedStream(
			new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
			signal,
		);
		const authenticated = extractWatcherTar(raw, name, version);
		signal.throwIfAborted();
		return bytes.equals(authenticated);
	} catch {
		return false;
	}
}
