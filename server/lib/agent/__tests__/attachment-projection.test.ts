import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachedFilesHint, buildLegacyAttachedFilesHint } from "../../attached-files";
import { setUploadsDirForTests } from "../../uploads";
import { projectAttachmentLocations } from "../attachment-projection";
import { projectFileReferenceText } from "../file-reference-projection";
import { projectMessageSenderText, type SenderMessage } from "../sender-projection";

type TestMessage = SenderMessage & { contentJson: Array<Record<string, unknown>> };

let root: string;
let cwd: string;
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=",
	"base64",
);
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nf-attachment-projection-"));
	cwd = join(root, "worktree");
	mkdirSync(cwd);
	mkdirSync(join(root, "uploads", "owner"), { recursive: true });
	writeFileSync(join(root, "uploads", "owner", "image.png"), png);
	setUploadsDirForTests(join(root, "uploads"));
});
afterEach(() => {
	setUploadsDirForTests(null);
	rmSync(root, { recursive: true, force: true });
});
function message(text = "use this image"): TestMessage {
	return {
		id: "user",
		narratorId: "owner",
		role: "user",
		parentToolUseId: null,
		messageUuid: null,
		contentText: text,
		contentJson: [
			{ type: "image", imageId: "image", filename: "logo.png", mediaType: "image/png" },
			{ type: "text", text },
		],
	};
}
function prepare(messages: TestMessage[], currentInput?: string, worktree = cwd) {
	return projectAttachmentLocations(messages, { cwd: worktree, narratorId: "fork", currentInput });
}

test("current input and history share one local image locator without mutating saved rows", async () => {
	const source = message();
	const before = JSON.stringify(source);
	const prepared = await prepare([source], source.contentText ?? undefined);
	const text = prepared.messages[0].contentText ?? "";
	expect(text).toContain('image: "logo.png"');
	expect(text).toContain("device: local");
	expect(text).toContain(join(cwd, ".narrafork", "attached"));
	expect(text).not.toContain(join(root, "uploads"));
	expect(prepared.currentInput).toBe(text);
	expect(JSON.stringify(source)).toBe(before);
	expect(prepared.messages[0].contentJson?.[0]).toEqual(source.contentJson?.[0]);
});

test("fork retains upload owner and recreates missing copies in another worktree", async () => {
	const source = message();
	source.narratorId = "fork";
	source.contentJson = [
		{ type: "image", imageId: "image", filename: "logo.png", uploadNarratorId: "owner" },
		{ type: "text", text: "use this image" },
	];
	const first = await prepare([source]);
	const other = join(root, "other");
	mkdirSync(other);
	const second = await prepare(first.messages, undefined, other);
	expect(second.messages[0].contentText).toContain(join(other, ".narrafork", "attached"));
	expect(second.messages[0].contentText).not.toContain(join(cwd, ".narrafork", "attached"));
	expect(readdirSync(join(other, ".narrafork", "attached"))).toHaveLength(1);
});

test("image and old file hint become one unified list; repeated projection is idempotent", async () => {
	const source = message();
	const file = { filename: "notes.txt", filePath: join(cwd, "notes.txt"), size: 12 };
	source.contentJson?.unshift({ type: "text_file", ...file });
	source.contentText = `use this image${buildLegacyAttachedFilesHint([file])}`;
	const first = await prepare([source], source.contentText);
	const second = await prepare(first.messages, first.currentInput);
	expect(second.messages[0].contentText).toBe(first.messages[0].contentText);
	expect(second.currentInput).toBe(first.currentInput);
	expect(first.currentInput?.match(/<attached_files>/g)).toHaveLength(1);
	expect(first.currentInput).toContain('file: "notes.txt"');
	expect(first.currentInput).toContain('image: "logo.png"');
	expect(readdirSync(join(cwd, ".narrafork", "attached"))).toHaveLength(1);
});

test("file-only history gains the same device-qualified list", async () => {
	const source = message("read notes");
	const file = { filename: "notes.txt", filePath: join(cwd, "notes.txt"), size: 12 };
	source.contentJson = [
		{ type: "text_file", ...file },
		{ type: "text", text: "read notes" },
	];
	source.contentText = `read notes${buildAttachedFilesHint([file])}`;
	const prepared = await prepare([source], source.contentText);
	expect(prepared.currentInput).toBe(source.contentText);
	expect(prepared.messages[0].contentText).toContain("device: local");
});

test("pure image input acquires text without losing the image block", async () => {
	const source = message("");
	source.contentJson?.pop();
	const prepared = await prepare([source], "");
	expect(prepared.currentInput).toContain('image: "logo.png"');
	expect(prepared.messages[0].contentJson?.[0].type).toBe("image");
});

test("missing originals yield unavailable metadata, never an upload path", async () => {
	const source = message();
	rmSync(join(root, "uploads", "owner", "image.png"));
	const prepared = await prepare([source], source.contentText ?? undefined);
	expect(prepared.currentInput).toContain("worktree copy unavailable; no usable path");
	expect(prepared.currentInput).not.toContain(join(root, "uploads"));
	expect(prepared.messages[0].contentJson?.[0].type).toBe("image");
});

test("current sender attribution and frozen file references survive attachment preparation", async () => {
	const source = message();
	source.createdBy = "alice";
	source.creator = { username: "Alice" };
	const snapshot = {
		type: "file_reference" as const,
		reference: { id: "ref", path: "/offline/source.ts", label: "source.ts", deviceId: "remote" },
		snapshotText: "const frozen = 1;",
		snapshotHash: "accepted-hash",
		capturedAt: "2026-10-07T00:00:00.000Z",
	};
	source.contentJson?.push(snapshot);
	const current = projectFileReferenceText(source.contentText ?? "", [snapshot]);
	const prepared = await prepare([source], projectMessageSenderText(source, current));
	expect(prepared.currentInput).toContain('<sender kind="human" id="alice" name="Alice" />');
	expect(prepared.currentInput).toContain("const frozen = 1;");
	expect(prepared.currentInput).toContain('image: "logo.png"');
	expect(prepared.messages[0].contentJson).toContainEqual(snapshot);
});

test("unpersisted control input is not assigned the tail user's attachments", async () => {
	const prepared = await prepare([message()], "continue from the tool results");
	expect(prepared.currentInput).toBe("continue from the tool results");
});

test("literal user-authored hint delimiters are not stripped", async () => {
	const text = "Please inspect this literal:\n<attached_files>not generated</attached_files>";
	const prepared = await prepare([message(text)], text);
	expect(prepared.currentInput).toStartWith(text);
});

test("attachment names cannot forge additional metadata lines", () => {
	const hint = buildAttachedFilesHint(
		[],
		[{ filename: "logo.png\npath: /private", imageId: "id" }],
	);
	expect(hint).toContain('"logo.png\\npath: /private"');
	expect(hint).not.toContain("\npath: /private");
});

test("deleted worktree copies are restored from retained originals", async () => {
	const first = await prepare([message()]);
	const dir = join(cwd, ".narrafork", "attached");
	const saved = join(dir, readdirSync(dir)[0]);
	rmSync(saved);
	const restored = await prepare(first.messages);
	expect(restored.messages[0].contentText).toBe(first.messages[0].contentText);
	expect(await Bun.file(saved).bytes()).toEqual(new Uint8Array(png));
});

test("history budget prioritizes current attachments and makes progress on later builds", async () => {
	const sources = Array.from({ length: 101 }, (_, index) => {
		const source = message(`use image ${index}`);
		source.id = `user-${index}`;
		source.contentJson[0] = {
			type: "image",
			imageId: `image-${index}`,
			filename: "same.png",
		};
		writeFileSync(join(root, "uploads", "owner", `image-${index}.png`), png);
		return source;
	});
	const first = await prepare(sources, "use image 100");
	expect(first.messages.map((source) => source.id)).toEqual(sources.map((source) => source.id));
	expect(first.currentInput).toContain("device: local; path:");
	expect(first.messages[0].contentText).toContain("worktree copy unavailable");
	const second = await prepare(first.messages, first.currentInput);
	expect(second.messages[0].contentText).not.toContain("worktree copy unavailable");
	expect(readdirSync(join(cwd, ".narrafork", "attached"))).toHaveLength(101);
	expect(second.currentInput).toBe(first.currentInput);
});

test("cancelled history preparation propagates cancellation rather than marking attachments missing", async () => {
	const controller = new AbortController();
	controller.abort(new Error("session interrupted"));
	await expect(
		projectAttachmentLocations([message()], {
			cwd,
			narratorId: "fork",
			signal: controller.signal,
		}),
	).rejects.toThrow("session interrupted");
});

test("legacy file and image attachments share safe absolute worktree locations", async () => {
	mkdirSync(join(root, "uploads", "owner", "text"));
	writeFileSync(join(root, "uploads", "owner", "notes.txt"), "not the legacy source");
	writeFileSync(join(root, "uploads", "owner", "text", "notes.txt"), "legacy notes");
	const legacy = {
		filename: "notes.txt",
		fileId: "notes",
		filePath: "owner/text/notes.txt",
		size: 12,
	};
	const source = message();
	source.contentJson.unshift({ type: "text_file", ...legacy });
	source.contentText = `use this image${buildLegacyAttachedFilesHint([legacy])}`;
	const before = JSON.stringify(source);
	const prepared = await prepare([source], source.contentText);
	expect(prepared.currentInput).toContain('file: "notes.txt"; device: local; path:');
	expect(prepared.currentInput).toContain(
		'image: "logo.png"; imageId: "image"; device: local; path:',
	);
	expect(prepared.currentInput).not.toContain("owner/text/notes.txt");
	expect(prepared.currentInput).not.toContain(join(root, "uploads"));
	expect(prepared.currentInput?.match(/<attached_files>/g)).toHaveLength(1);
	expect(JSON.stringify(source)).toBe(before);
	const dir = join(cwd, ".narrafork", "attached");
	const legacyCopy = readdirSync(dir).find((name) => name.startsWith("legacy-"));
	expect(legacyCopy).toBeDefined();
	expect(await Bun.file(join(dir, legacyCopy ?? "missing")).text()).toBe("legacy notes");
});

test("missing legacy files never advertise uploads-relative paths as worktree paths", async () => {
	const source = message();
	source.contentJson.unshift({
		type: "text_file",
		filename: "missing.txt",
		fileId: "missing",
		filePath: "owner/text/missing.txt",
		size: 10,
	});
	const prepared = await prepare([source], source.contentText ?? undefined);
	expect(prepared.currentInput).toContain('file: "missing.txt"; worktree copy unavailable');
	expect(prepared.currentInput).not.toContain("owner/text/missing.txt");
});

test("already attributed current packets rebase copies without losing their sender", async () => {
	const source = message("  use this image  ");
	source.createdBy = "alice";
	source.creator = { username: "Alice" };
	const first = await prepare([source], source.contentText ?? undefined);
	const other = join(root, "second");
	mkdirSync(other);
	const attributed = projectMessageSenderText(first.messages[0], first.currentInput ?? "");
	const second = await prepare(first.messages, attributed, other);
	expect(second.currentInput).toStartWith(
		'<sender kind="human" id="alice" name="Alice" />\n  use this image  ',
	);
	expect(second.currentInput).toContain(join(other, ".narrafork", "attached"));
	expect(second.currentInput).not.toContain(join(cwd, ".narrafork", "attached"));
	expect(second.currentInput?.match(/<sender /g)).toHaveLength(1);
});
