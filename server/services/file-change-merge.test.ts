import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { mergeFileChangeBytes } from "./file-change-merge";

let sandbox: string;
let temporaryRoot: string;
const sentinel = Buffer.from("untouched user file\r\n");

beforeEach(async () => {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated preload required");
	sandbox = await mkdtemp(join(await realpath(tmpdir()), "file-merge-test-"));
	temporaryRoot = join(sandbox, "private");
	await mkdir(temporaryRoot, { mode: 0o700 });
	await writeFile(join(sandbox, "user.txt"), sentinel);
});

afterEach(async () => {
	try {
		expect(await readFile(join(sandbox, "user.txt"))).toEqual(sentinel);
		expect(await readdir(temporaryRoot)).toEqual([]);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

function bytes(a: string, b: string) {
	return Buffer.concat([
		Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 13, 10]),
		Buffer.from(`${a}\r\n1\r\n2\r\n3\r\n4\r\n${b}\r\n`),
	]);
}

async function fakeGit(program: string): Promise<string> {
	const path = join(sandbox, "fake-git");
	await writeFile(path, `#!${process.execPath}\n${program}\n`, { mode: 0o700 });
	await chmod(path, 0o700);
	return path;
}

describe("bounded private raw merge-file", () => {
	test("real Git preserves invalid UTF-8/GBK, CRLF and non-overlapping edits", async () => {
		const current = bytes("selected", "human");
		const base = bytes("selected", "base");
		const incoming = bytes("original", "base");
		const output = await mergeFileChangeBytes(current, base, incoming, { temporaryRoot });
		expect(Buffer.from(output)).toEqual(bytes("original", "human"));
		expect(current).toEqual(bytes("selected", "human"));
	});

	test("real Git conflicts return no conflict-marker bytes or partial success", async () => {
		await expect(
			mergeFileChangeBytes(
				bytes("human", "base"),
				bytes("selected", "base"),
				bytes("original", "base"),
				{ temporaryRoot },
			),
		).rejects.toMatchObject({ reason: "merge_conflict" });
	});

	test("real clean output is bounded even when all individual inputs fit", async () => {
		await expect(
			mergeFileChangeBytes(
				bytes("selected", "human"),
				bytes("selected", "base"),
				bytes("original", "base"),
				{ temporaryRoot, maxOutputBytes: 8 },
			),
		).rejects.toMatchObject({ reason: "budget_exceeded" });
	});

	test("oversize inputs and attempts to raise shared limits are rejected before temp writes", async () => {
		await expect(
			mergeFileChangeBytes(Buffer.alloc(10), Buffer.alloc(0), Buffer.alloc(0), {
				temporaryRoot,
				maxInputBytes: 9,
			}),
		).rejects.toMatchObject({ reason: "budget_exceeded" });
		for (const options of [
			{ maxInputBytes: FILE_CHANGE_LIMITS.blobBytes + 1 },
			{ maxOutputBytes: FILE_CHANGE_LIMITS.blobBytes + 1 },
			{ timeoutMs: 30_001 },
		]) {
			await expect(
				mergeFileChangeBytes(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0), {
					temporaryRoot,
					...options,
				}),
			).rejects.toMatchObject({ reason: "invalid_input" });
		}
	});

	test("pre-abort never invokes Git; missing executable fails closed with private cleanup", async () => {
		const abort = new AbortController();
		abort.abort();
		const none = Buffer.alloc(0);
		await expect(
			mergeFileChangeBytes(none, none, none, { temporaryRoot, signal: abort.signal }),
		).rejects.toMatchObject({ reason: "cancelled" });
		await expect(
			mergeFileChangeBytes(none, none, none, {
				temporaryRoot,
				gitExecutable: join(sandbox, "missing-git"),
			}),
		).rejects.toMatchObject({ reason: "merge_failed" });
	});

	// Failure injection runs a direct private executable, not a shell or installed service.
	test.skipIf(process.platform === "win32")(
		"subprocess failure, stdout overflow and stderr overflow all refuse",
		async () => {
			for (const [program, reason] of [
				["process.exit(255)", "merge_failed"],
				["await Bun.write(Bun.stdout, Buffer.alloc(65536, 120))", "budget_exceeded"],
				[
					`await Bun.write(Bun.stderr, Buffer.alloc(${FILE_CHANGE_LIMITS.metadataBytes + 1}, 120))`,
					"budget_exceeded",
				],
			]) {
				const gitExecutable = await fakeGit(program ?? "");
				const none = Buffer.alloc(0);
				await expect(
					mergeFileChangeBytes(none, none, none, {
						temporaryRoot,
						gitExecutable,
						maxOutputBytes: 128,
					}),
				).rejects.toMatchObject({ reason });
				expect(await readdir(temporaryRoot)).toEqual([]);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"deadline and cancellation kill only the owned subprocess and await cleanup",
		async () => {
			const gitExecutable = await fakeGit("setInterval(() => {}, 1000)");
			const witness = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			try {
				const none = Buffer.alloc(0);
				await expect(
					mergeFileChangeBytes(none, none, none, { temporaryRoot, gitExecutable, timeoutMs: 80 }),
				).rejects.toMatchObject({ reason: "timeout" });
				expect(witness.exitCode).toBeNull();
				const abort = new AbortController();
				const timer = setTimeout(() => abort.abort(), 80);
				try {
					await expect(
						mergeFileChangeBytes(none, none, none, {
							temporaryRoot,
							gitExecutable,
							signal: abort.signal,
						}),
					).rejects.toMatchObject({ reason: "cancelled" });
				} finally {
					clearTimeout(timer);
				}
				expect(witness.exitCode).toBeNull();
			} finally {
				witness.kill("SIGKILL");
				await witness.exited;
			}
		},
	);
});
