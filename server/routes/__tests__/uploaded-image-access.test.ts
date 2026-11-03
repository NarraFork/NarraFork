/**
 * `GET /api/uploads/:narratorId/:imageId` serves a session's images only to someone who
 * may read that session, or a fork/copy of it whose history references the exact image.
 * Refusals and missing files must look identical, and the response must never be
 * stored by a shared cache.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeToolOutput } from "@shared/agent-protocol/tool-output";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
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
import {
	type ImageRef,
	imageRefToContentBlock,
	saveUploadedImage,
	setUploadsDirForTests,
} from "../../lib/uploads";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { narratorService } = await import("../../services/narrator-service");
const { narratorPersistence } = await import("../../services/narrator-persistence");
const { narratorReferencesImage } = await import("../../services/narrator-media-access");
const { grantNarratorAccess } = await import("../../services/narrator-sharing");
const { uploadRoutes } = await import("../uploads");

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

function request(
	owner: string,
	imageId: string,
	options: { referencingNarratorId?: string; user?: string } = {},
) {
	const user = options.user ?? sourceOwner;
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
	// The production serializer, so "identical response" means identical on the wire.
	app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "x" }, 500));
	const query = options.referencingNarratorId
		? `?referencingNarratorId=${encodeURIComponent(options.referencingNarratorId)}`
		: "";
	return app.request(`/uploads/${owner}/${imageId}${query}`);
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
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
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
