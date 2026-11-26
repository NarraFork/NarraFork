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
import { NotFoundError, ValidationError } from "../../lib/errors";
import { submissionFingerprint } from "../agent-runtime/user-submission";
import type { BufferedMessage } from "../narrator-session-state";

type Session = typeof import("../narrator-session");
type Executor = Session["executeQueuedNewCommand"];
type Prepare = Session["prepareIndependentQueuedNewCommand"];
type Parser = Session["parseQueuedNewCommand"];
type Admission = NonNullable<Parameters<Session["acceptUserMessage"]>[2]>;
type Attachments = Required<
	Pick<BufferedMessage, "images" | "textFiles" | "media" | "fileReferences">
>;

// Run production functions with local boundary injection, never global module mocks.
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
			"export async function prepareIndependentQueuedNewCommand(",
		),
	]
		.join("\n")
		.replace('import("./agent-runtime/user-submission")', "Promise.resolve(userSubmission)"),
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
	return { id, text, bufferedAt: "2026-01-01T00:00:00.000Z", queueMode: "tool", state: "queued" };
}
function attachments(): Attachments {
	return {
		images: [{ imageId: "image", filename: "image.png", mediaType: "image/png" }],
		textFiles: [new File(["attached text"], "notes.txt")],
		media: [{ mediaId: "audio", filename: "audio.wav", mediaType: "audio/wav", size: 4 }],
		fileReferences: [
			{
				type: "file_reference",
				reference: { id: "ref", deviceId: "local", path: "/file.ts", label: "file.ts" },
				snapshotText: "immutable snapshot",
				snapshotHash: "hash",
				capturedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
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
		gate?: Promise<void>;
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
		status: "running",
		history,
		guidanceAbort: { abort: guidanceAbort },
		get abortController() {
			abortReads++;
			return { signal: controller.signal, abort };
		},
	};
	const activeNarrators = new Map(options.active === false ? [] : [["source", active]]);
	const { abortController: _controller, ...originalActive } = active;
	abortReads = 0;
	let rows = [row("before"), message, row("after")];
	let cleaned = false;
	const order: string[] = [];
	const copiedText: string[] = [];
	const faults: {
		create?: "before" | "after";
		accept?: "before" | "after";
		send?: boolean;
		notification?: string;
		lookup?: Error;
	} = {};
	const failure = new Error("Injected independent dispatch failure");
	const targets = new Map<string, { id: string; type: string; ownerUserId: string | null }>();
	const receipts = new Map<string, NonNullable<Admission["submission"]>>();
	const getById = mock(async (id: string) => {
		order.push(`read:${id}`);
		if (id === "source") return sourceNarrator;
		if (faults.lookup) throw faults.lookup;
		const target = targets.get(id);
		if (!target) throw new NotFoundError("Narrator", id);
		return target;
	});
	const create = mock(async (input: Record<string, unknown>, settings?: { reservedId: string }) => {
		order.push("create");
		if (faults.create === "before") throw failure;
		const target = {
			id: settings?.reservedId ?? "new-primary",
			type: "primary",
			ownerUserId: input.ownerUserId as string | null,
		};
		targets.set(target.id, target);
		if (faults.create === "after") throw failure;
		return target;
	});
	const { promise: deliveryStarted, resolve: notifyDeliveryStarted } =
		Promise.withResolvers<void>();
	async function copyFiles(files?: File[]) {
		notifyDeliveryStarted();
		await options.gate;
		for (const file of files ?? []) {
			expect(cleaned).toBe(false);
			copiedText.push(await file.text());
			order.push("text-copied");
		}
	}
	const accept = mock(async (id: string, _text: string, input: Admission) => {
		expect(id).toBe("new-primary");
		order.push("accept-start");
		await copyFiles(input.textFiles);
		if (faults.accept === "before") throw failure;
		if (!input.submission) throw new Error("Independent admission needs a durable submission");
		const existing = receipts.get(input.submission.clientSubmissionId);
		if (existing) expect(input.submission).toEqual(existing);
		else receipts.set(input.submission.clientSubmissionId, input.submission);
		if (faults.accept === "after") throw failure;
		order.push("accept-end");
		return { delivered: true };
	});
	const send = mock(async (...args: Parameters<Session["sendMessage"]>) => {
		expect(args[0]).toBe("new-primary");
		await copyFiles(args[7]);
		if (faults.send) throw failure;
		order.push("send-end");
	});
	const resolveModel = mock(async (..._args: unknown[]) => ({ model: "provider:materialized" }));
	const executorBindings = {
		narratorService: { getById, create },
		FOLLOW_PARENT_MODEL,
		NotFoundError,
		ValidationError,
		resolveSubagentModelForRun: resolveModel,
		normalizeBooleanOverride,
		normalizeDangerReflectionOverride,
		userSubmission: { submissionFingerprint },
		sendMessage: send,
		acceptUserMessage: accept,
	};
	const actual = new Function(
		...Object.keys(executorBindings),
		`${executorCode}\nreturn { executeQueuedNewCommand, parseQueuedNewCommand };`,
	)(...Object.values(executorBindings)) as {
		executeQueuedNewCommand: Executor;
		parseQueuedNewCommand: Parser;
	};
	const execute = mock(actual.executeQueuedNewCommand);
	// The real buffer layer has separate persistence tests. This boundary models its
	// durable failed hold and success-only consumption, preserving the exact payload.
	const take = mock(
		async (
			id: string,
			mid: string,
			predicate: (item: BufferedMessage) => boolean,
			settings: { retry?: boolean } = {},
		) => {
			expect(id).toBe("source");
			order.push("take");
			const candidate = rows.find((item) => item.id === mid);
			if (!candidate || (candidate.state === "failed" && !settings.retry) || !predicate(candidate))
				return undefined;
			candidate.state = "failed";
			candidate._independentNewNarratorId ??= "new-primary";
			return { ...candidate };
		},
	);
	const cleanup = mock(async (id: string) => {
		expect(id).toBe(message._stagingId ?? message.id);
		order.push("cleanup");
		cleaned = true;
		await options.cleanup?.();
	});
	const run = mock(
		async (
			id: string,
			mid: string,
			target: string,
			callback: (item: BufferedMessage) => Promise<string>,
		) => {
			expect([id, mid, target]).toEqual(["source", "command", "new-primary"]);
			const candidate = rows.find((item) => item.id === mid);
			if (
				!candidate ||
				candidate.state !== "failed" ||
				candidate._independentNewNarratorId !== target
			)
				throw new Error("Invalid durable hold");
			try {
				const result = await callback({ ...candidate });
				expect(result).toBe(target);
				rows = rows.filter((item) => item.id !== mid);
				await cleanup(candidate._stagingId ?? candidate.id);
				return result;
			} catch (error) {
				candidate.error = String(error);
				throw error;
			}
		},
	);
	const broadcast = mock((_id: string, event: { type: string; [key: string]: unknown }) => {
		order.push(event.type);
		if (faults.notification === event.type) throw failure;
	});
	const getUserLanguage = mock(async (_userId: string) => "zh-CN");
	const getUserReplyInLanguage = mock(async (_userId: string) => true);
	const warn = mock((_message: string, _context: unknown) => {});
	const bindings = {
		...executorBindings,
		parseQueuedNewCommand: actual.parseQueuedNewCommand,
		executeQueuedNewCommand: execute,
		takeBufferedMessageForIndependentCommand: take,
		runIndependentBufferedCommand: run,
		activeNarrators,
		getUserLanguage,
		i18n: { getUserReplyInLanguage },
		broadcastToNarrator: broadcast,
		getBufferedMessagesAsync: async () => rows,
		toBufferSummary: (items: BufferedMessage[]) => items.map(({ id, state }) => ({ id, state })),
		logger: { warn },
	};
	const prepare = new Function(
		...Object.keys(bindings),
		`${prepareCode}\nreturn prepareIndependentQueuedNewCommand;`,
	)(...Object.values(bindings)) as Prepare;
	function assertSourceUntouched() {
		expect(sourceNarrator).toEqual(originalSource);
		expect(activeNarrators.get("source")).toBe(options.active === false ? undefined : active);
		expect(abortReads).toBe(0);
		const { abortController: _ignored, ...current } = Object.getOwnPropertyDescriptors(active);
		for (const key of Object.keys(originalActive))
			expect(current[key]?.value).toEqual(originalActive[key as keyof typeof originalActive]);
		expect(history).toEqual(originalHistory);
		expect(controller.signal.aborted).toBe(options.aborted ?? false);
		expect(abort).not.toHaveBeenCalled();
		expect(guidanceAbort).not.toHaveBeenCalled();
	}
	return {
		message,
		execute,
		parse: actual.parseQueuedNewCommand,
		prepare: (settings: { retry?: boolean } = {}) => prepare("source", message.id, settings),
		take,
		run,
		create,
		send,
		accept,
		resolveModel,
		cleanup,
		broadcast,
		getById,
		getUserLanguage,
		getUserReplyInLanguage,
		faults,
		failure,
		targets,
		receipts,
		warn,
		rows: () => rows,
		deliveryStarted,
		order,
		copiedText,
		assertSourceUntouched,
	};
}
async function dispatch(f: ReturnType<typeof fixture>, retry = false) {
	const thunk = await f.prepare(retry ? { retry: true } : {});
	if (!thunk) throw new Error("Expected independently prepared /new command");
	return thunk();
}
function expectHeld(f: ReturnType<typeof fixture>) {
	expect(f.rows().map(({ id }) => id)).toEqual(["before", "command", "after"]);
	expect(f.message).toMatchObject({ state: "failed", _independentNewNarratorId: "new-primary" });
	expect(f.cleanup).not.toHaveBeenCalled();
	f.assertSourceUntouched();
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
		for (const text of ["/newer task", "please /new task", "ordinary message", "/new-task"])
			expect(f.parse(text)).toBeNull();
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
		test(`does not hold ${name} even when its text looks like /new`, async () => {
			const f = fixture({ message });
			expect(await f.prepare()).toBeUndefined();
			expect(f.message.state).toBe("queued");
			expect(f.message._independentNewNarratorId).toBeUndefined();
			expect(f.rows().map(({ id }) => id)).toEqual(["before", "command", "after"]);
			expect(f.getById).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
			expect(f.cleanup).not.toHaveBeenCalled();
			f.assertSourceUntouched();
		});
	}
	test("admission durably holds only the target and defers execution outside admission", async () => {
		const f = fixture();
		const thunk = await f.prepare();
		expect(thunk).toBeFunction();
		expectHeld(f);
		expect(f.order).toEqual(["take"]);
		expect(f.getById).not.toHaveBeenCalled();
		expect(f.create).not.toHaveBeenCalled();
		expect(await f.prepare()).toBeUndefined();
		await thunk?.();
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.rows().map(({ id }) => id)).toEqual(["before", "after"]);
		f.assertSourceUntouched();
	});
});

describe("independent queued /new execution", () => {
	test("bare /new creates a primary with inherited settings and author ownership, but no first message", async () => {
		const f = fixture({ message: { text: " /new " } });
		expect(await dispatch(f)).toBe("new-primary");
		expect(f.create).toHaveBeenCalledWith(
			{
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
			},
			{ reservedId: "new-primary" },
		);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.accept).not.toHaveBeenCalled();
		expect(f.execute.mock.calls[0]?.[0]).toEqual({
			narratorId: "source",
			cwd: "/persisted-workspace",
			locale: "zh-CN",
			_replyInUserLanguage: true,
		});
		expect(f.broadcast.mock.calls.map(([, event]) => event)).toEqual([
			{
				type: "buffer_consumed",
				narratorId: "source",
				messageId: "command",
				remaining: [
					{ id: "before", state: "queued" },
					{ id: "after", state: "queued" },
				],
			},
			{
				type: "queued_new_narrator_created",
				narratorId: "source",
				messageId: "command",
				newNarratorId: "new-primary",
			},
		]);
		expect(f.cleanup).toHaveBeenCalledTimes(1);
		f.assertSourceUntouched();
	});
	test("arguments are a literal first admission on the new recipient with all attachments intact", async () => {
		const files = attachments();
		const f = fixture({
			message: {
				text: "projected command",
				commandText: "/new first\nsecond",
				composerDocument: document(
					{ type: "text", text: "/new first" },
					{ type: "break" },
					{ type: "text", text: "second" },
				),
				...files,
			},
		});
		await dispatch(f);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.accept).toHaveBeenCalledTimes(1);
		expect(f.accept).toHaveBeenCalledWith("new-primary", "first\nsecond", {
			...files,
			locale: "zh-CN",
			replyInUserLanguage: true,
			userId: "author",
			queueMode: "turn",
			executionIntent: { literal: true },
			submission: {
				clientSubmissionId: "queued-new-command",
				fingerprint: submissionFingerprint({
					source: "source",
					message: "command",
					target: "new-primary",
					initialMessage: "first\nsecond",
				}),
			},
		});
		expect(f.copiedText).toEqual(["attached text"]);
		expect(f.order.indexOf("accept-end")).toBeLessThan(f.order.indexOf("cleanup"));
		expect(f.order.indexOf("cleanup")).toBeLessThan(f.order.indexOf("buffer_consumed"));
		f.assertSourceUntouched();
	});
	for (const attachment of ["images", "textFiles", "media", "fileReferences"] as const) {
		test(`bare /new with only ${attachment} preserves it and cleans after acceptance`, async () => {
			const content = attachments()[attachment];
			const f = fixture({ message: { text: "/new", [attachment]: content } });
			await dispatch(f);
			expect(f.accept).toHaveBeenCalledTimes(1);
			expect(f.accept.mock.calls[0]?.slice(0, 2)).toEqual(["new-primary", ""]);
			expect(f.accept.mock.calls[0]?.[2][attachment]).toBe(content);
			expect(f.copiedText).toEqual(attachment === "textFiles" ? ["attached text"] : []);
			expect(f.cleanup).toHaveBeenCalledTimes(1);
			expect(f.order.indexOf("accept-end")).toBeLessThan(f.order.indexOf("cleanup"));
			f.assertSourceUntouched();
		});
	}
	test("nested /new arguments are never interpreted as a second control command", async () => {
		const f = fixture({ message: { text: "/new /new nested task" } });
		await dispatch(f);
		const accepted = f.accept.mock.calls[0];
		if (!accepted) throw new Error("Expected initial message acceptance");
		const [, prompt, input] = accepted;
		expect(prompt).toBe("/new nested task");
		expect(input.executionIntent).toEqual({ literal: true });
		expect(
			f.parse(prompt, input.commandText, input.composerDocument, input.executionIntent),
		).toBeNull();
		expect(f.create).toHaveBeenCalledTimes(1);
	});
	for (const active of [true, false]) {
		test(`succeeds with ${active ? "an already aborted" : "no"} source runtime`, async () => {
			const f = fixture({ active, aborted: active });
			await dispatch(f);
			expect(f.accept).toHaveBeenCalledTimes(1);
			f.assertSourceUntouched();
		});
	}
	test("FOLLOW_PARENT materializes without reading or passing the old abort controller", async () => {
		const f = fixture({ aborted: true, source: { model: FOLLOW_PARENT_MODEL } });
		const thunk = await f.prepare();
		if (!thunk) throw new Error("Expected thunk");
		await thunk();
		expect(f.resolveModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "source", model: FOLLOW_PARENT_MODEL }),
			"author",
			undefined,
			{},
		);
		expect(f.create.mock.calls[0]?.[0].model).toBe("provider:materialized");
		f.assertSourceUntouched();
	});
	test("legacy non-independent execution still sends only to the new id", async () => {
		const f = fixture({ aborted: true });
		const input = { narratorId: "source", cwd: "/runtime-workspace", locale: "en" as const };
		Object.defineProperty(input, "abortController", {
			get() {
				throw new Error("Old controller must not be read");
			},
		});
		await f.execute(input, f.message, "first task");
		expect(f.create.mock.calls[0]?.[1]).toBeUndefined();
		expect(f.send.mock.calls[0]?.slice(0, 2)).toEqual(["new-primary", "first task"]);
		expect(f.accept).not.toHaveBeenCalled();
		f.assertSourceUntouched();
	});
	test("missing author uses source owner for ownership, language, reply preference and acceptance", async () => {
		const f = fixture({ message: { createdBy: null } });
		await dispatch(f);
		expect(f.create.mock.calls[0]?.[0].ownerUserId).toBe("owner");
		expect(f.getUserLanguage).toHaveBeenCalledWith("owner");
		expect(f.getUserReplyInLanguage).toHaveBeenCalledWith("owner");
		expect(f.accept.mock.calls[0]?.[2].userId).toBe("owner");
		f.assertSourceUntouched();
	});
	test("ownerless bare /new uses runtime cwd and locale fallbacks without user preference reads", async () => {
		const f = fixture({
			message: { text: "/new", createdBy: null },
			source: { cwd: null, ownerUserId: null },
		});
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
	test("lazy staging files remain until the new recipient has copied them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "independent-new-"));
		const path = join(directory, "notes.txt");
		const gate = Promise.withResolvers<void>();
		try {
			await Bun.write(path, "lazy file contents");
			const f = fixture({
				gate: gate.promise,
				cleanup: () => rm(directory, { recursive: true, force: true }),
				message: { _stagingId: "staged-command", textFiles: [Bun.file(path) as unknown as File] },
			});
			const pending = dispatch(f);
			await f.deliveryStarted;
			expect(f.cleanup).not.toHaveBeenCalled();
			expect(await Bun.file(path).exists()).toBe(true);
			gate.resolve();
			await pending;
			expect(f.copiedText).toEqual(["lazy file contents"]);
			expect(f.cleanup).toHaveBeenCalledWith("staged-command");
			expect(await Bun.file(path).exists()).toBe(false);
			expect(f.order.indexOf("text-copied")).toBeLessThan(f.order.indexOf("cleanup"));
			f.assertSourceUntouched();
		} finally {
			gate.resolve();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("durable independent /new retries", () => {
	test("pre-create failure preserves payload and reserved id, then explicit retry creates that same id", async () => {
		const files = attachments();
		const f = fixture({ message: files });
		f.faults.create = "before";
		await expect(dispatch(f)).rejects.toBe(f.failure);
		expectHeld(f);
		for (const key of Object.keys(files) as (keyof Attachments)[])
			expect(f.message[key]).toBe(files[key]);
		expect(f.targets.size).toBe(0);
		expect(f.accept).not.toHaveBeenCalled();
		expect(f.broadcast).toHaveBeenCalledWith(
			"source",
			expect.objectContaining({ type: "buffer_set" }),
		);
		expect(await f.prepare()).toBeUndefined();
		f.faults.create = undefined;
		await dispatch(f, true);
		expect(f.take.mock.calls.at(-1)?.[3]).toEqual({ retry: true });
		expect(f.create.mock.calls.map(([, settings]) => settings)).toEqual([
			{ reservedId: "new-primary" },
			{ reservedId: "new-primary" },
		]);
		expect(f.targets.size).toBe(1);
		expect(f.accept).toHaveBeenCalledTimes(1);
		expect(f.cleanup).toHaveBeenCalledTimes(1);
		expect(f.rows().map(({ id }) => id)).toEqual(["before", "after"]);
		f.assertSourceUntouched();
	});
	test("a committed creation whose response fails is recovered by reserved id without another create", async () => {
		const f = fixture();
		f.faults.create = "after";
		expect(await dispatch(f)).toBe("new-primary");
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.targets.size).toBe(1);
		expect(f.accept).toHaveBeenCalledTimes(1);
		expect(f.cleanup).toHaveBeenCalledTimes(1);
		expect(await f.prepare({ retry: true })).toBeUndefined();
		f.assertSourceUntouched();
	});
	for (const stage of ["before", "after"] as const) {
		test(`acceptance error ${stage} receipt keeps attachments and retries with one target and stable submission`, async () => {
			const f = fixture({ source: { model: FOLLOW_PARENT_MODEL }, message: attachments() });
			f.faults.accept = stage;
			await expect(dispatch(f)).rejects.toBe(f.failure);
			expectHeld(f);
			expect(f.create).toHaveBeenCalledTimes(1);
			const submission = f.accept.mock.calls[0]?.[2].submission;
			expect(submission?.clientSubmissionId).toBe("queued-new-command");
			expect(submission?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
			f.faults.accept = undefined;
			f.resolveModel.mockImplementation(async () => {
				throw new Error("Source model unavailable after creation");
			});
			await dispatch(f, true);
			expect(f.accept).toHaveBeenCalledTimes(2);
			expect(f.accept.mock.calls[1]?.[2].submission).toEqual(submission);
			expect(f.resolveModel).toHaveBeenCalledTimes(1);
			expect(f.create).toHaveBeenCalledTimes(1);
			expect(f.targets.size).toBe(1);
			expect(f.receipts.size).toBe(1);
			expect(f.cleanup).toHaveBeenCalledTimes(1);
			f.assertSourceUntouched();
		});
	}
	test("target lookup errors other than NotFound never create a replacement or discard input", async () => {
		const f = fixture();
		f.faults.lookup = new Error("Database unavailable");
		await expect(dispatch(f)).rejects.toBe(f.faults.lookup);
		expect(f.create).not.toHaveBeenCalled();
		expectHeld(f);
	});
	for (const notification of ["buffer_consumed", "queued_new_narrator_created"]) {
		test(`${notification} notification failure does not replay successful acceptance`, async () => {
			const f = fixture();
			f.faults.notification = notification;
			expect(await dispatch(f)).toBe("new-primary");
			expect(f.warn).toHaveBeenCalledTimes(1);
			expect(f.cleanup).toHaveBeenCalledTimes(1);
			expect(await f.prepare({ retry: true })).toBeUndefined();
			expect(f.create).toHaveBeenCalledTimes(1);
			expect(f.accept).toHaveBeenCalledTimes(1);
			expect(f.rows().map(({ id }) => id)).toEqual(["before", "after"]);
			f.assertSourceUntouched();
		});
	}
	test("failure notification errors cannot mask dispatch failure or clean retained payload", async () => {
		const f = fixture();
		f.faults.create = "before";
		f.faults.notification = "buffer_set";
		await expect(dispatch(f)).rejects.toBe(f.failure);
		expectHeld(f);
		expect(f.warn).toHaveBeenCalledTimes(1);
	});
});
