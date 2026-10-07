import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import { ensureLegacyFileWorktreeCopy } from "../legacy-file-attachments";
import {
	ensureImageWorktreeCopy,
	type ImageWorktreeCopyBudget,
	setUploadsDirForTests,
	type TextFileRef,
} from "../uploads";

type LegacyRef = TextFileRef & { fileId?: string };

let root: string;
let cwd: string;
let uploadsRoot: string;
const file: LegacyRef = {
	fileId: "file_1",
	filePath: "original-owner/text/file_1.txt",
	filename: "../../notes.txt",
	size: 999,
};

function sourcePath(ref = file): string {
	return resolve(uploadsRoot, ref.filePath);
}

function targetPath(ref = file): string {
	const hash = createHash("sha256").update(ref.filePath).digest("hex");
	const extension = ref.filePath.split(".").pop();
	return resolve(cwd, ".narrafork/attached", `legacy-${hash}.${extension}`);
}

function source(ref = file, content = "original notes"): void {
	const owner = ref.filePath.split("/")[0];
	mkdirSync(resolve(uploadsRoot, owner, "text"), { recursive: true });
	writeFileSync(sourcePath(ref), content);
}

beforeEach(() => {
	root = mkdtempSync(resolve(tmpdir(), "narrafork-legacy-copy-"));
	cwd = resolve(root, "worktree");
	uploadsRoot = resolve(root, "uploads");
	mkdirSync(cwd);
	mkdirSync(uploadsRoot);
	setUploadsDirForTests(uploadsRoot);
});

afterEach(() => {
	setUploadsDirForTests(null);
	rmSync(root, { recursive: true, force: true });
});

describe("legacy worktree file copies", () => {
	test("copies the canonical storage owner path with a stable nonrevealing filename", async () => {
		source();
		const copy = await ensureLegacyFileWorktreeCopy(cwd, file);
		expect(copy).toEqual({ filename: file.filename, filePath: targetPath(), size: 14 });
		expect(copy?.filePath).not.toContain("original-owner");
		expect(copy?.filePath).not.toContain("/uploads/");
		expect(await Bun.file(copy?.filePath ?? "").text()).toBe("original notes");
	});

	test("reuses edited copies without overwriting even after source removal", async () => {
		source();
		const copy = await ensureLegacyFileWorktreeCopy(cwd, file);
		if (!copy) throw new Error("Copy missing");
		writeFileSync(copy.filePath, "my edits");
		expect(await ensureLegacyFileWorktreeCopy(cwd, file)).toEqual({ ...copy, size: 8 });
		rmSync(uploadsRoot, { recursive: true });
		expect(await ensureLegacyFileWorktreeCopy(cwd, file)).toEqual({ ...copy, size: 8 });
		expect(await Bun.file(copy.filePath).text()).toBe("my edits");
	});

	test("returns null for absent sources and does not match fileId prefixes", async () => {
		source({ ...file, fileId: "file_1-extra", filePath: "original-owner/text/file_1-extra.txt" });
		expect(await ensureLegacyFileWorktreeCopy(cwd, file)).toBeNull();
		rmSync(uploadsRoot, { recursive: true });
		expect(await ensureLegacyFileWorktreeCopy(cwd, file)).toBeNull();
	});

	test("rejects traversal, noncanonical paths, and absent or mismatched file IDs", async () => {
		for (const path of [
			"../original-owner/text/file_1.txt",
			"original-owner/../original-owner/text/file_1.txt",
			"original-owner//text/file_1.txt",
			"original-owner/text/./file_1.txt",
			"original-owner/text/file_1.txt/evil",
			"original-owner/text/file_1.txt\n",
			"original-owner/text/file_1.txt.exe",
			"original-owner/text/file_1",
			"original-owner/text/%2e%2e.txt",
			"original-owner\\text\\file_1.txt",
			"/original-owner/text/file_1.txt",
			"original-owner/files/file_1.txt",
			"original-owner/text/wrong.txt",
		]) {
			await expect(ensureLegacyFileWorktreeCopy(cwd, { ...file, filePath: path })).rejects.toThrow(
				"Invalid canonical",
			);
		}
		for (const fileId of [undefined, "", "../file_1", "file_1-extra"]) {
			await expect(ensureLegacyFileWorktreeCopy(cwd, { ...file, fileId })).rejects.toThrow(
				"Invalid canonical",
			);
		}
	});

	test("same names and IDs from different storage owners cannot overwrite each other", async () => {
		source();
		const second = { ...file, filePath: "other-owner/text/file_1.txt" };
		source(second, "second owner");
		const firstCopy = await ensureLegacyFileWorktreeCopy(cwd, file);
		const secondCopy = await ensureLegacyFileWorktreeCopy(cwd, second);
		expect(firstCopy?.filePath).not.toBe(secondCopy?.filePath);
		expect(await Bun.file(firstCopy?.filePath ?? "").text()).toBe("original notes");
		expect(await Bun.file(secondCopy?.filePath ?? "").text()).toBe("second owner");
	});

	for (const part of [".narrafork", ".narrafork/attached"]) {
		test(`rejects target directory symlink ${part}`, async () => {
			source();
			const outside = resolve(root, "outside");
			mkdirSync(outside);
			if (part.includes("/")) mkdirSync(resolve(cwd, ".narrafork"));
			symlinkSync(outside, resolve(cwd, part));
			await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("Unsafe");
			expect(readdirSync(outside)).toEqual([]);
		});
	}

	for (const part of ["", "original-owner", "original-owner/text"]) {
		test(`rejects source directory symlink ${part || "uploads root"}`, async () => {
			source();
			const outside = resolve(root, "outside");
			mkdirSync(outside);
			const path = resolve(uploadsRoot, part);
			rmSync(path, { recursive: true });
			symlinkSync(outside, path);
			await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("Unsafe");
		});
	}

	test("rejects source symlinks, including dangling symlinks", async () => {
		source();
		const outside = resolve(root, "outside.txt");
		writeFileSync(outside, "secret");
		rmSync(sourcePath());
		symlinkSync(outside, sourcePath());
		await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("Unsafe");
		rmSync(outside);
		await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("Unsafe");
	});

	test("rejects target symlinks and does not overwrite their destinations", async () => {
		source();
		mkdirSync(resolve(cwd, ".narrafork/attached"), { recursive: true });
		const outside = resolve(root, "outside.txt");
		writeFileSync(outside, "untouched");
		symlinkSync(outside, targetPath());
		await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("Unsafe");
		expect(await Bun.file(outside).text()).toBe("untouched");
		rmSync(outside);
		await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("Unsafe");
	});

	test("enforces source and existing-copy size caps using real sizes", async () => {
		source();
		truncateSync(sourcePath(), MAX_TEXT_FILE_SIZE + 1);
		await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("too large");
		expect(readdirSync(resolve(cwd, ".narrafork/attached"))).toEqual([]);
		writeFileSync(sourcePath(), "small");
		const copy = await ensureLegacyFileWorktreeCopy(cwd, file);
		if (!copy) throw new Error("Missing copy");
		truncateSync(copy.filePath, MAX_TEXT_FILE_SIZE + 1);
		await expect(ensureLegacyFileWorktreeCopy(cwd, file)).rejects.toThrow("too large");
		expect(statSync(copy.filePath).size).toBe(MAX_TEXT_FILE_SIZE + 1);
	});

	test("copies multi-chunk and empty files", async () => {
		source();
		const bytes = Buffer.alloc(150_000, 42);
		writeFileSync(sourcePath(), bytes);
		const copy = await ensureLegacyFileWorktreeCopy(cwd, file);
		expect(copy?.size).toBe(bytes.length);
		expect(await Bun.file(copy?.filePath ?? "").bytes()).toEqual(new Uint8Array(bytes));
		const empty = { ...file, fileId: "empty", filePath: "original-owner/text/empty.json" };
		source(empty, "");
		expect((await ensureLegacyFileWorktreeCopy(cwd, empty))?.size).toBe(0);
	});

	test("concurrent publication produces one complete file with no temporary leftovers", async () => {
		source();
		const copies = await Promise.all(
			Array.from({ length: 6 }, () => ensureLegacyFileWorktreeCopy(cwd, file)),
		);
		for (const copy of copies) expect(copy).toEqual(copies[0]);
		expect(readdirSync(resolve(cwd, ".narrafork/attached"))).toEqual([
			targetPath().split("/").pop() ?? "",
		]);
	});

	test("debits shared budget by actual copied size and leaves reuse free", async () => {
		source();
		const budget: ImageWorktreeCopyBudget = {
			remainingCopies: 2,
			remainingBytes: 40,
			deadlineAt: Date.now() + 10_000,
		};
		expect((await ensureLegacyFileWorktreeCopy(cwd, file, undefined, budget))?.size).toBe(14);
		expect(budget.remainingCopies).toBe(1);
		expect(budget.remainingBytes).toBe(26);
		const depleted = { remainingCopies: 0, remainingBytes: 0, deadlineAt: 0 };
		expect((await ensureLegacyFileWorktreeCopy(cwd, file, undefined, depleted))?.size).toBe(14);
		expect(depleted).toEqual({ remainingCopies: 0, remainingBytes: 0, deadlineAt: 0 });
	});

	test("returns null without copying for depleted count, byte allowance, or shared deadline", async () => {
		source();
		for (const budget of [
			{ remainingCopies: 0, remainingBytes: 100, deadlineAt: Date.now() + 10_000 },
			{ remainingCopies: 1, remainingBytes: 13, deadlineAt: Date.now() + 10_000 },
			{ remainingCopies: 1, remainingBytes: 100, deadlineAt: 0 },
		]) {
			const before = { ...budget };
			expect(await ensureLegacyFileWorktreeCopy(cwd, file, undefined, budget)).toBeNull();
			expect(budget).toEqual(before);
			expect(readdirSync(resolve(cwd, ".narrafork/attached"))).toEqual([]);
		}
	});

	test("image and legacy copies share one count and byte budget", async () => {
		source();
		const imageBytes = Buffer.alloc(24);
		imageBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		writeFileSync(resolve(uploadsRoot, "original-owner/image_1.png"), imageBytes);
		const budget: ImageWorktreeCopyBudget = {
			remainingCopies: 2,
			remainingBytes: 38,
			deadlineAt: Date.now() + 10_000,
		};
		expect(
			(
				await ensureImageWorktreeCopy(
					cwd,
					{
						imageId: "image_1",
						uploadNarratorId: "original-owner",
						filename: "picture.png",
						mediaType: "image/png",
					},
					undefined,
					undefined,
					budget,
				)
			)?.size,
		).toBe(24);
		expect((await ensureLegacyFileWorktreeCopy(cwd, file, undefined, budget))?.size).toBe(14);
		expect(budget.remainingBytes).toBe(0);
		expect(budget.remainingCopies).toBe(0);
	});

	test("racing publication debits the shared budget only once", async () => {
		source();
		const budget: ImageWorktreeCopyBudget = {
			remainingCopies: 6,
			remainingBytes: 84,
			deadlineAt: Date.now() + 10_000,
		};
		const copies = await Promise.all(
			Array.from({ length: 6 }, () => ensureLegacyFileWorktreeCopy(cwd, file, undefined, budget)),
		);
		for (const copy of copies) expect(copy?.size).toBe(14);
		expect(budget.remainingCopies).toBe(5);
		expect(budget.remainingBytes).toBe(70);
	});

	test("shared deadline expiring mid-copy cleans temporary data without debiting", async () => {
		source();
		const budget: ImageWorktreeCopyBudget = {
			remainingCopies: 1,
			remainingBytes: 14,
			deadlineAt: 2000,
		};
		let calls = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => (++calls >= 6 ? 2000 : 1000));
		try {
			await expect(ensureLegacyFileWorktreeCopy(cwd, file, undefined, budget)).rejects.toThrow(
				"timed out",
			);
			expect(budget.remainingCopies).toBe(1);
			expect(budget.remainingBytes).toBe(14);
			expect(readdirSync(resolve(cwd, ".narrafork/attached"))).toEqual([]);
		} finally {
			clock.mockRestore();
		}
	});

	test("source growth cannot exceed the remaining byte allowance and failed copy is free", async () => {
		source(file, "small");
		const budget: ImageWorktreeCopyBudget = {
			remainingCopies: 1,
			remainingBytes: 5,
			deadlineAt: Date.now() + 10_000,
		};
		let calls = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => {
			if (++calls === 9) writeFileSync(sourcePath(), "this grew beyond five bytes");
			return 0;
		});
		try {
			await expect(ensureLegacyFileWorktreeCopy(cwd, file, undefined, budget)).rejects.toThrow(
				"too large",
			);
			expect(budget.remainingCopies).toBe(1);
			expect(budget.remainingBytes).toBe(5);
			expect(readdirSync(resolve(cwd, ".narrafork/attached"))).toEqual([]);
		} finally {
			clock.mockRestore();
		}
	});

	test("already aborted signals stop before any worktree writes", async () => {
		source();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(ensureLegacyFileWorktreeCopy(cwd, file, controller.signal)).rejects.toThrow(
			"cancelled",
		);
		expect(readdirSync(cwd)).toEqual([]);
	});

	for (const mode of ["timeout", "abort"]) {
		test(`${mode} during copying cleans temporary files and never publishes partial data`, async () => {
			source();
			const controller = new AbortController();
			let calls = 0;
			const clock = spyOn(performance, "now").mockImplementation(() => {
				calls++;
				if (calls >= 10) {
					if (mode === "abort") controller.abort(new Error("cancelled"));
					else return 20_000;
				}
				return 0;
			});
			try {
				await expect(ensureLegacyFileWorktreeCopy(cwd, file, controller.signal)).rejects.toThrow(
					mode === "abort" ? "cancelled" : "timed out",
				);
				expect(readdirSync(resolve(cwd, ".narrafork/attached"))).toEqual([]);
			} finally {
				clock.mockRestore();
			}
		});
	}
});
