/**
 * `GET /api/uploads/:narratorId/:imageId` serves a session's images only to someone who
 * may read that session, or a fork/copy of it whose history references the exact image.
 * Refusals and missing files must look identical, and the response must never be
 * stored by a shared cache.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeToolOutput } from "@shared/agent-protocol/tool-output";
import { mediaRefToContentBlock } from "@shared/media-attachments";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { wavFile } from "../../../tests/fixtures/native-media";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import type { SessionPayload } from "../../lib/auth";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { saveUploadedMedia } from "../../lib/media-uploads";
import {
	type ImageRef,
	imageRefToContentBlock,
	saveAvatarImage,
	saveUploadedImage,
	setUploadsDirForTests,
} from "../../lib/uploads";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { narratorService } = await import("../../services/narrator-service");
const { narratorPersistence } = await import("../../services/narrator-persistence");
const {
	lastReferenceLookupStatsForTests,
	narratorReferencesImage,
	narratorReferencesMedia,
	setReferenceLookupLimitsForTests,
} = await import("../../services/narrator-media-access");
const { insertEnvelope } = await import("../../services/narrator-body-writes");
const { grantNarratorAccess } = await import("../../services/narrator-sharing");
const { uploadRoutes } = await import("../uploads");
const { sessionInterchangeRoutes } = await import("../session-interchange");

const home = mkdtempSync(join(tmpdir(), "nf-image-acl-"));
setUploadsDirForTests(home);
const now = new Date().toISOString();
const sourceOwner = "source-user";
const forkOwner = "fork-user";
const stranger = "stranger";
const admin = "admin-user";

/** Minimal valid 1×1 PNG, so the upload pipeline's content sniffing accepts it. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFPqZqPAAAAAElFTkSuQmCC",
	"base64",
);
const png = (name = "shot.png") => new File([PNG_1X1], name, { type: "image/png" });

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of [sourceOwner, forkOwner, stranger, admin]) {
		db.insert(users)
			.values({
				id,
				username: id,
				passwordHash: "x",
				role: id === admin ? "admin" : "user",
				createdAt: now,
			})
			.run();
	}
});
afterEach(() => setReferenceLookupLimitsForTests(null));
afterAll(() => {
	setUploadsDirForTests(null);
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	rmSync(home, { recursive: true, force: true });
});

function addNarrator(
	ownerUserId: string,
	visibility: typeof narrators.$inferInsert.visibility = "private",
) {
	const id = generateId();
	db.insert(narrators)
		.values({ id, ownerUserId, cwd: home, visibility, createdAt: now, updatedAt: now })
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
		.values({ id, narratorId, role, contentJson, contentText: "image", createdAt: now })
		.run();
	db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId: id, seq }).run();
	return id;
}
function addRef(narratorId: string, messageId: string, seq: number) {
	db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq }).run();
}
function addToolImage(narratorId: string, messageId: string, image: ImageRef) {
	db.insert(narratorToolCalls)
		.values({
			id: generateId(),
			narratorId,
			messageId,
			toolName: "GenUI",
			toolUseId: generateId(),
			status: "success",
			createdAt: now,
			outputJson: encodeToolOutput("inspected", {
				images: [
					{
						imageId: image.imageId,
						mediaType: image.mediaType,
						uploadNarratorId: image.uploadNarratorId ?? narratorId,
					},
				],
			}),
		})
		.run();
}

function revoke(narratorId: string, userId: string) {
	db.delete(aclGrants)
		.where(and(eq(aclGrants.scopeId, narratorId), eq(aclGrants.principalId, userId)))
		.run();
}

function appAs(user: string) {
	const app = new Hono<{ Variables: { user: SessionPayload } }>();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: user,
			role: user === admin ? "admin" : "user",
			iat: 0,
			exp: 9999999999,
		});
		await next();
	});
	app.route("/uploads", uploadRoutes);
	app.route("/session-interchange", sessionInterchangeRoutes);
	// The production serializer, so "identical response" means identical on the wire.
	app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "x" }, 500));
	return app;
}

function request(
	owner: string,
	imageId: string,
	options: { referencingNarratorId?: string; user?: string } = {},
) {
	const query = options.referencingNarratorId
		? `?referencingNarratorId=${encodeURIComponent(options.referencingNarratorId)}`
		: "";
	return appAs(options.user ?? sourceOwner).request(`/uploads/${owner}/${imageId}${query}`);
}

async function expectImage(response: Response) {
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_1X1);
}

async function sourceWithImage(visibility: typeof narrators.$inferInsert.visibility = "private") {
	const source = addNarrator(sourceOwner, visibility);
	const image = await saveUploadedImage(source, png());
	const messageId = addMessage(source, 0, [imageRefToContentBlock(image, source)]);
	return { source, image, messageId };
}

describe("owner and shared readers", () => {
	test("the owner reads its image with private, per-session caching", async () => {
		const { source, image } = await sourceWithImage();
		const response = await request(source, image.imageId);
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600, immutable");
		expect(response.headers.get("Vary")).toContain("Authorization");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Type")).toStartWith("image/png");
		await expectImage(response);
	});

	test("a signed-in user without access gets 404, the media route's answer", async () => {
		const { source, image } = await sourceWithImage();
		const response = await request(source, image.imageId, { user: stranger });
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBeNull();
	});

	test("public visibility, read/write grants and admins read; revoking a grant denies", async () => {
		const { source, image } = await sourceWithImage();
		await expectImage(await request(source, image.imageId, { user: admin }));

		const principal = { userId: sourceOwner, isAdmin: false };
		await grantNarratorAccess(source, [stranger], "read", principal);
		await expectImage(await request(source, image.imageId, { user: stranger }));
		revoke(source, stranger);
		expect((await request(source, image.imageId, { user: stranger })).status).toBe(404);

		await grantNarratorAccess(source, [stranger], "write", principal);
		await expectImage(await request(source, image.imageId, { user: stranger }));
		revoke(source, stranger);

		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, source));
		await expectImage(await request(source, image.imageId, { user: stranger }));
	});

	test("a reader of the owner is served even when the reference context is unrelated", async () => {
		const { source, image } = await sourceWithImage();
		const unrelated = addNarrator(stranger);
		await expectImage(await request(source, image.imageId, { referencingNarratorId: unrelated }));
	});
});

async function fork(cow: boolean) {
	const { source, image, messageId } = await sourceWithImage();
	const toolImage = await saveUploadedImage(source, png("inspect.png"));
	const toolMessage = addMessage(source, 1, [{ type: "text", text: "Inspect" }], "assistant");
	addToolImage(source, toolMessage, toolImage);
	const forked = await narratorService.forkNarrator(source, null, { inheritMode: "full" });
	// The fork's reader cannot read the private source: only the reference path helps.
	await db.update(narrators).set({ ownerUserId: forkOwner }).where(eq(narrators.id, forked.id));
	if (cow) {
		await narratorPersistence.copyOnWriteMessage(forked.id, messageId);
		await narratorPersistence.copyOnWriteMessage(forked.id, toolMessage);
	}
	return { source, fork: forked.id, image, toolImage };
}

for (const cow of [false, true]) {
	describe(cow ? "COW image references" : "shared-message image references", () => {
		test("a fork's reader sees only the source images its history references", async () => {
			const f = await fork(cow);
			const asForkOwner = { user: forkOwner, referencingNarratorId: f.fork };
			expect((await request(f.source, f.image.imageId, { user: forkOwner })).status).toBe(404);
			await expectImage(await request(f.source, f.image.imageId, asForkOwner));
			await expectImage(await request(f.source, f.toolImage.imageId, asForkOwner));

			const unreferenced = await saveUploadedImage(f.source, png("other.png"));
			expect((await request(f.source, unreferenced.imageId, asForkOwner)).status).toBe(404);
			// The owner/id pair is exact: the fork's own directory does not hold the file.
			expect((await request(f.fork, f.image.imageId, asForkOwner)).status).toBe(404);
			// A context the caller cannot read authorizes nothing.
			expect(
				(
					await request(f.source, f.image.imageId, {
						user: stranger,
						referencingNarratorId: f.fork,
					})
				).status,
			).toBe(404);
			// A readable context that never referenced the image authorizes nothing either.
			const unrelated = addNarrator(forkOwner);
			expect(
				(
					await request(f.source, f.image.imageId, {
						user: forkOwner,
						referencingNarratorId: unrelated,
					})
				).status,
			).toBe(404);
		});
	});
}

test("a fork shared with another user extends to the images it references", async () => {
	const f = await fork(false);
	await grantNarratorAccess(f.fork, [stranger], "read", { userId: forkOwner, isAdmin: false });
	await expectImage(
		await request(f.source, f.image.imageId, { user: stranger, referencingNarratorId: f.fork }),
	);
});

test("legacy blocks without uploadNarratorId belong to their message's narrator", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const image = await saveUploadedImage(source, png());
	const { uploadNarratorId: _owner, ...legacy } = imageRefToContentBlock(image);
	const messageId = addMessage(source, 0, [legacy]);
	addRef(context, messageId, 0);
	await expectImage(
		await request(source, image.imageId, { user: forkOwner, referencingNarratorId: context }),
	);
	// The same legacy block copied into the context's own message names the context.
	const copy = addNarrator(forkOwner);
	addMessage(copy, 0, [legacy]);
	expect(await narratorReferencesImage(copy, source, image.imageId)).toBe(false);
});

test("revoking the referencing message revokes the image", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const image = await saveUploadedImage(source, png());
	const messageId = addMessage(context, 0, [imageRefToContentBlock(image)]);
	const asForkOwner = { user: forkOwner, referencingNarratorId: context };
	await expectImage(await request(source, image.imageId, asForkOwner));
	db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, messageId)).run();
	expect((await request(source, image.imageId, asForkOwner)).status).toBe(404);
});

test("reference lookup ignores JSON strings, media blocks and other owners", async () => {
	const source = addNarrator(sourceOwner);
	const context = addNarrator(forkOwner);
	const image = await saveUploadedImage(source, png());
	const block = imageRefToContentBlock(image);
	addMessage(context, 0, [{ type: "text", text: JSON.stringify(block) }]);
	addMessage(context, 1, [
		{ type: "audio", mediaId: image.imageId, uploadNarratorId: source, filename: "a.wav" },
	]);
	expect(await narratorReferencesImage(context, source, image.imageId)).toBe(false);
	addMessage(context, 2, [block]);
	expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
	expect(await narratorReferencesImage(context, `${source}-wrong`, image.imageId)).toBe(false);
	expect(await narratorReferencesImage(context, source, `${image.imageId}-wrong`)).toBe(false);
});

test("a missing image is indistinguishable from one the caller may not read", async () => {
	const { source, image } = await sourceWithImage();
	const own = addNarrator(stranger);
	const context = addNarrator(stranger);
	const answers = await Promise.all(
		[
			// Exists, but the narrator is private to someone else.
			request(source, image.imageId, { user: stranger }),
			// Same id in a narrator the caller owns, where no such file exists.
			request(own, image.imageId, { user: stranger }),
			// A narrator id that does not exist at all.
			request("no-such-narrator", image.imageId, { user: stranger }),
			// A readable context that does not reference it.
			request(source, image.imageId, { user: stranger, referencingNarratorId: context }),
			// A context that does not exist.
			request(source, image.imageId, { user: stranger, referencingNarratorId: "nope" }),
		].map(async (pending) => {
			const response = await pending;
			return {
				status: response.status,
				body: await response.text(),
				headers: [...response.headers.entries()],
			};
		}),
	);
	expect(answers[0].status).toBe(404);
	for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
});

test("avatars stay readable by any signed-in user but are never publicly cacheable", async () => {
	const avatar = await saveAvatarImage(sourceOwner, png("avatar.png"));
	const response = await appAs(stranger).request(
		`/uploads/avatars/${sourceOwner}/${avatar.imageId}`,
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
});

describe("forged references", () => {
	/** A tool's plain-text output, e.g. Bash `printf '%s' '<json>'`: stored as a string. */
	function addTextToolOutput(narratorId: string, text: string) {
		const messageId = addMessage(narratorId, 0, [], "assistant");
		db.insert(narratorToolCalls)
			.values({
				id: generateId(),
				narratorId,
				messageId,
				toolName: "Bash",
				toolUseId: generateId(),
				status: "success",
				createdAt: now,
				outputJson: encodeToolOutput(text),
			})
			.run();
	}

	test("tool text that looks like `_images` is not a reference", async () => {
		const { source, image } = await sourceWithImage();
		const attacker = addNarrator(stranger);
		const forged = JSON.stringify({
			_images: [{ imageId: image.imageId, mediaType: "image/png", uploadNarratorId: source }],
		});
		addTextToolOutput(attacker, forged);
		const [call] = db
			.select({ output: narratorToolCalls.outputJson })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.narratorId, attacker))
			.all();
		expect(call.output).toBe(forged);
		expect(await narratorReferencesImage(attacker, source, image.imageId)).toBe(false);
		expect(
			(await request(source, image.imageId, { user: stranger, referencingNarratorId: attacker }))
				.status,
		).toBe(404);
	});

	test("tool text that looks like `_media` is not a reference either", async () => {
		const source = addNarrator(sourceOwner);
		const media = await saveUploadedMedia(source, wavFile());
		const attacker = addNarrator(stranger);
		addTextToolOutput(attacker, JSON.stringify({ _media: [mediaRefToContentBlock(media)] }));
		expect(await narratorReferencesMedia(attacker, source, media.mediaId)).toBe(false);
		const response = await appAs(stranger).request(
			`/uploads/${source}/media/${media.mediaId}?referencingNarratorId=${attacker}`,
		);
		expect(response.status).toBe(404);
	});

	test("an uploaded transcript cannot forge a reference to another user's image", async () => {
		const { source, image } = await sourceWithImage();
		const session = "44444444-4444-4444-8444-444444444444";
		const forged = JSON.stringify({
			_images: [{ imageId: image.imageId, mediaType: "image/png", uploadNarratorId: source }],
		});
		const rows = [
			{
				type: "user",
				uuid: "u1",
				parentUuid: null,
				sessionId: session,
				cwd: home,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
			{
				type: "assistant",
				uuid: "a1",
				parentUuid: "u1",
				sessionId: session,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					id: "msg_1",
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo" } }],
				},
			},
			{
				type: "user",
				uuid: "r1",
				parentUuid: "a1",
				sessionId: session,
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: forged }],
				},
			},
		];
		const form = new FormData();
		form.append(
			"files",
			new File([`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`], `${session}.jsonl`),
		);
		const attacker = appAs(stranger);
		const imported = await attacker.request("/session-interchange/import/upload", {
			method: "POST",
			body: form,
		});
		expect(imported.status).toBe(201);
		const { narratorId } = (await imported.json()) as { narratorId: string };
		const response = await attacker.request(
			`/uploads/${source}/${image.imageId}?referencingNarratorId=${narratorId}`,
		);
		expect(response.status).toBe(404);
	});
});

describe("other legitimate viewers", () => {
	test("a reader of the root reads an image uploaded to its subagent", async () => {
		const root = addNarrator(sourceOwner);
		const sub = generateId();
		db.insert(narrators)
			.values({
				id: sub,
				ownerUserId: sourceOwner,
				cwd: home,
				visibility: "private",
				type: "subagent",
				parentNarratorId: root,
				aclRootNarratorId: root,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const image = await saveUploadedImage(sub, png());
		expect((await request(sub, image.imageId, { user: stranger })).status).toBe(404);
		await grantNarratorAccess(root, [stranger], "read", { userId: sourceOwner, isAdmin: false });
		await expectImage(await request(sub, image.imageId, { user: stranger }));
		await expectImage(
			await request(sub, image.imageId, { user: stranger, referencingNarratorId: root }),
		);
	});

	test("a fork's reader still sees an inherited image after the source is deleted", async () => {
		const source = addNarrator(sourceOwner);
		const image = await saveUploadedImage(source, png());
		const { uploadNarratorId: _owner, ...legacy } = imageRefToContentBlock(image);
		const messageId = addMessage(source, 0, [legacy, { type: "text", text: "see" }]);
		const forked = await narratorService.forkNarrator(source, null, { inheritMode: "full" });
		await db.update(narrators).set({ ownerUserId: forkOwner }).where(eq(narrators.id, forked.id));
		await narratorService.remove(source);
		const [kept] = db
			.select({ owner: narratorMessages.narratorId })
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.all();
		expect(kept.owner).toBe(forked.id);
		await expectImage(
			await request(source, image.imageId, {
				user: forkOwner,
				referencingNarratorId: forked.id,
			}),
		);
		expect(
			(await request(source, image.imageId, { user: stranger, referencingNarratorId: forked.id }))
				.status,
		).toBe(404);
	});
});

describe("bounded reference lookup", () => {
	async function longContext(referenceAt: number, length = referenceAt + 1) {
		const source = addNarrator(sourceOwner);
		const context = addNarrator(forkOwner);
		const image = await saveUploadedImage(source, png());
		db.transaction(() => {
			for (let seq = 0; seq < length; seq++)
				addMessage(context, seq, seq === referenceAt ? [imageRefToContentBlock(image)] : []);
		});
		return { source, context, image };
	}

	test("a reference past the ref cap is denied, one inside it is found", async () => {
		setReferenceLookupLimitsForTests({ maxRefs: 256 });
		const late = await longContext(300);
		expect(await narratorReferencesImage(late.context, late.source, late.image.imageId)).toBe(
			false,
		);
		const early = await longContext(10, 300);
		expect(await narratorReferencesImage(early.context, early.source, early.image.imageId)).toBe(
			true,
		);
	});

	test("the decode cap denies when too many rows merely mention the id", async () => {
		const { source, context, image } = await longContext(5);
		setReferenceLookupLimitsForTests({ maxDecoded: 3 });
		for (let seq = 0; seq < 5; seq++)
			db.update(narratorMessages)
				.set({ contentJson: [{ type: "text", text: `mentions ${image.imageId}` }] })
				.where(
					eq(
						narratorMessages.id,
						db
							.select({ id: narratorMessageRefs.messageId })
							.from(narratorMessageRefs)
							.where(
								and(eq(narratorMessageRefs.narratorId, context), eq(narratorMessageRefs.seq, seq)),
							)
							.all()[0].id,
					),
				)
				.run();
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(false);
		setReferenceLookupLimitsForTests(null);
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
	});

	test("the time cap denies a lookup that runs too long", async () => {
		const { source, context, image } = await longContext(0);
		setReferenceLookupLimitsForTests({ maxMs: 1_000 });
		let calls = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => (calls++ === 0 ? 0 : 5_000));
		try {
			expect(await narratorReferencesImage(context, source, image.imageId)).toBe(false);
		} finally {
			clock.mockRestore();
		}
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
	});

	test("ids too short to be upload ids never start a lookup", async () => {
		const { source, context } = await longContext(0);
		expect(await narratorReferencesImage(context, source, "abc")).toBe(false);
	});

	test("a running lookup aborts with its request and frees its slot", async () => {
		setReferenceLookupLimitsForTests({ processRunning: 1 });
		const { source, context, image } = await longContext(600);
		const controller = new AbortController();
		const pending = narratorReferencesImage(context, source, image.imageId, {
			signal: controller.signal,
			principal: forkOwner,
		});
		setTimeout(() => controller.abort(), 0);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(
			await narratorReferencesImage(context, source, image.imageId, { principal: forkOwner }),
		).toBe(true);
	});

	test("one user's queue is bounded; a waiting lookup can be aborted", async () => {
		setReferenceLookupLimitsForTests({ userRunning: 1, userPending: 2 });
		const { source, context, image } = await longContext(600);
		const lookup = (signal?: AbortSignal) =>
			narratorReferencesImage(context, source, image.imageId, { signal, principal: forkOwner });
		const first = lookup();
		const controller = new AbortController();
		const waiting = lookup(controller.signal);
		// Running + waiting already fill this user's queue: denied without a lookup.
		expect(await lookup()).toBe(false);
		// Another user is not affected by this user's queue.
		const other = narratorReferencesImage(context, source, image.imageId, { principal: stranger });
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(await first).toBe(true);
		expect(await other).toBe(true);
		// Every slot was returned.
		expect(await lookup()).toBe(true);
	});

	test("a full process queue denies at once", async () => {
		setReferenceLookupLimitsForTests({ processRunning: 1, processPending: 1 });
		const { source, context, image } = await longContext(600);
		const first = narratorReferencesImage(context, source, image.imageId, { principal: "a" });
		expect(await narratorReferencesImage(context, source, image.imageId, { principal: "b" })).toBe(
			false,
		);
		expect(await first).toBe(true);
	});

	test("queued short lookups yield to the event loop instead of running back to back", async () => {
		// One window each (well under 256 refs), so only the yield after getting a slot can
		// let a timer run before the whole burst has drained.
		const { source, context } = await longContext(-1, 50);
		const burst = 8;
		let completed = 0;
		let completedWhenTimerFired = -1;
		setTimeout(() => {
			completedWhenTimerFired = completed;
		}, 0);
		const results = await Promise.all(
			Array.from({ length: burst }, (_, index) =>
				narratorReferencesImage(context, source, `missing${index}`, { principal: forkOwner }).then(
					(found) => {
						completed++;
						return found;
					},
				),
			),
		);
		expect(results).toEqual(Array(burst).fill(false));
		expect(completedWhenTimerFired).toBeGreaterThanOrEqual(0);
		expect(completedWhenTimerFired).toBeLessThan(burst);
	});

	test("windows are cut by stored bytes, and a row over the budget is scanned alone", async () => {
		const source = addNarrator(sourceOwner);
		const context = addNarrator(forkOwner);
		const image = await saveUploadedImage(source, png());
		db.transaction(() => {
			for (let seq = 0; seq < 40; seq++)
				addMessage(context, seq, [{ type: "text", text: "x".repeat(10 * 1024) }]);
			addMessage(context, 40, [{ type: "text", text: "y".repeat(100 * 1024) }]);
			addMessage(context, 41, [imageRefToContentBlock(image)]);
		});
		setReferenceLookupLimitsForTests({ windowBytes: 32 * 1024 });
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
		const stats = lastReferenceLookupStatsForTests();
		// About three 10 KB rows per window, then the 100 KB row by itself.
		expect(stats.statements).toBeGreaterThanOrEqual(15);
		expect(stats.largestStatementBytes).toBeGreaterThan(100 * 1024);
		expect(stats.largestStatementBytes).toBeLessThan(120 * 1024);
		setReferenceLookupLimitsForTests(null);
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
		expect(lastReferenceLookupStatsForTests().statements).toBe(1);
	});

	test("a block-format body whose rows are current is scanned and counted from its rows only", async () => {
		const source = addNarrator(sourceOwner);
		const context = addNarrator(forkOwner);
		const image = await saveUploadedImage(source, png());
		const id = generateId();
		db.transaction((tx) =>
			insertEnvelope(tx, {
				id,
				narratorId: context,
				role: "user",
				bodyFormat: 2,
				contentJson: [{ type: "text", text: "z".repeat(64 * 1024) }, imageRefToContentBlock(image)],
				contentText: "z",
				createdAt: now,
			}),
		);
		addRef(context, id, 0);
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
		// The column beside current rows is not read as the body (`contentJsonSql`).
		const { largestStatementBytes } = lastReferenceLookupStatsForTests();
		expect(largestStatementBytes).toBeGreaterThan(64 * 1024);
		expect(largestStatementBytes).toBeLessThan(96 * 1024);
	});

	test("waiting lookups are served round-robin across users", async () => {
		setReferenceLookupLimitsForTests({ processRunning: 1 });
		const { source, context, image } = await longContext(0);
		const order: string[] = [];
		const lookup = (principal: string) =>
			narratorReferencesImage(context, source, image.imageId, { principal }).then((found) => {
				order.push(principal);
				return found;
			});
		// "a" queues three lookups before "b" asks once: "b" must not wait behind all of them.
		const pending = [lookup("a"), lookup("a"), lookup("a"), lookup("b")];
		expect(await Promise.all(pending)).toEqual([true, true, true, true]);
		expect(order.indexOf("b")).toBeLessThan(3);
	});

	test("denials are logged per request at debug level, not as warnings", async () => {
		const { source, context, image } = await longContext(0);
		setReferenceLookupLimitsForTests({ maxRefs: 0 });
		const debug = spyOn(logger, "debug");
		const warn = spyOn(logger, "warn");
		try {
			for (let index = 0; index < 5; index++)
				expect(await narratorReferencesImage(context, source, image.imageId)).toBe(false);
			const denials = debug.mock.calls.filter(([message]) =>
				String(message).includes("lookup denied"),
			);
			expect(denials).toHaveLength(5);
			expect(warn.mock.calls.filter(([message]) => String(message).includes("denied"))).toEqual([]);
		} finally {
			debug.mockRestore();
			warn.mockRestore();
		}
	});

	test("one ref over the per-ref byte cap is denied before any candidate statement", async () => {
		const source = addNarrator(sourceOwner);
		const context = addNarrator(forkOwner);
		const image = await saveUploadedImage(source, png());
		addMessage(context, 0, [
			{ type: "text", text: "x".repeat(100 * 1024) },
			imageRefToContentBlock(image),
		]);
		setReferenceLookupLimitsForTests({ maxRefBytes: 64 * 1024 });
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(false);
		expect(lastReferenceLookupStatsForTests().statements).toBe(0);
		setReferenceLookupLimitsForTests({ maxRefBytes: 256 * 1024 });
		expect(await narratorReferencesImage(context, source, image.imageId)).toBe(true);
		expect(lastReferenceLookupStatsForTests().statements).toBe(1);
	});

	test("a lookup that waits too long for a slot is denied and frees its place", async () => {
		// Many tiny windows, each yielding, keep the only slot busy well past the wait cap.
		setReferenceLookupLimitsForTests({
			processRunning: 1,
			processPending: 2,
			windowBytes: 1,
			maxQueueWaitMs: 30,
		});
		const { source, context, image } = await longContext(600);
		const holder = narratorReferencesImage(context, source, image.imageId, { principal: "a" });
		const started = performance.now();
		expect(await narratorReferencesImage(context, source, image.imageId, { principal: "b" })).toBe(
			false,
		);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(await holder).toBe(true);
		// Both places were returned: with room for two, two more lookups still get in.
		setReferenceLookupLimitsForTests({ processRunning: 1, processPending: 2 });
		expect(
			await Promise.all([
				narratorReferencesImage(context, source, image.imageId, { principal: "a" }),
				narratorReferencesImage(context, source, image.imageId, { principal: "b" }),
			]),
		).toEqual([true, true]);
	});
});
