import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MediaRef, mediaRefToContentBlock } from "@shared/media-attachments";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { wavBytes, wavFile, webmBytes } from "../../../tests/fixtures/native-media";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { SessionPayload } from "../../lib/auth";
import { AppError } from "../../lib/errors";
import * as fsScanClient from "../../lib/fs-scan-worker/client";
import { generateId } from "../../lib/id";
import { getMediaPath, saveUploadedMedia } from "../../lib/media-uploads";
import { setUploadsDirForTests } from "../../lib/uploads";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { narratorService } = await import("../narrator-service");
const { cleanupOrphanedUploads } = await import("../storage-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { narratorReferencesMedia } = await import("../narrator-media-access");
const { uploadRoutes } = await import("../../routes/uploads");
const { insertEnvelope } = await import("../narrator-body-writes");
const { noteRowsOnlyEnvelopes } = await import("../narrator-block-scans");
const home = mkdtempSync(join(tmpdir(), "nf-media-fork-"));
setUploadsDirForTests(home);
const now = new Date().toISOString();
const sourceOwner = "source-user";
const forkOwner = "fork-user";
const stranger = "stranger";

beforeEach(() => {
	cleanDb(sqlite);
	noteRowsOnlyEnvelopes(undefined);
	for (const id of [sourceOwner, forkOwner, stranger]) {
		db.insert(users).values({ id, username: id, passwordHash: "x", createdAt: now }).run();
	}
});
afterAll(() => {
	setUploadsDirForTests(null);
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	rmSync(home, { recursive: true, force: true });
});

function addNarrator(ownerUserId: string) {
	const id = generateId();
	db.insert(narrators)
		.values({ id, ownerUserId, cwd: home, visibility: "private", createdAt: now, updatedAt: now })
		.run();
	return id;
}
function addMessage(
	narratorId: string,
	seq: number,
	contentJson: unknown,
	role: typeof narratorMessages.$inferInsert.role = "user",
) {
	const id = generateId();
	db.insert(narratorMessages)
		.values({ id, narratorId, role, contentJson, contentText: "media", createdAt: now })
		.run();
	db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId: id, seq }).run();
	return id;
}
function request(owner: string, mediaId: string, referencingNarratorId?: string, user = forkOwner) {
	const app = new Hono<{ Variables: { user: SessionPayload } }>();
	app.use("*", async (c, next) => {
		c.set("user", { sub: user, role: "user", iat: 0, exp: 9999999999 });
		await next();
	});
	app.route("/uploads", uploadRoutes);
	app.onError((error, c) =>
		c.json({ error: error.message }, error instanceof AppError ? (error.statusCode as 400) : 500),
	);
	const query = referencingNarratorId
		? `?referencingNarratorId=${encodeURIComponent(referencingNarratorId)}`
		: "";
	return app.request(`/uploads/${owner}/media/${mediaId}${query}`);
}
async function fixture(cow: boolean) {
	const source = addNarrator(sourceOwner);
	const audio = await saveUploadedMedia(source, wavFile());
	const video = await saveUploadedMedia(
		source,
		new File([new Uint8Array(webmBytes([1, 2]))], "clip.webm", { type: "video/webm" }),
	);
	const toolMedia = await saveUploadedMedia(source, wavFile("read.wav"));
	const userMessage = addMessage(
		source,
		0,
		[audio, video].map((ref) => mediaRefToContentBlock(ref)),
	);
	const toolMessage = addMessage(source, 1, [{ type: "text", text: "Read" }], "assistant");
	const toolCallId = generateId();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId: source,
			messageId: toolMessage,
			toolName: "Read",
			toolUseId: generateId(),
			status: "success",
			createdAt: now,
			outputJson: { _text: "media file", _media: [mediaRefToContentBlock(toolMedia)] },
		})
		.run();
	const fork = await narratorService.forkNarrator(source, null, {
		inheritMode: "full",
	});
	// Main preserves primary forks independently of their parent's lifecycle.
	// Keep parentNarratorId intact to cover that rule while separating access.
	await db.update(narrators).set({ ownerUserId: forkOwner }).where(eq(narrators.id, fork.id));
	if (cow) {
		await narratorPersistence.copyOnWriteMessage(fork.id, userMessage);
		await narratorPersistence.copyOnWriteMessage(fork.id, toolMessage);
	}
	return { source, fork: fork.id, audio, video, toolMedia, toolCallId };
}

test("orphan cleanup retains media directories and still reclaims ordinary uploads", async () => {
	const isolated = mkdtempSync(join(tmpdir(), "nf-media-cleanup-"));
	setUploadsDirForTests(isolated);
	try {
		mkdirSync(join(isolated, "media-owner", "media"), { recursive: true });
		mkdirSync(join(isolated, "empty-media-owner", "media"), { recursive: true });
		mkdirSync(join(isolated, "orphan"), { recursive: true });
		mkdirSync(join(isolated, "avatars"), { recursive: true });
		writeFileSync(join(isolated, "media-owner", "media", "audio.wav"), "audio");
		writeFileSync(join(isolated, "media-owner", "image.png"), "image");
		writeFileSync(join(isolated, "orphan", "image.png"), "orphan");
		writeFileSync(join(isolated, "avatars", "avatar.png"), "avatar");

		expect(await cleanupOrphanedUploads()).toEqual({ removed: 1, freedBytes: 6 });
		expect(existsSync(join(isolated, "media-owner", "media", "audio.wav"))).toBe(true);
		expect(existsSync(join(isolated, "media-owner", "image.png"))).toBe(true);
		expect(existsSync(join(isolated, "empty-media-owner", "media"))).toBe(true);
		expect(existsSync(join(isolated, "orphan"))).toBe(false);
		expect(existsSync(join(isolated, "avatars", "avatar.png"))).toBe(true);
	} finally {
		setUploadsDirForTests(home);
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("media created while orphan children are being removed survives cleanup", async () => {
	const isolated = mkdtempSync(join(tmpdir(), "nf-media-cleanup-race-"));
	setUploadsDirForTests(isolated);
	const owner = "orphan-race";
	mkdirSync(join(isolated, owner), { recursive: true });
	writeFileSync(join(isolated, owner, "image.png"), "image");
	const originalRm = fsPromises.rm;
	let mediaId: string | undefined;
	const rmSpy = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
		if (String(path) === join(isolated, owner, "image.png")) {
			mediaId = (await saveUploadedMedia(owner, wavFile())).mediaId;
		}
		return originalRm(path, options);
	});
	try {
		expect(await cleanupOrphanedUploads()).toEqual({ removed: 0, freedBytes: 5 });
		expect(mediaId).toBeDefined();
		expect(getMediaPath(owner, mediaId ?? "")).not.toBeNull();
		expect(existsSync(join(isolated, owner, "image.png"))).toBe(false);
	} finally {
		rmSpy.mockRestore();
		setUploadsDirForTests(home);
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("media created just before removing an empty orphan root survives cleanup", async () => {
	const isolated = mkdtempSync(join(tmpdir(), "nf-media-rmdir-race-"));
	setUploadsDirForTests(isolated);
	const owner = "orphan-rmdir-race";
	mkdirSync(join(isolated, owner), { recursive: true });
	const originalRmdir = fsPromises.rmdir;
	let mediaId: string | undefined;
	const rmdirSpy = spyOn(fsPromises, "rmdir").mockImplementation(async (...args) => {
		if (String(args[0]) === join(isolated, owner)) {
			mediaId = (await saveUploadedMedia(owner, wavFile())).mediaId;
		}
		return originalRmdir(...args);
	});
	try {
		expect(await cleanupOrphanedUploads()).toEqual({ removed: 0, freedBytes: 0 });
		expect(mediaId).toBeDefined();
		expect(getMediaPath(owner, mediaId ?? "")).not.toBeNull();
	} finally {
		rmdirSpy.mockRestore();
		setUploadsDirForTests(home);
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("narrator removal retains media uploaded while its old files are cleaned", async () => {
	const owner = addNarrator(sourceOwner);
	mkdirSync(join(home, owner), { recursive: true });
	writeFileSync(join(home, owner, "image.png"), "image");
	const originalRm = fsPromises.rm;
	let mediaId: string | undefined;
	const rmSpy = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
		if (String(path) === join(home, owner, "image.png")) {
			mediaId = (await saveUploadedMedia(owner, wavFile())).mediaId;
		}
		return originalRm(path, options);
	});
	try {
		await narratorService.remove(owner);
		expect(mediaId).toBeDefined();
		expect(getMediaPath(owner, mediaId ?? "")).not.toBeNull();
		expect(existsSync(join(home, owner, "image.png"))).toBe(false);
	} finally {
		rmSpy.mockRestore();
	}
});

test("orphan cleanup tolerates directories and files disappearing during inspection", async () => {
	const isolated = mkdtempSync(join(tmpdir(), "nf-cleanup-enoent-"));
	setUploadsDirForTests(isolated);
	for (const owner of ["missing-owner", "missing-file", "missing-dir", "ordinary"]) {
		mkdirSync(join(isolated, owner), { recursive: true });
	}
	writeFileSync(join(isolated, "missing-file", "image.png"), "image");
	mkdirSync(join(isolated, "missing-dir", "text"));
	writeFileSync(join(isolated, "ordinary", "image.png"), "normal");
	const originalReaddir = fsPromises.readdir;
	const originalLstat = fsPromises.lstat;
	const originalMeasure = fsScanClient.measureDirectoriesOffThread;
	const missing = () => Object.assign(new Error("disappeared"), { code: "ENOENT" });
	const seen = new Set<string>();
	const readSpy = spyOn(fsPromises, "readdir").mockImplementation((async (path, options) => {
		if (String(path) === join(isolated, "missing-owner")) {
			seen.add("readdir");
			throw missing();
		}
		return originalReaddir(path, options as never);
	}) as typeof fsPromises.readdir);
	const statSpy = spyOn(fsPromises, "lstat").mockImplementation((async (path, options) => {
		if (String(path) === join(isolated, "missing-file", "image.png")) {
			seen.add("lstat");
			throw missing();
		}
		return originalLstat(path, options as never);
	}) as typeof fsPromises.lstat);
	const measureSpy = spyOn(fsScanClient, "measureDirectoriesOffThread").mockImplementation(
		async (paths, options) => {
			if (paths[0] === join(isolated, "missing-dir", "text")) {
				seen.add("dirSize");
				throw missing();
			}
			return originalMeasure(paths, options);
		},
	);
	try {
		const result = await cleanupOrphanedUploads();
		expect(result.freedBytes).toBe(6);
		expect(seen).toEqual(new Set(["readdir", "lstat", "dirSize"]));
		expect(existsSync(join(isolated, "ordinary"))).toBe(false);
	} finally {
		readSpy.mockRestore();
		statSpy.mockRestore();
		measureSpy.mockRestore();
		setUploadsDirForTests(home);
		rmSync(isolated, { recursive: true, force: true });
	}
});

for (const cow of [false, true]) {
	describe(cow ? "COW media references" : "shared-message media references", () => {
		test("a readable fork authorizes only its exact owner/id, not the private source", async () => {
			const f = await fixture(cow);
			expect((await request(f.source, f.audio.mediaId)).status).toBe(404);
			for (const ref of [f.audio, f.video, f.toolMedia]) {
				const response = await request(f.source, ref.mediaId, f.fork);
				expect(response.status).toBe(200);
				expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			}
			const unrelated = await saveUploadedMedia(f.source, wavFile("unreferenced.wav"));
			expect((await request(f.source, unrelated.mediaId, f.fork)).status).toBe(404);
			expect((await request(f.fork, f.audio.mediaId, f.fork)).status).toBe(404);
			expect((await request(f.source, f.audio.mediaId, f.fork, stranger)).status).toBe(404);
			const unrelatedNarrator = addNarrator(forkOwner);
			expect((await request(f.source, f.audio.mediaId, unrelatedNarrator)).status).toBe(404);
		});
		test("source deletion preserves audio/video bytes and shared Read output references", async () => {
			const f = await fixture(cow);
			await narratorService.remove(f.source);
			await cleanupOrphanedUploads();
			expect(
				await db.query.narrators.findFirst({ where: eq(narrators.id, f.source) }),
			).toBeUndefined();
			expect(await db.query.narrators.findFirst({ where: eq(narrators.id, f.fork) })).toBeDefined();
			const retainedTool = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.narratorId, f.fork),
			});
			expect(retainedTool?.executionOriginToolCallId).toBe(f.toolCallId);
			for (const ref of [f.audio, f.video, f.toolMedia]) {
				expect(getMediaPath(f.source, ref.mediaId)).not.toBeNull();
				const response = await request(f.source, ref.mediaId, f.fork);
				expect(response.status).toBe(200);
				if (ref.mediaType === "audio/wav") {
					expect(Buffer.from(await response.arrayBuffer())).toEqual(wavBytes());
				}
			}
			expect((await request(f.source, f.toolMedia.mediaId)).status).toBe(404);
			expect((await request(f.source, f.toolMedia.mediaId, f.fork, stranger)).status).toBe(404);
			await narratorService.remove(f.fork);
			expect((await request(f.source, f.audio.mediaId, f.fork)).status).toBe(404);
		});
	});
}

test("reference lookup pages only the authorized narrator and ignores JSON/string decoys", async () => {
	const source = addNarrator(sourceOwner),
		context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	for (let seq = 0; seq < 20; seq++) {
		addMessage(context, seq, [
			{ type: "text", text: JSON.stringify(mediaRefToContentBlock(media)) },
		]);
	}
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(false);
	addMessage(context, 20, [mediaRefToContentBlock(media)]);
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
	expect(await narratorReferencesMedia(context, `${source}-wrong`, media.mediaId)).toBe(false);
	expect(await narratorReferencesMedia(context, source, `${media.mediaId}-wrong`)).toBe(false);
});

for (const rowsOnly of [false, true]) {
	test(`authorizes the authoritative block body with rowsOnly=${rowsOnly}`, async () => {
		const source = addNarrator(sourceOwner);
		const context = addNarrator(forkOwner);
		const media = await saveUploadedMedia(source, wavFile());
		const id = generateId();
		db.transaction((tx) =>
			insertEnvelope(tx, {
				id,
				narratorId: context,
				role: "user",
				bodyFormat: 2,
				contentJson: [mediaRefToContentBlock(media)],
				contentText: "audio",
				createdAt: now,
			}),
		);
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: context, messageId: id, seq: 0 })
			.run();
		sqlite.run(
			"UPDATE narrator_messages SET content_json = '[]', body_rows_only = ?, state_revision = state_revision + 1 WHERE id = ?",
			[rowsOnly ? 1 : 0, id],
		);
		if (rowsOnly) {
			noteRowsOnlyEnvelopes(true);
			sqlite.run("INSERT OR IGNORE INTO narrator_block_sync_queue (message_id) VALUES (?)", [id]);
		}
		expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
		expect((await request(source, media.mediaId, context)).status).toBe(200);
		expect(await narratorReferencesMedia(context, context, media.mediaId)).toBe(false);
	});
}

test("authorizes media in oversized block bodies", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	const id = generateId();
	db.transaction((tx) =>
		insertEnvelope(tx, {
			id,
			narratorId: context,
			role: "user",
			bodyFormat: 2,
			contentJson: [{ type: "text", text: "x".repeat(129 * 1024) }, mediaRefToContentBlock(media)],
			contentText: "large",
			createdAt: now,
		}),
	);
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: context, messageId: id, seq: 0 })
		.run();
	sqlite.run(
		"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1, state_revision = state_revision + 1 WHERE id = ?",
		[id],
	);
	noteRowsOnlyEnvelopes(true);
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
	expect(await narratorReferencesMedia(context, `${source}-wrong`, media.mediaId)).toBe(false);
});

test("elapsed time under the lookup's cap does not reject a valid reference", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	addMessage(context, 0, [mediaRefToContentBlock(media)]);
	let ticks = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => (ticks++ < 2 ? 0 : 501));
	try {
		expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
	} finally {
		clock.mockRestore();
	}
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
});

test("cumulative bytes do not stop lookup before a later valid reference", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	db.transaction(() => {
		for (let seq = 0; seq < 80; seq++)
			addMessage(context, seq, [{ type: "text", text: "x".repeat(120 * 1024) }]);
		addMessage(context, 80, [mediaRefToContentBlock(media)]);
	});
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
});

test("reference lookup reaches the 8193rd authorized reference", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	db.transaction(() => {
		for (let seq = 0; seq < 8192; seq++) addMessage(context, seq, []);
		addMessage(context, 8192, [mediaRefToContentBlock(media)]);
	});
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
}, 60_000);

test("revoked references no longer authorize media", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	const id = addMessage(context, 0, [mediaRefToContentBlock(media)]);
	const response = await request(source, media.mediaId, context);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, id)).run();
	expect((await request(source, media.mediaId, context)).status).toBe(404);
});

test("reference pages preserve refs sharing the same sequence", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	// More refs than one lookup window, all at one seq: the keyset must break ties by id.
	for (let index = 0; index < 300; index++) {
		const id = addMessage(context, 0, index === 299 ? [mediaRefToContentBlock(media)] : []);
		db.update(narratorMessageRefs)
			.set({ id: `ref-${String(index).padStart(3, "0")}` })
			.where(eq(narratorMessageRefs.messageId, id))
			.run();
	}
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
});

test("tool rows are paged before following a later message page", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	const id = addMessage(context, 0, [], "assistant");
	for (let index = 0; index < 65; index++)
		db.insert(narratorToolCalls)
			.values({
				id: `tool-${String(index).padStart(3, "0")}`,
				narratorId: context,
				messageId: id,
				toolName: "Read",
				toolUseId: generateId(),
				status: "success",
				createdAt: now,
				// Decoys mention the id, so they pass the SQL prefilter and fill a tool page.
				outputJson:
					index === 64
						? { _media: [mediaRefToContentBlock(media)] }
						: { _text: `mentions ${media.mediaId}` },
			})
			.run();
	// The later reference sits past the first lookup window.
	for (let seq = 1; seq < 300; seq++) addMessage(context, seq, []);
	const laterMedia = await saveUploadedMedia(source, wavFile("later.wav"));
	addMessage(context, 300, [mediaRefToContentBlock(laterMedia)]);
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
	expect(await narratorReferencesMedia(context, source, laterMedia.mediaId)).toBe(true);
});

test("revoking a ref during tool pagination prevents stale authorization", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	const messageId = addMessage(context, 0, [], "assistant");
	for (let index = 0; index < 65; index++) {
		db.insert(narratorToolCalls)
			.values({
				id: `revoked-tool-${String(index).padStart(3, "0")}`,
				narratorId: context,
				messageId,
				toolName: "Read",
				toolUseId: generateId(),
				status: "success",
				createdAt: now,
				// Decoys mention the id so the lookup pages (and yields) through tool rows.
				outputJson:
					index === 64
						? { _media: [mediaRefToContentBlock(media)] }
						: { _text: `mentions ${media.mediaId}` },
			})
			.run();
	}
	const pending = narratorReferencesMedia(context, source, media.mediaId);
	setTimeout(
		() => db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, messageId)).run(),
		0,
	);
	expect(await pending).toBe(false);
});

test("authorizes exact references in oversized tool outputs shared by a fork", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	const id = addMessage(source, 0, [], "assistant");
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: context, messageId: id, seq: 0 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: generateId(),
			narratorId: source,
			messageId: id,
			toolName: "Read",
			toolUseId: generateId(),
			status: "success",
			createdAt: now,
			outputJson: { _text: "x".repeat(129 * 1024), _media: [mediaRefToContentBlock(media)] },
		})
		.run();
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
	expect(await narratorReferencesMedia(context, context, media.mediaId)).toBe(false);
	expect(await narratorReferencesMedia(context, source, `${media.mediaId}-wrong`)).toBe(false);
});

test("lookup observes cancellation between reference pages", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const media = await saveUploadedMedia(source, wavFile());
	// More refs than one lookup window, so the lookup yields before it reaches the match.
	for (let seq = 0; seq < 300; seq++) addMessage(context, seq, []);
	addMessage(context, 300, [mediaRefToContentBlock(media)]);
	const controller = new AbortController();
	const pending = narratorReferencesMedia(context, source, media.mediaId, {
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 0);
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("oversized legacy JSON authorizes exact references and cancellation fails closed", async () => {
	const source = addNarrator(sourceOwner),
		context = addNarrator(forkOwner);
	const media: MediaRef = {
		mediaId: "known-id",
		mediaType: "audio/wav",
		filename: "a.wav",
		size: 60,
		uploadNarratorId: source,
	};
	addMessage(context, 0, [
		{ type: "text", text: "x".repeat(129 * 1024) },
		mediaRefToContentBlock(media),
	]);
	expect(await narratorReferencesMedia(context, source, media.mediaId)).toBe(true);
	expect(await narratorReferencesMedia(context, `${source}-wrong`, media.mediaId)).toBe(false);
	const controller = new AbortController();
	controller.abort();
	await expect(
		narratorReferencesMedia(context, source, media.mediaId, { signal: controller.signal }),
	).rejects.toMatchObject({ name: "AbortError" });
});
