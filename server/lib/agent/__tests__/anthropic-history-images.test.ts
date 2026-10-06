import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setUploadsDirForTests } from "../../uploads";
import { AnthropicProvider } from "../anthropic-provider";
import type { DbMessage } from "../provider";

/**
 * Replay of images attached to past user turns.
 *
 * A stored message keeps only an `imageId`; the bytes live under the uploading
 * narrator's directory. `buildAnthropicHistory` previously read text blocks only,
 * so every history image was dropped — a follow-up question about an earlier
 * screenshot reached the model with nothing to look at, and nothing in the request
 * indicated an image had been lost.
 *
 * This also covers the direct Anthropic provider, not just the NUG path: the
 * defect was in the shared history builder, so both were affected.
 */

const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

let testUploadsRoot = "";

beforeEach(() => {
	testUploadsRoot = mkdtempSync(resolve(tmpdir(), "narrafork-anthropic-images-"));
	setUploadsDirForTests(testUploadsRoot);
});

afterEach(() => {
	setUploadsDirForTests(null);
	if (testUploadsRoot) rmSync(testUploadsRoot, { recursive: true, force: true });
});

function registerTestImage(narratorId: string, imageId: string, ext = ".png"): void {
	const dir = resolve(testUploadsRoot, narratorId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(resolve(dir, `${imageId}${ext}`), Buffer.from(SAMPLE_PNG_BASE64, "base64"));
}

function provider(): AnthropicProvider {
	return new AnthropicProvider({
		id: "anthro",
		prefix: "anthro",
		baseUrl: "https://api.invalid",
		apiKey: "k",
		officialApi: false,
		models: [{ id: "claude-sonnet-4.5", name: "Sonnet" }],
	} as never);
}

function userMessage(overrides: Partial<DbMessage> = {}): DbMessage {
	return {
		id: "user-1",
		role: "user",
		contentJson: [],
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
		...overrides,
	};
}

/** The trailing user message is consumed as the current turn, so history needs a tail. */
function withTail(messages: DbMessage[]): DbMessage[] {
	return [...messages, userMessage({ id: "current", contentText: "and now?" })];
}

type ImagePart = { type: string; source?: { type: string; media_type: string; data: string } };

function imagePartsOf(history: unknown[]): ImagePart[] {
	const parts: ImagePart[] = [];
	for (const message of history as Array<{ content: unknown }>) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as ImagePart[]) {
			if (part.type === "image") parts.push(part);
		}
	}
	return parts;
}

describe("anthropic history image replay", () => {
	test("rebuilds an image from a past user turn", async () => {
		registerTestImage("narr-1", "img-a");

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [
						{ type: "text", text: "look at this" },
						{ type: "image", imageId: "img-a", mediaType: "image/png" },
					],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "I see it" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		const images = imagePartsOf(history);
		expect(images).toHaveLength(1);
		expect(images[0].source?.type).toBe("base64");
		expect(images[0].source?.data).toBe(SAMPLE_PNG_BASE64);
		expect(images[0].source?.media_type).toBe("image/png");
	});

	test("keeps the turn's text alongside the image", async () => {
		registerTestImage("narr-1", "img-a");

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [
						{ type: "text", text: "look at this" },
						{ type: "image", imageId: "img-a", mediaType: "image/png" },
					],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		const first = history[0] as { role: string; content: Array<{ type: string; text?: string }> };
		expect(first.role).toBe("user");
		expect(first.content[0]).toEqual({ type: "text", text: "look at this" });
		expect(first.content[1].type).toBe("image");
	});

	test("resolves against the uploading narrator when it differs from the owner", async () => {
		// A forked narrator replays a parent's history, so the image lives under the
		// narrator that originally uploaded it.
		registerTestImage("uploader", "img-b");

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [
						{
							type: "image",
							imageId: "img-b",
							uploadNarratorId: "uploader",
							mediaType: "image/png",
						},
					],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"forked-narrator",
		);

		expect(imagePartsOf(history)).toHaveLength(1);
	});

	test("prefers the detected media type over the stored one", async () => {
		// A file saved with the wrong extension would otherwise be declared as a
		// media type its bytes contradict, which the API rejects.
		registerTestImage("narr-1", "img-c");

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [{ type: "image", imageId: "img-c", mediaType: "image/jpeg" }],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		expect(imagePartsOf(history)[0].source?.media_type).toBe("image/png");
	});

	test("skips a missing file instead of failing the turn", async () => {
		// An old upload may have been cleaned up. Losing one image is bad; failing
		// the whole request because of it is worse.
		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [
						{ type: "text", text: "still here" },
						{ type: "image", imageId: "gone", mediaType: "image/png" },
					],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		expect(imagePartsOf(history)).toHaveLength(0);
		// The surrounding text must survive.
		expect(JSON.stringify(history)).toContain("still here");
	});

	test("emits no image parts when the owning narrator is unknown", async () => {
		// Without an owner there is no directory to look in, so the block cannot be
		// resolved; it must be skipped rather than guessed at.
		registerTestImage("narr-1", "img-a");

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [{ type: "image", imageId: "img-a", mediaType: "image/png" }],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			undefined,
		);

		expect(imagePartsOf(history)).toHaveLength(0);
	});

	test("text-only history is unchanged", async () => {
		// The overwhelmingly common case: a plain string content must not become an
		// array of parts just because the image branch exists.
		const { history } = await provider().buildHistory(
			withTail([
				userMessage({ id: "past", contentJson: [{ type: "text", text: "hello" }] }),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "hi" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		expect(history[0]).toEqual({ role: "user", content: "hello" });
	});

	test("skips an unreadable file instead of failing the turn", async () => {
		// Distinct from the missing-file case above: the path resolves, so the failure
		// happens inside imageToBase64 rather than in the lookup. Both have to be
		// caught, or one cleaned-up upload takes the whole turn down.
		const dir = resolve(testUploadsRoot, "narr-1");
		mkdirSync(dir, { recursive: true });
		// A directory where a file is expected: the path exists, reading it throws.
		mkdirSync(resolve(dir, "broken.png"), { recursive: true });

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [
						{ type: "text", text: "text survives" },
						{ type: "image", imageId: "broken", mediaType: "image/png" },
					],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		expect(imagePartsOf(history)).toHaveLength(0);
		expect(JSON.stringify(history)).toContain("text survives");
	});

	test("replays multiple images from one turn", async () => {
		registerTestImage("narr-1", "img-1");
		registerTestImage("narr-1", "img-2");

		const { history } = await provider().buildHistory(
			withTail([
				userMessage({
					id: "past",
					contentJson: [
						{ type: "image", imageId: "img-1", mediaType: "image/png" },
						{ type: "image", imageId: "img-2", mediaType: "image/png" },
					],
				}),
				{ ...userMessage({ id: "reply", role: "assistant", contentText: "ok" }) },
			]),
			"anthro:claude-sonnet-4.5",
			"narr-1",
		);

		expect(imagePartsOf(history)).toHaveLength(2);
	});
});
