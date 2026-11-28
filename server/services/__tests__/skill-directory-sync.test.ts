import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { constants, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AppError } from "@server/lib/errors";
import * as ids from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import {
	replaceSkillDirectory,
	snapshotSkillDefinition,
	snapshotSkillDirectory,
} from "../skill-directory-sync";

const MiB = 1024 * 1024;
type PositionalRead = (
	buffer: Buffer,
	offset: number,
	length: number,
	position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;
let root: string;

async function writeTree(directory: string, files: Record<string, string | Uint8Array>) {
	await fs.mkdir(directory, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const fullPath = join(directory, path);
		await fs.mkdir(dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, content);
	}
}

async function captureError(action: Promise<unknown>): Promise<unknown> {
	return action.then(
		() => {
			throw new Error("Expected the operation to fail");
		},
		(error: unknown) => error,
	);
}

async function makePublication() {
	const target = join(root, "installed");
	const staging = join(root, ".staging");
	await writeTree(target, { "SKILL.md": "old", "attachments/removed.txt": "old attachment" });
	await writeTree(staging, { "SKILL.md": "new", "attachments/new.bin": new Uint8Array([0, 255]) });
	return { target, staging };
}

beforeEach(async () => {
	root = await fs.mkdtemp(join(getNarraforkHome(), "skill-directory-sync-"));
});

afterEach(async () => {
	mock.restore();
	await fs.rm(root, { recursive: true, force: true });
});

describe("bounded local skill directory snapshots", () => {
	test("hashes manifests stably, independent of enumeration order", async () => {
		await writeTree(root, { "z.bin": new Uint8Array([0, 255, 1]), "SKILL.md": "body", "a/x": "x" });
		const first = await snapshotSkillDirectory(root);
		expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(await snapshotSkillDirectory(root)).toEqual(first);
		const opendir = fs.opendir;
		const enumerationSpy = spyOn(fs, "opendir").mockImplementation(async (...args) => {
			const directory = await opendir(...args);
			const children: Dirent[] = [];
			for await (const child of directory) children.push(child);
			children.reverse();
			return Object.assign(directory, {
				async *[Symbol.asyncIterator]() {
					yield* children;
				},
			});
		});
		expect(await snapshotSkillDirectory(root)).toEqual(first);
		enumerationSpy.mockRestore();
		await fs.utimes(join(root, "SKILL.md"), new Date(1000), new Date(1000));
		const touched = await snapshotSkillDirectory(root);
		expect(touched.fingerprint).not.toBe(first.fingerprint);
		await fs.writeFile(join(root, "SKILL.md"), "edit");
		const changed = await snapshotSkillDirectory(root);
		expect(changed.fingerprint).not.toBe(first.fingerprint);
	});

	test("full fingerprints detect same-content rewrite and file delete/recreate ABA", async () => {
		const path = join(root, "SKILL.md");
		await fs.writeFile(path, "body");
		await fs.utimes(path, new Date(1000), new Date(1000));
		const original = await snapshotSkillDirectory(root);
		await fs.writeFile(path, "body");
		const rewritten = await snapshotSkillDirectory(root);
		expect(rewritten.fingerprint).not.toBe(original.fingerprint);
		await fs.rename(path, join(root, "previous-file"));
		await fs.writeFile(path, "body");
		await fs.rm(join(root, "previous-file"));
		const recreated = await snapshotSkillDirectory(root);
		expect(recreated.fingerprint).not.toBe(rewritten.fingerprint);
	});

	test("full fingerprints include root and empty directory identity", async () => {
		const local = join(root, "local");
		await fs.mkdir(join(local, "empty"), { recursive: true });
		const original = await snapshotSkillDirectory(local);
		await fs.rename(join(local, "empty"), join(root, "previous-empty"));
		await fs.mkdir(join(local, "empty"));
		const changedChild = await snapshotSkillDirectory(local);
		expect(changedChild.fingerprint).not.toBe(original.fingerprint);
		await fs.rename(local, join(root, "previous-root"));
		await fs.mkdir(join(local, "empty"), { recursive: true });
		const changedRoot = await snapshotSkillDirectory(local);
		expect(changedRoot.fingerprint).not.toBe(changedChild.fingerprint);
	});

	test("accepts disabled SKILL.md names and records empty directories", async () => {
		await writeTree(root, { "SKILL.md.disabled": "body" });
		const disabled = await snapshotSkillDirectory(root);
		expect(await snapshotSkillDirectory(root)).toEqual(disabled);
		await fs.rename(join(root, "SKILL.md.disabled"), join(root, "SKILL.md"));
		expect((await snapshotSkillDirectory(root)).fingerprint).not.toBe(disabled.fingerprint);
		await fs.mkdir(join(root, "empty"));
		const withEmpty = await snapshotSkillDirectory(root);
		await fs.rmdir(join(root, "empty"));
		expect((await snapshotSkillDirectory(root)).fingerprint).not.toBe(withEmpty.fingerprint);
	});

	test("includes file permission modes", async () => {
		await writeTree(root, { "run.sh": "#!/bin/sh\n" });
		if (process.platform === "win32") {
			// Windows has no portable chmod executable bits: inject only the stat mode.
			const lstat = fs.lstat;
			const open = fs.open;
			let executable = false;
			const modeStat = (stat: Awaited<ReturnType<typeof fs.lstat>>) => {
				const mode = stat.mode as bigint | number;
				return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
					mode:
						typeof mode === "bigint"
							? (mode & ~0o111n) | (executable ? 0o111n : 0n)
							: (mode & ~0o111) | (executable ? 0o111 : 0),
				});
			};
			spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) =>
				modeStat(await lstat(...args))) as typeof fs.lstat);
			spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				const stat = handle.stat.bind(handle);
				spyOn(handle, "stat").mockImplementation((async (...statArgs: Parameters<typeof stat>) =>
					modeStat(await stat(...statArgs))) as typeof handle.stat);
				return handle;
			});
			const first = await snapshotSkillDirectory(root);
			executable = true;
			const changed = await snapshotSkillDirectory(root);
			expect(changed.fingerprint).not.toBe(first.fingerprint);
			return;
		}
		await fs.chmod(join(root, "run.sh"), 0o644);
		const first = await snapshotSkillDirectory(root);
		await fs.chmod(join(root, "run.sh"), 0o600);
		expect((await snapshotSkillDirectory(root)).fingerprint).not.toBe(first.fingerprint);
		await fs.chmod(join(root, "run.sh"), 0o755);
		expect((await snapshotSkillDirectory(root)).fingerprint).not.toBe(first.fingerprint);
	});

	test("reads files asynchronously in at most 64 KiB chunks with NOFOLLOW", async () => {
		await writeTree(root, { "asset.bin": new Uint8Array(MiB) });
		const open = fs.open;
		let reads = 0;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			expect((args[1] as number) & (constants.O_NOFOLLOW ?? 0)).toBe(constants.O_NOFOLLOW ?? 0);
			const handle = await open(...args);
			const read: PositionalRead = handle.read.bind(handle);
			spyOn(handle, "read").mockImplementation((async (...readArgs: Parameters<typeof read>) => {
				const [buffer, , length] = readArgs;
				expect((buffer as Uint8Array).byteLength).toBeLessThanOrEqual(64 * 1024);
				expect(length as number).toBeLessThanOrEqual(64 * 1024);
				reads++;
				return read(...readArgs);
			}) as typeof handle.read);
			return handle;
		});
		await snapshotSkillDirectory(root);
		expect(reads).toBe(17);
	});

	test("rejects oversized ordinary files before opening them", async () => {
		await writeTree(root, { "huge.bin": new Uint8Array(MiB + 1) });
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LIMIT",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("accepts the exact 10 MiB total byte budget and rejects an extra byte", async () => {
		const files: Record<string, Uint8Array> = {};
		for (let index = 0; index < 10; index++) files[`file-${index}`] = new Uint8Array(MiB);
		await writeTree(root, files);
		await snapshotSkillDirectory(root);
		await fs.writeFile(join(root, "extra"), "x");
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LIMIT",
		});
	});

	test("allows 100 files and rejects the 101st file", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 100; index++) files[`file-${index}`] = "";
		await writeTree(root, files);
		await snapshotSkillDirectory(root);
		await fs.writeFile(join(root, "extra"), "");
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LIMIT",
		});
	});

	test("allows 512 entries and rejects the 513th entry", async () => {
		for (let index = 0; index < 512; index++) await fs.mkdir(join(root, `dir-${index}`));
		await snapshotSkillDirectory(root);
		await fs.mkdir(join(root, "extra"));
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LIMIT",
		});
	});

	test("uses portable imported paths and the eight-segment depth budget", async () => {
		const deep = Array.from({ length: 8 }, (_, index) => `d${index}`).join("/");
		await fs.mkdir(join(root, deep), { recursive: true });
		await snapshotSkillDirectory(root);
		await fs.writeFile(join(root, deep, "too-deep"), "");
		await expect(snapshotSkillDirectory(root)).rejects.toThrow("depth limit");
	});

	test("rejects portable-path violations before opening their content", async () => {
		await fs.writeFile(join(root, "unsafe "), "");
		// Win32 strips trailing spaces, so present its entry name as an invalid portable name.
		if (process.platform === "win32") {
			const opendir = fs.opendir;
			spyOn(fs, "opendir").mockImplementation(async (...args) => {
				const directory = await opendir(...args);
				return Object.assign(directory, {
					async *[Symbol.asyncIterator]() {
						try {
							yield { name: "unsafe " };
						} finally {
							await directory.close();
						}
					},
				});
			});
		}
		await expect(snapshotSkillDirectory(root)).rejects.toThrow("unsafe or unsupported path");
	});

	test.each([
		["asset", "ASSET"],
		["é", "e\u0301"],
		["ß", "ss"],
	])("rejects casefold collisions between %s and %s", async (first, second) => {
		await writeTree(root, { [first]: "x" });
		const opendir = fs.opendir;
		spyOn(fs, "opendir").mockImplementation(async (...args) => {
			const directory = await opendir(...args);
			return Object.assign(directory, {
				async *[Symbol.asyncIterator]() {
					try {
						yield { name: first };
						yield { name: second };
					} finally {
						await directory.close();
					}
				},
			});
		});
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
	});

	test("rejects symlinked roots and nested directories without reading their files", async () => {
		const outside = join(root, "outside");
		const local = join(root, "local");
		await writeTree(outside, { secret: "must not read" });
		await fs.mkdir(local);
		const linked = join(local, "linked");
		await fs.symlink(outside, linked, "junction");
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDirectory(linked))).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
		expect(await captureError(snapshotSkillDirectory(local))).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("rejects symlinked regular files before opening their content", async () => {
		const outside = join(root, "outside");
		const local = join(root, "local");
		await fs.writeFile(outside, "must not read");
		await fs.mkdir(local);
		await fs.symlink(outside, join(local, "linked.txt"), "file");
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDirectory(local))).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("does not read children of a directory swapped for a symlink during opening", async () => {
		const local = join(root, "local");
		const outside = join(root, "outside");
		await writeTree(local, { "SKILL.md": "old" });
		await writeTree(outside, { secret: "must not read" });
		const opendir = fs.opendir;
		spyOn(fs, "opendir").mockImplementation(async (...args) => {
			await fs.rename(local, join(root, "saved"));
			await fs.symlink(outside, local, "junction");
			return opendir(...args);
		});
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDirectory(local))).toMatchObject({
			code: "SKILL_SYNC_LOCAL_CHANGED",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("rejects special entries without opening them", async () => {
		await writeTree(root, { special: "placeholder" });
		const lstat = fs.lstat;
		spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
			const stat = await lstat(...args);
			if (String(args[0]).endsWith("special")) {
				Object.assign(stat, { isDirectory: () => false, isFile: () => false });
			}
			return stat;
		}) as typeof fs.lstat);
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("rejects a different inode opened after lstat", async () => {
		const local = join(root, "local");
		await writeTree(local, { "SKILL.md": "same" });
		const incoming = join(root, "incoming");
		await fs.writeFile(incoming, "same");
		const open = fs.open;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			await fs.rename(incoming, join(local, "SKILL.md"));
			return open(...args);
		});
		expect(await captureError(snapshotSkillDirectory(local))).toMatchObject({
			code: "SKILL_SYNC_LOCAL_CHANGED",
		});
	});

	test("rejects same-size writes and growing files during chunked reads", async () => {
		await writeTree(root, { "asset.bin": new Uint8Array(2 * 64 * 1024) });
		const open = fs.open;
		let grow = false;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			const read: PositionalRead = handle.read.bind(handle);
			let changed = false;
			spyOn(handle, "read").mockImplementation((async (...readArgs: Parameters<typeof read>) => {
				const result = await read(...readArgs);
				if (!changed) {
					changed = true;
					if (grow) await fs.appendFile(join(root, "asset.bin"), "x");
					else {
						await fs.writeFile(join(root, "asset.bin"), new Uint8Array(2 * 64 * 1024).fill(1));
						await fs.utimes(join(root, "asset.bin"), new Date(1000), new Date(1000));
					}
				}
				return result;
			}) as typeof handle.read);
			return handle;
		});
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LOCAL_CHANGED",
		});
		grow = true;
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LOCAL_CHANGED",
		});
	});

	test("rechecks an earlier file after reading later entries", async () => {
		await writeTree(root, { a: "a", b: "b" });
		const open = fs.open;
		let firstPath: string | undefined;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			if (!firstPath) firstPath = String(args[0]);
			else {
				await fs.writeFile(firstPath, "changed");
			}
			return open(...args);
		});
		expect(await captureError(snapshotSkillDirectory(root))).toMatchObject({
			code: "SKILL_SYNC_LOCAL_CHANGED",
		});
	});

	test("honors cancellation before enumeration and between file chunks, closing the handle", async () => {
		const before = new AbortController();
		before.abort();
		const opendirSpy = spyOn(fs, "opendir");
		expect(await captureError(snapshotSkillDirectory(root, before.signal))).toMatchObject({
			code: "SKILL_SYNC_ABORTED",
		});
		expect(opendirSpy).not.toHaveBeenCalled();
		await writeTree(root, { "asset.bin": new Uint8Array(MiB) });
		const during = new AbortController();
		const open = fs.open;
		let reads = 0;
		let closes = 0;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			const read: PositionalRead = handle.read.bind(handle);
			const close = handle.close.bind(handle);
			spyOn(handle, "read").mockImplementation((async (...readArgs: Parameters<typeof read>) => {
				const result = await read(...readArgs);
				reads++;
				during.abort();
				return result;
			}) as typeof handle.read);
			spyOn(handle, "close").mockImplementation(async () => {
				closes++;
				await close();
			});
			return handle;
		});
		expect(await captureError(snapshotSkillDirectory(root, during.signal))).toMatchObject({
			code: "SKILL_SYNC_ABORTED",
		});
		expect(reads).toBe(1);
		expect(closes).toBe(1);
	});
});

describe("bounded skill definition snapshots", () => {
	test("ignores oversized, numerous, and symlinked attachments without enumerating them", async () => {
		const files: Record<string, string | Uint8Array> = {
			"SKILL.md": "body",
			"large.bin": new Uint8Array(2 * MiB),
		};
		for (let index = 0; index < 120; index++) files[`attachment-${index}`] = "attachment";
		await writeTree(root, files);
		await fs.symlink(join(root, "large.bin"), join(root, "linked.bin"), "file");
		const opendirSpy = spyOn(fs, "opendir");
		const readdirSpy = spyOn(fs, "readdir");
		const open = fs.open;
		const opened: string[] = [];
		spyOn(fs, "open").mockImplementation(async (...args) => {
			opened.push(String(args[0]));
			return open(...args);
		});
		const definition = join(root, "SKILL.md");
		const first = await snapshotSkillDefinition(definition);
		expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(await snapshotSkillDefinition(definition)).toEqual(first);
		await fs.writeFile(definition, "edited body");
		expect((await snapshotSkillDefinition(definition)).fingerprint).not.toBe(first.fingerprint);
		expect(opendirSpy).not.toHaveBeenCalled();
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(opened).toEqual([definition, definition, definition]);
	});

	test("hashes only a regular definition up to exactly 200000 bytes", async () => {
		const definition = join(root, "SKILL.md.disabled");
		await fs.writeFile(definition, new Uint8Array(200000));
		const first = await snapshotSkillDefinition(definition);
		expect(await snapshotSkillDefinition(definition)).toEqual(first);
		await fs.appendFile(definition, "x");
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDefinition(definition))).toMatchObject({
			code: "SKILL_SYNC_LIMIT",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("detects same-content rewrites and containing directory replacement", async () => {
		const local = join(root, "local");
		await writeTree(local, { "SKILL.md": "body" });
		const definition = join(local, "SKILL.md");
		await fs.utimes(definition, new Date(1000), new Date(1000));
		const first = await snapshotSkillDefinition(definition);
		await fs.writeFile(definition, "body");
		const rewritten = await snapshotSkillDefinition(definition);
		expect(rewritten.fingerprint).not.toBe(first.fingerprint);
		await fs.rename(local, join(root, "previous-root"));
		await writeTree(local, { "SKILL.md": "body" });
		expect((await snapshotSkillDefinition(definition)).fingerprint).not.toBe(rewritten.fingerprint);
	});

	test("rejects a symlinked definition and symlinked containing directory before reading", async () => {
		const local = join(root, "local");
		const outside = join(root, "outside");
		await writeTree(local, { "actual.md": "body" });
		await writeTree(outside, { "SKILL.md": "outside" });
		await fs.symlink(join(local, "actual.md"), join(local, "SKILL.md"), "file");
		await fs.symlink(outside, join(root, "linked"), "junction");
		const openSpy = spyOn(fs, "open");
		expect(await captureError(snapshotSkillDefinition(join(local, "SKILL.md")))).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
		expect(
			await captureError(snapshotSkillDefinition(join(root, "linked", "SKILL.md"))),
		).toMatchObject({
			code: "SKILL_SYNC_PATH",
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("rejects containing-directory mutation while hashing the definition", async () => {
		await writeTree(root, { "SKILL.md": "body" });
		const open = fs.open;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			const read: PositionalRead = handle.read.bind(handle);
			let changed = false;
			spyOn(handle, "read").mockImplementation((async (...readArgs: Parameters<typeof read>) => {
				const result = await read(...readArgs);
				if (!changed) {
					changed = true;
					await fs.utimes(root, new Date(1000), new Date(1000));
				}
				return result;
			}) as typeof handle.read);
			return handle;
		});
		expect(await captureError(snapshotSkillDefinition(join(root, "SKILL.md")))).toMatchObject({
			code: "SKILL_SYNC_LOCAL_CHANGED",
		});
	});

	test("honors cancellation before and during bounded definition reads", async () => {
		await writeTree(root, { "SKILL.md": new Uint8Array(200000) });
		const definition = join(root, "SKILL.md");
		const controller = new AbortController();
		controller.abort();
		const openSpy = spyOn(fs, "open");
		expect(
			await captureError(snapshotSkillDefinition(definition, controller.signal)),
		).toMatchObject({
			code: "SKILL_SYNC_ABORTED",
		});
		expect(openSpy).not.toHaveBeenCalled();
		openSpy.mockRestore();
		const during = new AbortController();
		const open = fs.open;
		let reads = 0;
		let closes = 0;
		spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			const read: PositionalRead = handle.read.bind(handle);
			const close = handle.close.bind(handle);
			spyOn(handle, "read").mockImplementation((async (...readArgs: Parameters<typeof read>) => {
				const result = await read(...readArgs);
				reads++;
				during.abort();
				return result;
			}) as typeof handle.read);
			spyOn(handle, "close").mockImplementation(async () => {
				closes++;
				await close();
			});
			return handle;
		});
		expect(await captureError(snapshotSkillDefinition(definition, during.signal))).toMatchObject({
			code: "SKILL_SYNC_ABORTED",
		});
		expect(reads).toBe(1);
		expect(closes).toBe(1);
	});
});

describe("recoverable skill directory publication", () => {
	test("replaces the whole directory, removing obsolete attachments and the backup", async () => {
		const { target, staging } = await makePublication();
		expect(await replaceSkillDirectory(staging, target)).toEqual({});
		expect(await fs.readFile(join(target, "SKILL.md"), "utf8")).toBe("new");
		expect(await fs.readdir(join(target, "attachments"))).toEqual(["new.bin"]);
		expect(new Uint8Array(await fs.readFile(join(target, "attachments/new.bin")))).toEqual(
			new Uint8Array([0, 255]),
		);
		expect(await fs.readdir(root)).toEqual(["installed"]);
	});

	test("checks cancellation immediately before moving the old directory", async () => {
		const { target, staging } = await makePublication();
		const controller = new AbortController();
		const lstat = fs.lstat;
		spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
			try {
				return await lstat(...args);
			} finally {
				controller.abort();
			}
		}) as typeof fs.lstat);
		const renameSpy = spyOn(fs, "rename");
		expect(
			await captureError(replaceSkillDirectory(staging, target, controller.signal)),
		).toMatchObject({
			code: "SKILL_SYNC_ABORTED",
		});
		expect(renameSpy).not.toHaveBeenCalled();
		expect(await fs.readFile(join(target, "SKILL.md"), "utf8")).toBe("old");
		expect(await fs.readFile(join(staging, "SKILL.md"), "utf8")).toBe("new");
	});

	test("allocates a hidden sibling backup without overwriting a collision", async () => {
		const { target, staging } = await makePublication();
		const occupied = join(root, ".skill-sync-backup-occupied");
		await writeTree(occupied, { evidence: "keep" });
		const idSpy = spyOn(ids, "generateId")
			.mockReturnValueOnce("occupied")
			.mockReturnValueOnce("free");
		const rename = fs.rename;
		const destinations: string[] = [];
		spyOn(fs, "rename").mockImplementation(async (from, to) => {
			destinations.push(String(to));
			await rename(from, to);
		});
		await replaceSkillDirectory(staging, target);
		expect(idSpy).toHaveBeenCalledTimes(2);
		expect(dirname(destinations[0])).toBe(dirname(target));
		expect(basename(destinations[0])).toBe(".skill-sync-backup-free");
		expect(await fs.readFile(join(occupied, "evidence"), "utf8")).toBe("keep");
	});

	test("finishes publication when cancelled between the two renames", async () => {
		const { target, staging } = await makePublication();
		const controller = new AbortController();
		const rename = fs.rename;
		let calls = 0;
		spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (++calls === 1) controller.abort();
		});
		expect(await replaceSkillDirectory(staging, target, controller.signal)).toEqual({});
		expect(calls).toBe(2);
		expect(await fs.readFile(join(target, "SKILL.md"), "utf8")).toBe("new");
	});

	test("restores the old directory if the second rename fails, even after cancellation", async () => {
		const { target, staging } = await makePublication();
		const controller = new AbortController();
		const failure = new Error("injected publication failure");
		const rename = fs.rename;
		let calls = 0;
		spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (++calls === 2) {
				controller.abort();
				throw failure;
			}
			await rename(from, to);
		});
		const rmSpy = spyOn(fs, "rm");
		expect(await captureError(replaceSkillDirectory(staging, target, controller.signal))).toBe(
			failure,
		);
		expect(calls).toBe(3);
		expect(rmSpy).not.toHaveBeenCalled();
		expect(await fs.readFile(join(target, "SKILL.md"), "utf8")).toBe("old");
		expect(await fs.readFile(join(target, "attachments/removed.txt"), "utf8")).toBe(
			"old attachment",
		);
		expect(await fs.readFile(join(staging, "SKILL.md"), "utf8")).toBe("new");
		expect((await fs.readdir(root)).sort()).toEqual([".staging", "installed"]);
	});

	test("keeps recovery evidence if publication and restoration fail despite cancellation", async () => {
		const { target, staging } = await makePublication();
		const controller = new AbortController();
		const rename = fs.rename;
		let calls = 0;
		let backupPath = "";
		spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (++calls !== 1) {
				controller.abort();
				throw new Error("injected rename failure");
			}
			backupPath = String(to);
			await rename(from, to);
		});
		const rmSpy = spyOn(fs, "rm");
		const error = await captureError(replaceSkillDirectory(staging, target, controller.signal));
		expect(error).toBeInstanceOf(AppError);
		expect(error).toMatchObject({
			statusCode: 500,
			code: "SKILL_SYNC_RECOVERY_REQUIRED",
			details: { backupPath },
		});
		expect(calls).toBe(3);
		expect(rmSpy).not.toHaveBeenCalled();
		expect(await fs.readFile(join(backupPath, "SKILL.md"), "utf8")).toBe("old");
		expect(await fs.readFile(join(staging, "SKILL.md"), "utf8")).toBe("new");
		expect((await fs.readdir(root)).sort()).toEqual([basename(backupPath), ".staging"].sort());
	});

	test("returns a success warning if backup cleanup fails without rolling back", async () => {
		const { target, staging } = await makePublication();
		const rmSpy = spyOn(fs, "rm").mockRejectedValue(new Error("injected cleanup failure"));
		const result = await replaceSkillDirectory(staging, target);
		const backupPath = String(rmSpy.mock.calls[0][0]);
		expect(result.cleanupWarning).toContain(backupPath);
		expect(await fs.readFile(join(target, "SKILL.md"), "utf8")).toBe("new");
		expect(await fs.readFile(join(backupPath, "SKILL.md"), "utf8")).toBe("old");
		expect(await fs.readdir(join(target, "attachments"))).toEqual(["new.bin"]);
	});

	test("does not delete anything when moving the old directory fails", async () => {
		const { target, staging } = await makePublication();
		const failure = new Error("injected first rename failure");
		const renameSpy = spyOn(fs, "rename").mockRejectedValue(failure);
		const rmSpy = spyOn(fs, "rm");
		expect(await captureError(replaceSkillDirectory(staging, target))).toBe(failure);
		expect(renameSpy).toHaveBeenCalledTimes(1);
		expect(rmSpy).not.toHaveBeenCalled();
		expect(await fs.readFile(join(target, "SKILL.md"), "utf8")).toBe("old");
		expect(await fs.readFile(join(staging, "SKILL.md"), "utf8")).toBe("new");
	});
});
