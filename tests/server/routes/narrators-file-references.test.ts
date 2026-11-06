import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFileReferenceSnapshots } from "@server/lib/agent/file-reference-projection";
import {
	findStagedAttachment,
	setStagedAttachmentsDirForTests,
	stageAttachment,
	stagedAttachmentAsFile,
} from "@server/lib/attachment-staging";
import {
	bindComposerDocumentReferences,
	bindComposerMediaProjection,
	parseOptionalComposerDocument,
	restoreMultipartComposerText,
	validateComposerAssets,
	validateComposerProjection,
} from "@server/lib/composer-document";
import { AppError, catalogError, NotFoundError, ValidationError } from "@server/lib/errors";
import {
	parseFileReferenceInput,
	replaceFileReferenceSnapshots,
} from "@server/lib/file-reference-input";
import {
	bufferQueueModeSchema,
	editAndRegenerateJsonSchema,
	editAssistantMessageSchema,
	sendMessageSchema,
	updateBufferedMessageSchema,
	updateNarratorDraftSchema,
} from "@server/lib/validators/narrators";
import { type ComposerDocument, composerDocumentText } from "@shared/composer-document";
import {
	type FileReference,
	type FileReferenceSnapshot,
	fileReferenceMessageForDisplay,
	MAX_FILE_REFERENCE_TEXT_BYTES,
} from "@shared/file-reference";
import { MAX_MEDIA_ATTACHMENTS } from "@shared/media-attachments";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
	MAX_STAGED_ATTACHMENTS_TOTAL_BYTES,
} from "@shared/text-file-types";
import { type Context, Hono } from "hono";

// Execute the actual route bodies with injected boundaries. Importing the giant
// router would initialize DB/migrations and agent services; this harness imports
// neither, and does not globally mock modules used by other test suites.
const source = await Bun.file(new URL("../../../server/routes/narrators.ts", import.meta.url))
	.text()
	.then((text) => text.replaceAll("\r\n", "\n"));
function section(start: string, end: string) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new Error(`Route test boundary missing: ${start}`);
	return source.slice(from, to);
}
const routeCode = [
	section("function parseNewCommand(", "export const narratorRoutes"),
	section("const NARRATOR_ID_GATE_EXEMPT_SEGMENTS", "/**\n * Gate for the routes keyed"),
	section('narratorRoutes.get("/:id/draft"', "// ─── Access control (sharing)"),
	section('narratorRoutes.post("/:id/messages"', "// Retry last user message"),
	section("async function resolveEditedFileReferences(", "// Edit an assistant message's text"),
	section(
		'narratorRoutes.post("/:id/edit-message/:messageId"',
		"/** Primary and subagent user queues are projections of the same durable mailbox. */",
	),
	section("interface LocatedBufferedMessage", "/** Called under start admission"),
]
	.join("\n")
	.replaceAll("export async function", "async function")
	.replaceAll("export function", "function")
	.replaceAll("export interface", "interface");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(routeCode);

const reference: FileReference = {
	id: "ref-a",
	deviceId: "RemoteCaseID",
	path: "/workspace/a.ts",
	label: "a.ts",
};
function snapshot(ref = reference, text = "accepted before file deletion"): FileReferenceSnapshot {
	return {
		type: "file_reference",
		reference: structuredClone(ref),
		snapshotText: text,
		snapshotHash: "a".repeat(64),
		capturedAt: "2026-01-01T00:00:00.000Z",
	};
}
interface QueueItem {
	id: string;
	text: string;
	fileReferences: FileReferenceSnapshot[];
	images?: Array<{ imageId: string }>;
	textFiles?: File[];
}

function fixture(
	options: { busy?: boolean; subagent?: boolean; compact?: boolean; user?: string } = {},
) {
	// Every session — delegated or not — has the same one durable mailbox.
	const queue: QueueItem[] = [];
	const captures: Array<{
		narratorId: string;
		userId: string;
		refs: readonly FileReference[];
		signal: AbortSignal;
	}> = [];
	const events: unknown[] = [];
	const deletedImages: string[] = [];
	let savedImages = 0;
	const state = {
		captureError: null as Error | null,
		queueFull: false,
		messageExists: true,
		sourceText: "freshly read bytes",
		existing: [snapshot()],
	};
	const storedMessages: Array<{
		id: string;
		role: "user";
		contentJson: Array<FileReferenceSnapshot | { type: "text"; text: string }>;
	}> = [];
	function storedMessage(id: string, text: string, refs: FileReferenceSnapshot[] = []) {
		const message = {
			id,
			role: "user" as const,
			contentJson: [...refs, { type: "text" as const, text }],
		};
		storedMessages.push(message);
		return message;
	}
	interface AcceptedInput {
		composerDocument?: ComposerDocument;
		fileReferences?: FileReferenceSnapshot[];
		images?: Array<{ imageId: string }>;
		queueOnly?: boolean;
	}
	const send = mock(async (_id: string, text: string, input: AcceptedInput) =>
		storedMessage("sent", text, input.fileReferences),
	);
	// Simulate additional internal fields so the route's summary-only contract is
	// tested against accidental future additions to a service result.
	const editResult = {
		ok: true,
		warnings: [
			{ code: "SUBAGENT_CHANGES_REVERTED", changeCount: 1, sampleFilePaths: [reference.path] },
		],
		contentJson: state.existing,
		userMessage: { id: "edited", contentJson: state.existing },
	};
	const edit = mock(async (..._args: unknown[]) => editResult);
	const persistAdditional = mock(async (_mid: string, _files: File[], _reserved: string[]) => []);
	const capture = async (
		narratorId: string,
		userId: string,
		refs: readonly FileReference[],
		signal: AbortSignal,
	) => {
		captures.push({ narratorId, userId, refs, signal });
		if (state.captureError) throw state.captureError;
		if (signal.aborted) throw new ValidationError("Reference capture aborted");
		return refs.map((ref) => snapshot(ref, state.sourceText));
	};
	const push = mock(async (_id: string, text: string, input: AcceptedInput) => {
		if (state.queueFull) throw new ValidationError("Buffer queue full");
		queue.push({
			id: "queued",
			text,
			fileReferences: input.fileReferences ?? [],
		});
		return { ok: true, id: "queued", bufferedAt: "now" };
	});
	const update = mock(
		(
			_id: string,
			mid: string,
			text: string,
			opts: { fileReferences?: FileReferenceSnapshot[] },
		) => {
			const item = queue.find((entry) => entry.id === mid);
			if (!item) return false;
			item.text = text;
			if (opts.fileReferences !== undefined) item.fileReferences = opts.fileReferences;
			return true;
		},
	);

	const draftUpdate = mock(async (...args: unknown[]) => ({
		previousHasDraft: false,
		hasDraft: true,
		text: args[2],
		fileReferences: args[4] ?? [],
		revision: 2,
		updatedBy: args[0],
		updatedAt: "now",
		sourceId: args[3],
	}));
	const acl = mock(async (c: Context, id: string, need: string) => {
		if (
			id !== "session" ||
			c.get("user").sub === "stranger" ||
			(c.get("user").sub === "viewer" && need !== "read")
		)
			throw new NotFoundError("Narrator", id);
	});
	const routes = new Hono();
	const child = new Hono();
	child.post("/resolve", (c) =>
		c.json({ narratorId: c.req.param("id"), userId: c.get("user").sub }),
	);
	child.get("/preview", (c) => c.json({ ok: true }));
	const bindings = {
		narratorRoutes: routes,
		fileReferenceRoutes: child,
		requestRecordingRoutes: new Hono(),
		requireNarratorAccess: acl,
		AppError,
		ValidationError,
		NotFoundError,
		catalogError,
		// Spec sessions: the outline-only /goal refusals stay out of the way.
		resolveTaskBackend: async () => "spec",
		isRefusedOutlineGoal: async () => false,
		parseFileReferenceInput,
		parseOptionalComposerDocument,
		bindComposerDocumentReferences,
		bindComposerMediaProjection,
		restoreMultipartComposerText,
		validateComposerAssets,
		validateComposerProjection,
		replaceFileReferenceSnapshots,
		getFileReferenceSnapshots,
		// Block reads off: bodies read from the column, as before block storage.
		bodyColumns: (columns?: Record<string, boolean>) => (columns ? { columns } : {}),
		fillBody: <T>(row: T) => row,
		fileReferenceMessageForDisplay,
		sendMessageSchema,
		bufferQueueModeSchema,
		updateBufferedMessageSchema,
		editAndRegenerateJsonSchema,
		editAssistantMessageSchema,
		updateNarratorDraftSchema,
		MAX_EDIT_IMAGES_PER_MESSAGE,
		MAX_EDIT_TEXT_FILES_PER_MESSAGE,
		MAX_MEDIA_ATTACHMENTS,
		MAX_STAGED_ATTACHMENTS_TOTAL_BYTES,
		findStagedAttachment,
		stagedAttachmentAsFile,
		MAX_NARRATOR_ATTACHMENT_BYTES: 128 * 1024 * 1024,
		validateTextFile: () => {},
		validateUploadedImage: () => {},
		saveUploadedImage: async () => ({ imageId: `upload-${++savedImages}` }),
		deleteUploadedImage: (_id: string, imageId: string) => deletedImages.push(imageId),
		captureFileReferences: capture,
		narratorService: {
			getById: async () => ({
				id: "session",
				status: options.busy ? "working" : "idle",
				variant: options.subagent ? "subagent" : "primary",
				traits: [],
			}),
		},
		getQueueDuringCompaction: () => true,
		isCompactInProgress: () => !!options.compact,
		isSubagentVariant: (variant: string) => variant === "subagent",
		isLoopRunning: () => !!options.busy,
		isExecutionSuspended: () => false,
		isNarratorRuntimeBusy: () => !!options.busy,
		reconcileRunningStatus: async () => {},
		requestBufferedMessageSoftStop: () => {},
		resolveCommand: async (message: string) => {
			if (message.startsWith("/goal")) return { resolved: true, specGoal: true, objective: "work" };
			if (message.startsWith("/bash")) return { resolved: true, bashCommand: "pwd" };
			if (message.startsWith("/tool")) return { resolved: true, loadTool: "Read" };
			if (message.startsWith("/custom"))
				return { resolved: true, expandedPrompt: "expanded model prompt", rawCommand: message };
			if (message.startsWith("/skill"))
				return { resolved: true, loadSkill: "sample", rawCommand: message };
			return { resolved: false };
		},
		handleLoadSkillCommand: async () => ({
			found: true,
			skillName: "sample",
			content: "skill instructions",
		}),
		acceptUserMessage: async (id: string, text: string, input: AcceptedInput) => {
			if (options.busy || input.queueOnly) {
				const queued = await push(id, text, input);
				return { buffered: true, ...queued };
			}
			return { buffered: false, userMsg: await send(id, text, input) };
		},
		editAndRegenerate: edit,
		editAssistantMessage: edit,
		restoreAssistantMessage: edit,
		prepareHistoryRewrite: mock(async () => {}),
		updateBufferedMessage: update,
		getBufferedMessagesAsync: async () => queue,
		withNarratorWorkAdmission: async (_id: string, work: () => Promise<unknown>) => work(),
		toBufferSummary: (items: QueueItem[]) =>
			items.map((item) => ({
				...item,
				fileReferences: item.fileReferences.map((entry) => entry.reference),
			})),
		broadcastToNarrator: (_id: string, event: unknown) => events.push(event),
		broadcastBufferQueue: async () => {},
		broadcastToUser: (_id: string, event: unknown) => events.push(event),
		getUserLanguage: async () => "en",
		getUserReplyInLanguage: async () => false,
		logger: { warn: () => {} },
		db: {
			query: {
				users: { findFirst: async () => undefined },
				narratorMessageRefs: {
					findFirst: async ({ where }: { where: Array<[string, string]> }) =>
						state.messageExists &&
						where.some(([key, value]) => key === "messageId" && value === "message")
							? { messageId: "message" }
							: undefined,
				},
				narratorMessages: {
					findFirst: async () => ({ role: "user", contentJson: state.existing }),
				},
			},
		},
		users: { id: "id" },
		narratorMessageRefs: { narratorId: "narratorId", messageId: "messageId" },
		narratorMessages: { id: "id" },
		eq: (a: unknown, b: unknown) => [a, b],
		and: (...args: unknown[]) => args,
		loadBufferedTextFiles: () => [],
		deleteBufferedTextFile: () => {},
		persistAdditionalBufferedTextFiles: persistAdditional,
		// The route drops staged originals after a successful queue edit; these
		// fixtures never stage uploads, so a no-op keeps the code path reachable.
		releaseStagedFiles: () => {},
		getNarratorDraft: async () => ({
			text: "",
			fileReferences: [reference],
			revision: 1,
			hasDraft: true,
		}),
		updateNarratorDraft: draftUpdate,
		syncNarratorDraftToRecentTabs: async () => {},
		publicTraitsResponse: () => [],
		revertScopeSchema: { parse: (value: unknown) => value },
	};
	new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: options.user ?? "actual-sender", role: "user", iat: 0, exp: 9999999999 });
		await next();
	});
	app.onError((error) => {
		// Missing injected bindings are harness bugs, not expected HTTP failures.
		if (!(error instanceof AppError)) throw error;
		return Response.json({ error: error.message, code: error.code }, { status: error.statusCode });
	});
	app.route("/api/narrators", routes);
	const request = (path: string, body: unknown, method = "POST", signal?: AbortSignal) =>
		app.request(`/api/narrators/session/${path}`, {
			method,
			signal,
			...(body instanceof FormData
				? { body }
				: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
		});
	return {
		app,
		request,
		state,
		storedMessages,
		editResult,
		queue,
		captures,
		deletedImages,
		events,
		send,
		edit,
		persistAdditional,
		push,
		update,
		draftUpdate,
		acl,
		rewrite: bindings.prepareHistoryRewrite,
	};
}
function multipart(message = "", refs: unknown = [reference]) {
	const body = new FormData();
	body.set("message", message);
	body.set("fileReferences", JSON.stringify(refs));
	body.append("images", new File(["image"], "a.png", { type: "image/png" }));
	return body;
}

describe("file reference HTTP sends", () => {
	test.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	])("composer projection precedes reference capture (multipart=%s, mismatch=%s)", async (form, mismatch) => {
		const f = fixture();
		const composerDocument: ComposerDocument = {
			version: 1,
			assets: [],
			paragraphs: [
				{
					children: [
						{ type: "text", text: "Inspect " },
						{ type: "fileReference", id: "inline-ref", reference },
					],
				},
			],
		};
		const projection = composerDocumentText(composerDocument);
		const message = projection.text + (mismatch ? " altered" : "");
		const body = { message, fileReferences: projection.fileReferences, composerDocument };
		const multipartBody = new FormData();
		multipartBody.set("message", message);
		multipartBody.set("fileReferences", JSON.stringify(projection.fileReferences));
		multipartBody.set("composerDocument", JSON.stringify(composerDocument));
		const response = await f.request("messages", form ? multipartBody : body);
		expect(response.status).toBe(mismatch ? 400 : 201);
		if (mismatch) {
			expect(f.captures).toHaveLength(0);
			expect(f.send).not.toHaveBeenCalled();
		} else {
			expect(f.captures).toHaveLength(1);
			expect(f.send.mock.calls[0][2]).toMatchObject({
				composerDocument,
				fileReferences: projection.fileReferences.map((ref) => snapshot(ref, "freshly read bytes")),
			});
		}
	});
	test("multipart references alone count as content without images or text files", async () => {
		const f = fixture();
		const form = new FormData();
		form.set("fileReferences", JSON.stringify([reference]));
		expect((await f.request("messages", form)).status).toBe(201);
		expect(f.send.mock.calls[0][2].images).toEqual([]);
		expect(f.send.mock.calls[0][2].fileReferences).toEqual([
			snapshot(reference, "freshly read bytes"),
		]);
	});
	test.each([
		false,
		true,
	])("JSON and multipart carry one frozen capture (multipart=%s)", async (form) => {
		const f = fixture();
		const response = await f.request(
			"messages",
			form ? multipart() : { fileReferences: [reference] },
		);
		expect(response.status).toBe(201);
		expect(f.captures).toHaveLength(1);
		expect(f.captures[0]).toMatchObject({
			narratorId: "session",
			userId: "actual-sender",
			refs: [reference],
		});
		expect(f.captures[0].signal).toBeInstanceOf(AbortSignal);
		expect(f.send.mock.calls[0][2].fileReferences).toEqual([
			snapshot(reference, "freshly read bytes"),
		]);
		expect(f.deletedImages).toEqual([]);
	});
	test.each([
		false,
		true,
	])("primary busy/compacting queues freeze before returning (compact=%s)", async (compact) => {
		const f = fixture({ busy: !compact, compact });
		expect((await f.request("messages", { message: "", fileReferences: [reference] })).status).toBe(
			202,
		);
		expect(f.push.mock.calls[0][2].fileReferences).toEqual([
			snapshot(reference, "freshly read bytes"),
		]);
		f.state.sourceText = "changed after acceptance";
		expect(f.queue[0].fileReferences[0].snapshotText).toBe("freshly read bytes");
		expect(f.captures).toHaveLength(1);
		expect(JSON.stringify(f.events)).not.toContain("snapshotText");
	});
	test.each([false, true])("subagent followup/queue carries snapshots (busy=%s)", async (busy) => {
		const f = fixture({ busy, subagent: true });
		expect((await f.request("messages", { message: "", fileReferences: [reference] })).status).toBe(
			busy ? 202 : 201,
		);
		// Same admission as any session: delivered now when idle, queued when busy.
		const payload = busy ? f.push.mock.calls[0][2] : f.send.mock.calls[0][2];
		expect(payload).toMatchObject({ fileReferences: [snapshot(reference, "freshly read bytes")] });
		if (busy) {
			f.state.sourceText = "changed after acceptance";
			expect(f.queue[0].fileReferences[0].snapshotText).toBe("freshly read bytes");
		}
		expect(f.captures).toHaveLength(1);
	});
	test.each([
		"/new other",
		"/goal work",
		"/bash pwd",
		"/tool Read",
	])("rejects refs on control command %s and cleans uploads", async (message) => {
		const f = fixture();
		expect((await f.request("messages", multipart(message))).status).toBe(400);
		expect(f.captures).toHaveLength(0);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.deletedImages).toEqual(["upload-1"]);
	});
	test.each([
		"/custom task",
		"/skill sample",
	])("model-expanding commands can carry refs: %s", async (message) => {
		const f = fixture();
		expect((await f.request("messages", { message, fileReferences: [reference] })).status).toBe(
			201,
		);
		expect(f.send.mock.calls[0][2].fileReferences).toEqual([
			snapshot(reference, "freshly read bytes"),
		]);
	});
	test.each([
		false,
		true,
	])("capture rejection/abort removes parsed uploads (abort=%s)", async (abort) => {
		const f = fixture();
		const controller = new AbortController();
		if (abort) controller.abort();
		else f.state.captureError = new ValidationError("Read denied");
		expect((await f.request("messages", multipart(), "POST", controller.signal)).status).toBe(400);
		expect(f.deletedImages).toEqual(["upload-1"]);
		expect(f.send).not.toHaveBeenCalled();
	});
	test("full queue cleans uploaded images after capturing once", async () => {
		const f = fixture({ busy: true });
		f.state.queueFull = true;
		expect((await f.request("messages", multipart())).status).toBe(400);
		expect(f.deletedImages).toEqual(["upload-1"]);
		expect(f.captures).toHaveLength(1);
	});
	test.each([
		false,
		true,
	])("rejects forged snapshots before writing images (multipart=%s)", async (form) => {
		const f = fixture();
		const refs = [{ ...reference, snapshotText: "forged" }];
		expect(
			(
				await f.request(
					"messages",
					form ? multipart("", refs) : { message: "hi", fileReferences: refs },
				)
			).status,
		).toBe(400);
		expect(f.deletedImages).toEqual([]);
		expect(f.captures).toHaveLength(0);
	});
});

describe("HTTP file reference display boundaries", () => {
	for (const subagent of [false, true]) {
		for (const form of [false, true]) {
			test(`send returns metadata without mutating 128 KiB snapshots (subagent=${subagent}, multipart=${form})`, async () => {
				const f = fixture({ subagent });
				f.state.sourceText = "x".repeat(MAX_FILE_REFERENCE_TEXT_BYTES);
				const refs = Array.from({ length: 4 }, (_, index) => ({
					...reference,
					id: `occurrence-${index}`,
				}));
				const response = await f.request(
					"messages",
					form ? multipart("user text", refs) : { message: "user text", fileReferences: refs },
				);
				expect(response.status).toBe(201);
				const serialized = await response.text();
				expect(serialized).not.toContain("snapshotText");
				expect(serialized).not.toContain("snapshotHash");
				expect(serialized).not.toContain("capturedAt");
				expect(serialized.length).toBeLessThan(4096);
				expect(JSON.parse(serialized).contentJson).toEqual([
					...refs.map((ref) => ({ type: "file_reference", reference: ref })),
					{ type: "text", text: "user text" },
				]);
				expect(f.captures).toHaveLength(1);
				const internalSnapshots = getFileReferenceSnapshots(f.storedMessages[0].contentJson);
				expect(internalSnapshots).toHaveLength(4);
				expect(internalSnapshots).toEqual(refs.map((ref) => snapshot(ref, f.state.sourceText)));
				expect(f.send.mock.calls[0][2].fileReferences).toEqual(internalSnapshots);
			});
		}
	}

	test.each([
		false,
		true,
	])("edit acknowledgement cannot expose internal user message snapshots (subagent=%s)", async (subagent) => {
		const f = fixture({ subagent });
		const response = await f.request("edit-and-regenerate/message", {
			skipRevert: true,
			content: "edited text",
			fileReferences: [reference],
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ok: true, warnings: f.editResult.warnings });
		expect(JSON.stringify(body)).not.toContain("snapshotText");
		expect(f.state.existing).toEqual([snapshot()]);
		expect(f.editResult.contentJson).toEqual([snapshot()]);
		expect(f.edit.mock.calls[0][5]).toMatchObject({ fileReferences: [snapshot()] });
	});

	test.each([
		"edit-message",
		"restore-message",
	])("%s acknowledges only public status", async (endpoint) => {
		const f = fixture();
		const response = await f.request(`${endpoint}/message`, { content: "changed" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(f.editResult.userMessage.contentJson).toEqual([snapshot()]);
	});
});

describe("staged attachment edit ordering", () => {
	for (const queued of [false, true]) {
		test.each([
			[0, "large body", "x", "large.log", "small.log"],
			[1, "large body", "x", "large.log", "small.log"],
			[0, "AAAA", "BBBB", "same.log", "same.log"],
			[1, "AAAA", "BBBB", "same.log", "same.log"],
		] as const)(`keeps original new-file index %s in ${queued ? "queue" : "history"} edits`, async (index, stagedBody, inlineBody, stagedName, inlineName) => {
			const root = mkdtempSync(join(tmpdir(), "nf-route-stage-"));
			setStagedAttachmentsDirForTests(root);
			try {
				const staged = await stageAttachment(new Blob([stagedBody]).stream(), {
					narratorId: "session",
					filename: stagedName,
				});
				const f = fixture();
				if (queued) f.queue.push({ id: "queued", text: "before", fileReferences: [] });
				const form = new FormData();
				form.set(queued ? "text" : "content", "after");
				form.set("skipRevert", "true");
				form.set("fileReferences", "[]");
				form.append("textFiles", new File([inlineBody], inlineName));
				form.set("stagedAttachments", JSON.stringify([{ uploadId: staged.uploadId, index }]));
				const response = await f.request(
					queued ? "buffer/queued" : "edit-and-regenerate/message",
					form,
					queued ? "PATCH" : "POST",
				);
				expect(response.status).toBe(200);
				const files = queued
					? f.persistAdditional.mock.calls[0][1]
					: (f.edit.mock.calls[0][5] as { newTextFiles: File[] }).newTextFiles;
				expect(await Promise.all(files.map((file) => file.text()))).toEqual(
					index === 0 ? [stagedBody, inlineBody] : [inlineBody, stagedBody],
				);
			} finally {
				setStagedAttachmentsDirForTests(null);
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});

describe("file reference edits", () => {
	test("file restore without a reviewed plan refuses before capture or history interruption", async () => {
		const f = fixture();
		const response = await f.request("edit-and-regenerate/message", {
			content: "changed",
			fileReferences: [reference],
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "REVERT_CONFIRMATION_REQUIRED" });
		expect(f.captures).toHaveLength(0);
		expect(f.rewrite).not.toHaveBeenCalled();
		expect(f.edit).not.toHaveBeenCalled();
	});

	test.each([
		false,
		true,
	])("message edit reuses only this message's saved bytes (subagent=%s)", async (subagent) => {
		const f = fixture({ subagent });
		f.state.captureError = new ValidationError("source was deleted");
		expect(
			(
				await f.request("edit-and-regenerate/message", {
					skipRevert: true,
					content: "",
					fileReferences: [reference],
				})
			).status,
		).toBe(200);
		expect(f.captures).toHaveLength(0);
		expect(f.edit.mock.calls[0][5]).toMatchObject({ fileReferences: [snapshot()] });
	});
	test("message omission preserves, [] deletes, and changed target is recaptured", async () => {
		const f = fixture();
		await f.request("edit-and-regenerate/message", { skipRevert: true, content: "text only" });
		expect(f.edit.mock.calls[0][5]).toMatchObject({ fileReferences: undefined });
		await f.request("edit-and-regenerate/message", {
			skipRevert: true,
			content: "text",
			fileReferences: [],
		});
		expect(f.edit.mock.calls[1][5]).toMatchObject({ fileReferences: [] });
		const changed = { ...reference, path: "/workspace/b.ts" };
		await f.request("edit-and-regenerate/message", {
			skipRevert: true,
			content: "text",
			fileReferences: [changed],
		});
		expect(f.captures[0].refs).toEqual([changed]);
	});
	test("unknown message refuses before capture or history interruption", async () => {
		const f = fixture();
		expect(
			(
				await f.request("edit-and-regenerate/someone-elses-message", {
					skipRevert: true,
					content: "",
					fileReferences: [reference],
				})
			).status,
		).toBe(404);
		expect(f.captures).toHaveLength(0);
		expect(f.rewrite).not.toHaveBeenCalled();
	});
	test("a foreign occurrence ID is captured, not borrowed from another message", async () => {
		const f = fixture();
		const other = { ...reference, id: "other-message-occurrence" };
		await f.request("edit-and-regenerate/message", {
			skipRevert: true,
			content: "",
			fileReferences: [other],
		});
		expect(f.captures[0].refs).toEqual([other]);
		expect(f.edit.mock.calls[0][5]).toMatchObject({
			fileReferences: [snapshot(other, "freshly read bytes")],
		});
	});
	test("multipart message edit parses references and failure leaves history unchanged", async () => {
		const f = fixture();
		const form = new FormData();
		form.set("content", "updated");
		form.set("skipRevert", "true");
		form.set("fileReferences", JSON.stringify([{ ...reference, id: "added" }]));
		f.state.captureError = new ValidationError("Read denied");
		expect((await f.request("edit-and-regenerate/message", form)).status).toBe(400);
		expect(f.rewrite).not.toHaveBeenCalled();
	});
	test.each([
		false,
		true,
	])("queue edit uses actual snapshots and permits reference-only text (subagent=%s)", async (subagent) => {
		const f = fixture({ subagent });
		const queue = f.queue;
		queue.push({ id: "queued", text: "old", fileReferences: [snapshot()] });
		f.state.captureError = new ValidationError("offline");
		expect(
			(await f.request("buffer/queued", { text: "", fileReferences: [reference] }, "PATCH")).status,
		).toBe(200);
		expect(queue[0].fileReferences).toEqual([snapshot()]);
		expect(f.captures).toHaveLength(0);
		expect((await f.request("buffer/queued", { text: "new wording" }, "PATCH")).status).toBe(200);
		expect(queue[0].fileReferences).toEqual([snapshot()]);
		const form = new FormData();
		form.set("text", "now plain");
		form.set("fileReferences", "[]");
		expect((await f.request("buffer/queued", form, "PATCH")).status).toBe(200);
		expect(queue[0].fileReferences).toEqual([]);
	});
	test.each([
		"/new next",
		"/goal work",
	])("queue editing cannot bypass control-command reference rejection: %s", async (text) => {
		const f = fixture();
		f.queue.push({ id: "queued", text, fileReferences: [] });
		expect(
			(await f.request("buffer/queued", { fileReferences: [reference] }, "PATCH")).status,
		).toBe(400);
		expect(f.captures).toHaveLength(0);
		expect(f.queue[0].fileReferences).toEqual([]);
	});

	test("removing the final queued reference cannot create an empty message", async () => {
		const f = fixture();
		f.queue.push({ id: "queued", text: "", fileReferences: [snapshot()] });
		expect((await f.request("buffer/queued", { fileReferences: [] }, "PATCH")).status).toBe(400);
		expect(f.queue[0].fileReferences).toEqual([snapshot()]);
	});
});

describe("file reference draft and ACL wiring", () => {
	test("draft writes and private broadcasts share reference metadata", async () => {
		const f = fixture();
		const result = await f.request(
			"draft",
			{ text: "", sourceId: "tab", fileReferences: [reference] },
			"PUT",
		);
		expect(result.status).toBe(200);
		expect(f.draftUpdate.mock.calls[0]).toEqual([
			"actual-sender",
			"session",
			"",
			"tab",
			[reference],
			undefined,
		]);
		expect(await result.json()).toMatchObject({ fileReferences: [reference] });
		expect(f.events[0]).toMatchObject({ type: "draft_changed", fileReferences: [reference] });
		expect(await (await f.app.request("/api/narrators/session/draft")).json()).toMatchObject({
			fileReferences: [reference],
		});
	});
	test("resolve is read-only but remains gated by the parent narrator ACL", async () => {
		const viewer = fixture({ user: "viewer" });
		const result = await viewer.request("file-references/resolve", { targets: [] });
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ narratorId: "session", userId: "viewer" });
		expect(viewer.acl.mock.calls[0][2]).toBe("read");
		expect((await viewer.request("messages", { fileReferences: [reference] })).status).toBe(404);
		const stranger = fixture({ user: "stranger" });
		expect((await stranger.request("file-references/resolve", { targets: [] })).status).toBe(404);
		expect(
			(await stranger.app.request("/api/narrators/session/file-references/preview")).status,
		).toBe(404);
		expect((await viewer.request("other/file-references/resolve", {})).status).toBe(404);
	});
});
