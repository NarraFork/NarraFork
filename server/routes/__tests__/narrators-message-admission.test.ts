import { describe, expect, mock, test } from "bun:test";
import { type FileReference, fileReferenceMessageForDisplay } from "@shared/file-reference";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
} from "@shared/text-file-types";
import { Hono } from "hono";
import { AppError, ValidationError } from "../../lib/errors";
import { parseFileReferenceInput } from "../../lib/file-reference-input";
import { sendMessageSchema } from "../../lib/validators/narrators";

// Run the real parser/HTTP handler with injected service boundaries, without
// initializing the database or mocking process-global agent modules.
const source = await Bun.file(new URL("../narrators.ts", import.meta.url)).text();
function section(start: string, end: string) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new Error(`Missing route boundary: ${start}`);
	return source.slice(from, to);
}
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
	[
		section("function parseNewCommand(", "export const narratorRoutes"),
		section('narratorRoutes.post("/:id/messages"', "// Retry last user message"),
	]
		.join("\n")
		.replaceAll("export async function", "async function")
		.replace(
			/import\(\s*"\.\.\/services\/narrator-subagent"\s*\)/g,
			"Promise.resolve(subagentQueue)",
		)
		.replace(
			/import\(\s*"\.\.\/services\/subagent-executor"\s*\)/g,
			"Promise.resolve(subagentQueue)",
		),
);

function fixture(
	options: {
		status?: "idle" | "working" | "waiting";
		busy?: boolean;
		runtimeBusy?: boolean;
		buffered?: boolean;
		subagent?: boolean;
		compact?: boolean;
		modelOverride?: boolean;
		control?: "bash" | "load" | "unload" | "block" | "unblock";
		reject?: boolean;
	} = {},
) {
	let status = options.status ?? "idle";
	const deletedImages: string[] = [];
	const userMsg = {
		id: "user-message",
		role: "user",
		contentText: "hello",
		contentJson: [{ type: "text", text: "hello" }],
	};
	const accept = mock(async (_id: string, _prompt: string, _options: Record<string, unknown>) => {
		if (options.reject) throw new ValidationError("Message queue is full");
		return options.buffered
			? { buffered: true, id: "queued-message", bufferedAt: "now" }
			: {
					buffered: false,
					userMsg: {
						...userMsg,
						contentJson: [
							...((_options.fileReferences ?? []) as unknown[]),
							...userMsg.contentJson,
						],
					},
				};
	});
	const legacySend = mock(() => {
		throw new Error("Primary admission bypassed");
	});
	const legacyPush = mock(() => {
		throw new Error("Primary admission bypassed");
	});
	const pushSub = mock(async (_id: string, _prompt: string, _options: Record<string, unknown>) => ({
		ok: true,
		id: "sub-queued",
		bufferedAt: "now",
	}));
	const resume = mock(async (_options: Record<string, unknown>) => ({ userMessage: userMsg }));
	const updateModel = mock(async () => {});
	const modelBroadcast = mock(() => {});
	const restoreModel = mock(async () => {});
	const awaitCompact = mock(async () => {});
	const broadcast = mock(() => {});
	const routes = new Hono();
	const bindings = {
		narratorRoutes: routes,
		ValidationError,
		parseFileReferenceInput,
		sendMessageSchema,
		MAX_EDIT_IMAGES_PER_MESSAGE,
		MAX_EDIT_TEXT_FILES_PER_MESSAGE,
		fileReferenceMessageForDisplay,
		captureFileReferences: async (_id: string, _userId: string, refs: FileReference[]) =>
			refs.map((reference) => ({
				type: "file_reference",
				reference,
				snapshotText: "private snapshot bytes",
				snapshotHash: "a".repeat(64),
				capturedAt: "2026-09-21T00:00:00.000Z",
			})),
		validateTextFile: () => {},
		validateUploadedImage: () => {},
		saveUploadedImage: async () => ({ imageId: "saved-image", mediaType: "image/png" }),
		deleteUploadedImage: (_id: string, imageId: string) => deletedImages.push(imageId),
		narratorService: {
			getById: async () => ({
				id: "session",
				status,
				variant: options.subagent ? "subagent" : "primary",
				model: "original",
			}),
			updateModel,
		},
		isSubagentVariant: (variant: string) => variant === "subagent",
		isLoopRunning: () => !!options.busy,
		isNarratorRuntimeBusy: () => options.runtimeBusy ?? !!options.busy,
		isExecutionSuspended: () => false,
		getQueueDuringCompaction: () => true,
		isCompactInProgress: () => !!options.compact,
		awaitCompactCompletion: awaitCompact,
		reconcileRunningStatus: async () => {
			status = options.busy ? "working" : "idle";
		},
		resolveCommand: async (message: string) =>
			options.control
				? {
						resolved: true,
						rawCommand: message,
						...{
							bash: { bashCommand: "pwd" },
							load: { loadTool: "Read" },
							unload: { unloadTool: "Read" },
							block: { blockAllSkills: true },
							unblock: { unblockAllSkills: true },
						}[options.control],
					}
				: message.startsWith("/goal")
					? { resolved: true, specGoal: true, objective: "do work", rawCommand: message }
					: options.modelOverride
						? {
								resolved: true,
								expandedPrompt: "expanded",
								rawCommand: message,
								bashCommand: "pwd",
								command: { modelOverride: { model: "replacement", mode: "temporary" } },
							}
						: { resolved: false },
		getUserLanguage: async () => "zh-CN",
		getUserReplyInLanguage: async () => true,
		acceptUserMessage: accept,
		sendMessage: legacySend,
		pushBufferedMessage: legacyPush,
		resumeSubagent: resume,
		subagentQueue: {
			bufferSubagentUserMessage: pushSub,
			isTakenOver: () => true,
			getSubagentBufferedMessagesAsync: async () => [],
		},
		toBufferSummary: (items: unknown[]) => items,
		broadcastToNarrator: broadcast,
		setTemporaryModelRestore: restoreModel,
		updateNarratorModel: modelBroadcast,
		db: {
			query: {
				users: {
					findFirst: async () => ({
						id: "owner",
						username: "Alice",
						avatarColor: "blue",
						avatarImageId: null,
					}),
				},
			},
		},
		users: { id: "id" },
		eq: () => undefined,
		logger: { warn: () => {} },
	};
	new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "owner", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
			}),
	);
	app.route("/narrators", routes);
	return {
		accept,
		legacySend,
		legacyPush,
		pushSub,
		resume,
		deletedImages,
		updateModel,
		modelBroadcast,
		restoreModel,
		awaitCompact,
		broadcast,
		post: (body: FormData | Record<string, unknown>) =>
			app.request("http://localhost/narrators/session/messages", {
				method: "POST",
				...(body instanceof FormData
					? { body }
					: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
			}),
	};
}

function multipart(interrupt?: string) {
	const body = new FormData();
	body.set("message", "hello");
	body.append("images", new File(["image"], "image.png", { type: "image/png" }));
	body.append("textFiles", new File(["text"], "note.txt", { type: "text/plain" }));
	if (interrupt !== undefined) body.set("interrupt", interrupt);
	return body;
}

describe("primary HTTP message admission", () => {
	test.each([
		true,
		false,
		undefined,
	])("JSON preserves interrupt=%s and implies priority only when true", async (interrupt) => {
		const f = fixture({ buffered: true });
		const response = await f.post({ message: "hello", interrupt });
		expect(response.status).toBe(202);
		const admission = f.accept.mock.calls[0]?.[2];
		expect(admission?.interrupt).toBe(interrupt);
		expect(!!admission?.priority).toBe(interrupt === true);
		expect(f.legacySend).not.toHaveBeenCalled();
		expect(f.legacyPush).not.toHaveBeenCalled();
	});

	test("JSON rejects a string interrupt instead of coercing it", async () => {
		const f = fixture();
		expect((await f.post({ message: "hello", interrupt: "true" })).status).toBe(400);
		expect(f.accept).not.toHaveBeenCalled();
	});

	test.each([
		"true",
		"false",
		undefined,
	])("multipart parses interrupt=%s without dropping attachments", async (interrupt) => {
		const f = fixture({ buffered: true });
		const response = await f.post(multipart(interrupt));
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			buffered: true,
			id: "queued-message",
			bufferedAt: "now",
		});
		const admission = f.accept.mock.calls[0]?.[2];
		expect(!!admission?.interrupt).toBe(interrupt === "true");
		expect(!!admission?.priority).toBe(interrupt === "true");
		expect(admission?.images).toEqual([{ imageId: "saved-image", mediaType: "image/png" }]);
		expect((admission?.textFiles as File[])[0]?.name).toBe("note.txt");
		expect(f.deletedImages).toEqual([]);
	});

	test.each([
		"idle",
		"working",
		"waiting",
	] as const)("%s status may accept behind a backlog with 202, never a busy error", async (status) => {
		const f = fixture({ status, buffered: true });
		expect((await f.post(multipart())).status).toBe(202);
		expect(f.accept).toHaveBeenCalledTimes(1);
		expect(f.deletedImages).toEqual([]);
		expect(f.broadcast).not.toHaveBeenCalled();
	});

	test.each([
		"idle",
		"working",
	] as const)("%s status can return a direct 201 and retain images", async (status) => {
		const f = fixture({ status });
		const response = await f.post(multipart());
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ id: "user-message", contentText: "hello" });
		expect(f.deletedImages).toEqual([]);
		expect(f.accept.mock.calls[0]?.[2]).toMatchObject({
			userId: "owner",
			locale: "zh-CN",
			replyInUserLanguage: true,
			creator: { id: "owner", username: "Alice", avatarColor: "blue", avatarImageId: null },
		});
	});

	test.each([
		false,
		true,
	])("file references reach admission but only display metadata reaches HTTP (buffered=%s)", async (buffered) => {
		const f = fixture({ buffered });
		const reference = {
			id: "ref",
			deviceId: "local",
			path: "/workspace/file.ts",
			label: "file.ts",
		};
		const response = await f.post({ message: "hello", fileReferences: [reference] });
		expect(response.status).toBe(buffered ? 202 : 201);
		expect(f.accept.mock.calls[0]?.[2].fileReferences).toEqual([
			expect.objectContaining({ reference, snapshotText: "private snapshot bytes" }),
		]);
		const payload = await response.json();
		expect(JSON.stringify(payload)).not.toContain("private snapshot bytes");
		if (!buffered) expect(payload.contentJson[0]).toEqual({ type: "file_reference", reference });
	});

	test("rejected admission still cleans uploads", async () => {
		const f = fixture({ reject: true });
		expect((await f.post(multipart())).status).toBe(400);
		expect(f.deletedImages).toEqual(["saved-image"]);
	});

	test("busy interrupt reaches atomic admission without an HTTP-side interrupt or enqueue", async () => {
		const f = fixture({ status: "working", busy: true, buffered: true });
		expect(
			(await f.post({ message: "replacement", priority: false, interrupt: true })).status,
		).toBe(202);
		expect(f.accept.mock.calls[0]).toEqual([
			"session",
			"replacement",
			expect.objectContaining({ interrupt: true, priority: true }),
		]);
		expect(f.accept).toHaveBeenCalledTimes(1);
		expect(f.legacySend).not.toHaveBeenCalled();
		expect(f.legacyPush).not.toHaveBeenCalled();
	});

	test("ordinary priority remains a soft-boundary intent", async () => {
		const f = fixture({ buffered: true });
		expect((await f.post({ message: "hello", priority: true })).status).toBe(202);
		expect(f.accept.mock.calls[0]?.[2]).toMatchObject({ priority: true, interrupt: undefined });
	});

	test("compaction queues without waiting; interrupt opts out", async () => {
		for (const interrupt of [false, true]) {
			const f = fixture({ compact: true, buffered: true });
			expect((await f.post({ message: "hello", interrupt })).status).toBe(202);
			expect(f.accept.mock.calls[0]?.[2].queueOnly).toBe(!interrupt);
			expect(f.awaitCompact).not.toHaveBeenCalled();
		}
	});

	test("queued /goal response preserves the UI flag", async () => {
		const f = fixture({ status: "working", busy: true, buffered: true });
		const response = await f.post({ message: "/goal do work" });
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			buffered: true,
			id: "queued-message",
			bufferedAt: "now",
			specGoalQueued: true,
			objective: "do work",
		});
		expect(f.accept.mock.calls[0]?.[2].commandText).toBe("/goal do work");
	});

	test.each([false, true])("model override travels with admission (busy=%s)", async (busy) => {
		const f = fixture({
			busy,
			status: busy ? "working" : "idle",
			buffered: busy,
			modelOverride: true,
		});
		expect((await f.post({ message: "/custom" })).status).toBe(busy ? 202 : 201);
		expect(f.updateModel).not.toHaveBeenCalled();
		expect(f.restoreModel).not.toHaveBeenCalled();
		expect(f.modelBroadcast).not.toHaveBeenCalled();
		expect(f.accept.mock.calls[0]?.[2].executionIntent).toEqual({
			modelOverride: { model: "replacement", mode: "temporary" },
		});
		expect(f.accept.mock.calls[0]).toEqual([
			"session",
			"expanded",
			expect.objectContaining({ preBashCommand: "pwd", commandText: "/custom" }),
		]);
	});

	test("loop-less runtime owner with stale idle status does not receive a model override", async () => {
		const f = fixture({ runtimeBusy: true, buffered: true, modelOverride: true });
		expect((await f.post({ message: "/custom" })).status).toBe(202);
		expect(f.accept).toHaveBeenCalledTimes(1);
		expect(f.updateModel).not.toHaveBeenCalled();
		expect(f.restoreModel).not.toHaveBeenCalled();
		expect(f.modelBroadcast).not.toHaveBeenCalled();
	});

	test("stale busy model override is still owned by admission", async () => {
		const f = fixture({ status: "working", modelOverride: true });
		expect((await f.post({ message: "/custom" })).status).toBe(201);
		expect(f.updateModel).not.toHaveBeenCalled();
	});

	test.each([
		"bash",
		"load",
		"unload",
		"block",
		"unblock",
	] as const)("interrupting %s control is admitted instead of directly executing", async (control) => {
		const f = fixture({ control, busy: true, status: "working", buffered: true });
		const response = await f.post({ message: `/${control} pwd`, interrupt: true });
		expect(response.status).toBe(202);
		expect(f.accept.mock.calls[0]?.[2]).toMatchObject({
			interrupt: true,
			executionIntent: { controlCommand: true },
			userId: "owner",
		});
	});
});

describe("subagent HTTP compatibility", () => {
	test("busy subagent uses its existing queue, ignoring primary interrupt intent", async () => {
		const f = fixture({ subagent: true, status: "working", busy: true });
		const response = await f.post(multipart("true"));
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ buffered: true, id: "sub-queued", bufferedAt: "now" });
		expect(f.accept).not.toHaveBeenCalled();
		expect(f.pushSub.mock.calls[0]?.[2]).toMatchObject({ requestSoftStop: false });
		expect(f.pushSub.mock.calls[0]?.[2].interrupt).toBeUndefined();
		expect(!!f.pushSub.mock.calls[0]?.[2].priority).toBe(false);
		expect(f.deletedImages).toEqual([]);
	});

	test("explicit subagent priority is still passed through", async () => {
		const f = fixture({ subagent: true, status: "working", busy: true });
		expect((await f.post({ message: "hello", priority: true })).status).toBe(202);
		expect(f.pushSub.mock.calls[0]?.[2].priority).toBe(true);
	});

	test("idle compacting subagent waits then resumes, ignoring interrupt", async () => {
		const f = fixture({ subagent: true, compact: true });
		expect((await f.post({ message: "hello", interrupt: true })).status).toBe(201);
		expect(f.awaitCompact).toHaveBeenCalledTimes(1);
		expect(f.resume).toHaveBeenCalledTimes(1);
		expect(f.resume.mock.calls[0]?.[0].interrupt).toBeUndefined();
		expect(f.accept).not.toHaveBeenCalled();
	});
});
