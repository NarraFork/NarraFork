// Archive core for independent build/CI/import CLIs. Static imports are deliberately bundleable.
// Not callable from NF request handlers or the remote host's assetHandler.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { parseRemoteFrontendCapability } from "../../shared/remote-access/application";
import {
	REMOTE_FRONTEND_ARCHIVE_MAX_BYTES as ARCHIVE_MAX,
	computeRemoteFrontendBuildId,
	REMOTE_FRONTEND_EXPANDED_MAX_BYTES as EXPANDED_MAX,
	REMOTE_FRONTEND_FILE_MAX_BYTES as FILE_MAX,
	REMOTE_FRONTEND_MAX_FILES as FILES_MAX,
	isRemoteFrontendAssetPath,
	REMOTE_FRONTEND_MANIFEST_MAX_BYTES as MANIFEST_MAX,
	parseRemoteFrontendManifest,
	type RemoteFrontendFile,
	type RemoteFrontendManifest,
	remoteFrontendArtifactNames,
} from "../../shared/remote-access/frontend-manifest";
import type { RemoteFrontendArtifactTarget } from "./remote-frontend-artifact";

const TAR_MAX = EXPANDED_MAX + FILES_MAX * 1024 + 1024;
const CHUNK = 64 * 1024;
const operationSignal = new AsyncLocalStorage<AbortSignal>();
const check = () => operationSignal.getStore()?.throwIfAborted();
function failure(code: string): never {
	throw new Error(`REMOTE_FRONTEND_${code}`);
}
const sha = () => createHash("sha256");

async function directory(path: string): Promise<void> {
	for (let current = resolve(path); ; current = dirname(current)) {
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) failure("DIRECTORY_UNSAFE");
		if (dirname(current) === current) return;
	}
}
async function regular(path: string, maximum: number) {
	check();
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
		failure("FILE_TYPE_OR_SIZE");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maximum || stat.dev !== before.dev || stat.ino !== before.ino)
			failure("FILE_CHANGED");
		return { handle, stat };
	} catch (error) {
		await handle.close();
		throw error;
	}
}
async function small(path: string, maximum = MANIFEST_MAX): Promise<Buffer> {
	const { handle } = await regular(path, maximum);
	try {
		const result = Buffer.alloc(maximum + 1);
		let offset = 0;
		while (offset < result.length) {
			const { bytesRead } = await handle.read(result, offset, result.length - offset, null);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > maximum) failure("FILE_TOO_LARGE");
		return result.subarray(0, offset);
	} finally {
		await handle.close();
	}
}
async function* readChunks(handle: Awaited<ReturnType<typeof open>>, maximum: number) {
	let total = 0;
	while (true) {
		check();
		const chunk = Buffer.alloc(Math.min(CHUNK, maximum - total + 1));
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
		if (!bytesRead) return;
		total += bytesRead;
		if (total > maximum) failure("FILE_TOO_LARGE");
		yield chunk.subarray(0, bytesRead);
	}
}
async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
	for (let offset = 0; offset < data.length; ) {
		check();
		const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
		if (!bytesWritten) failure("WRITE_FAILED");
		offset += bytesWritten;
	}
}
async function writeExclusive(path: string, data: Uint8Array): Promise<void> {
	const handle = await open(path, "wx", 0o600);
	try {
		await writeAll(handle, data);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
function targetMatch(manifest: RemoteFrontendManifest, target: RemoteFrontendArtifactTarget): void {
	if (
		manifest.repository !== target.repository ||
		manifest.nfVersion !== target.version ||
		manifest.sourceCommit !== target.commit ||
		JSON.stringify(manifest.capability) !==
			JSON.stringify(parseRemoteFrontendCapability(target.capability))
	)
		failure("TARGET_MISMATCH");
}
async function load(directoryPath: string, target: RemoteFrontendArtifactTarget) {
	await directory(directoryPath);
	const names = remoteFrontendArtifactNames(target.version);
	const raw = await small(join(directoryPath, names.manifest));
	const manifest = parseRemoteFrontendManifest(JSON.parse(raw.toString("utf8")));
	targetMatch(manifest, target);
	if ((await computeRemoteFrontendBuildId(manifest)) !== manifest.buildId)
		failure("BUILD_ID_MISMATCH");
	return { manifest, raw, manifestSha256: sha().update(raw).digest("hex") };
}

interface SourceFile {
	path: string;
	size: number;
	absolute: string;
}
async function sources(root: string, installed = false): Promise<SourceFile[]> {
	await directory(root);
	const files: SourceFile[] = [];
	let nodes = 0,
		total = 0;
	const folded = new Set<string>();
	async function visit(relative: string): Promise<void> {
		const entries = await opendir(join(root, relative));
		for await (const entry of entries) {
			check();
			if (++nodes > FILES_MAX * 2) failure("TREE_TOO_LARGE");
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			const absolute = join(root, path);
			const stat = await lstat(absolute);
			if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
				failure("FILE_TYPE_OR_SIZE");
			if (!installed && (path === ".vite" || path === "remote-module-graph.json")) continue;
			if (installed && path === "manifest.json") continue;
			if (!isRemoteFrontendAssetPath(path)) failure("PATH_INVALID");
			const lower = path.toLowerCase();
			if (folded.has(lower)) failure("CASE_COLLISION");
			folded.add(lower);
			if (stat.isDirectory()) {
				await visit(path);
				continue;
			}
			total += stat.size;
			if (stat.size > FILE_MAX || files.length >= FILES_MAX || total > EXPANDED_MAX)
				failure("FILE_OR_EXPANDED_LIMIT");
			files.push({ path, size: stat.size, absolute });
		}
	}
	await visit("");
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}
function field(header: Buffer, offset: number, length: number, value: string): void {
	const bytes = Buffer.from(value, "ascii");
	if (bytes.length > length) failure("TAR_PATH_LENGTH");
	bytes.copy(header, offset);
}
function octal(header: Buffer, offset: number, length: number, value: number): void {
	field(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}
function tarHeader(path: string, size: number): Buffer {
	const header = Buffer.alloc(512);
	let name = path,
		prefix = "";
	if (Buffer.byteLength(name) > 100) {
		const slash = path.lastIndexOf("/");
		if (slash < 1) failure("TAR_PATH_LENGTH");
		prefix = path.slice(0, slash);
		name = path.slice(slash + 1);
	}
	field(header, 0, 100, name);
	octal(header, 100, 8, 0o644);
	octal(header, 108, 8, 0);
	octal(header, 116, 8, 0);
	octal(header, 124, 12, size);
	octal(header, 136, 12, 0);
	header.fill(32, 148, 156);
	header[156] = 48;
	field(header, 257, 6, "ustar\0");
	field(header, 263, 2, "00");
	field(header, 345, 155, prefix);
	const checksum = header.reduce((sum, value) => sum + value, 0);
	field(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	return header;
}
function stringField(header: Buffer, start: number, length: number): string {
	const bytes = header.subarray(start, start + length);
	const zero = bytes.indexOf(0);
	if (zero !== -1 && bytes.subarray(zero).some((value) => value !== 0))
		failure("TAR_STRING_PADDING");
	return bytes.subarray(0, zero === -1 ? bytes.length : zero).toString("ascii");
}
function numberField(header: Buffer, start: number, length: number): number {
	const raw = header.subarray(start, start + length);
	if (raw.some((n) => n > 127)) failure("TAR_NUMBER");
	const text = raw
		.toString("ascii")
		.replace(/[\0 ]+$/g, "")
		.trimStart();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) failure("TAR_NUMBER");
	const value = Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value)) failure("TAR_NUMBER");
	return value;
}
function parseTarHeader(header: Buffer): { path: string; size: number } {
	const expected = numberField(header, 148, 8);
	let checksum = 0;
	for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
	if (
		checksum !== expected ||
		!header.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
		header.toString("ascii", 263, 265) !== "00"
	)
		failure("TAR_HEADER");
	if (![0, 48].includes(header[156]) || header.subarray(157, 257).some((n) => n !== 0))
		failure("TAR_SPECIAL_ENTRY");
	if (
		header.subarray(0, 100).some((n) => n > 127) ||
		header.subarray(345, 500).some((n) => n > 127)
	)
		failure("PATH_INVALID");
	const prefix = stringField(header, 345, 155),
		name = stringField(header, 0, 100),
		path = prefix ? `${prefix}/${name}` : name;
	if (!isRemoteFrontendAssetPath(path)) failure("PATH_INVALID");
	const size = numberField(header, 124, 12);
	if (size > FILE_MAX || numberField(header, 100, 8) > 0o777) failure("FILE_TYPE_OR_SIZE");
	return { path, size };
}
class TarReader {
	private readonly iterator: AsyncIterator<Buffer>;
	private chunk = Buffer.alloc(0);
	private position = 0;
	private total = 0;
	constructor(stream: Readable) {
		this.iterator = stream[Symbol.asyncIterator]();
	}
	async read(size: number, allowEOF = false): Promise<Buffer | null> {
		const result = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			check();
			if (this.position === this.chunk.length) {
				const next = await this.iterator.next();
				if (next.done) {
					if (!offset && allowEOF) return null;
					failure("TAR_TRUNCATED");
				}
				this.chunk = Buffer.from(next.value);
				this.position = 0;
				this.total += this.chunk.length;
				if (this.total > TAR_MAX) failure("EXPANDED_TOO_LARGE");
			}
			const n = Math.min(size - offset, this.chunk.length - this.position);
			this.chunk.copy(result, offset, this.position, this.position + n);
			this.position += n;
			offset += n;
		}
		return result;
	}
}
async function inspectArchive(
	directoryPath: string,
	manifest: RemoteFrontendManifest,
	staging?: string,
): Promise<void> {
	if (staging) {
		await directory(staging);
		const entries = await opendir(staging);
		for await (const _entry of entries) failure("STAGING_NOT_EMPTY");
	}
	const source = await regular(join(directoryPath, manifest.archive.name), ARCHIVE_MAX);
	if (source.stat.size !== manifest.archive.size) {
		await source.handle.close();
		failure("ARCHIVE_SIZE_MISMATCH");
	}
	let compressed = 0;
	const hash = sha();
	const meter = new Transform({
		transform(chunk, _encoding, callback) {
			compressed += chunk.length;
			if (compressed > ARCHIVE_MAX || compressed > manifest.archive.size) {
				callback(new Error("REMOTE_FRONTEND_ARCHIVE_TOO_LARGE"));
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	const gunzip = createGunzip();
	const input = Readable.from(readChunks(source.handle, manifest.archive.size), {
		objectMode: false,
		highWaterMark: CHUNK,
	});
	const pumping = pipeline(input, meter, gunzip, { signal: operationSignal.getStore() });
	void pumping.catch(() => {});
	const reader = new TarReader(gunzip),
		expected = new Map(manifest.files.map((file) => [file.path, file])),
		seen = new Set<string>(),
		folded = new Set<string>(),
		spellings = new Map<string, string>();
	let expanded = 0;
	try {
		while (true) {
			const header = await reader.read(512);
			if (!header) failure("TAR_TRUNCATED");
			if (header.every((n) => n === 0)) {
				const end = await reader.read(512);
				if (!end?.every((n) => n === 0) || (await reader.read(1, true)) !== null)
					failure("TAR_TRAILING_DATA");
				break;
			}
			const entry = parseTarHeader(header),
				file = expected.get(entry.path);
			if (seen.has(entry.path) || folded.has(entry.path.toLowerCase()))
				failure("ARCHIVE_DUPLICATE");
			seen.add(entry.path);
			folded.add(entry.path.toLowerCase());
			const parts = entry.path.split("/");
			for (let i = 1; i <= parts.length; i++) {
				const spelling = parts.slice(0, i).join("/"),
					key = spelling.toLowerCase(),
					previous = spellings.get(key);
				if (previous !== undefined && previous !== spelling) failure("CASE_COLLISION");
				spellings.set(key, spelling);
				if (spellings.size > FILES_MAX * 2) failure("TREE_TOO_LARGE");
			}
			expanded += entry.size;
			if (!file || file.size !== entry.size || seen.size > FILES_MAX || expanded > EXPANDED_MAX)
				failure("ARCHIVE_UNDECLARED_OR_SIZE");
			let output: Awaited<ReturnType<typeof open>> | undefined;
			if (staging) {
				const path = join(staging, entry.path);
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				output = await open(path, "wx", 0o600);
			}
			const fileHash = sha();
			try {
				for (let remaining = entry.size; remaining > 0; ) {
					const chunk = await reader.read(Math.min(remaining, CHUNK));
					if (!chunk) failure("TAR_TRUNCATED");
					remaining -= chunk.length;
					fileHash.update(chunk);
					if (output) await writeAll(output, chunk);
				}
				if (output) await output.sync();
			} finally {
				await output?.close();
			}
			if (fileHash.digest("hex") !== file.sha256) failure("FILE_HASH_MISMATCH");
			const padding = (512 - (entry.size % 512)) % 512;
			if (padding) {
				const bytes = await reader.read(padding);
				if (bytes?.some((n) => n !== 0)) failure("TAR_PADDING");
			}
		}
		await pumping;
		if (seen.size !== expected.size) failure("ARCHIVE_FILE_MISSING");
		if (compressed !== manifest.archive.size || hash.digest("hex") !== manifest.archive.sha256)
			failure("ARCHIVE_HASH_MISMATCH");
	} finally {
		input.destroy();
		gunzip.destroy();
		meter.destroy();
		await pumping.catch(() => {});
		await source.handle.close();
	}
}
async function viteEntries(
	input: string,
	files: SourceFile[],
): Promise<{ entry: string; bootstrap: string; css: string[] }> {
	const value = JSON.parse(
		(await small(join(input, ".vite", "manifest.json"))).toString("utf8"),
	) as Record<
		string,
		{
			file?: unknown;
			name?: unknown;
			isEntry?: unknown;
			imports?: unknown;
			dynamicImports?: unknown;
			css?: unknown;
		}
	>;
	if (!value || typeof value !== "object" || Array.isArray(value)) failure("VITE_MANIFEST_INVALID");
	const entries = Object.entries(value);
	if (entries.length > FILES_MAX * 2) failure("VITE_MANIFEST_INVALID");
	const select = (name: string) => {
		const found = entries.filter(([, item]) => item?.isEntry === true && item.name === name);
		if (found.length !== 1 || typeof found[0][1].file !== "string") failure("VITE_ENTRY_MISSING");
		return found[0];
	};
	const [mountKey, mount] = select("mount"),
		[, bootstrap] = select("bootstrap");
	const css = new Set<string>(),
		visited = new Set<string>(),
		declared = new Set(files.map((file) => file.path));
	function visit(key: string) {
		if (visited.has(key)) return;
		visited.add(key);
		const item = value[key];
		if (!item) failure("VITE_IMPORT_MISSING");
		if (typeof item.file !== "string" || !declared.has(item.file))
			failure("VITE_IMPORT_FILE_MISSING");
		if (item.css !== undefined) {
			if (!Array.isArray(item.css)) failure("VITE_CSS_INVALID");
			for (const path of item.css) {
				if (typeof path !== "string" || !declared.has(path) || !path.endsWith(".css"))
					failure("VITE_CSS_INVALID");
				css.add(path);
			}
		}
		for (const imports of [item.imports, item.dynamicImports]) {
			if (imports === undefined) continue;
			if (!Array.isArray(imports)) failure("VITE_IMPORT_INVALID");
			for (const key of imports) {
				if (typeof key !== "string") failure("VITE_IMPORT_INVALID");
				visit(key);
			}
		}
	}
	visit(mountKey);
	return { entry: mount.file as string, bootstrap: bootstrap.file as string, css: [...css].sort() };
}
async function build(
	inputDir: string,
	outputDir: string,
	target: RemoteFrontendArtifactTarget,
): Promise<RemoteFrontendManifest> {
	await directory(outputDir);
	const files = await sources(inputDir),
		entry = await viteEntries(inputDir, files),
		inventory: RemoteFrontendFile[] = [];
	const names = remoteFrontendArtifactNames(target.version),
		archiveHash = sha();
	let archiveSize = 0;
	async function* tar() {
		for (const file of files) {
			check();
			yield tarHeader(file.path, file.size);
			const source = await regular(file.absolute, FILE_MAX);
			const hash = sha();
			let count = 0;
			try {
				for await (const part of readChunks(source.handle, file.size)) {
					check();
					const chunk = Buffer.from(part);
					count += chunk.length;
					if (count > file.size) failure("FILE_CHANGED");
					hash.update(chunk);
					yield chunk;
				}
				const after = await source.handle.stat();
				if (
					count !== file.size ||
					after.size !== source.stat.size ||
					after.mtimeMs !== source.stat.mtimeMs ||
					after.ctimeMs !== source.stat.ctimeMs
				)
					failure("FILE_CHANGED");
			} finally {
				await source.handle.close();
			}
			inventory.push({ path: file.path, size: count, sha256: hash.digest("hex") });
			const pad = (512 - (count % 512)) % 512;
			if (pad) yield Buffer.alloc(pad);
		}
		yield Buffer.alloc(1024);
	}
	const meter = new Transform({
		transform(chunk, _encoding, callback) {
			archiveSize += chunk.length;
			if (archiveSize > ARCHIVE_MAX) {
				callback(new Error("REMOTE_FRONTEND_ARCHIVE_TOO_LARGE"));
				return;
			}
			archiveHash.update(chunk);
			callback(null, chunk);
		},
	});
	const output = await open(join(outputDir, names.archive), "wx", 0o600);
	try {
		await pipeline(
			Readable.from(tar()),
			createGzip({ level: 9 }),
			meter,
			new Writable({
				write(chunk, _encoding, callback) {
					writeAll(output, chunk).then(() => callback(), callback);
				},
			}),
			{ signal: operationSignal.getStore() },
		);
		await output.sync();
	} finally {
		await output.close();
	}
	const material = {
		repository: target.repository,
		nfVersion: target.version,
		sourceCommit: target.commit,
		capability: parseRemoteFrontendCapability(target.capability),
		...entry,
		files: inventory,
	};
	const manifest = parseRemoteFrontendManifest({
		schemaVersion: 1,
		...material,
		buildId: await computeRemoteFrontendBuildId(material),
		archive: { name: names.archive, size: archiveSize, sha256: archiveHash.digest("hex") },
	});
	const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	if (raw.length > MANIFEST_MAX) failure("MANIFEST_TOO_LARGE");
	await writeExclusive(join(outputDir, names.manifest), raw);
	await inspectArchive(outputDir, manifest);
	return manifest;
}
async function installed(
	path: string,
	expectedManifestSha256: string,
): Promise<RemoteFrontendManifest> {
	await directory(path);
	const raw = await small(join(path, "manifest.json"));
	if (sha().update(raw).digest("hex") !== expectedManifestSha256) failure("MANIFEST_HASH_MISMATCH");
	const manifest = parseRemoteFrontendManifest(JSON.parse(raw.toString("utf8")));
	if ((await computeRemoteFrontendBuildId(manifest)) !== manifest.buildId)
		failure("BUILD_ID_MISMATCH");
	const files = await sources(path, true),
		expected = new Map(manifest.files.map((file) => [file.path, file]));
	if (files.length !== expected.size) failure("INSTALLED_FILES_MISMATCH");
	for (const file of files) {
		check();
		const match = expected.get(file.path);
		if (!match || match.size !== file.size) failure("INSTALLED_FILES_MISMATCH");
		const source = await regular(file.absolute, FILE_MAX),
			hash = sha();
		let count = 0;
		try {
			for await (const chunk of readChunks(source.handle, file.size)) {
				check();
				count += chunk.length;
				if (count > file.size) failure("FILE_CHANGED");
				hash.update(chunk);
			}
		} finally {
			await source.handle.close();
		}
		if (count !== match.size || hash.digest("hex") !== match.sha256) failure("FILE_HASH_MISMATCH");
	}
	return manifest;
}
async function snapshot(
	directoryPath: string,
	destination: string,
	target: RemoteFrontendArtifactTarget,
): Promise<Record<string, never>> {
	await directory(destination);
	const { manifest, raw } = await load(directoryPath, target),
		names = remoteFrontendArtifactNames(target.version);
	await writeExclusive(join(destination, names.manifest), raw);
	const source = await regular(join(directoryPath, names.archive), ARCHIVE_MAX);
	if (source.stat.size !== manifest.archive.size) {
		await source.handle.close();
		failure("ARCHIVE_SIZE_MISMATCH");
	}
	const output = await open(join(destination, names.archive), "wx", 0o600);
	let count = 0;
	try {
		for await (const chunk of readChunks(source.handle, manifest.archive.size)) {
			check();
			count += chunk.length;
			if (count > manifest.archive.size) failure("ARCHIVE_TOO_LARGE");
			await writeAll(output, chunk);
		}
		if (count !== manifest.archive.size) failure("ARCHIVE_SIZE_MISMATCH");
		await output.sync();
	} finally {
		await source.handle.close();
		await output.close();
	}
	await inspectArchive(destination, manifest);
	return {};
}
export async function runRemoteFrontendArchiveOperation(
	operation: string,
	payload: Record<string, unknown>,
	parent?: AbortSignal,
) {
	const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(5 * 60_000)]);
	return operationSignal.run(signal, async () => {
		check();
		const args = payload as unknown as {
			inputDir: string;
			outputDir: string;
			directory: string;
			staging: string;
			destination: string;
			target: RemoteFrontendArtifactTarget;
			expectedManifestSha256: string;
		};
		if (operation === "build") return build(args.inputDir, args.outputDir, args.target);
		if (operation === "installed") return installed(args.directory, args.expectedManifestSha256);
		if (operation === "snapshot") return snapshot(args.directory, args.destination, args.target);
		if (operation !== "verify" && operation !== "extract") failure("ARCHIVE_OPERATION_INVALID");
		const loaded = await load(args.directory, args.target);
		await inspectArchive(
			args.directory,
			loaded.manifest,
			operation === "extract" ? args.staging : undefined,
		);
		if (operation === "extract") {
			await writeExclusive(join(args.staging, "manifest.json"), loaded.raw);
			return { manifest: loaded.manifest, manifestSha256: loaded.manifestSha256 };
		}
		return loaded.manifest;
	});
}
