import { expect, test } from "bun:test";
import { isMediaContentBlock } from "@shared/media-attachments";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";
import { getFileReferenceSnapshots } from "../../lib/agent/file-reference-projection";
import { NotFoundError, ValidationError } from "../../lib/errors";

const source = await Bun.file(new URL("../narrators.ts", import.meta.url)).text();
const from = source.indexOf('narratorRoutes.get("/:id/messages/:mid/composer-document"');
const to = source.indexOf('narratorRoutes.get("/:id/draft"', from);
if (from < 0 || to < 0) throw new Error("Missing composer detail route boundaries");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(from, to));
const guardFrom = source.indexOf("const boundedComposerJsonRequest =");
const guardTo = source.indexOf("// This smaller guard MUST", guardFrom);
if (guardFrom < 0 || guardTo < 0) throw new Error("Missing composer JSON body guard");
const compiledGuard = new Bun.Transpiler({ loader: "ts" }).transformSync(
	source.slice(guardFrom, guardTo),
);

test.each([
	"/n/messages",
	"/n/draft",
	"/n/edit-and-regenerate/m",
	"/n/blocks/b/edit-and-regenerate",
	"/n/buffer/m",
])("composer JSON budget bounds streamed and dishonest-length requests at %s", async (path) => {
	const app = new Hono();
	new Function("narratorRoutes", "bodyLimit", compiledGuard)(app, bodyLimit);
	let decoded = 0;
	app.all("*", async (c) => {
		await c.req.json();
		decoded++;
		return c.json({ ok: true });
	});
	app.onError((_error, c) => c.json({ error: "body rejected" }, 400));
	const oversized = JSON.stringify({ unknown: "x".repeat(4 * 1024 * 1024) });
	for (const contentLength of [undefined, "2"]) {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (contentLength) headers["content-length"] = contentLength;
		expect((await app.request(path, { method: "POST", headers, body: oversized })).status).toBe(
			413,
		);
	}
	expect(decoded).toBe(0);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "normal" }),
			})
		).status,
	).toBe(200);
	expect(decoded).toBe(1);
});

test("JSON-only draft cannot bypass its limit with a forged multipart header", async () => {
	const app = new Hono();
	new Function("narratorRoutes", "bodyLimit", compiledGuard)(app, bodyLimit);
	let decoded = 0;
	app.put("/n/draft", async (c) => {
		await c.req.json();
		decoded++;
		return c.json({ ok: true });
	});
	for (const length of [undefined, "2"]) {
		const headers: Record<string, string> = {
			"content-type": "multipart/form-data; boundary=fake",
		};
		if (length) headers["content-length"] = length;
		const response = await app.request("/n/draft", {
			method: "PUT",
			headers,
			body: JSON.stringify({ text: "ok", padding: "x".repeat(8 * 1024 * 1024) }),
		});
		expect(response.status).toBe(413);
	}
	expect(decoded).toBe(0);
});

test.each([
	"/n/messages",
	"/n/edit-and-regenerate/m",
	"/n/blocks/b/edit-and-regenerate",
	"/n/buffer/m",
])("%s budgets the actual decoder rather than a MIME substring", async (path) => {
	const app = new Hono();
	new Function("narratorRoutes", "bodyLimit", compiledGuard)(app, bodyLimit);
	let decoded = 0;
	app.all("*", async (c) => {
		const type = c.req.header("content-type") ?? "";
		if (type.split(";")[0]?.trim().toLowerCase() === "multipart/form-data") {
			const form = await c.req.formData();
			expect((form.get("file") as File).size).toBe(5 * 1024 * 1024);
		} else await c.req.json();
		decoded++;
		return c.json({ ok: true });
	});
	const disguised = await app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json; bogus=multipart/form-data" },
		body: JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }),
	});
	expect(disguised.status).toBe(413);
	expect(decoded).toBe(0);
	const form = new FormData();
	form.set("file", new File(["x".repeat(5 * 1024 * 1024)], "valid.txt", { type: "text/plain" }));
	expect((await app.request(path, { method: "POST", body: form })).status).toBe(200);
	expect(decoded).toBe(1);
});

const document = {
	version: 1,
	paragraphs: [{ children: [{ type: "text", text: "new snapshot" }] }],
	assets: [],
};
function fixture(options: { member?: boolean; content?: string | null } = {}) {
	const app = new Hono();
	const message = {
		composerDocument: document,
		bodyRevision: 8,
		// The route's SQL admits user bodies within the limit; an oversized one comes back 0.
		admitted: options.content === null ? 0 : 1,
		content:
			options.content === undefined
				? JSON.stringify([
						{
							type: "image",
							imageId: "new-image-id",
							filename: "same.png",
							mediaType: "image/png",
							size: 9,
							secret: "drop",
						},
						{
							type: "audio",
							mediaId: "voice",
							filename: "voice.wav",
							mediaType: "audio/wav",
							size: 60,
							uploadNarratorId: "source-owner",
							base64: "must-not-export",
						},
						{
							type: "video",
							mediaId: "clip",
							filename: "clip.webm",
							mediaType: "video/webm",
							size: 32,
						},
						{ type: "text_file", filename: "same.txt", filePath: "/authorized/file.txt", size: 7 },
						{ type: "text", text: "new snapshot" },
					])
				: options.content,
	};
	const refs = [
		{
			type: "file_reference",
			reference: { id: "ref", deviceId: "local", path: "/a.ts", label: "a.ts" },
			snapshotText: "private captured bytes",
		},
	];
	const bindings = {
		narratorRoutes: app,
		narratorMessageRefs,
		narratorMessages,
		and,
		eq,
		sql,
		NotFoundError,
		ValidationError,
		getFileReferenceSnapshots,
		isMediaContentBlock,
		// Block reads off: the plain column, as before block storage.
		storedBodyBytesSql: () => sql`length(CAST(${narratorMessages.contentJson} AS BLOB))`,
		contentJsonSql: () => narratorMessages.contentJson,
		blockBody: () => [],
		db: {
			query: {
				narratorMessageRefs: {
					findFirst: async () => (options.member === false ? undefined : { id: "member" }),
				},
			},
			select: () => ({ from: () => ({ where: () => ({ get: async () => message }) }) }),
		},
		locateBufferedMessage: async () =>
			options.member === false
				? undefined
				: {
						message: {
							composerDocument: document,
							text: "queued snapshot",
							fileReferences: refs,
							images: [
								{
									imageId: "queued-image-id",
									filename: "same.png",
									mediaType: "image/png",
									size: 9,
								},
							],
							media: [
								{
									mediaId: "queued-voice",
									filename: "voice.wav",
									mediaType: "audio/wav",
									size: 60,
									uploadNarratorId: "source-owner",
								},
							],
							_savedFiles: [{ filename: "same.txt", size: 7, path: "/private-staging-path" }],
						},
					},
	};
	new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
	app.onError((error, c) =>
		c.json(
			{ error: error.message },
			error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 500,
		),
	);
	return app;
}
test("history composer detail binds doc and attachment identities from one bounded snapshot", async () => {
	const response = await fixture().request("/n/messages/m/composer-document");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toMatchObject({
		composerDocument: document,
		bodyRevision: 8,
		text: "new snapshot",
		images: [{ imageId: "new-image-id", filename: "same.png", size: 9 }],
		media: [
			{ mediaId: "voice", uploadNarratorId: "source-owner" },
			{ mediaId: "clip", uploadNarratorId: "n" },
		],
		textFiles: [{ filePath: "/authorized/file.txt", size: 7 }],
	});
	expect(body.images[0].secret).toBeUndefined();
	expect(JSON.stringify(body.media)).not.toContain("must-not-export");
});
test("queue detail returns current keep keys but never managed staging paths or snapshot bodies", async () => {
	const response = await fixture().request("/n/buffer/m/composer-document");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toMatchObject({
		composerDocument: document,
		text: "queued snapshot",
		images: [{ imageId: "queued-image-id" }],
		media: [{ mediaId: "queued-voice", uploadNarratorId: "source-owner" }],
		textFiles: [{ index: 0, filename: "same.txt", size: 7 }],
	});
	expect(JSON.stringify(body)).not.toContain("private-staging-path");
	expect(JSON.stringify(body)).not.toContain("private captured bytes");
});
test("detail refuses absent membership and oversized or non-user message bodies", async () => {
	expect((await fixture({ member: false }).request("/n/messages/m/composer-document")).status).toBe(
		404,
	);
	expect((await fixture({ member: false }).request("/n/buffer/m/composer-document")).status).toBe(
		404,
	);
	expect((await fixture({ content: null }).request("/n/messages/m/composer-document")).status).toBe(
		400,
	);
});
