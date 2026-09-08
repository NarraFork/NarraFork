import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FileReferenceSnapshot } from "@shared/file-reference";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema";
import {
	getFileReferenceSnapshots,
	projectFileReferencesForModel,
} from "../../lib/agent/file-reference-projection";
import type { DbMessage } from "../../lib/agent/provider";
import { settings } from "../../lib/settings";

if (process.env.NARRAFORK_FILE_REFERENCE_FIXTURE !== "messages") {
	test("isolated file reference message flow suite", () => {
		const env: NodeJS.ProcessEnv = { ...process.env, NARRAFORK_FILE_REFERENCE_FIXTURE: "messages" };
		delete env.NARRAFORK_HOME;
		const result = spawnSync(process.execPath, ["test", import.meta.path], {
			env,
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 512 * 1024,
		});
		if (result.error || result.status !== 0)
			throw new Error(`${result.error ?? "Fixture failed"}\n${result.stdout}\n${result.stderr}`);
		expect(result.status).toBe(0);
	}, 65_000);
} else {
	// A serialization fixture, not the application DB. Mock persistence writes the
	// exact text/blocks the REAL send/edit/queue services supply, then reads JSON back.
	const sqlite = new Database(":memory:");
	sqlite.exec("CREATE TABLE saved_messages (id TEXT PRIMARY KEY, row_json TEXT NOT NULL)");
	const fixtureDb = drizzle({ client: sqlite, schema });
	let idSeq = 0;
	let failPersist = false;
	let suppressLoop = false;
	let includeTrailingSys = false;
	let currentTarget = "";
	const frames: unknown[] = [];
	const state = await import("../narrator-session-state");

	function allMessages(): DbMessage[] {
		return (
			sqlite.query("SELECT row_json FROM saved_messages ORDER BY rowid").all() as Array<{
				row_json: string;
			}>
		).map((row) => JSON.parse(row.row_json));
	}
	function saveRow(row: DbMessage) {
		sqlite
			.query("INSERT OR REPLACE INTO saved_messages VALUES (?, ?)")
			.run(row.id, JSON.stringify(row));
		return JSON.parse(JSON.stringify(row));
	}
	function saveMessage(
		narratorId: string,
		text: string,
		blocks: unknown[],
		parentToolUseId: string | null = null,
	) {
		if (failPersist) throw new Error("fixture persistence failed");
		return saveRow({
			id: `message-${++idSeq}`,
			narratorId,
			role: "user",
			contentText: text,
			contentJson: blocks,
			parentToolUseId,
			messageUuid: null,
		});
	}

	mock.module("../../db", () => ({
		sqlite,
		db: new Proxy(fixtureDb, {
			get(target, key, receiver) {
				if (key === "query")
					return {
						...target.query,
						narrators: { findFirst: async () => ({ status: "idle", substatus: [] }) },
						narratorMessageRefs: {
							findFirst: async () => ({ narratorId: "n", messageId: currentTarget, seq: 1 }),
						},
						narratorMessages: {
							findFirst: async (options?: { columns?: { parentToolUseId?: boolean } }) =>
								options?.columns?.parentToolUseId
									? { parentToolUseId: "origin" }
									: allMessages().find((row) => row.id === currentTarget),
						},
					};
				const value = Reflect.get(target, key, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	}));
	mock.module("../../websocket/narrator-ws", () => ({
		broadcastToNarrator: (_id: string, frame: unknown) => frames.push(frame),
		broadcastToAll: () => {},
		broadcastToUser: () => {},
		broadcastToChatRoom: () => {},
		getNarratorConnections: () => new Set(),
		getNarratorPresence: () => [],
		getNarratorPresenceBatch: () => new Map(),
		getNarratorIdsWithPresence: () => new Set(),
		getChatRoomSubscriberUserIds: () => new Set(),
		dropNarratorSubscriptionsForUnauthorizedUsers: async () => {},
	}));
	mock.module("../subagent-knowledge-injection", () => ({
		getSubagentKnowledgeCycle: () => ({ ids: new Set(), seq: -1 }),
		clearSubagentKnowledgeCycle: () => {},
		resolveInjectionUserId: () => null,
		syncSubagentKnowledgeCycle: async () => {},
		scanSubagentTextForKnowledge: async () => null,
	}));
	const realNarratorServiceModule = { ...(await import("../narrator-service")) };
	mock.module("../narrator-service", () => ({
		...realNarratorServiceModule,
		handleBashCommand: async () => {},
		narratorService: {
			...realNarratorServiceModule.narratorService,
			getById: async (id: string) => ({
				id,
				variant: id.startsWith("resume-") ? "subagent:general" : "primary",
				parentNarratorId: "n",
				model: "refs:model",
				status: "idle",
				substatus: [],
				title: "Existing title",
				cwd: import.meta.dir,
				chapterId: null,
			}),
			persistUserMessage: async (id: string, text: string, blocks: unknown[]) =>
				saveMessage(id, text, blocks),
			persistSubagentUserMessage: async (
				id: string,
				text: string,
				toolUseId: string,
				options?: { fileReferences?: FileReferenceSnapshot[] },
			) =>
				saveMessage(
					id,
					text,
					[...(options?.fileReferences ?? []), { type: "text", text }],
					toolUseId,
				),
			getModelHistorySinceLastCompact: async () => {
				const history = allMessages();
				if (includeTrailingSys)
					history.push({
						id: "standing-sys",
						role: "sys",
						contentText: "standing reminder",
						contentJson: [{ type: "text", text: "standing reminder" }],
						parentToolUseId: null,
						messageUuid: null,
					});
				return history;
			},
			deleteMessagesAfter: async () => ({ deletedMessageIds: [] }),
			copyOnWriteMessage: async (_id: string, messageId: string, overrides: Partial<DbMessage>) => {
				const old = allMessages().find((message) => message.id === messageId);
				if (!old) throw new Error("missing fixture message");
				const id = `cow-${++idSeq}`;
				saveRow({ ...old, ...overrides, id });
				currentTarget = id;
				return id;
			},
			updateStatus: async (id: string, status: string) => {
				// We exercise send preparation/persistence, not network execution. Deliberately
				// claim the loop after commit so the ordinary concurrency guard declines it.
				const active = state.activeNarrators.get(id);
				if (suppressLoop && status === "working" && active) active._loopRunning = true;
			},
		},
	}));
	const session = await import("../narrator-session");
	const subagent = await import("../subagent-executor");
	const { toBufferSummary } = await import("../narrator-buffer");
	const resumedInputs: Array<import("../subagent-runner").ContinueSubagentInput> = [];
	const realRunner = { ...(await import("../subagent-runner")) };
	mock.module("../subagent-runner", () => ({
		...realRunner,
		startContinuedSubagent: async (input: import("../subagent-runner").ContinueSubagentInput) => {
			resumedInputs.push(input);
			const userMessage =
				input.persistPrompt !== false
					? saveMessage(
							input.subagentId,
							input.prompt ?? "",
							[...(input.fileReferences ?? []), { type: "text", text: input.prompt ?? "" }],
							input.toolUseId,
						)
					: undefined;
			return {
				userMessage,
				runId: "fixture-run",
				completion: Promise.resolve("done"),
				terminalCompletion: Promise.resolve("done"),
			};
		},
	}));
	const { resumeSubagent } = await import("../subagent-resume");

	function snapshot(): FileReferenceSnapshot {
		return {
			type: "file_reference",
			reference: {
				id: "r",
				path: "/file-deleted-after-acceptance.ts",
				deviceId: "remote-X",
				label: "file",
			},
			snapshotText: "the exact accepted bytes",
			snapshotHash: "hash-fixed",
			capturedAt: "2026-09-01T00:00:00Z",
		};
	}
	function expectMetadataOnlyFrames() {
		const json = JSON.stringify(frames);
		expect(json).toContain('"type":"file_reference"');
		expect(json).toContain('"label":"file"');
		expect(json).not.toContain('"snapshotText"');
		expect(json).not.toContain('"snapshotHash"');
		expect(json).not.toContain('"capturedAt"');
		expect(json).not.toContain(snapshot().snapshotText);
	}

	function activeNarrator() {
		const active = {
			narratorId: "n",
			alive: true,
			abortController: new AbortController(),
			events: new EventEmitter(),
			cwd: import.meta.dir,
			locale: "en",
			_substatus: new Set<string>(),
			_loopRunning: false,
		};
		state.activeNarrators.set("n", active as never);
		return active;
	}

	beforeEach(() => {
		sqlite.exec("DELETE FROM saved_messages");
		state.activeNarrators.clear();
		subagent.clearSubagentBufferedMessages("child");
		frames.length = 0;
		failPersist = false;
		suppressLoop = false;
		includeTrailingSys = false;
		currentTarget = "";
		resumedInputs.length = 0;
		settings.anthropicProviders = [
			{
				id: "refs",
				prefix: "refs",
				name: "fixture",
				apiKey: "fixture",
				baseUrl: "https://example.invalid",
				defaultModel: "model",
				officialApi: false,
			},
		];
	});
	afterAll(() => {
		state.activeNarrators.clear();
		subagent.clearSubagentBufferedMessages("child");
		sqlite.close();
	});

	describe("send/save/edit fixed file references", () => {
		test("pre-Bash user broadcast is metadata-only while the returned row stays complete", async () => {
			activeNarrator();
			suppressLoop = true;
			const saved = await session.sendMessage(
				"n",
				"",
				undefined,
				"en",
				false,
				null,
				null,
				undefined,
				"true",
				undefined,
				[snapshot()],
			);
			expectMetadataOnlyFrames();
			expect(getFileReferenceSnapshots(saved.contentJson)).toEqual([snapshot()]);
			expect(projectFileReferencesForModel([saved])[0].contentText).toContain(
				snapshot().snapshotText,
			);
		});

		test("startSession yields only reference metadata while retaining the saved snapshot", async () => {
			const active = activeNarrator();
			suppressLoop = true;
			const stream = session.startSession("n", "", undefined, "en", false, [snapshot()]);
			const first = await stream.next();
			expect(first.value).toMatchObject({ type: "user_message" });
			expect(JSON.stringify(first.value)).toContain('"type":"file_reference"');
			expect(JSON.stringify(first.value)).not.toContain('"snapshotText"');
			expect(JSON.stringify(first.value)).not.toContain(snapshot().snapshotText);
			expectMetadataOnlyFrames();
			expect(getFileReferenceSnapshots(allMessages()[0].contentJson)).toEqual([snapshot()]);
			active.events.emit("event", { type: "done", data: null });
			await stream.next();
			await stream.return(undefined);
		});

		test("normal and reference-only sends keep one snapshot in JSON, not in contentText", async () => {
			for (const text of ["please inspect", ""]) {
				activeNarrator();
				suppressLoop = true;
				const accepted = snapshot();
				const sending = session.sendMessage(
					"n",
					text,
					undefined,
					"en",
					false,
					null,
					null,
					undefined,
					null,
					undefined,
					[accepted],
				);
				accepted.snapshotText = "caller modified while admission awaited";
				const saved = await sending;
				expect(saved.contentText).toBe(text);
				expect(getFileReferenceSnapshots(saved.contentJson)).toEqual([snapshot()]);
				expectMetadataOnlyFrames();
				const recovered = session.resolvePoppedTrailingUserText([saved]);
				expect(recovered).toContain(snapshot().snapshotText);
			}
		});

		test("editing a fork retains bytes with omission and [] removes only the fork's copy", async () => {
			const initial = saveMessage("n", "original", [
				snapshot(),
				{ type: "text", text: "original" },
			]);
			currentTarget = initial.id;
			const edited = await session.editAndRegenerate("n", initial.id, "edited", "en", false, {
				deferContinuation: true,
				revertFiles: false,
			});
			expect(edited.ok).toBe(true);
			const copy = allMessages().find((row) => row.id === currentTarget);
			expect(copy?.contentText).toBe("edited");
			expect(getFileReferenceSnapshots(copy?.contentJson)).toEqual([snapshot()]);
			expectMetadataOnlyFrames();
			const clear = await session.editAndRegenerate("n", currentTarget, "plain", "en", false, {
				deferContinuation: true,
				revertFiles: false,
				fileReferences: [],
			});
			expect(clear.ok).toBe(true);
			expect(getFileReferenceSnapshots(allMessages().at(-1)?.contentJson)).toEqual([]);
			expect(getFileReferenceSnapshots(allMessages()[0].contentJson)).toEqual([snapshot()]);
		});

		test("selected replacement accepts a reference-only edit without reading its source", async () => {
			const initial = saveMessage("n", "old", [{ type: "text", text: "old" }]);
			currentTarget = initial.id;
			await session.editAndRegenerate("n", initial.id, "", "en", false, {
				deferContinuation: true,
				revertFiles: false,
				fileReferences: [snapshot()],
			});
			const saved = allMessages().at(-1);
			expect(saved?.contentText).toBe("");
			expect(getFileReferenceSnapshots(saved?.contentJson)).toEqual([snapshot()]);
			expect(projectFileReferencesForModel([saved as DbMessage])[0].contentText).toContain(
				snapshot().snapshotText,
			);
		});
	});

	describe("subagent continuation and retry", () => {
		test("official retry before trailing sys carries the saved material only in current input", async () => {
			includeTrailingSys = true;
			settings.anthropicProviders = (settings.anthropicProviders ?? []).map((provider) => ({
				...provider,
				officialApi: true,
			}));
			saveMessage("resume-official", "", [snapshot()], "origin");
			const result = await resumeSubagent({
				subagentId: "resume-official",
				intent: "retry_last_input",
				actor: "user",
				locale: "en",
				skipConclusionDelivery: true,
				retryRevertFiles: false,
			});
			await result.terminalCompletion;
			const current = resumedInputs[0];
			expect(JSON.stringify(current.initialHistory)).not.toContain(snapshot().snapshotText);
			expect(current.prompt).toContain(snapshot().snapshotText);
			expect(current.initialHistory).toContainEqual({
				role: "system",
				content: "standing reminder",
			});
			expect(getFileReferenceSnapshots(allMessages()[0].contentJson)).toEqual([snapshot()]);
		});

		test("a reference-only retry uses accepted bytes from the saved message", async () => {
			saveMessage("resume-child", "", [snapshot()], "origin");
			const result = await resumeSubagent({
				subagentId: "resume-child",
				intent: "retry_last_input",
				actor: "user",
				locale: "en",
				skipConclusionDelivery: true,
				retryRevertFiles: false,
			});
			await result.terminalCompletion;
			expect(resumedInputs[0].persistPrompt).toBe(false);
			expect(resumedInputs[0].prompt).toContain(snapshot().snapshotText);
			expect(allMessages()).toHaveLength(1);
		});

		test("a reference-only follow-up passes snapshots to continuation without pre-projecting stored text", async () => {
			const refs = [snapshot()];
			const resuming = resumeSubagent({
				subagentId: "resume-followup",
				intent: "follow_up",
				actor: "user",
				locale: "en",
				skipConclusionDelivery: true,
				prompt: "",
				fileReferences: refs,
			});
			refs[0].snapshotText = "caller changed while resume waited";
			const result = await resuming;
			await result.terminalCompletion;
			expect(resumedInputs[0].prompt).toBe("");
			expect(resumedInputs[0].fileReferences).toEqual([snapshot()]);
			expect(getFileReferenceSnapshots(result.userMessage?.contentJson)).toEqual([snapshot()]);
			expectMetadataOnlyFrames();
		});
	});

	describe("subagent's existing queue", () => {
		test("official queue consumption before sys includes accepted bytes exactly once", async () => {
			includeTrailingSys = true;
			settings.anthropicProviders = (settings.anthropicProviders ?? []).map((provider) => ({
				...provider,
				officialApi: true,
			}));
			subagent.pushSubagentBufferedMessage("child", "inspect", { fileReferences: [snapshot()] });
			const consumed = await subagent.consumeNextBufferedSubagentMessage({
				narratorId: "child",
				parentNarratorId: "n",
				toolUseId: "origin",
				model: "model",
				provider: "refs",
				cwd: import.meta.dir,
			});
			expect(JSON.stringify(consumed?.history)).not.toContain(snapshot().snapshotText);
			expect(consumed?.prompt.split(snapshot().snapshotText)).toHaveLength(2);
			expect(consumed?.history).toContainEqual({ role: "system", content: "standing reminder" });
			expect(getFileReferenceSnapshots(allMessages()[0].contentJson)).toEqual([snapshot()]);
		});

		test("concurrent drains cannot dispatch one accepted snapshot twice", async () => {
			subagent.pushSubagentBufferedMessage("child", "", { fileReferences: [snapshot()] });
			const options = {
				narratorId: "child",
				parentNarratorId: "n",
				toolUseId: "origin",
				model: "model",
				provider: "refs",
				cwd: import.meta.dir,
			};
			const consumed = await Promise.all([
				subagent.consumeNextBufferedSubagentMessage(options),
				subagent.consumeNextBufferedSubagentMessage(options),
			]);
			expect(consumed.filter(Boolean)).toHaveLength(1);
			expect(allMessages()).toHaveLength(1);
		});

		test("priority edits retain immutable snapshots and consume projects them once", async () => {
			const input = snapshot();
			const pushed = subagent.bufferSubagentUserMessage("child", "inspect", {
				priority: true,
				fileReferences: [input],
			});
			input.reference.path = "/changed";
			input.snapshotText = "changed";
			subagent.updateSubagentBufferedMessage("child", pushed.id, "edited text");
			const before = subagent.getSubagentBufferedMessages("child");
			expect(before[0].fileReferences).toEqual([snapshot()]);
			expect(toBufferSummary(before)[0].fileReferences).toEqual([snapshot().reference]);
			expect(subagent.canDeliverBufferedMessageInPass(before[0], null)).toBe(false);
			const consumed = await subagent.consumeNextBufferedSubagentMessage({
				narratorId: "child",
				parentNarratorId: "n",
				toolUseId: "origin",
				model: "model",
				provider: "refs",
				cwd: import.meta.dir,
			});
			expect(consumed?.prompt.split(snapshot().snapshotText).length).toBe(2);
			expect(allMessages()[0].contentText).toBe("edited text");
			expect(getFileReferenceSnapshots(allMessages()[0].contentJson)).toEqual([snapshot()]);
			expectMetadataOnlyFrames();
			expect(subagent.getSubagentBufferedMessages("child")).toEqual([]);
		});

		test("failed consume keeps accepted snapshots queued for the retry", async () => {
			subagent.pushSubagentBufferedMessage("child", "", { fileReferences: [snapshot()] });
			failPersist = true;
			const options = {
				narratorId: "child",
				parentNarratorId: "n",
				toolUseId: "origin",
				model: "model",
				provider: "refs",
				cwd: import.meta.dir,
			};
			await expect(subagent.consumeNextBufferedSubagentMessage(options)).rejects.toThrow(
				"fixture persistence failed",
			);
			expect(subagent.getSubagentBufferedMessages("child")[0].fileReferences).toEqual([snapshot()]);
			failPersist = false;
			expect((await subagent.consumeNextBufferedSubagentMessage(options))?.prompt).toContain(
				snapshot().snapshotText,
			);
		});
	});
}
