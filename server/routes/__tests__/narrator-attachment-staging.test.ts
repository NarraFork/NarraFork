/**
 * Staged attachments through the message path.
 *
 * `attachment-staging.test.ts` covers the store itself. This file covers the two
 * places the rest of the app meets it, and both have a failure mode that is
 * invisible in a unit test of the store:
 *
 *  1. **The request field is parsed defensively.** It arrives as JSON inside a
 *     form field, so a malformed value must be a validation error rather than a
 *     half-resolved attachment list.
 *  2. **Claiming copies the bytes and then drops the staged original.** If the
 *     release were skipped, every sent attachment would leave a second copy on
 *     disk until the TTL sweep — indefinite growth for anyone who keeps sending.
 *     If it happened too early, the copy would read a file that is already gone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ComposerDocument } from "@shared/composer-document";
import {
	getStagedAttachmentsDir,
	setStagedAttachmentsDirForTests,
	stageAttachment,
} from "../../lib/attachment-staging";
import { saveTextFileToWorktree } from "../../lib/uploads";
import {
	attachmentBytesOf,
	parseMessageRequest,
	parseStagedAttachmentInput,
	resolveStagedAttachments,
} from "../narrators";

let stagingRoot: string;
let worktree: string;

beforeEach(() => {
	stagingRoot = mkdtempSync(resolve(tmpdir(), "nf-staging-claim-"));
	worktree = mkdtempSync(resolve(tmpdir(), "nf-worktree-"));
	setStagedAttachmentsDirForTests(stagingRoot);
});

afterEach(() => {
	setStagedAttachmentsDirForTests(null);
	rmSync(stagingRoot, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

function bodyOf(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function stage(text: string, filename = "notes.log") {
	return stageAttachment(bodyOf(text), { narratorId: "narr1", filename });
}

describe("parseStagedAttachmentInput", () => {
	test("an absent field means no staged attachments", () => {
		expect(parseStagedAttachmentInput(null)).toEqual([]);
		expect(parseStagedAttachmentInput(undefined)).toEqual([]);
		expect(() => parseStagedAttachmentInput("")).toThrow(/valid JSON/i);
	});

	test("accepts indexed objects without reordering them", () => {
		const inputs = [
			{ uploadId: "a1", index: 2 },
			{ uploadId: "b2", index: 0 },
		];
		expect(parseStagedAttachmentInput(JSON.stringify(inputs))).toEqual(inputs);
	});

	test.each([
		["bare string", ["a1"]],
		["missing index", [{ uploadId: "a1" }]],
		["string index", [{ uploadId: "a1", index: "0" }]],
		["negative index", [{ uploadId: "a1", index: -1 }]],
		["fractional index", [{ uploadId: "a1", index: 0.5 }]],
		["unsafe id", [{ uploadId: "../a1", index: 0 }]],
		[
			"duplicate index",
			[
				{ uploadId: "a1", index: 0 },
				{ uploadId: "b2", index: 0 },
			],
		],
		[
			"duplicate id",
			[
				{ uploadId: "a1", index: 0 },
				{ uploadId: "a1", index: 1 },
			],
		],
	])("rejects %s", (_label, input) => {
		expect(() => parseStagedAttachmentInput(JSON.stringify(input))).toThrow();
	});

	test("rejects a file instead of a JSON form field", () => {
		expect(() => parseStagedAttachmentInput(new File(["[]"], "input.json"))).toThrow(/JSON array/);
	});

	test("rejects malformed JSON rather than ignoring the field", () => {
		expect(() => parseStagedAttachmentInput("{not json")).toThrow(/valid JSON/i);
	});

	test("bounds control metadata before parsing JSON", () => {
		expect(() => parseStagedAttachmentInput("[".repeat(4097))).toThrow(/too large/i);
	});

	test("rejects a non-array payload", () => {
		expect(() => parseStagedAttachmentInput(JSON.stringify({ uploadId: "a" }))).toThrow(
			/must be a JSON array/i,
		);
	});

	test("rejects an entry without a usable uploadId", () => {
		expect(() => parseStagedAttachmentInput(JSON.stringify([{ filename: "x.log" }]))).toThrow(
			/uploadId/i,
		);
		expect(() => parseStagedAttachmentInput(JSON.stringify([""]))).toThrow(/uploadId/i);
	});

	test("bounds the count to the per-message attachment limit", () => {
		const tooMany = Array.from({ length: 11 }, (_, index) => ({ uploadId: `u${index}` }));
		expect(() => parseStagedAttachmentInput(JSON.stringify(tooMany))).toThrow(/Maximum/i);
	});
});

describe("resolveStagedAttachments", () => {
	test("resolves a staged upload into a File with real metadata", async () => {
		const staged = await stage("hello world");
		const [file] = resolveStagedAttachments("narr1", [{ uploadId: staged.uploadId, index: 0 }]);
		expect(file.name).toBe("notes.log");
		expect(file.size).toBe(11);
		expect(attachmentBytesOf([file])).toBe(11);
	});

	test("an unknown id is a user-facing validation error, not a crash", () => {
		expect(() =>
			resolveStagedAttachments("narr1", [{ uploadId: "doesnotexist", index: 0 }]),
		).toThrow(/expired/i);
	});

	test("a narrator cannot claim another narrator's staged upload", async () => {
		const staged = await stage("secret");
		expect(() =>
			resolveStagedAttachments("narr2", [{ uploadId: staged.uploadId, index: 0 }]),
		).toThrow(/expired/i);
	});
});

describe("ordered multipart attachments", () => {
	test.each([
		["large then small", 0, "staged larger body", "small", "large.log", "small.log"],
		["small then large", 1, "staged larger body", "small", "large.log", "small.log"],
		["same metadata, different content", 0, "AAAA", "BBBB", "same.log", "same.log"],
		["same metadata, reversed", 1, "AAAA", "BBBB", "same.log", "same.log"],
	] as const)("preserves %s with a composer manifest", async (_label, index, stagedBody, inlineBody, stagedName, inlineName) => {
		const staged = await stage(stagedBody, stagedName);
		const inline = new File([inlineBody], inlineName);
		const ordered =
			index === 0
				? [{ name: stagedName, size: staged.size }, inline]
				: [inline, { name: stagedName, size: staged.size }];
		const document: ComposerDocument = {
			version: 1,
			assets: ordered.map((file, i) => ({
				id: `asset-${i}`,
				kind: "textFile",
				name: file.name,
				size: file.size,
				mimeType: "application/octet-stream",
			})),
			paragraphs: [
				{
					children: ordered.map((_, i) => ({
						type: "attachment",
						id: `node-${i}`,
						assetId: `asset-${i}`,
					})),
				},
			],
		};
		const form = new FormData();
		form.set("message", "");
		form.append("textFiles", inline);
		form.set("stagedAttachments", JSON.stringify([{ uploadId: staged.uploadId, index }]));
		form.set("composerDocument", JSON.stringify(document));
		const request = await parseMessageRequest(
			{
				req: {
					header: () => "multipart/form-data",
					formData: async () => form,
					json: async () => {
						throw new Error("Unexpected JSON");
					},
				},
			},
			"narr1",
		);
		expect(request.composerDocument).toEqual(document);
		expect(await Promise.all(request.textFiles.map((file) => file.text()))).toEqual(
			index === 0 ? [stagedBody, inlineBody] : [inlineBody, stagedBody],
		);
	});

	test("staged wire order does not override original indexes", async () => {
		const first = await stage("first");
		const last = await stage("last");
		const files = resolveStagedAttachments(
			"narr1",
			[
				{ uploadId: last.uploadId, index: 2 },
				{ uploadId: first.uploadId, index: 0 },
			],
			[new File(["middle"], "notes.log")],
		);
		expect(await Promise.all(files.map((file) => file.text()))).toEqual([
			"first",
			"middle",
			"last",
		]);
	});

	test("rejects an index outside the combined newly-added list", async () => {
		const staged = await stage("body");
		expect(() =>
			resolveStagedAttachments(
				"narr1",
				[{ uploadId: staged.uploadId, index: 2 }],
				[new File(["inline"], "notes.log")],
			),
		).toThrow(/index/i);
	});

	test("rejects string textFiles fields", () => {
		expect(() => resolveStagedAttachments("narr1", [], ["not a file"])).toThrow(/files/i);
	});
});

describe("claiming through the worktree copy", () => {
	test("copies the bytes and releases the staged original", async () => {
		const staged = await stage("attachment body");
		const [file] = resolveStagedAttachments("narr1", [{ uploadId: staged.uploadId, index: 0 }]);

		const ref = await saveTextFileToWorktree(worktree, file);

		expect(ref.filename).toBe("notes.log");
		expect(ref.size).toBe(15);
		expect(await Bun.file(ref.filePath).text()).toBe("attachment body");
		// The whole point of releasing here: the bytes are durable in the worktree,
		// so keeping the staging copy would double the disk cost of every send.
		expect(existsSync(staged.path)).toBe(false);
	});

	test("a failed copy keeps the staged original for the caller's retry", async () => {
		// A file where the attachment directory must go makes the mkdir fail.
		const blocked = resolve(worktree, ".narrafork");
		await Bun.write(blocked, "not a directory");
		const staged = await stage("retry me");
		const [file] = resolveStagedAttachments("narr1", [{ uploadId: staged.uploadId, index: 0 }]);

		await expect(saveTextFileToWorktree(worktree, file)).rejects.toThrow();
		expect(existsSync(staged.path)).toBe(true);
	});

	test("a multipart file is copied without touching the staging area", async () => {
		const file = new File(["inline"], "inline.txt", { type: "text/plain" });
		const ref = await saveTextFileToWorktree(worktree, file);
		expect(await Bun.file(ref.filePath).text()).toBe("inline");
		const stagingNarratorDir = resolve(getStagedAttachmentsDir(), "narr1");
		expect(existsSync(stagingNarratorDir) ? readdirSync(stagingNarratorDir) : []).toEqual([]);
	});
});
