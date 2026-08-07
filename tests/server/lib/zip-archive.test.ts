import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
	extractZipArchive,
	normalizeZipEntryName,
	readZipArchive,
	ZipArchiveError,
} from "@server/lib/zip-archive";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-zip-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Build a zip with the system `zip` binary (only used to produce fixtures). */
async function zipDirectory(sourceDir: string, archivePath: string, args: string[] = ["-q", "-r"]) {
	const proc = Bun.spawn(["zip", ...args, archivePath, "."], {
		cwd: sourceDir,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`zip failed: ${stderr}`);
	}
}

/**
 * Hand-build a minimal zip so tests do not depend on the `zip` binary for the
 * cases that matter most (traversal names, stored vs deflated entries).
 */
function buildZip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBytes = Buffer.from(file.name, "utf8");
		const stored = file.deflate ? deflateRawSync(file.data) : file.data;
		const crc = Bun.hash.crc32(file.data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(file.deflate ? 8 : 0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, stored);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(file.deflate ? 8 : 0, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(stored.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + stored.length;
	}

	const localBlock = Buffer.concat(locals);
	const centralBlock = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBlock.length, 12);
	eocd.writeUInt32LE(localBlock.length, 16);
	return Buffer.concat([localBlock, centralBlock, eocd]);
}

describe("zip-archive", () => {
	test("reads and extracts stored and deflated entries with correct bytes", async () => {
		const root = await makeTempRoot();
		const archive = join(root, "mixed.zip");
		const text = Buffer.from("hello ".repeat(500), "utf8");
		const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
		await writeFile(
			archive,
			buildZip([
				{ name: "nested/text.txt", data: text, deflate: true },
				{ name: "raw.bin", data: binary },
			]),
		);

		const info = await readZipArchive(archive);
		expect(info.fileCount).toBe(2);
		expect(info.entries.map((entry) => entry.name)).toEqual(["nested/text.txt", "raw.bin"]);
		expect(info.totalUncompressedBytes).toBe(text.length + binary.length);

		const destination = join(root, "out");
		const result = await extractZipArchive(archive, destination);
		expect(result.files).toBe(2);
		expect(await readFile(join(destination, "nested", "text.txt"))).toEqual(text);
		expect(await readFile(join(destination, "raw.bin"))).toEqual(binary);
	});

	test("accepts `./`-prefixed names, which some writers emit and unzip accepted", async () => {
		const root = await makeTempRoot();
		const archive = join(root, "dot.zip");
		await writeFile(
			archive,
			buildZip([
				{ name: "./manifest.json", data: Buffer.from('{"pluginId":"com.example.hello"}') },
				{ name: "./server/./index.js", data: Buffer.from("export default {};\n") },
			]),
		);

		const destination = join(root, "out");
		const result = await extractZipArchive(archive, destination);
		expect(result.files).toBe(2);
		expect(await readFile(join(destination, "manifest.json"), "utf8")).toContain("com.example");
		expect(await readFile(join(destination, "server", "index.js"), "utf8")).toContain("export");
	});

	test("still rejects `..` hidden behind a `.` segment", async () => {
		const root = await makeTempRoot();
		const archive = join(root, "sneaky.zip");
		await writeFile(archive, buildZip([{ name: "./../escape.txt", data: Buffer.from("x") }]));
		await expect(extractZipArchive(archive, join(root, "out"))).rejects.toThrow(
			/escapes its root/i,
		);
		await expect(stat(join(root, "escape.txt"))).rejects.toThrow();
	});

	test("rejects a name made only of `.` segments (it addresses the root itself)", () => {
		expect(() => normalizeZipEntryName("./.")).toThrow(/no usable path/i);
	});

	test("rejects path traversal entry names before writing anything", async () => {
		const root = await makeTempRoot();
		const archive = join(root, "evil.zip");
		await writeFile(
			archive,
			buildZip([{ name: "../escape.txt", data: Buffer.from("escape", "utf8") }]),
		);

		const destination = join(root, "out");
		await expect(extractZipArchive(archive, destination)).rejects.toThrow(/escapes its root/i);
		await expect(stat(join(root, "escape.txt"))).rejects.toThrow();
	});

	test("rejects absolute and backslash entry names", async () => {
		const root = await makeTempRoot();
		const absolute = join(root, "absolute.zip");
		await writeFile(absolute, buildZip([{ name: "/etc/evil", data: Buffer.from("x") }]));
		await expect(extractZipArchive(absolute, join(root, "a"))).rejects.toThrow(/absolute/i);

		const backslash = join(root, "backslash.zip");
		await writeFile(backslash, buildZip([{ name: "dir\\evil", data: Buffer.from("x") }]));
		await expect(extractZipArchive(backslash, join(root, "b"))).rejects.toThrow(/backslash/i);
	});

	test("enforces per-file and total size caps", async () => {
		const root = await makeTempRoot();
		const archive = join(root, "big.zip");
		const payload = Buffer.alloc(4096, 0x41);
		await writeFile(archive, buildZip([{ name: "big.bin", data: payload, deflate: true }]));

		await expect(readZipArchive(archive, { maxFileBytes: 1024 })).rejects.toThrow(/file limit/i);
		await expect(readZipArchive(archive, { maxTotalBytes: 1024 })).rejects.toThrow(
			/unpacked limit/i,
		);
		await expect(readZipArchive(archive, { maxEntries: 0 })).rejects.toThrow(/more than 0/i);
	});

	test("fails a corrupted entry instead of writing wrong bytes", async () => {
		const root = await makeTempRoot();
		const archive = join(root, "corrupt.zip");
		const bytes = buildZip([{ name: "data.txt", data: Buffer.from("original", "utf8") }]);
		// Flip a byte inside the stored data so the CRC no longer matches.
		const dataStart = 30 + Buffer.byteLength("data.txt");
		bytes[dataStart] = bytes[dataStart] ^ 0xff;
		await writeFile(archive, bytes);

		await expect(extractZipArchive(archive, join(root, "out"))).rejects.toThrow(/CRC/i);
	});

	test("rejects files that are not zip archives", async () => {
		const root = await makeTempRoot();
		const notZip = join(root, "plain.txt");
		await writeFile(notZip, "definitely not a zip archive");
		await expect(readZipArchive(notZip)).rejects.toThrow(ZipArchiveError);
	});

	test("round-trips an archive produced by the system zip binary", async () => {
		if (!Bun.which("zip")) return;
		const root = await makeTempRoot();
		const source = join(root, "src");
		await mkdir(join(source, "server"), { recursive: true });
		await writeFile(join(source, "manifest.json"), '{"pluginId":"com.example.hello"}');
		await writeFile(join(source, "server", "index.js"), "export default {};\n");
		const archive = join(root, "package.zip");
		await zipDirectory(source, archive);

		const destination = join(root, "out");
		await extractZipArchive(archive, destination);
		expect(await readFile(join(destination, "manifest.json"), "utf8")).toContain(
			"com.example.hello",
		);
		expect(await readFile(join(destination, "server", "index.js"), "utf8")).toContain("export");
	});
});
