import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposerDocument, composerDocumentText } from "@shared/composer-document";
import type { FileReferenceSnapshot } from "@shared/file-reference";
import { MAX_MEDIA_ATTACHMENTS, type MediaRef } from "@shared/media-attachments";
import { Hono } from "hono";
import {
	bindComposerEditFiles,
	composerEditDetailAttachments,
	projectComposerEdit,
	seedComposerEditSession,
} from "../../../frontend/components/narrator/interaction/queued-attachment-edit";
import { AUDIO_MP4, wavBytes, wavFile, webmBytes } from "../../../tests/fixtures/native-media";
import {
	findStagedAttachment,
	releaseStagedAttachment,
	stagedAttachmentAsFile,
} from "../../lib/attachment-staging";
import {
	bindComposerDocumentReferences,
	bindComposerMediaProjection,
	parseOptionalComposerDocument,
	restoreMultipartComposerText,
	validateComposerAssets,
	validateComposerProjection,
} from "../../lib/composer-document";
import { AppError, catalogError, NotFoundError, ValidationError } from "../../lib/errors";
import {
	parseFileReferenceInput,
	replaceFileReferenceSnapshots,
} from "../../lib/file-reference-input";
import {
	deleteUploadedMedia,
	getMediaPath,
	saveUploadedMedia,
	validateUploadedMedia,
} from "../../lib/media-uploads";
import { setUploadsDirForTests } from "../../lib/uploads";
import {
	bufferQueueModeSchema,
	sendMessageSchema,
	updateBufferedMessageSchema,
} from "../../lib/validators/narrators";

const home = mkdtempSync(join(tmpdir(), "nf-media-http-"));
setUploadsDirForTests(home);
afterAll(() => {
	setUploadsDirForTests(null);
	rmSync(home, { recursive: true, force: true });
});
const source = await Bun.file(new URL("../narrators.ts", import.meta.url)).text();
const uploads = await Bun.file(new URL("../uploads.ts", import.meta.url)).text();
function section(text: string, start: string, end: string) {
	const from = text.indexOf(start),
		to = text.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new Error(`Missing route boundary ${start}`);
	return text.slice(from, to);
}
function execute(text: string, bindings: Record<string, unknown>) {
	const js = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
	return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const common = {
	ValidationError,
	NotFoundError,
	catalogError,
	// Spec sessions: the outline subagent's /goal refusal stays out of the way.
	resolveTaskBackend: async () => "spec",
	isRefusedOutlineGoal: async () => false,
	parseOptionalComposerDocument,
	restoreMultipartComposerText,
	validateComposerAssets,
	validateComposerProjection,
	bindComposerDocumentReferences,
	bindComposerMediaProjection,
	MAX_MEDIA_ATTACHMENTS,
	validateUploadedMedia,
	saveUploadedMedia,
	deleteUploadedMedia,
	MAX_EDIT_IMAGES_PER_MESSAGE: 20,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE: 20,
	MAX_NARRATOR_ATTACHMENT_BYTES: 128 * 1024 * 1024,
	// The sliced routes also merge streamed (staged) text files into the multipart
	// set. These tests never stage uploads, but the merge still runs, so the real
	// helpers (compiled from the same source below) are bound rather than stubs.
	MAX_STAGED_ATTACHMENTS_TOTAL_BYTES: 2 * 1024 * 1024 * 1024,
	releaseStagedAttachment,
	releaseStagedFiles: () => {},
	parseFileReferenceInput,
	bufferQueueModeSchema,
	sendMessageSchema,
	updateBufferedMessageSchema,
	validateUploadedImage: () => {
		throw new Error("unexpected image");
	},
	validateTextFile: () => {
		throw new Error("unexpected text file");
	},
};
// The staged-attachment helpers live in the same route file as the handlers
// under test. Compile them from source the same way, rather than importing the
// whole route module (which would initialize the database and services).
const stagedHelpers = execute(
	`${section(
		source,
		"export interface StagedAttachmentInput",
		"/** Parse message request supporting",
	)
		.replaceAll("export function", "function")
		.replaceAll("export interface", "interface")}
return { parseStagedAttachmentInput, resolveStagedAttachments, attachmentBytesOf };`,
	{
		ValidationError,
		MAX_EDIT_TEXT_FILES_PER_MESSAGE: common.MAX_EDIT_TEXT_FILES_PER_MESSAGE,
		findStagedAttachment,
		stagedAttachmentAsFile,
	},
) as Record<
	"parseStagedAttachmentInput" | "resolveStagedAttachments" | "attachmentBytesOf",
	unknown
>;
Object.assign(common, stagedHelpers);
function errors(app: Hono) {
	app.onError((error, c) =>
		c.json({ error: error.message }, error instanceof AppError ? (error.statusCode as 400) : 500),
	);
}
const parseMessageRequest = execute(
	`${section(
		source,
		"export async function parseMessageRequest(",
		"export const narratorRoutes",
	).replace("export async", "async")}\nreturn parseMessageRequest;`,
	common,
) as (
	c: { req: { header: () => string; formData: () => Promise<FormData> } },
	id: string,
) => Promise<{ message: string; media: MediaRef[]; composerDocument?: ComposerDocument }>;

test("history edit normalizes detected audio before handing off to session validation", async () => {
	let passed: { text: string; document: ComposerDocument } | undefined;
	const edit = execute(
		`${section(source, "async function editAndRegenerateResponse(", "// Edit an assistant message")}\nreturn editAndRegenerateResponse;`,
		{
			...common,
			revertScopeSchema: { parse: (value: unknown) => value },
			narratorService: { getById: async () => ({ status: "idle" }) },
			resolveEditedFileReferences: async () => undefined,
			prepareHistoryRewrite: async () => {},
			getUserLanguage: async () => "en",
			getUserReplyInLanguage: async () => false,
			editAndRegenerate: async (
				_id: string,
				_mid: string,
				text: string,
				_locale: string,
				_reply: boolean,
				opts: { composerDocument: ComposerDocument },
			) => {
				passed = { text, document: opts.composerDocument };
				return { ok: true };
			},
		},
	);
	const file = new File([new Uint8Array(AUDIO_MP4)], "voice.mp4", { type: "video/mp4" });
	const document: ComposerDocument = {
		version: 1,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "listen " },
					{ type: "attachment", id: "node", assetId: "asset" },
				],
			},
		],
		assets: [{ id: "asset", kind: "video", name: file.name, size: file.size, mimeType: file.type }],
	};
	const form = new FormData();
	form.set("content", composerDocumentText(document).text);
	form.set("composerDocument", JSON.stringify(document));
	form.set("skipRevert", "true");
	form.append("media", file);
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "user", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.post("/edit", (c) => edit(c, "edit", "message"));
	errors(app);
	const response = await app.request("/edit", { method: "POST", body: form });
	expect(response.status).toBe(200);
	expect(passed?.document.assets[0].kind).toBe("audio");
	expect(passed?.text).toBe(composerDocumentText(passed!.document).text);
	// History edits do not load omitted references in the route; a document that
	// contains one must be rejected rather than silently rebound to another target.
	const withReference: ComposerDocument = {
		...document,
		paragraphs: [
			{
				children: [
					...document.paragraphs[0].children,
					{
						type: "fileReference",
						id: "ref-node",
						reference: { id: "ref", deviceId: "local", path: "/file", label: "file" },
					},
				],
			},
		],
	};
	const missingReferences = new FormData();
	missingReferences.set("content", composerDocumentText(withReference).text);
	missingReferences.set("composerDocument", JSON.stringify(withReference));
	missingReferences.set("skipRevert", "true");
	missingReferences.append("media", file);
	passed = undefined;
	expect((await app.request("/edit", { method: "POST", body: missingReferences })).status).toBe(
		400,
	);
	expect(passed).toBeUndefined();
});

describe("native media upload request", () => {
	test("media-only multipart is meaningful and persisted", async () => {
		const body = new FormData();
		body.append("media", wavFile());
		const result = await parseMessageRequest(
			{ req: { header: () => "multipart/form-data", formData: async () => body } },
			"sender",
		);
		expect(result.message).toBe("");
		expect(result.media).toHaveLength(1);
		expect(getMediaPath("sender", result.media[0].mediaId)).not.toBeNull();
	});
	test("rich media manifests bind validated modality before any write", async () => {
		const file = new File([new Uint8Array(webmBytes([2]))], "voice.webm", { type: "video/webm" });
		const document: ComposerDocument = {
			version: 1,
			paragraphs: [{ children: [{ type: "attachment", id: "voice-node", assetId: "voice" }] }],
			assets: [
				{ id: "voice", kind: "audio", name: file.name, size: file.size, mimeType: file.type },
			],
		};
		const body = new FormData();
		body.append("message", composerDocumentText(document).text);
		body.append("composerDocument", JSON.stringify(document));
		body.append("media", file);
		const result = await parseMessageRequest(
			{ req: { header: () => "multipart/form-data", formData: async () => body } },
			"rich",
		);
		expect(result.media[0].mediaType).toBe("audio/webm");
		document.assets[0].kind = "video";
		body.set("message", composerDocumentText(document).text);
		body.set("composerDocument", JSON.stringify(document));
		const normalized = await parseMessageRequest(
			{ req: { header: () => "multipart/form-data", formData: async () => body } },
			"wrong-manifest",
		);
		expect(normalized.media[0].mediaType).toBe("audio/webm");
	});
	test.each([
		["webm", webmBytes([2])],
		["mp4", AUDIO_MP4],
	])("normalizes browser video/%s audio and its positional projection", async (extension, bytes) => {
		const file = new File([new Uint8Array(bytes)], `voice.${extension}`, {
			type: `video/${extension}`,
		});
		const document: ComposerDocument = {
			version: 1,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "listen " },
						{ type: "attachment", id: "node", assetId: "asset" },
					],
				},
			],
			assets: [
				{ id: "asset", kind: "video", name: file.name, size: file.size, mimeType: file.type },
			],
		};
		const body = new FormData();
		body.set("message", composerDocumentText(document).text);
		body.set("composerDocument", JSON.stringify(document));
		body.append("media", file);
		const result = await parseMessageRequest(
			{ req: { header: () => "multipart/form-data", formData: async () => body } },
			`audio-${extension}`,
		);
		expect(result.composerDocument?.assets[0].kind).toBe("audio");
		expect(result.media[0].mediaType).toBe(`audio/${extension}`);
		expect(result.message).toBe(composerDocumentText(result.composerDocument!).text);
	});
	test("invalid attachment rejects the entire batch before any writes", async () => {
		const body = new FormData();
		body.append("media", wavFile());
		body.append("media", new File(["spoof"], "bad.wav", { type: "audio/wav" }));
		await expect(
			parseMessageRequest(
				{ req: { header: () => "multipart/form-data", formData: async () => body } },
				"invalid",
			),
		).rejects.toThrow();
		expect(() => readdirSync(join(home, "invalid", "media"))).toThrow();
	});
	test("enforces media count before writing", async () => {
		const body = new FormData();
		for (let i = 0; i <= MAX_MEDIA_ATTACHMENTS; i++) body.append("media", wavFile());
		await expect(
			parseMessageRequest(
				{ req: { header: () => "multipart/form-data", formData: async () => body } },
				"too-many",
			),
		).rejects.toThrow("Maximum");
	});
});

describe("new-session media forwarding", () => {
	for (const fail of [false, true]) {
		test(
			fail
				? "failed /new send removes only unaccepted source uploads"
				: "/new sends media-only input to the new session with its source owner",
			async () => {
				const ref = await saveUploadedMedia("new-source", wavFile());
				const calls: unknown[][] = [];
				const branch = section(
					source,
					"\t\tif (queuedNewCommand && !narratorBusy) {",
					"\n\t\tconst locale = await getUserLanguage(userId);",
				);
				const cleanup = section(source, "\t} finally {\n\t\tif (!uploadsAccepted)", "\n});");
				const run = execute(
					`return async () => { let uploadsAccepted = false; try { ${branch} ${cleanup} }`,
					{
						queuedNewCommand: {},
						narratorBusy: false,
						narrator: { cwd: home },
						userId: "creator",
						id: "new-source",
						media: [ref],
						images: [],
						textFiles: [],
						FOLLOW_PARENT_MODEL: "parent",
						normalizeBooleanOverride: () => undefined,
						normalizeDangerReflectionOverride: () => undefined,
						normalizeAutoContinuationOverride: () => undefined,
						narratorService: { create: async () => ({ id: "new-target" }) },
						getUserLanguage: async () => "en",
						getUserReplyInLanguage: async () => false,
						publicNarratorResponse: (value: unknown) => value,
						c: { json: (body: unknown, status: number) => ({ body, status }) },
						sendMessage: async (...args: unknown[]) => {
							calls.push(args);
							if (fail) throw new Error("admission failed");
						},
						deleteUploadedMedia,
						logger: { warn: () => {} },
					},
				) as () => Promise<{ status: number }>;
				if (fail) await expect(run()).rejects.toThrow("admission failed");
				else expect((await run()).status).toBe(201);
				expect(calls).toHaveLength(1);
				expect(calls[0][0]).toBe("new-target");
				expect(calls[0][1]).toBe("");
				expect(calls[0][12]).toEqual([ref]);
				expect(ref.uploadNarratorId).toBe("new-source");
				if (fail) expect(getMediaPath("new-source", ref.mediaId)).toBeNull();
				else expect(getMediaPath("new-source", ref.mediaId)).not.toBeNull();
			},
		);
	}
});

describe("authenticated media previews and Range", () => {
	async function fixture(deny = false) {
		const ref = await saveUploadedMedia("viewer", wavFile());
		const app = new Hono();
		execute(
			section(
				uploads,
				'uploadRoutes.get("/:narratorId/media/:mediaId"',
				"// Serve uploaded images",
			),
			{
				uploadRoutes: app,
				getMediaPath,
				NotFoundError,
				requireNarratorAccess: async (_c: unknown, id: string, permission: string) => {
					expect([id, permission]).toEqual(["viewer", "read"]);
					if (deny) throw new AppError("Forbidden", 403, "FORBIDDEN");
				},
			},
		);
		errors(app);
		return (range?: string) =>
			app.request(`/viewer/media/${ref.mediaId}`, { headers: range ? { range } : {} });
	}
	test("serves complete native bytes with private no-store and nosniff", async () => {
		const request = await fixture(),
			response = await request();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/^audio\/(?:x-)?wav$/);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(wavBytes());
	});
	test("supports byte ranges, suffixes and open-ended ranges", async () => {
		const request = await fixture();
		for (const [range, start, end] of [
			["bytes=4-11", 4, 11],
			["bytes=-8", 52, 59],
			["bytes=55-", 55, 59],
		] as const) {
			const response = await request(range);
			expect(response.status).toBe(206);
			expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/60`);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(
				wavBytes().subarray(start, end + 1),
			);
		}
	});
	test("rejects unsatisfiable, malformed and multiple ranges with 416", async () => {
		const request = await fixture();
		for (const range of [
			"bytes=60-",
			"bytes=9-2",
			"bytes=-0",
			"bytes=0-1,3-4",
			"bytes=-",
			"bytes=9007199254740992-",
		]) {
			const response = await request(range);
			expect(response.status).toBe(416);
			expect(response.headers.get("content-range")).toBe("bytes */60");
		}
	});
	test("checks narrator access before disclosing bytes", async () => {
		const response = await (await fixture(true))("bytes=0-9");
		expect(response.status).toBe(403);
	});
});

describe("queued media HTTP edits", () => {
	async function fixture(fail = false, fileReferences?: FileReferenceSnapshot[]) {
		const original = await saveUploadedMedia("edit", wavFile("old.wav"));
		let message: {
			text: string;
			media: MediaRef[];
			composerDocument?: ComposerDocument;
			fileReferences?: FileReferenceSnapshot[];
		} = {
			text: "before",
			media: [original],
			fileReferences,
		};
		const created: MediaRef[] = [];
		let lastReferences: FileReferenceSnapshot[] | undefined;
		const app = new Hono();
		execute(
			section(
				source,
				'narratorRoutes.patch("/:id/buffer/:mid",',
				"/** Called under start admission",
			),
			{
				...common,
				narratorRoutes: app,
				parseJsonArrayField: (raw: unknown) =>
					typeof raw === "string" ? JSON.parse(raw) : undefined,
				locateBufferedMessage: async () => ({ message }),
				resolveKeptBufferAttachments: () => ({ keptImages: [], keptTextFileIndexes: [] }),
				replaceFileReferenceSnapshots,
				saveUploadedMedia: async (id: string, file: File) => {
					const ref = await saveUploadedMedia(id, file);
					created.push(ref);
					return ref;
				},
				updateBufferedMessage: async (
					_id: string,
					_mid: string,
					text: string,
					opts: {
						media: MediaRef[];
						composerDocument?: ComposerDocument;
						fileReferences?: FileReferenceSnapshot[];
					},
				) => {
					if (fail) return false;
					lastReferences = opts.fileReferences;
					message = {
						text,
						media: opts.media,
						composerDocument: opts.composerDocument,
						fileReferences: opts.fileReferences ?? message.fileReferences,
					};
					return true;
				},
				broadcastBufferQueue: async () => {},
			},
		);
		errors(app);
		return {
			original,
			created,
			message: () => message,
			lastReferences: () => lastReferences,
			request: (body: FormData | object) =>
				app.request("/edit/buffer/message", {
					method: "PATCH",
					...(body instanceof FormData
						? { body }
						: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
				}),
		};
	}
	test("text-only edit preserves media and explicit [] clears refs without deleting shared bytes", async () => {
		const f = await fixture();
		expect((await f.request({ text: "after" })).status).toBe(200);
		expect(f.message().media).toEqual([f.original]);
		expect((await f.request({ keepMediaIds: [] })).status).toBe(200);
		expect(f.message().media).toEqual([]);
		expect(getMediaPath("edit", f.original.mediaId)).not.toBeNull();
	});
	test("appends real media while preserving the kept source", async () => {
		const f = await fixture(),
			body = new FormData();
		body.append("media", wavFile("new.wav"));
		const response = await f.request(body);
		expect({ status: response.status, body: await response.json() }).toEqual({
			status: 200,
			body: { ok: true },
		});
		expect(f.message().media.map((ref) => ref.filename)).toEqual(["old.wav", "new.wav"]);
	});
	test("rich media editor projection round-trips retained, new and deleted resources through HTTP", async () => {
		const f = await fixture();
		const existing = composerEditDetailAttachments(
			{ images: [], textFiles: [], media: f.message().media },
			"edit",
		);
		if (!existing) throw new Error("Missing resource snapshot");
		const session = seedComposerEditSession({ text: "after", fileReferences: [] }, existing);
		const file = wavFile("inserted.wav");
		const inserted = bindComposerEditFiles(session, [file], "audio");
		const document = {
			...session.document,
			assets: [...session.document.assets, ...inserted.assets],
			paragraphs: [
				{ children: [...inserted.nodes, ...session.document.paragraphs[0].children] },
				...session.document.paragraphs.slice(1),
			],
		};
		const snapshot = projectComposerEdit(session, document);
		const body = new FormData();
		body.set("text", snapshot.text);
		body.set("keepMediaIds", JSON.stringify(snapshot.keepMediaIds));
		body.set("composerDocument", JSON.stringify(snapshot.composerDocument));
		for (const media of snapshot.newMedia) body.append("media", media);
		const response = await f.request(body);
		expect({ status: response.status, body: await response.json() }).toEqual({
			status: 200,
			body: { ok: true },
		});
		expect(f.message().media.map((media) => media.filename)).toEqual(["old.wav", "inserted.wav"]);
		expect(f.message().media[0]).toEqual(f.original);
		expect(f.message().composerDocument?.paragraphs).toEqual(document.paragraphs);
		const reopenedAttachments = composerEditDetailAttachments(
			{ images: [], textFiles: [], media: f.message().media },
			"edit",
		);
		if (!reopenedAttachments) throw new Error("Missing saved resource snapshot");
		const reopened = seedComposerEditSession(
			{
				text: f.message().text,
				fileReferences: [],
				composerDocument: f.message().composerDocument,
			},
			reopenedAttachments,
		);
		expect(projectComposerEdit(reopened, reopened.document).keepMediaIds).toEqual(
			f.message().media.map((media) => media.mediaId),
		);
		const cleared = projectComposerEdit(reopened, {
			...reopened.document,
			assets: [],
			paragraphs: [{ children: [{ type: "text", text: "removed" }] }],
		});
		expect(
			(
				await f.request({
					text: cleared.text,
					keepMediaIds: cleared.keepMediaIds,
					composerDocument: cleared.composerDocument,
				})
			).status,
		).toBe(200);
		expect(f.message().media).toEqual([]);
		expect(getMediaPath("edit", f.original.mediaId)).not.toBeNull();
	});
	test("queue edit normalizes newly uploaded audio containers", async () => {
		const f = await fixture();
		const file = new File([new Uint8Array(webmBytes([2]))], "voice.webm", { type: "video/webm" });
		const document: ComposerDocument = {
			version: 1,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "listen " },
						{ type: "attachment", id: "node", assetId: "asset" },
					],
				},
			],
			assets: [
				{ id: "asset", kind: "video", name: file.name, size: file.size, mimeType: file.type },
			],
		};
		const body = new FormData();
		body.set("text", composerDocumentText(document).text);
		body.set("composerDocument", JSON.stringify(document));
		body.set("keepMediaIds", "[]");
		body.append("media", file);
		expect((await f.request(body)).status).toBe(200);
		expect(f.message().composerDocument?.assets[0].kind).toBe("audio");
		expect(f.message().text).toBe(composerDocumentText(f.message().composerDocument!).text);
	});
	test("queue normalization persists omitted existing file reference snapshots", async () => {
		const file = new File([new Uint8Array(webmBytes([2]))], "voice.webm", { type: "video/webm" });
		const document: ComposerDocument = {
			version: 1,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "listen " },
						{ type: "attachment", id: "node", assetId: "asset" },
						{
							type: "fileReference",
							id: "ref-node",
							reference: { id: "ref", deviceId: "local", path: "/file", label: "file" },
						},
					],
				},
			],
			assets: [
				{ id: "asset", kind: "video", name: file.name, size: file.size, mimeType: file.type },
			],
		};
		const projection = composerDocumentText(document);
		const snapshot: FileReferenceSnapshot = {
			type: "file_reference",
			reference: projection.fileReferences[0],
			snapshotText: "retained bytes",
			snapshotHash: "hash",
			capturedAt: "2026-01-01T00:00:00.000Z",
		};
		const f = await fixture(false, [snapshot]);
		const body = new FormData();
		body.set("text", projection.text);
		body.set("composerDocument", JSON.stringify(document));
		body.set("keepMediaIds", "[]");
		body.append("media", file);
		expect((await f.request(body)).status).toBe(200);
		const saved = f.lastReferences();
		expect(saved).toBeDefined();
		expect(saved?.[0].snapshotText).toBe("retained bytes");
		expect(saved?.map((item) => item.reference)).toEqual(
			composerDocumentText(f.message().composerDocument!).fileReferences,
		);
	});
	test("failed queue mutation rolls back only newly uploaded bytes", async () => {
		const f = await fixture(true),
			body = new FormData();
		body.append("media", wavFile("new.wav"));
		expect((await f.request(body)).status).toBe(404);
		expect(f.created).toHaveLength(1);
		expect(getMediaPath("edit", f.created[0].mediaId)).toBeNull();
		expect(getMediaPath("edit", f.original.mediaId)).not.toBeNull();
		expect(f.message().media).toEqual([f.original]);
	});
	test("kept plus newly uploaded media allow ten and reject eleven before writing", async () => {
		const f = await fixture();
		const accepted = new FormData();
		for (let index = 0; index < MAX_MEDIA_ATTACHMENTS - 1; index++)
			accepted.append("media", wavFile(`new-${index}.wav`));
		expect((await f.request(accepted)).status).toBe(200);
		expect(f.message().media).toHaveLength(MAX_MEDIA_ATTACHMENTS);
		const createdCount = f.created.length;
		const rejected = new FormData();
		rejected.append("media", wavFile("eleventh.wav"));
		expect((await f.request(rejected)).status).toBe(400);
		expect(f.created).toHaveLength(createdCount);
		expect(f.message().media).toHaveLength(MAX_MEDIA_ATTACHMENTS);
		expect(getMediaPath("edit", f.original.mediaId)).not.toBeNull();
	});
	test("rejects stale keep ids instead of silently deleting attachments", async () => {
		const f = await fixture();
		expect((await f.request({ keepMediaIds: ["stale"] })).status).toBe(400);
		expect(f.message().media).toEqual([f.original]);
	});
});
