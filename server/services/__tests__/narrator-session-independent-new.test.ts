import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposerDocument, ComposerInlineNode } from "@shared/composer-document";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import {
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
} from "../../lib/boolean-override";
import type { BufferedMessage } from "../narrator-session-state";

type Session = typeof import("../narrator-session");
type Executor = Session["executeQueuedNewCommand"];
type Prepare = Session["prepareIndependentQueuedNewCommand"];
type Parser = Session["parseQueuedNewCommand"];

// Run the production functions with local boundary injection, never module-wide mocks.
const source = await Bun.file(new URL("../narrator-session.ts", import.meta.url)).text();
function section(start: string, end: string) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new Error(`Missing independent /new boundary: ${start}`);
	return source.slice(from, to).replaceAll("export ", "");
}
const transpiler = new Bun.Transpiler({ loader: "ts" });
const executorCode = transpiler.transformSync(
	[
		section("export function parseQueuedNewCommand(", "/**\n * Recognize a buffered `/goal"),
		section("function normalizeOptionalBooleanOverride(", "/**\n * Resolve the remote devices"),
		section(
			"export function shouldSendQueuedNewInitialMessage(",
			"/**\n * Prepared under source admission",
		),
	].join("\n"),
);
const prepareCode = transpiler.transformSync(
	section(
		"export async function prepareIndependentQueuedNewCommand(",
		"/**\n * Persist and broadcast a `spec_goal_added`",
	).replace('import("../lib/i18n")', "Promise.resolve(i18n)"),
);

function document(...children: ComposerInlineNode[]): ComposerDocument {
	return { version: 1, paragraphs: [{ children }], assets: [] };
}
function row(id: string, text = "ordinary message"): BufferedMessage {
	return { id, text, bufferedAt: "2026-01-01T00:00:00.000Z", queueMode: "tool" };
}
const defaults = {
	id: "source",
	model: "provider:old-model" as string | null,
	systemPrompt: "source system prompt",
	permissionMode: "bypassPermissions",
	reasoningEffort: "high",
	fastModeOverride: "on",
	relaxedPlan: true,
	planReflectionAutoApproveOverride: "off",
	dangerReflectionOverride: "strict",
	questionReflectionOverride: "on",
	cwd: "/persisted-workspace" as string | null,
	ownerUserId: "owner" as string | null,
	status: "running",
};
function fixture(
	options: {
		message?: Partial<BufferedMessage>;
		source?: Partial<typeof defaults>;
		active?: boolean;
		aborted?: boolean;
		createError?: Error;
		sendError?: Error;
		sendGate?: Promise<void>;
		cleanup?: () => Promise<void>;
	} = {},
) {
	const message: BufferedMessage = {
		...row("command", "/new first task"),
		createdBy: "author",
		executionIntent: { controlCommand: true, modelOverride: { model: "other", mode: "permanent" } },
		...options.message,
	};
	const sourceNarrator = { ...defaults, ...options.source };
	const originalSource = structuredClone(sourceNarrator);
	const controller = new AbortController();
	if (options.aborted) controller.abort("source stopped independently");
	const abort = mock(() => controller.abort());
	const guidanceAbort = mock(() => {});
	const history = [{ role: "user", content: "old history" }];
	const originalHistory = structuredClone(history);
	let abortReads = 0;
	const active = {
		narratorId: "source",
		cwd: "/runtime-workspace",
		locale: "en",
		_modelRef: "provider:old-runtime-model",
		_modelSelectionRef: "provider:old-model",
		status: "running",
		history,
		guidanceAbort: { abort: guidanceAbort },
		get abortController() {
			abortReads++;
			return { signal: controller.signal, abort };
		},
	};
	const activeNarrators = new Map(options.active === false ? [] : [["source", active]]);
	const originalActive = { ...active };
	abortReads = 0;
	let rows = [row("before"), message, row("after")];
	let cleaned = false;
	const order: string[] = [];
	const copiedText: string[] = [];
	const getById = mock(async (id: string) => {
		expect(id).toBe("source");
		order.push("source-read");
		return sourceNarrator;
	});
	const create = mock(async (_input: Record<string, unknown>) => {
		order.push("create");
		if (options.createError) throw options.createError;
		return { id: "new-primary" };
	});
	let notifySendStarted!: () => void;
	const sendStarted = new Promise<void>((resolve) => {
		notifySendStarted = resolve;
	});
	const send = mock(async (...args: Parameters<Session["sendMessage"]>) => {
		expect(args[0]).toBe("new-primary");
		order.push("send-start");
		notifySendStarted();
		await options.sendGate;
		for (const file of args[7] ?? []) {
			expect(cleaned).toBe(false);
			copiedText.push(await file.text());
			order.push("text-copied");
		}
		if (options.sendError) throw options.sendError;
		order.push("send-end");
	});
	const resolveModel = mock(async (..._args: unknown[]) => ({ model: "provider:materialized" }));
	const executorBindings = {
		narratorService: { getById, create },
		FOLLOW_PARENT_MODEL,
		resolveSubagentModelForRun: resolveModel,
		normalizeBooleanOverride,
		normalizeDangerReflectionOverride,
		sendMessage: send,
	};
	const actual = new Function(
		...Object.keys(executorBindings),
		`${executorCode}\nreturn { executeQueuedNewCommand, parseQueuedNewCommand };`,
	)(...Object.values(executorBindings)) as {
		executeQueuedNewCommand: Executor;
		parseQueuedNewCommand: Parser;
	};
	const execute = mock(actual.executeQueuedNewCommand);
	const take = mock(
		async (id: string, mid: string, predicate: (item: BufferedMessage) => boolean) => {
			expect(id).toBe("source");
			order.push("take");
			const candidate = rows.find((item) => item.id === mid);
			if (!candidate || !predicate(candidate)) return undefined;
			rows = rows.filter((item) => item.id !== mid);
			return candidate;
		},
	);
	const cleanup = mock(async (id: string) => {
		expect(id).toBe(message._stagingId ?? message.id);
		order.push("cleanup");
		cleaned = true;
		await options.cleanup?.();
	});
	const broadcast = mock((_id: string, event: { type: string; [key: string]: unknown }) => {
		order.push(event.type);
	});
	const getUserLanguage = mock(async (_userId: string) => "zh-CN");
	const getUserReplyInLanguage = mock(async (_userId: string) => true);
	const readQueue = mock(async (_id: string) => rows);
	const summary = (items: BufferedMessage[]) => items.map(({ id }) => ({ id }));
	const prepareBindings = {
		...executorBindings,
		parseQueuedNewCommand: actual.parseQueuedNewCommand,
		executeQueuedNewCommand: execute,
		takeBufferedMessageForIndependentCommand: take,
		activeNarrators,
		getUserLanguage,
		i18n: { getUserReplyInLanguage },
		broadcastToNarrator: broadcast,
		getBufferedMessagesAsync: readQueue,
		toBufferSummary: summary,
		cleanupBufferedTextFilesAsync: cleanup,
	};
	const prepare = new Function(
		...Object.keys(prepareBindings),
		`${prepareCode}\nreturn prepareIndependentQueuedNewCommand;`,
	)(...Object.values(prepareBindings)) as Prepare;
	function assertSourceUntouched() {
		expect(sourceNarrator).toEqual(originalSource);
		expect(activeNarrators.get("source")).toBe(options.active === false ? undefined : active);
		expect(abortReads).toBe(0);
		const { abortController: _controller, ...snapshot } = originalActive;
		const { abortController: _ignored, ...current } = Object.getOwnPropertyDescriptors(active);
		for (const key of Object.keys(snapshot)) {
			expect(current[key]?.value).toEqual(snapshot[key as keyof typeof snapshot]);
		}
		expect(history).toEqual(originalHistory);
		expect(controller.signal.aborted).toBe(options.aborted ?? false);
		expect(abort).not.toHaveBeenCalled();
		expect(guidanceAbort).not.toHaveBeenCalled();
	}
	return {
		message,
		active,
		controller,
		execute,
		parse: actual.parseQueuedNewCommand,
		prepare: () => prepare("source", message.id),
		take,
		create,
		send,
		resolveModel,
		cleanup,
		broadcast,
		getById,
		getUserLanguage,
		getUserReplyInLanguage,
		readQueue,
		rows: () => rows,
		sendStarted,
		order,
		copiedText,
		assertSourceUntouched,
	};
}

async function dispatch(f: ReturnType<typeof fixture>) {
	const thunk = await f.prepare();
	expect(thunk).toBeFunction();
	if (!thunk) throw new Error("Expected independently prepared /new command");
	return thunk();
}

describe("independent queued /new parser and admission", () => {
	test("uses the real parser for whitespace, multiline arguments and commandText", () => {
		const f = fixture();
		expect(f.parse(" \n/new\t ")).toEqual({ rawCommand: "/new", initialMessage: "" });
		expect(f.parse("/new first\nsecond")).toEqual({
			rawCommand: "/new first\nsecond",
			initialMessage: "first\nsecond",
		});
		expect(f.parse("projected text", " /new original ")).toEqual({
			rawCommand: "/new original",
			initialMessage: "original",
		});
		for (const text of ["/newer task", "please /new task", "ordinary message", "/new-task"]) {
			expect(f.parse(text)).toBeNull();
		}
	});
	for (const [name, message] of [
		["literal user speech", { executionIntent: { literal: true } }],
		["ordinary text", { text: "ordinary text", commandText: null }],
		[
			"mixed composer quote",
			{
				commandText: "/new first task",
				composerDocument: document(
					{ type: "text", text: "/new first task" },
					{ type: "quote", id: "quote", label: "quoted", text: "context" },
				),
			},
		],
		[
			"mixed composer attachment",
			{
				composerDocument: document(
					{ type: "text", text: "/new first task" },
					{ type: "attachment", id: "attachment", assetId: "asset" },
				),
			},
		],
	] satisfies [string, Partial<BufferedMessage>][]) {
		test(`does not consume ${name} even when its text looks like /new`, async () => {
			const f = fixture({ message });
			expect(await f.prepare()).toBeUndefined();
			expect(f.take).toHaveBeenCalledTimes(1);
			expect(f.rows().map(({ id }) => id)).toEqual(["before", "command", "after"]);
			expect(f.getById).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
			expect(f.cleanup).not.toHaveBeenCalled();
			f.assertSourceUntouched();
		});
	}
	test("admission consumes only the target and returns a deferred thunk", async () => {
		const f = fixture();
		const thunk = await f.prepare();
		expect(thunk).toBeFunction();
		expect(f.rows().map(({ id }) => id)).toEqual(["before", "after"]);
		expect(f.order).toEqual(["take"]);
		expect(f.getById).not.toHaveBeenCalled();
		expect(f.create).not.toHaveBeenCalled();
		expect(f.cleanup).not.toHaveBeenCalled();
		expect(await f.prepare()).toBeUndefined();
		await thunk?.();
		expect(f.create).toHaveBeenCalledTimes(1);
		f.assertSourceUntouched();
	});
});

describe("independent queued /new execution", () => {
	test("bare /new only creates an independent primary with inherited settings and author ownership", async () => {
		const f = fixture({ message: { text: " /new " } });
		expect(await dispatch(f)).toBe("new-primary");
		expect(f.create).toHaveBeenCalledWith({
			model: "provider:old-model",
			systemPrompt: "source system prompt",
			permissionMode: "bypassPermissions",
			reasoningEffort: "high",
			fastModeOverride: "on",
			relaxedPlan: true,
			planReflectionAutoApproveOverride: "off",
			dangerReflectionOverride: "strict",
			questionReflectionOverride: "on",
			cwd: "/persisted-workspace",
			ownerUserId: "author",
		});
		expect(f.send).not.toHaveBeenCalled();
		expect(f.execute.mock.calls[0]?.[0]).toEqual({
			narratorId: "source",
			cwd: "/persisted-workspace",
			locale: "zh-CN",
			_replyInUserLanguage: true,
		});
		expect(f.broadcast.mock.calls).toEqual([
			[
				"source",
				{
					type: "buffer_consumed",
					narratorId: "source",
					messageId: "command",
					remaining: [{ id: "before" }, { id: "after" }],
				},
			],
			[
				"source",
				{
					type: "queued_new_narrator_created",
					narratorId: "source",
					messageId: "command",
					newNarratorId: "new-primary",
				},
			],
		]);
		expect(f.cleanup).toHaveBeenCalledTimes(1);
		expect(f.order.at(-1)).toBe("cleanup");
		f.assertSourceUntouched();
	});
	test("arguments become only the new recipient's first message, retaining all attachments", async () => {
		const images = [{ imageId: "image", filename: "image.png", mediaType: "image/png" }];
		const textFiles = [new File(["attached text"], "notes.txt")];
		const media = [{ mediaId: "audio", filename: "audio.wav", mediaType: "audio/wav", size: 4 }];
		const fileReferences: NonNullable<BufferedMessage["fileReferences"]> = [
			{
				type: "file_reference",
				reference: { id: "ref", deviceId: "local", path: "/file.ts", label: "file.ts" },
				snapshotText: "immutable snapshot",
				snapshotHash: "hash",
				capturedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const f = fixture({
			message: {
				text: "projected command",
				commandText: "/new first\nsecond",
				composerDocument: document(
					{ type: "text", text: "/new first" },
					{ type: "break" },
					{ type: "text", text: "second" },
				),
				images,
				textFiles,
				media,
				fileReferences,
			},
		});
		await dispatch(f);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.send).toHaveBeenCalledWith(
			"new-primary",
			"first\nsecond",
			images,
			"zh-CN",
			true,
			undefined,
			"author",
			textFiles,
			undefined,
			undefined,
			fileReferences,
			undefined,
			media,
		);
		expect(f.copiedText).toEqual(["attached text"]);
		expect(f.order.indexOf("send-end")).toBeLessThan(f.order.indexOf("buffer_consumed"));
		f.assertSourceUntouched();
	});
	for (const [attachment, argumentIndex, message] of [
		["images", 2, { images: [{ imageId: "image", filename: "i.png", mediaType: "image/png" }] }],
		["textFiles", 7, { textFiles: [new File(["attached text"], "notes.txt")] }],
		[
			"media",
			12,
			{ media: [{ mediaId: "audio", filename: "a.wav", mediaType: "audio/wav", size: 4 }] },
		],
		[
			"fileReferences",
			10,
			{
				fileReferences: [
					{
						type: "file_reference",
						reference: { id: "ref", deviceId: "local", path: "/file.ts", label: "file.ts" },
						snapshotText: "snapshot",
						snapshotHash: "hash",
						capturedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		],
	] satisfies [
		"images" | "textFiles" | "media" | "fileReferences",
		number,
		Partial<BufferedMessage>,
	][]) {
		test(`bare /new with ${attachment} preserves the attachment and cleans after delivery`, async () => {
			const f = fixture({ message: { text: "/new", ...message } });
			await dispatch(f);
			expect(f.send).toHaveBeenCalledTimes(1);
			expect(f.send.mock.calls[0]?.slice(0, 2)).toEqual(["new-primary", ""]);
			expect(f.send.mock.calls[0]?.[argumentIndex]).toBe(f.message[attachment]);
			expect(f.copiedText).toEqual(attachment === "textFiles" ? ["attached text"] : []);
			expect(f.cleanup).toHaveBeenCalledTimes(1);
			expect(f.order.indexOf("send-end")).toBeLessThan(f.order.indexOf("cleanup"));
			expect(f.order.at(-1)).toBe("cleanup");
			f.assertSourceUntouched();
		});
	}
	for (const active of [true, false]) {
		test(`creates successfully with ${active ? "an already aborted" : "no"} source runtime`, async () => {
			const f = fixture({ active, aborted: active });
			await dispatch(f);
			expect(f.send).toHaveBeenCalledTimes(1);
			f.assertSourceUntouched();
		});
	}
	test("FOLLOW_PARENT materializes the model without reading or passing the old abort controller", async () => {
		const f = fixture({ aborted: true, source: { model: FOLLOW_PARENT_MODEL } });
		const input = { narratorId: "source", cwd: "/runtime-workspace", locale: "en" as const };
		Object.defineProperty(input, "abortController", {
			get() {
				throw new Error("Old controller must not be read");
			},
		});
		await f.execute(input, f.message, "first task");
		expect(f.resolveModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "source", model: FOLLOW_PARENT_MODEL }),
			"author",
			undefined,
			{},
		);
		expect(f.create.mock.calls[0]?.[0].model).toBe("provider:materialized");
		expect(f.send.mock.calls[0]?.[0]).toBe("new-primary");
		f.assertSourceUntouched();
	});
	test("missing author falls back to source owner for ownership, language and reply preference", async () => {
		const f = fixture({ message: { createdBy: null } });
		await dispatch(f);
		expect(f.create.mock.calls[0]?.[0].ownerUserId).toBe("owner");
		expect(f.getUserLanguage).toHaveBeenCalledWith("owner");
		expect(f.getUserReplyInLanguage).toHaveBeenCalledWith("owner");
		f.assertSourceUntouched();
	});
	test("ownerless source uses active cwd/locale fallbacks without querying user preferences", async () => {
		const f = fixture({ message: { createdBy: null }, source: { cwd: null, ownerUserId: null } });
		await dispatch(f);
		expect(f.execute.mock.calls[0]?.[0]).toEqual({
			narratorId: "source",
			cwd: "/runtime-workspace",
			locale: "en",
			_replyInUserLanguage: false,
		});
		expect(f.getUserLanguage).not.toHaveBeenCalled();
		expect(f.getUserReplyInLanguage).not.toHaveBeenCalled();
		f.assertSourceUntouched();
	});
	test("cleanup waits until the new recipient has copied lazy on-disk text files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "independent-new-"));
		const path = join(directory, "notes.txt");
		let release!: () => void;
		const sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await Bun.write(path, "lazy file contents");
			const f = fixture({
				sendGate,
				cleanup: () => rm(directory, { recursive: true, force: true }),
				message: { _stagingId: "staged-command", textFiles: [Bun.file(path) as unknown as File] },
			});
			const thunk = await f.prepare();
			if (!thunk) throw new Error("Expected /new thunk");
			const pending = thunk();
			await f.sendStarted;
			expect(f.cleanup).not.toHaveBeenCalled();
			expect(await Bun.file(path).exists()).toBe(true);
			release();
			await pending;
			expect(f.copiedText).toEqual(["lazy file contents"]);
			expect(f.cleanup).toHaveBeenCalledWith("staged-command");
			expect(await Bun.file(path).exists()).toBe(false);
			expect(f.order.indexOf("text-copied")).toBeLessThan(f.order.indexOf("cleanup"));
			f.assertSourceUntouched();
		} finally {
			release();
			await rm(directory, { recursive: true, force: true });
		}
	});
	for (const stage of ["create", "send"] as const) {
		test(`${stage} failure cleans once without requeue, retry or duplicate creation`, async () => {
			const error = new Error(`${stage} failed`);
			const f = fixture({ [stage === "create" ? "createError" : "sendError"]: error });
			await expect(dispatch(f)).rejects.toBe(error);
			expect(f.create).toHaveBeenCalledTimes(1);
			expect(f.send).toHaveBeenCalledTimes(stage === "send" ? 1 : 0);
			expect(f.cleanup).toHaveBeenCalledTimes(1);
			expect(f.broadcast).not.toHaveBeenCalled();
			expect(f.rows().map(({ id }) => id)).toEqual(["before", "after"]);
			expect(await f.prepare()).toBeUndefined();
			expect(f.create).toHaveBeenCalledTimes(1);
			expect(f.cleanup).toHaveBeenCalledTimes(1);
			f.assertSourceUntouched();
		});
	}
});
