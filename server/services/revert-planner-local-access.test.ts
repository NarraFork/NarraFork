import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRevertAction,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { eq, inArray } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db, sqlite } from "../db";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { structSedTool } from "../lib/agent/tools/struct-sed";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { createToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import { createRevertPlanSchema, revertPlanFilesQuerySchema } from "../lib/validators/narrators";
import * as narratorWs from "../websocket/narrator-ws";
import { fileChangeIdentityKey } from "./file-change-identity";
import { fileChangeLocalIo } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import * as narratorState from "./narrator-session-state";
import type { RevertPlanFileMetadata, RevertPlanSummary } from "./revert-plan-service";
import { RevertPlannerLocalAccess } from "./revert-planner-local-access";
import type { RevertSelectionResult } from "./revert-selection-service";
import {
	type RevertTransactionExecution,
	RevertTransactionService,
} from "./revert-transaction-service";

// No mock auth/app/collector/reversal and no alternate runtime. Only explicit fault
// injection uses spies, restored immediately; every row/path belongs to test preload.
let workspace: string;
let narratorId: string;
let projectId: string;
let userId: string;
let otherId: string;
let token: string;
let otherToken: string;
let runtime: LocalFileChangeRuntime;
let sequence: number;
const restorers: (() => void | Promise<void>)[] = [];
const now = () => new Date().toISOString();
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(getNarraforkHome()).toBe(testEnvironment.narraforkHome);
	workspace = await mkdtemp(join(testEnvironment.isolatedHome, "revert-http-"));
	userId = generateId();
	otherId = generateId();
	narratorId = generateId();
	projectId = generateId();
	sequence = 0;
	for (const id of [userId, otherId])
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "test", role: "user", createdAt: now() })
			.run();
	db.insert(schema.projects)
		.values({
			id: projectId,
			name: "preview fixture",
			ownerUserId: userId,
			gitPath: workspace,
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	db.insert(schema.narrators)
		.values({
			id: narratorId,
			title: "preview fixture",
			cwd: workspace,
			ownerUserId: userId,
			contextProjectId: projectId,
			messageVersion: 7,
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	token = await createToken(userId, "user");
	otherToken = await createToken(otherId, "user");
	settings.chapters.treeSnapshotsEnabled = false;
	runtime = await getDefaultLocalFileChangeRuntime();
});
afterEach(async () => {
	for (const restore of restorers.splice(0).reverse()) await restore();
	// Preserve every journal/plan pin in the disposable test DB. Never reset the
	// default runtime, coordinator state, unknown records or production directory.
	await rm(workspace, { recursive: true, force: true });
});
function request(extra: Record<string, unknown> = {}) {
	return {
		idempotencyKey: "http-preview",
		expectedMessageVersion: 7,
		kind: "revert",
		revertScope: "narrator",
		selector: { kind: "all" },
		...extra,
	};
}
async function http(
	endpoint: string,
	method = "GET",
	body?: unknown,
	bearer = token,
	signal?: AbortSignal,
) {
	return app.request(`http://localhost/api/narrators/${narratorId}/${endpoint}`, {
		method,
		headers: {
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
	});
}
async function prepare(extra: Record<string, unknown> = {}, bearer = token) {
	return http("revert-plans", "POST", request(extra), bearer);
}
async function prepared(extra: Record<string, unknown> = {}) {
	const response = await prepare(extra);
	const body = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(body.executable).toBe(false);
	expect(body.plan.status).toBe("prepared");
	expect(body.plan.coverageComplete).toBe(true);
	return body.plan as RevertPlanSummary;
}
function message(role: "user" | "assistant", blocks: unknown[]) {
	const messageId = generateId();
	db.insert(schema.narratorMessages)
		.values({ id: messageId, narratorId, role, contentJson: blocks, createdAt: now() })
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: ++sequence })
		.run();
	return messageId;
}
function messageRow(messageId: string) {
	return db
		.select()
		.from(schema.narratorMessages)
		.where(eq(schema.narratorMessages.id, messageId))
		.get();
}
function messageRefs() {
	return db
		.select()
		.from(schema.narratorMessageRefs)
		.where(eq(schema.narratorMessageRefs.narratorId, narratorId))
		.orderBy(schema.narratorMessageRefs.seq)
		.limit(100)
		.all();
}
function messageVersion() {
	return db
		.select({ version: schema.narrators.messageVersion })
		.from(schema.narrators)
		.where(eq(schema.narrators.id, narratorId))
		.get()?.version;
}
async function toolContext(
	name: "Write" | "Edit" | "StructSed",
	path: string,
	input: Record<string, unknown>,
	existingMessageId?: string,
) {
	const targetPath = await localBackend.resolvePathIdentity(path);
	const target: ToolExecutionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd: workspace,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: targetPath.lexicalPath,
		canonicalPath: targetPath.canonicalPath,
		runtimeGeneration: localBackend.runtimeGeneration,
		selectionSource: "local_default",
	};
	const toolCallId = generateId();
	const toolUseId = generateId();
	const block = { type: "tool_use", id: toolUseId, name, input };
	const messageId = existingMessageId ?? message("assistant", [{ type: "text", text: "keep" }]);
	const previous = messageRow(messageId)?.contentJson;
	if (!Array.isArray(previous)) throw new Error("Missing tool message blocks");
	const blockIndex = previous.length;
	db.update(schema.narratorMessages)
		.set({ contentJson: [...previous, block] })
		.where(eq(schema.narratorMessages.id, messageId))
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: name,
			inputJson: input,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now(),
			executionDeviceId: "local",
			executionCwd: workspace,
			executionPathFlavor: target.pathFlavor,
			resolvedFilePath: target.lexicalPath,
			canonicalFilePath: target.canonicalPath,
			runtimeGeneration: target.runtimeGeneration,
			createdAt: now(),
		})
		.run();
	const ctx: ToolContext = {
		narratorId,
		userId,
		cwd: workspace,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: toolUseId,
		toolCallBinding: { toolCallId, attempt: 1 },
		executionTarget: target,
		requestPermission: async () => ({ behavior: "allow" }),
	};
	return { ctx, toolCallId, toolUseId, messageId, blockIndex };
}
async function write(path: string, content: string, messageId?: string) {
	const input = { file_path: path, content };
	const call = await toolContext("Write", path, input, messageId);
	const result = await writeTool.execute(input, call.ctx);
	expect(result.isError, String(result.output)).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success" })
		.where(eq(schema.narratorToolCalls.id, call.toolCallId))
		.run();
	return call;
}
async function edit(path: string, old_string: string, new_string: string, messageId?: string) {
	const input = { file_path: path, old_string, new_string };
	const call = await toolContext("Edit", path, input, messageId);
	const result = await editTool.execute(input, call.ctx);
	expect(result.isError, String(result.output)).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success" })
		.where(eq(schema.narratorToolCalls.id, call.toolCallId))
		.run();
	return call;
}
async function human(path: string, content: string) {
	const original = await readFile(path, "utf8");
	const response = await app.request("http://localhost/api/fs/write", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ narratorId, path, content, baseHash: hash(original) }),
	});
	const body = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(200);
	expect(body.fileChangeEvidence.grade).toBe("measured");
}
async function fixture() {
	const path = join(workspace, "file.txt");
	await writeFile(path, "old\n");
	const call = await write(path, "new\n");
	return { path, call };
}
function history() {
	return JSON.stringify({
		refs: db
			.select()
			.from(schema.narratorMessageRefs)
			.where(eq(schema.narratorMessageRefs.narratorId, narratorId))
			.limit(100)
			.all(),
		messages: db
			.select()
			.from(schema.narratorMessages)
			.where(eq(schema.narratorMessages.narratorId, narratorId))
			.limit(100)
			.all(),
		tools: db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.narratorId, narratorId))
			.limit(100)
			.all(),
	});
}
function ownPlans() {
	return db
		.select()
		.from(schema.revertOperations)
		.where(eq(schema.revertOperations.narratorId, narratorId))
		.limit(100)
		.all();
}
function scope() {
	const row = db
		.select()
		.from(schema.fileChangeScopes)
		.where(eq(schema.fileChangeScopes.canonicalRoot, workspace))
		.get();
	if (!row) throw new Error("Missing actual scope");
	return row;
}
function effects() {
	const operations = db
		.select({ id: schema.fileChangeOperations.id })
		.from(schema.fileChangeOperations)
		.where(eq(schema.fileChangeOperations.narratorId, narratorId))
		.limit(100)
		.all();
	return operations.length
		? db
				.select()
				.from(schema.fileChangeEffects)
				.where(
					inArray(
						schema.fileChangeEffects.operationId,
						operations.map((op) => op.id),
					),
				)
				.limit(100)
				.all()
		: [];
}
async function bytes(state: FileChangeState) {
	if (state.kind !== "regular") throw new Error("Expected regular plan state");
	return Buffer.from(await (await runtime.verifyNamespace()).store.readBytes(state.blob));
}
async function refused(response: Response, code?: string) {
	const value = await response.json();
	expect(response.status, JSON.stringify(value)).toBeGreaterThanOrEqual(400);
	if (code) expect(value.code).toBe(code);
	expect(
		ownPlans().filter((plan) => plan.status === "prepared" || plan.coverageComplete),
	).toHaveLength(0);
	return value;
}

type RevertAction = FileChangeRevertAction;
function actionRequest(
	action: RevertAction,
	messageId = "__all__",
	extra: Record<string, unknown> = {},
) {
	return { action, messageId, idempotencyKey: "http-action-preview", ...extra };
}
function actionPreview(
	action: RevertAction,
	messageId = "__all__",
	extra: Record<string, unknown> = {},
	bearer = token,
) {
	return http("revert-action-preview", "POST", actionRequest(action, messageId, extra), bearer);
}
async function boundedJson(response: Response, status = 200) {
	const raw = await response.text();
	expect(response.status, raw).toBe(status);
	expect(Buffer.byteLength(raw)).toBeLessThan(FILE_CHANGE_LIMITS.summaryBytes);
	expect(response.headers.get("content-type")).toContain("application/json");
	return JSON.parse(raw);
}
async function actionPrepared(
	action: RevertAction,
	messageId = "__all__",
	extra: Record<string, unknown> = {},
	expectedHistory?: { deletedMessageCount: number; deletedBlockCount: number },
) {
	const response = await actionPreview(action, messageId, extra);
	const body = await boundedJson(response);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(body.action).toBe(action);
	expect(body.executable).toBe(false);
	expect(body.plan, JSON.stringify(body)).toMatchObject({
		status: "prepared",
		coverageComplete: true,
		expectedMessageVersion: messageVersion(),
	});
	expect(body.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
	expect(body.historySummary).toEqual({
		deletedMessageCount: expect.any(Number),
		deletedBlockCount: expect.any(Number),
	});
	if (expectedHistory) expect(body.historySummary).toEqual(expectedHistory);
	expect(body).not.toHaveProperty("unavailable");
	const plan = body.plan as RevertPlanSummary;
	const selector = await originalManifest(plan.manifestDigests.selector);
	const manifest = await originalManifest(plan.manifestDigests.plan);
	expect(selector.request.uiAction).toBe(action);
	expect(manifest.header.selector.digest).toBe(plan.manifestDigests.selector);
	expect(manifest.header.requestDigest).toBe(
		hash(
			JSON.stringify({
				version: 1,
				owner: selector.owner,
				request: selector.request,
			}),
		),
	);
	if (action !== "revert_files") {
		const selected = (await originalManifest(
			plan.manifestDigests.history,
		)) as RevertSelectionResult;
		expect(body.historySummary).toEqual({
			deletedMessageCount: selected.history.messages.filter(
				(item) => item.action === "delete" || item.action === "unlink",
			).length,
			// Whole-message removals are counted above; this second count describes
			// only blocks removed from retained/replaced messages, without double counting.
			deletedBlockCount: selected.history.messages
				.filter((item) => item.action === "rewrite" || item.action === "copy_on_write")
				.reduce((total, item) => total + item.removedBlockCount, 0),
		});
	}
	return plan;
}
async function actionUnavailable(response: Response, action: RevertAction) {
	const body = await boundedJson(response);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(body).toEqual({
		action,
		plan: null,
		executable: false,
		unavailable: expect.any(String),
		historySummary: null,
	});
	expect(body.unavailable.length).toBeGreaterThan(0);
	expect(ownPlans().filter((plan) => plan.status === "prepared")).toHaveLength(0);
	return body;
}
function apply(
	plan: RevertPlanSummary,
	action: RevertAction,
	extra = {},
	bearer = token,
	signal?: AbortSignal,
) {
	return http(
		`revert-plans/${plan.id}/apply`,
		"POST",
		{ planHash: plan.planHash, action, ...extra },
		bearer,
		signal,
	);
}
async function committed(plan: RevertPlanSummary, action: RevertAction) {
	const response = await apply(plan, action);
	const body = await boundedJson(response);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(body).toEqual({
		planId: plan.id,
		status: "committed",
		journalStatus: "committed",
		settling: false,
		reason: null,
	});
	expect(ownPlans().find((row) => row.id === plan.id)?.status).toBe("committed");
	return body;
}
function journalFiles(plan: RevertPlanSummary) {
	return db
		.select()
		.from(schema.revertOperationFiles)
		.where(eq(schema.revertOperationFiles.revertOperationId, plan.id))
		.orderBy(schema.revertOperationFiles.sequence)
		.limit(100)
		.all();
}
async function originalManifest(digest: string | null) {
	if (!digest) throw new Error("Missing actual manifest digest");
	const blob = db
		.select({ sizeBytes: schema.fileChangeBlobs.sizeBytes })
		.from(schema.fileChangeBlobs)
		.where(eq(schema.fileChangeBlobs.digest, digest))
		.get();
	if (!blob) throw new Error("Missing original published manifest");
	const raw = await (await runtime.verifyNamespace()).store.readBytes({
		algorithm: "sha256",
		digest,
		sizeBytes: blob.sizeBytes,
	});
	return JSON.parse(Buffer.from(raw).toString());
}
function historyRefreshes() {
	type Broadcast = Extract<NarraForkEvent, { type: "narrator:ws_broadcast" }>;
	const events: { message: Broadcast["message"]; committed: boolean }[] = [];
	const listener = (event: NarraForkEvent) => {
		if (
			(event.type === "narrator:ws_broadcast" || event.type === "narrator:message_broadcast") &&
			event.narratorId === narratorId &&
			(event.message.type === "message_updated" ||
				event.message.type === "messages_deleted" ||
				event.message.type === "full_reload")
		)
			events.push({
				message: event.message,
				committed: ownPlans().some((plan) => plan.status === "committed"),
			});
	};
	eventBus.onAny(listener);
	restorers.push(() => eventBus.offAny(listener));
	return events;
}
function startLiveWorkAfterPreview() {
	const id = narratorId;
	expect(narratorState.activeNarrators.has(id)).toBe(false);
	const active: narratorState.ActiveNarrator = {
		narratorId: id,
		conversationId: generateId(),
		cwd: workspace,
		model: "isolated:live-admission",
		provider: "test",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		_loopRunning: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
	const release = narratorState.claimNarratorRuntime(id, `http-test-live-${generateId()}`);
	narratorState.activeNarrators.set(id, active);
	const finish = () => {
		active.alive = false;
		active._loopRunning = false;
		release();
		if (narratorState.activeNarrators.get(id) === active) narratorState.activeNarrators.delete(id);
	};
	// If admission wrongly interrupts this later work, let its real busy check
	// settle immediately so the test fails on the abort, rather than on a timeout.
	active.abortController.signal.addEventListener("abort", finish, { once: true });
	restorers.push(finish);
	return active;
}
function unjournaledTool(path: string, toolName: "Bash" | "Write", deviceId = "local") {
	const toolCallId = generateId();
	const toolUseId = generateId();
	const input =
		toolName === "Bash"
			? { command: "unrecorded historical command", cwd: workspace }
			: { file_path: path, content: "unverified historical write" };
	const messageId = message("assistant", [
		{ type: "text", text: "unverified execution history" },
		{ type: "tool_use", id: toolUseId, name: toolName, input },
	]);
	// Historical metadata is intentionally NOT authority: no v2 operation/effect,
	// receipt, blob or guessed before/after bytes are manufactured for these rows.
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName,
			inputJson: input,
			status: "success",
			executionDeviceId: deviceId,
			executionIdentityVersion: deviceId === "local" ? 0 : 1,
			executionAttempt: 1,
			executionPathFlavor: localBackend.pathFlavor,
			resolvedFilePath: path,
			canonicalFilePath: path,
			createdAt: now(),
		})
		.run();
	return { messageId, toolCallId, toolUseId, blockIndex: 1 };
}
function failCommit(plan: RevertPlanSummary, receipt = false) {
	const trigger = `action_fail_${generateId().replaceAll("-", "_")}`;
	if (receipt)
		sqlite.exec(
			`CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE OF observed_after_state_json ON revert_operation_files WHEN NEW.revert_operation_id='${plan.id}' AND NEW.observed_after_state_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'HTTP receipt persistence failure'); END`,
		);
	else
		sqlite.exec(
			`CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE OF status ON revert_operations WHEN NEW.id='${plan.id}' AND NEW.status='committed' BEGIN SELECT RAISE(ABORT,'HTTP history commit failure'); END`,
		);
	restorers.push(() => {
		sqlite.exec(`DROP TRIGGER ${trigger}`);
	});
}

describe("action-bound HTTP preview and real local execution", () => {
	test.each([
		"Write",
		"Edit",
		"StructSed",
	] as const)("namespace reset: triggering %s and later edits retain real rollback", async (tool) => {
		const { path, call: oldCall } = await fixture();
		const oldPlan = await actionPrepared("revert_files", oldCall.messageId);
		const oldNamespace = await runtime.verifyNamespace();
		const blobs = join(getNarraforkHome(), "file-change-blobs");
		await rm(blobs, { recursive: true, force: true });
		// The triggering mutation, not a sacrificial request, must acquire fresh evidence.
		let current: { messageId: string };
		if (tool === "Write") current = await write(path, "after-reset\n");
		else if (tool === "Edit") current = await edit(path, "new", "after-reset");
		else {
			const input = {
				file_path: path,
				command: "replace",
				address: "1",
				content: "after-reset",
				dry_run: false,
			};
			const call = await toolContext("StructSed", path, input);
			const result = await structSedTool.execute(input, call.ctx);
			expect(result.isError, String(result.output)).not.toBe(true);
			expect(result.metadata?.fileChangeEvidence).toBeDefined();
			db.update(schema.narratorToolCalls)
				.set({ status: "success" })
				.where(eq(schema.narratorToolCalls.id, call.toolCallId))
				.run();
			current = call;
		}
		const recovered = await runtime.verifyNamespace();
		expect(recovered.sourceInstanceId).toBe(oldNamespace.sourceInstanceId);
		expect(recovered.generation).toBeGreaterThan(oldNamespace.generation);
		const rejected = await prepare({ idempotencyKey: "old-evidence" });
		expect(rejected.status).toBe(409);
		expect(
			db
				.select()
				.from(schema.revertOperations)
				.where(eq(schema.revertOperations.id, oldPlan.id))
				.get()?.status,
		).toBe("expired");
		const plan = await actionPrepared("revert_files", current.messageId, {
			idempotencyKey: "reset-current",
		});
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe("new\n");
		const later = await edit(path, "new", "later");
		const laterPlan = await actionPrepared("revert_files", later.messageId, {
			idempotencyKey: "reset-later",
		});
		await committed(laterPlan, "revert_files");
		expect(await readFile(path, "utf8")).toBe("new\n");
	});

	test("real Write/Edit action preview -> apply restores bytes without deleting file-only history", async () => {
		const path = join(workspace, "exact.txt");
		const created = join(workspace, "created.txt");
		const original = Buffer.from("原始内容\r\nkeep\r\n", "utf8");
		await writeFile(path, original);
		await write(path, "changed\r\nkeep\r\n");
		await edit(path, "changed", "edited");
		await write(created, "tool-created\n");
		const before = history();
		const version = messageVersion();
		const events = historyRefreshes();
		const plan = await actionPrepared(
			"revert_files",
			"__all__",
			{},
			{
				deletedMessageCount: 0,
				deletedBlockCount: 0,
			},
		);
		expect(plan.expectedFileCount).toBe(2);
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("edited\r\nkeep\r\n");
		expect(await readFile(created, "utf8")).toBe("tool-created\n");
		expect(events).toHaveLength(0);
		await committed(plan, "revert_files");
		expect(await readFile(path)).toEqual(original);
		await expect(lstat(created)).rejects.toMatchObject({ code: "ENOENT" });
		expect(history()).toBe(before);
		expect(messageVersion()).toBe(version);
		expect(events.every((event) => event.message.type === "full_reload" && event.committed)).toBe(
			true,
		);
		for (const file of journalFiles(plan))
			expect(file.receiptJson).toMatchObject({
				apply: { receipt: { confirmed: true, outcome: "applied" } },
				compensate: null,
			});
	});
	test("delete_tool_block resolves the real PK and preserves text plus other actual tool blocks", async () => {
		const a = join(workspace, "selected.txt");
		const b = join(workspace, "retained.txt");
		await writeFile(a, "A0\n");
		await writeFile(b, "B0\n");
		const first = await write(a, "A1\n");
		const other = await edit(b, "B0", "B1", first.messageId);
		const original = messageRow(first.messageId)?.contentJson as unknown[];
		const blocks = [...original, { type: "text", text: "trailing explanation stays" }];
		db.update(schema.narratorMessages)
			.set({ contentJson: blocks })
			.where(eq(schema.narratorMessages.id, first.messageId))
			.run();
		const before = history();
		const version = messageVersion();
		const events = historyRefreshes();
		expect(first.toolCallId).not.toBe(first.toolUseId);
		const plan = await actionPrepared(
			"delete_tool_block",
			first.messageId,
			{
				blockIndex: first.blockIndex,
			},
			{ deletedMessageCount: 0, deletedBlockCount: 1 },
		);
		expect(plan.selectorKind).toBe("tool_calls");
		expect(plan.expectedFileCount).toBe(1);
		expect((await originalManifest(plan.manifestDigests.selector)).request.selector).toEqual({
			kind: "tool_calls",
			toolCallIds: [first.toolCallId],
		});
		expect(history()).toBe(before);
		expect(events).toHaveLength(0);
		await committed(plan, "delete_tool_block");
		expect(await readFile(a, "utf8")).toBe("A0\n");
		expect(await readFile(b, "utf8")).toBe("B1\n");
		expect(messageRow(first.messageId)?.contentJson).toEqual(
			blocks.filter((_, index) => index !== first.blockIndex),
		);
		expect(messageRefs().map((ref) => ref.messageId)).toEqual([first.messageId]);
		expect(
			db
				.select({ id: schema.narratorToolCalls.id })
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, first.toolCallId))
				.get(),
		).toBeUndefined();
		expect(
			db
				.select({ id: schema.narratorToolCalls.id })
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, other.toolCallId))
				.get()?.id,
		).toBe(other.toolCallId);
		expect(messageVersion()).toBe((version ?? 0) + 1);
		expect(events.some((event) => event.message.type === "full_reload")).toBe(true);
		expect(events.every((event) => event.committed)).toBe(true);
	});
	test("assistant rollback uses exact after_block and removes the entire later window", async () => {
		const path = join(workspace, "window.txt");
		const original = "A0\n1\n2\n3\nB0\n4\n5\n6\nC0\n";
		await writeFile(path, original);
		const boundary = await edit(path, "A0", "A1");
		await edit(path, "B0", "B1", boundary.messageId);
		const later = await edit(path, "C0", "C1");
		const laterText = message("assistant", [{ type: "text", text: "later response" }]);
		const initial = messageRow(boundary.messageId)?.contentJson as unknown[];
		const before = history();
		const events = historyRefreshes();
		const plan = await actionPrepared("rollback_to_block", boundary.messageId, {
			blockIndex: boundary.blockIndex,
		});
		expect(plan.selectorKind).toBe("after_block");
		expect((await originalManifest(plan.manifestDigests.selector)).request.selector).toEqual({
			kind: "after_block",
			messageId: boundary.messageId,
			keepThroughBlockIndex: boundary.blockIndex,
		});
		expect(history()).toBe(before);
		await committed(plan, "rollback_to_block");
		expect(await readFile(path, "utf8")).toBe(original.replace("A0", "A1"));
		expect(messageRefs().map((ref) => ref.messageId)).toEqual([boundary.messageId]);
		expect(messageRow(boundary.messageId)?.contentJson).toEqual(initial.slice(0, 2));
		expect(messageRow(later.messageId)).toBeUndefined();
		expect(messageRow(laterText)).toBeUndefined();
		expect(events.some((event) => event.message.type === "full_reload")).toBe(true);
		expect(events.every((event) => event.committed)).toBe(true);
	});
	test("user rollback keeps the complete multimodal boundary even when blockIndex points at its text", async () => {
		const prefix = message("assistant", [{ type: "text", text: "earlier context" }]);
		const blocks = [
			{ type: "text", text: "please revise the screenshot" },
			{ type: "image", imageId: "isolated-image-reference", mediaType: "image/png" },
			{ type: "text", text: "this trailing user instruction is also atomic" },
		];
		const boundary = message("user", blocks);
		const boundaryRow = messageRow(boundary);
		const path = join(workspace, "user-window.txt");
		await writeFile(path, "before\n");
		const first = await write(path, "first\n");
		const second = await edit(path, "first", "second");
		const before = history();
		const plan = await actionPrepared("rollback_to_block", boundary, { blockIndex: 0 });
		expect(history()).toBe(before);
		await committed(plan, "rollback_to_block");
		expect(await readFile(path, "utf8")).toBe("before\n");
		expect(messageRefs().map((ref) => ref.messageId)).toEqual([prefix, boundary]);
		expect(messageRow(boundary)).toEqual(boundaryRow);
		expect(messageRow(first.messageId)).toBeUndefined();
		expect(messageRow(second.messageId)).toBeUndefined();
	});
	test("revert_files message boundary includes later tools but leaves earlier writes and all history", async () => {
		const path = join(workspace, "from-message.txt");
		const original = "A0\n1\n2\n3\nB0\n4\n5\n6\nC0\n";
		await writeFile(path, original);
		await edit(path, "A0", "A1");
		const boundary = await edit(path, "B0", "B1");
		await edit(path, "C0", "C1");
		const before = history();
		const plan = await actionPrepared(
			"revert_files",
			boundary.messageId,
			{},
			{
				deletedMessageCount: 0,
				deletedBlockCount: 0,
			},
		);
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe(original.replace("A0", "A1"));
		expect(history()).toBe(before);
	});
	test("real authenticated nonconflicting later human edits survive action apply", async () => {
		const path = join(workspace, "human-hunks.txt");
		const original = "A0\n1\n2\n3\n4\nH0\n5\n6\n7\n8\nB0\n";
		await writeFile(path, original);
		await write(path, original.replace("A0", "A1"));
		await human(path, (await readFile(path, "utf8")).replace("H0", "H1"));
		await edit(path, "B0", "B1");
		await human(path, (await readFile(path, "utf8")).replace("H1", "H2"));
		const before = history();
		const plan = await actionPrepared("revert_files");
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe(original.replace("H0", "H2"));
		expect(history()).toBe(before);
	});
	test("recorded local effects remain executable when the narrator default device later becomes remote", async () => {
		const { path } = await fixture();
		db.update(schema.narrators)
			.set({ defaultDeviceId: "not-the-recorded-device" })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		const before = history();
		const plan = await actionPrepared("revert_files");
		expect(journalFiles(plan).map((file) => file.identityJson.deviceId)).toEqual(["local"]);
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe("old\n");
		expect(history()).toBe(before);
	});
	test("conflicting human changes make action preview unavailable without changing files or history", async () => {
		const { path } = await fixture();
		await human(path, "human replaced the tool hunk\n");
		const before = history();
		const disk = await readFile(path);
		await actionUnavailable(await actionPreview("revert_files"), "revert_files");
		expect(await readFile(path)).toEqual(disk);
		expect(history()).toBe(before);
	});
	test("human edits after preview refuse the fixed plan rather than silently replanning", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		await human(path, "human after preview\n");
		const before = history();
		await boundedJson(await apply(plan, "revert_files"), 409);
		expect(await readFile(path, "utf8")).toBe("human after preview\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
});

describe("action apply reauthorization and immutable admission", () => {
	test("requireAuth and other owners cannot preview or execute a known action plan", async () => {
		const { path } = await fixture();
		const before = history();
		expect((await actionPreview("revert_files", "__all__", {}, "")).status).toBe(401);
		expect((await actionPreview("revert_files", "__all__", {}, otherToken)).status).toBe(404);
		const plan = await actionPrepared("revert_files");
		expect((await apply(plan, "revert_files", {}, "")).status).toBe(401);
		expect((await apply(plan, "revert_files", {}, otherToken)).status).toBe(404);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test.each([
		"narrator",
		"project",
		"path",
	] as const)("apply rechecks revoked %s write authority after preview", async (gate) => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		if (gate === "narrator")
			db.update(schema.narrators)
				.set({ ownerUserId: otherId })
				.where(eq(schema.narrators.id, narratorId))
				.run();
		else if (gate === "project")
			db.update(schema.projects)
				.set({ ownerUserId: otherId })
				.where(eq(schema.projects.id, projectId))
				.run();
		else {
			const changed = join(workspace, "revoked-cwd");
			await mkdir(changed);
			db.update(schema.narrators)
				.set({ cwd: changed })
				.where(eq(schema.narrators.id, narratorId))
				.run();
		}
		const before = history();
		const response = await apply(plan, "revert_files");
		expect([403, 404]).toContain(response.status);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test("another authorized owner cannot inherit the original human plan capability", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		db.update(schema.projects)
			.set({ ownerUserId: otherId })
			.where(eq(schema.projects.id, projectId))
			.run();
		db.update(schema.narrators)
			.set({ ownerUserId: otherId })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		const before = history();
		const response = await apply(plan, "revert_files", {}, otherToken);
		expect([404, 409]).toContain(response.status);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test("known plan cannot be applied through a different owned narrator", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		const before = history();
		const original = narratorId;
		const otherNarrator = generateId();
		db.insert(schema.narrators)
			.values({
				id: otherNarrator,
				ownerUserId: userId,
				cwd: workspace,
				contextProjectId: projectId,
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
		try {
			narratorId = otherNarrator;
			expect([404, 409]).toContain((await apply(plan, "revert_files")).status);
		} finally {
			narratorId = original;
		}
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test.each([
		"delete_tool_block",
		"rollback_to_block",
	] as const)("file-only immutable action cannot be relabeled %s at confirmation", async (action) => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		const before = history();
		const rejected = await boundedJson(await apply(plan, action), 409);
		expect(rejected.code).toMatch(/ACTION/);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
		await committed(plan, "revert_files");
		expect(history()).toBe(before);
	});
	test.each([
		"file-only action",
		"unbound generic",
		"expired history",
		"wrong hash",
	] as const)("invalid %s confirmation cannot interrupt live work started after preview", async (invalid) => {
		const { path, call } = await fixture();
		const plan =
			invalid === "unbound generic"
				? await prepared()
				: invalid === "expired history"
					? await actionPrepared("delete_tool_block", call.messageId, { blockIndex: 1 })
					: await actionPrepared("revert_files");
		if (invalid === "expired history")
			db.update(schema.revertOperations)
				.set({ expiresAt: new Date(Date.now() - 1).toISOString() })
				.where(eq(schema.revertOperations.id, plan.id))
				.run();
		const active = startLiveWorkAfterPreview();
		const before = history();
		expect(narratorState.isNarratorRuntimeBusy(narratorId)).toBe(true);
		const rejected = await boundedJson(
			await apply(
				plan,
				"delete_tool_block",
				invalid === "wrong hash" ? { planHash: "0".repeat(64) } : {},
			),
			409,
		);
		expect(rejected.code).toMatch(invalid === "expired history" ? /EXPIRED/ : /ACTION/);
		expect(active.abortController.signal.aborted).toBe(false);
		expect(active.alive).toBe(true);
		expect(narratorState.activeNarrators.get(narratorId)).toBe(active);
		expect(narratorState.isNarratorRuntimeBusy(narratorId)).toBe(true);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test("action preview does not interrupt live narrator work before confirmation", async () => {
		const { path } = await fixture();
		const active = startLiveWorkAfterPreview();
		const plan = await actionPrepared("revert_files");
		expect(active.abortController.signal.aborted).toBe(false);
		expect(active.alive).toBe(true);
		expect(plan.expectedFileCount).toBe(1);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("generic plan preview does not interrupt live narrator work before confirmation", async () => {
		const { path } = await fixture();
		const active = startLiveWorkAfterPreview();
		const plan = await prepared();
		expect(active.abortController.signal.aborted).toBe(false);
		expect(active.alive).toBe(true);
		expect(plan.expectedFileCount).toBe(1);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("valid apply interrupts live narrator work before executing the prepared plan", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		const active = startLiveWorkAfterPreview();
		await committed(plan, "revert_files");
		expect(active.abortController.signal.aborted).toBe(true);
		expect(active.alive).toBe(false);
		expect(await readFile(path, "utf8")).toBe("old\n");
	});
	test("hot-upgrade refusal is preserved by preview and cannot interrupt or apply a prepared plan", async () => {
		const { path, call } = await fixture();
		const plan = await actionPrepared("delete_tool_block", call.messageId, { blockIndex: 1 });
		const active = startLiveWorkAfterPreview();
		const before = history();
		const bash = await import("../lib/agent/tools/bash");
		const guard = spyOn(bash, "assertBashActivityProtectionReady").mockImplementation(() => {
			throw new AppError("Cold start required", 409, "REVERT_RUNTIME_RELOAD_REQUIRED");
		});
		try {
			const preview = await boundedJson(await actionPreview("revert_files"));
			expect(preview).toMatchObject({ plan: null, unavailable: "runtime_reload_required" });
			const rejected = await boundedJson(await apply(plan, "delete_tool_block"), 409);
			expect(rejected.code).toBe("REVERT_RUNTIME_RELOAD_REQUIRED");
			expect(active.abortController.signal.aborted).toBe(false);
			expect(narratorState.isNarratorRuntimeBusy(narratorId)).toBe(true);
			expect(await readFile(path, "utf8")).toBe("new\n");
			expect(history()).toBe(before);
			expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
		} finally {
			guard.mockRestore();
		}
	});

	test("multi-tool rollback cannot masquerade as a single-tool delete", async () => {
		const boundary = message("user", [{ type: "text", text: "keep user" }]);
		const { path } = await fixture();
		await edit(path, "new", "newer");
		const plan = await actionPrepared("rollback_to_block", boundary, { blockIndex: 0 });
		const before = history();
		const rejected = await boundedJson(await apply(plan, "delete_tool_block"), 409);
		expect(rejected.code).toMatch(/ACTION/);
		expect(await readFile(path, "utf8")).toBe("newer\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test("wrong planHash refuses without consuming the original valid confirmation", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		const before = history();
		await boundedJson(await apply(plan, "revert_files", { planHash: "0".repeat(64) }), 409);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
		await committed(plan, "revert_files");
	});
	test("expired action plan refuses without touching files or history", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		db.update(schema.revertOperations)
			.set({ expiresAt: new Date(Date.now() - 1).toISOString() })
			.where(eq(schema.revertOperations.id, plan.id))
			.run();
		const before = history();
		const rejected = await boundedJson(await apply(plan, "revert_files"), 409);
		expect(rejected.code).toMatch(/EXPIRED/);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test("idempotency binds action and original target, not only the current file set", async () => {
		const { path, call } = await fixture();
		const plan = await actionPrepared("revert_files");
		const repeated = await actionPrepared("revert_files");
		expect(repeated.id).toBe(plan.id);
		expect(repeated.planHash).toBe(plan.planHash);
		await boundedJson(await actionPreview("revert_files", call.messageId), 409);
		await boundedJson(
			await actionPreview("delete_tool_block", call.messageId, { blockIndex: 1 }),
			409,
		);
		expect(ownPlans()).toHaveLength(1);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("duplicate file-only confirmation reads committed journal without replaying over a later human save", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		await committed(plan, "revert_files");
		await human(path, "human after successful revert\n");
		const before = history();
		const journal = journalFiles(plan);
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe("human after successful revert\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan)).toEqual(journal);
	});
	test("concurrent duplicate confirmations never dispatch a second file mutation", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		const before = history();
		const responses = await Promise.all([apply(plan, "revert_files"), apply(plan, "revert_files")]);
		expect(responses.some((response) => response.status === 200)).toBe(true);
		for (const response of responses) {
			expect([200, 409]).toContain(response.status);
			const result = await boundedJson(response, response.status);
			if (response.status === 200)
				expect(result).toMatchObject({
					status: "committed",
					journalStatus: "committed",
					settling: false,
				});
		}
		expect(await readFile(path, "utf8")).toBe("old\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan)).toHaveLength(1);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "applied" } },
			compensate: null,
		});
	});
	test("source block drift without a version bump refuses the original history manifest", async () => {
		const { path, call } = await fixture();
		const plan = await actionPrepared("delete_tool_block", call.messageId, { blockIndex: 1 });
		const blocks = messageRow(call.messageId)?.contentJson as unknown[];
		db.update(schema.narratorMessages)
			.set({ contentJson: [{ type: "text", text: "changed source" }, ...blocks.slice(1)] })
			.where(eq(schema.narratorMessages.id, call.messageId))
			.run();
		const before = history();
		await boundedJson(await apply(plan, "delete_tool_block"), 409);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test("committed history deletion remains nonreplayable after original source messages and tools disappear", async () => {
		const boundary = message("user", [{ type: "text", text: "keep this user request" }]);
		const { path, call } = await fixture();
		const events = historyRefreshes();
		const plan = await actionPrepared("rollback_to_block", boundary, { blockIndex: 0 });
		await committed(plan, "rollback_to_block");
		expect(messageRow(call.messageId)).toBeUndefined();
		expect(
			db
				.select({ id: schema.narratorToolCalls.id })
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, call.toolCallId))
				.get(),
		).toBeUndefined();
		const journal = journalFiles(plan);
		const eventCount = events.length;
		const version = messageVersion();
		await human(path, "human after source deletion\n");
		const before = history();
		await committed(plan, "rollback_to_block");
		expect(await readFile(path, "utf8")).toBe("human after source deletion\n");
		expect(history()).toBe(before);
		expect(messageVersion()).toBe(version);
		expect(journalFiles(plan)).toEqual(journal);
		// A terminal retry may conservatively invalidate caches, but must not
		// announce another historical mutation or resurrect the deleted source.
		expect(
			events
				.slice(eventCount)
				.every((event) => event.message.type === "full_reload" && event.committed),
		).toBe(true);
	});
});

describe("action unavailable evidence, actual failure outcomes and bounded requests", () => {
	test.each([
		["Write", "local"],
		["Write", "unsupported-remote"],
	] as const)("unjournaled %s on %s is unavailable without legacy or local fallback", async (name, device) => {
		const { path } = await fixture();
		const unknown = unjournaledTool(path, name, device);
		const before = history();
		for (const action of ["revert_files", "delete_tool_block", "rollback_to_block"] as const) {
			await actionUnavailable(
				await actionPreview(
					action,
					action === "revert_files" ? "__all__" : unknown.messageId,
					action === "revert_files" ? {} : { blockIndex: action === "delete_tool_block" ? 1 : 0 },
				),
				action,
			);
		}
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test("an unmeasured Bash in a rollback range does not block other file effects", async () => {
		const { path } = await fixture();
		unjournaledTool(path, "Bash");
		const before = history();
		const plan = await actionPrepared("revert_files");
		expect(plan.expectedFileCount).toBe(1);
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe("old\n");
		expect(history()).toBe(before);
	});
	test("oversized message boundary is unavailable before parsing or returning its tool payload", async () => {
		const { path, call } = await fixture();
		const blocks = messageRow(call.messageId)?.contentJson as unknown[];
		const marker = "OVERSIZED-BOUNDARY-PRIVATE-CONTENT-";
		db.update(schema.narratorMessages)
			.set({
				contentJson: [
					{ type: "text", text: marker + "界".repeat(FILE_CHANGE_LIMITS.summaryBytes) },
					...blocks.slice(1),
				],
			})
			.where(eq(schema.narratorMessages.id, call.messageId))
			.run();
		const before = history();
		for (const action of ["delete_tool_block", "rollback_to_block"] as const) {
			const body = await actionUnavailable(
				await actionPreview(action, call.messageId, {
					blockIndex: 1,
				}),
				action,
			);
			expect(body.unavailable).toBe("window_too_large");
			expect(JSON.stringify(body)).not.toContain(marker);
		}
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test("post-commit refresh failure reports committed 200 without replay or compensation", async () => {
		const { path } = await fixture();
		const plan = await actionPrepared("revert_files");
		const before = history();
		const broadcast = narratorWs.broadcastToNarrator;
		let failedRefreshes = 0;
		const refresh = spyOn(narratorWs, "broadcastToNarrator").mockImplementation((id, value) => {
			if (id === narratorId && value.type === "full_reload") {
				failedRefreshes++;
				throw new Error("HTTP test post-commit refresh failure");
			}
			broadcast(id, value);
		});
		try {
			const body = await boundedJson(await apply(plan, "revert_files"));
			expect(body).toEqual({
				planId: plan.id,
				status: "committed",
				journalStatus: "committed",
				settling: false,
				reason: "POST_COMMIT_REFRESH_FAILED",
			});
			expect(failedRefreshes).toBeGreaterThan(0);
		} finally {
			refresh.mockRestore();
		}
		expect(ownPlans().find((row) => row.id === plan.id)?.status).toBe("committed");
		expect(await readFile(path, "utf8")).toBe("old\n");
		expect(history()).toBe(before);
		const files = journalFiles(plan);
		expect(files[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "applied" } },
			compensate: null,
		});
		await human(path, "human after lost refresh\n");
		await committed(plan, "revert_files");
		expect(await readFile(path, "utf8")).toBe("human after lost refresh\n");
		expect(journalFiles(plan)).toEqual(files);
		expect(history()).toBe(before);
	});
	test("SQL history commit failure returns actual compensated 409 and restores pre-apply bytes", async () => {
		const { path, call } = await fixture();
		const plan = await actionPrepared("delete_tool_block", call.messageId, { blockIndex: 1 });
		const before = history();
		const disk = await readFile(path);
		const events = historyRefreshes();
		failCommit(plan);
		const result = await boundedJson(await apply(plan, "delete_tool_block"), 409);
		expect(result).toMatchObject({
			planId: plan.id,
			status: "compensated",
			journalStatus: "compensated",
			settling: false,
		});
		expect(result).toHaveProperty("reason");
		expect(ownPlans().find((row) => row.id === plan.id)?.status).toBe(result.journalStatus);
		expect(await readFile(path)).toEqual(disk);
		expect(history()).toBe(before);
		expect(events).toHaveLength(0);
		const files = journalFiles(plan);
		expect(files[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "applied" } },
			compensate: { receipt: { confirmed: true, outcome: "applied" } },
		});
		await boundedJson(await apply(plan, "delete_tool_block"), 409);
		expect(journalFiles(plan)).toEqual(files);
		expect(history()).toBe(before);
	});
	test("lost receipt persistence returns actual recovery_required 409 and never blindly retries IO", async () => {
		const { path, call } = await fixture();
		const plan = await actionPrepared("delete_tool_block", call.messageId, { blockIndex: 1 });
		const before = history();
		const events = historyRefreshes();
		failCommit(plan, true);
		const result = await boundedJson(await apply(plan, "delete_tool_block"), 409);
		expect(result).toMatchObject({
			planId: plan.id,
			status: "recovery_required",
			journalStatus: "recovery_required",
			settling: false,
		});
		expect(result).toHaveProperty("reason");
		expect(ownPlans().find((row) => row.id === plan.id)?.status).toBe(result.journalStatus);
		expect(history()).toBe(before);
		expect(events).toHaveLength(0);
		const files = journalFiles(plan);
		await writeFile(path, "external after uncertain receipt\n");
		const repeated = await boundedJson(await apply(plan, "delete_tool_block"), 409);
		expect(repeated.status).toBe("recovery_required");
		expect(await readFile(path, "utf8")).toBe("external after uncertain receipt\n");
		expect(journalFiles(plan)).toEqual(files);
		expect(history()).toBe(before);
	});
	test("HTTP abort after real dispatch returns settling 409 with the actual journal and retains its lease", async () => {
		const { path, call } = await fixture();
		const plan = await actionPrepared("delete_tool_block", call.messageId, { blockIndex: 1 });
		const before = history();
		const events = historyRefreshes();
		const controller = new AbortController();
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let held = false;
		let execution: RevertTransactionExecution | undefined;
		const execute = RevertTransactionService.prototype.execute;
		const executeObserver = spyOn(RevertTransactionService.prototype, "execute").mockImplementation(
			function (this: RevertTransactionService, input) {
				// Retain the real lifetime capability for cleanup; do not replace any
				// request, executor, journal, restore operation or returned outcome.
				execution = execute.call(this, input);
				return execution;
			},
		);
		const authorize = RevertPlannerLocalAccess.prototype.authorizeFile;
		const guard = spyOn(RevertPlannerLocalAccess.prototype, "authorizeFile").mockImplementation(
			async function (this: RevertPlannerLocalAccess, input) {
				await authorize.call(this, input);
				if (
					!held &&
					input.identity.canonicalPath === path &&
					journalFiles(plan)[0]?.status === "applying" &&
					(await readFile(path, "utf8")) === "old\n"
				) {
					held = true;
					entered();
					await gate;
				}
			},
		);
		const pending = apply(plan, "delete_tool_block", {}, token, controller.signal);
		try {
			await Promise.race([
				started,
				pending.then((response) => {
					throw new Error(`HTTP ${response.status} returned before the real post-dispatch guard`);
				}),
			]);
			controller.abort(new Error("cancel actual HTTP apply after file dispatch"));
			const result = await boundedJson(await pending, 409);
			expect(result).toMatchObject({
				planId: plan.id,
				status: "recovery_required",
				journalStatus: "applying",
				settling: true,
			});
			expect(result.reason).toBeString();
			expect(ownPlans().find((row) => row.id === plan.id)?.status).toBe("applying");
			expect(scope().activeLeaseId).toBeTruthy();
			expect(scope().activeMutationCount).toBe(1);
			expect(history()).toBe(before);
			expect(events).toHaveLength(0);
		} finally {
			release();
			await pending.catch(() => {});
			await execution?.whenSettled.catch(() => {});
			guard.mockRestore();
			executeObserver.mockRestore();
		}
		const settled = await execution?.whenSettled;
		expect(settled).toMatchObject({ status: "recovery_required", settling: false });
		expect(history()).toBe(before);
		expect(events).toHaveLength(0);
		expect(await readFile(path, "utf8")).toBe("old\n");
	}, 45_000);
	test("action preview and apply reject malformed inputs and never accept caller authority", async () => {
		const { path, call } = await fixture();
		const before = history();
		for (const body of [
			null,
			[],
			{},
			actionRequest("revert_files", "__all__", { action: "history_delete" }),
			actionRequest("delete_tool_block", "__all__", { blockIndex: 1 }),
			actionRequest("rollback_to_block", "__all__", { blockIndex: 0 }),
			actionRequest("delete_tool_block", call.messageId),
			actionRequest("delete_tool_block", call.messageId, { blockIndex: -1 }),
			actionRequest("delete_tool_block", call.messageId, { blockIndex: 0.5 }),
			actionRequest("delete_tool_block", call.messageId, {
				blockIndex: Number.MAX_SAFE_INTEGER + 1,
			}),
			actionRequest("revert_files", "__all__", { idempotencyKey: "" }),
			actionRequest("revert_files", "__all__", { idempotencyKey: "中".repeat(100) }),
			...[
				{ skipRevert: true },
				{ revertScope: "workspace" },
				{ principal: { userId: otherId } },
				{ actionBinding: { action: "delete_tool_block" } },
				{ toolCallId: call.toolCallId },
				{ selector: { kind: "all" } },
				{ manifestProof: { complete: true } },
			].map((extra) => actionRequest("revert_files", "__all__", extra)),
		])
			await boundedJson(await http("revert-action-preview", "POST", body), 400);
		expect(ownPlans()).toHaveLength(0);
		const plan = await actionPrepared("revert_files");
		for (const body of [
			null,
			[],
			{},
			{ planHash: plan.planHash },
			{ action: "revert_files" },
			{ planHash: "invalid", action: "revert_files" },
			{ planHash: plan.planHash, action: "revert_files", skipRevert: true },
			{ planHash: plan.planHash, action: "revert_files", files: [] },
			{ planHash: plan.planHash, action: "revert_files", messageId: call.messageId },
			{ planHash: plan.planHash, action: "delete_tool_block", toolCallId: call.toolCallId },
			{ planHash: plan.planHash, action: "revert_files", principal: { userId: otherId } },
		])
			await boundedJson(await http(`revert-plans/${plan.id}/apply`, "POST", body), 400);
		for (const endpoint of ["revert-action-preview", `revert-plans/${plan.id}/apply`]) {
			const response = await app.request(
				`http://localhost/api/narrators/${narratorId}/${endpoint}`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: '{"action":',
				},
			);
			await boundedJson(response, 400);
		}
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
	});
	test("unsupported block targets and missing messages cannot be resolved as arbitrary tool IDs", async () => {
		const { path, call } = await fixture();
		const before = history();
		for (const blockIndex of [0, 100]) {
			const response = await actionPreview("delete_tool_block", call.messageId, { blockIndex });
			if (response.status === 200) await actionUnavailable(response, "delete_tool_block");
			else await boundedJson(response, 400);
		}
		expect(
			(await actionPreview("delete_tool_block", call.toolCallId, { blockIndex: 1 })).status,
		).toBe(404);
		expect((await actionPreview("revert_files", generateId())).status).toBe(404);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
		expect(ownPlans()).toHaveLength(0);
	});
	test("action endpoints enforce request byte budgets before the general attachment collector", async () => {
		const { path } = await fixture();
		const before = history();
		const oversized = "x".repeat(FILE_CHANGE_LIMITS.summaryBytes + 1);
		await boundedJson(
			await actionPreview("revert_files", "__all__", { idempotencyKey: oversized }),
			413,
		);
		expect(ownPlans()).toHaveLength(0);
		const plan = await actionPrepared("revert_files");
		await boundedJson(await apply(plan, "revert_files", { planHash: oversized }), 413);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test("action summaries remain bounded metadata and never echo file bodies or tool payloads", async () => {
		const path = join(workspace, "large-content.txt");
		const marker = "PRIVATE-TOOL-CONTENT-DO-NOT-ECHO-";
		await writeFile(path, `${marker}${"a".repeat(FILE_CHANGE_LIMITS.summaryBytes + 1)}`);
		await write(path, `${marker}${"b".repeat(FILE_CHANGE_LIMITS.summaryBytes + 1)}`);
		const response = await actionPreview("revert_files");
		const value = await boundedJson(response);
		expect(value.plan).toMatchObject({ status: "prepared", expectedFileCount: 1 });
		const raw = JSON.stringify(value);
		for (const forbidden of [
			marker,
			"contentJson",
			"executionReceiptJson",
			"inputJson",
			"privateRoot",
		])
			expect(raw).not.toContain(forbidden);
		expect(raw).not.toContain(workspace);
		expect(value.executable).toBe(false);
	}, 30_000);
});

describe("production preview API and actual local evidence", () => {
	test("real Write -> human editor -> Edit -> late human produces a prepared HTTP plan without applying", async () => {
		const path = join(workspace, "combined.txt");
		const original = "A0\n1\n2\n3\n4\nH0\n5\n6\n7\n8\nB0\n";
		await writeFile(path, original);
		await write(path, original.replace("A0", "A1"));
		await human(path, (await readFile(path, "utf8")).replace("H0", "H1"));
		await edit(path, "B0", "B1");
		await human(path, (await readFile(path, "utf8")).replace("H1", "H2"));
		const before = history();
		const disk = await readFile(path);
		const plan = await prepared();
		expect(plan.expectedFileCount).toBe(1);
		expect(ownPlans()[0].requestedBySubjectKey).toBe(`human:${userId}`);
		const summary = await http(`revert-plans/${plan.id}`);
		expect(summary.status).toBe(200);
		expect((await summary.json()).executable).toBe(false);
		const response = await http(`revert-plans/${plan.id}/files?limit=1`);
		const raw = await response.text();
		expect(Buffer.byteLength(raw)).toBeLessThan(FILE_CHANGE_LIMITS.summaryBytes);
		const page = JSON.parse(raw) as {
			items: RevertPlanFileMetadata[];
			hasMore: boolean;
			executable: boolean;
		};
		expect(page.executable).toBe(false);
		expect(page.hasMore).toBe(false);
		expect(page.items).toHaveLength(1);
		expect((await bytes(page.items[0].desiredStateJson)).toString()).toBe(
			original.replace("H0", "H2"),
		);
		expect(await bytes(page.items[0].expectedStateJson)).toEqual(disk);
		expect(await readFile(path)).toEqual(disk);
		expect(history()).toBe(before);
		expect(raw).not.toContain("contentJson");
		expect(raw).not.toContain("executionReceiptJson");
		expect(raw).not.toContain("H2");
		const repeated = await prepared();
		expect(repeated.id).toBe(plan.id);
	});
	test("full HTTP file pagination traverses more than a plan batch, with no executable claim", async () => {
		for (let i = 0; i < 34; i++) {
			const path = join(workspace, `${i}.txt`);
			await writeFile(path, `before ${i}`);
			await write(path, `after ${i}`);
		}
		const before = history();
		const plan = await prepared();
		const sequences: number[] = [];
		let cursor: string | undefined;
		for (;;) {
			const response = await http(
				`revert-plans/${plan.id}/files?limit=7${cursor ? `&cursor=${cursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			const raw = await response.text();
			expect(Buffer.byteLength(raw)).toBeLessThan(FILE_CHANGE_LIMITS.summaryBytes);
			const page = JSON.parse(raw) as {
				items: RevertPlanFileMetadata[];
				hasMore: boolean;
				nextCursor: { fileKey: string } | null;
				executable: boolean;
			};
			expect(page.executable).toBe(false);
			for (const item of page.items) {
				sequences.push(item.sequence);
				expect((await bytes(item.desiredStateJson)).toString()).toStartWith("before ");
				expect(await readFile(item.identityJson.canonicalPath, "utf8")).toStartWith("after ");
			}
			if (!page.hasMore) break;
			cursor = page.nextCursor?.fileKey;
		}
		expect(sequences.sort((a, b) => a - b)).toEqual(Array.from({ length: 34 }, (_, i) => i));
		expect(history()).toBe(before);
	}, 60_000);
	test("local readCurrent only observes actual files and cannot publish or write database rows", async () => {
		const { path } = await fixture();
		const effect = effects()[0];
		const access = new RevertPlannerLocalAccess();
		const principal = { userId, isAdmin: false };
		const signal = new AbortController().signal;
		const owner = await access.owner(principal, narratorId, signal);
		const target = await access.resolveFile({
			principal,
			owner,
			identity: effect.identityJson,
			signal,
		});
		const before = sqlite
			.query<{ changes: number }, []>("SELECT total_changes() AS changes")
			.get()?.changes;
		const observed = await target.readCurrent({ signal, maxBytes: FILE_CHANGE_LIMITS.blobBytes });
		expect(Buffer.from(observed.raw ?? []).toString()).toBe("new\n");
		expect(observed.state.kind).toBe("regular");
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(
			sqlite.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()?.changes,
		).toBe(before);
	});
});

describe("real requireAuth and conjunctive ACL", () => {
	test("a previously prepared owner with read-only narrator access cannot page target metadata", async () => {
		await fixture();
		const plan = await prepared();
		db.update(schema.narrators)
			.set({ ownerUserId: otherId })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		db.insert(schema.aclGrants)
			.values({
				id: generateId(),
				scopeType: "narrator",
				scopeId: narratorId,
				principalType: "user",
				principalId: userId,
				capability: "read",
				grantedBy: otherId,
				createdAt: now(),
			})
			.run();
		expect((await http(`revert-plans/${plan.id}/files`)).status).toBe(404);
		expect((await http(`revert-plans/${plan.id}`)).status).toBe(404);
	});
	test("real ACL revocation during current file observation prevents durable preparation", async () => {
		const { path } = await fixture();
		const before = history();
		const read = fileChangeLocalIo.read;
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (...args) => {
			const observed = await read(...args);
			db.update(schema.narrators)
				.set({ ownerUserId: otherId })
				.where(eq(schema.narrators.id, narratorId))
				.run();
			return observed;
		});
		try {
			await refused(await prepare());
		} finally {
			spy.mockRestore();
		}
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("deleted authenticated database users are rejected even if a session was cached", async () => {
		await fixture();
		// The real auth middleware caches this unrelated user before the narrator
		// gate denies them. Deleting it has no fixture evidence ownership/FK cleanup.
		await prepare({}, otherToken);
		db.delete(schema.users).where(eq(schema.users.id, otherId)).run();
		await expect(
			new RevertPlannerLocalAccess().authenticate(
				{ userId: otherId, isAdmin: false },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ statusCode: 401 });
		await refused(await prepare({}, otherToken));
	});
	test("no token and another authenticated user cannot prepare or read owner plans", async () => {
		await fixture();
		const before = history();
		await refused(await prepare({}, ""));
		await refused(await prepare({}, otherToken));
		const plan = await prepared();
		for (const endpoint of [`revert-plans/${plan.id}`, `revert-plans/${plan.id}/files`])
			expect((await http(endpoint, "GET", undefined, otherToken)).status).toBe(404);
		expect(history()).toBe(before);
	});
	test("existing JWT with a changed database role fails even through the session cache", async () => {
		await fixture();
		await http("revert-plans", "POST", request({ unexpected: true }));
		db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, userId)).run();
		restorers.push(() => {
			db.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, userId)).run();
		});
		await refused(await prepare(), "REVERT_PREVIEW_AUTHENTICATION_CHANGED");
	});
	test("project gate cannot be bypassed by owning the narrator", async () => {
		await fixture();
		db.update(schema.projects)
			.set({ ownerUserId: otherId })
			.where(eq(schema.projects.id, projectId))
			.run();
		const before = history();
		await refused(await prepare());
		expect(history()).toBe(before);
	});
	test("a known plan cannot be read using another narrator or another authorized plan owner", async () => {
		await fixture();
		const plan = await prepared();
		const original = narratorId;
		narratorId = generateId();
		db.insert(schema.narrators)
			.values({
				id: narratorId,
				ownerUserId: userId,
				cwd: workspace,
				contextProjectId: projectId,
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
		expect((await http(`revert-plans/${plan.id}`)).status).toBeGreaterThanOrEqual(400);
		narratorId = original;
		db.update(schema.narrators)
			.set({ ownerUserId: otherId })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		db.update(schema.projects)
			.set({ ownerUserId: otherId })
			.where(eq(schema.projects.id, projectId))
			.run();
		expect(
			(await http(`revert-plans/${plan.id}`, "GET", undefined, otherToken)).status,
		).toBeGreaterThanOrEqual(400);
	});
	test("GET file metadata rechecks the current write boundary after preview", async () => {
		await fixture();
		const plan = await prepared();
		const other = join(workspace, "different-cwd");
		await mkdir(other);
		db.update(schema.narrators)
			.set({ cwd: other })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		expect((await http(`revert-plans/${plan.id}/files`)).status).toBe(403);
	});
});

describe("backend scope and namespace guards", () => {
	test("outside cwd is refused without implicit confirmation; configured writable roots allow it", async () => {
		const outside = await mkdtemp(join(testEnvironment.isolatedHome, "outside-preview-"));
		restorers.push(() => rm(outside, { recursive: true, force: true }));
		const path = join(outside, "file.txt");
		await writeFile(path, "old");
		await write(path, "new");
		const before = history();
		await refused(await prepare(), "REVERT_PREVIEW_FILE_ACCESS_DENIED");
		settings.paths.extraWritableDirs = [outside];
		expect((await prepared()).expectedFileCount).toBe(1);
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new");
	});
	test("changing narrator default to remote does not invalidate real local Write evidence", async () => {
		const { path } = await fixture();
		const before = history();
		const originalIdentity = effects()[0].identityJson;
		db.update(schema.narrators)
			.set({ defaultDeviceId: "remote-not-supported" })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		const plan = await prepared();
		expect(plan.expectedFileCount).toBe(1);
		const response = await http(`revert-plans/${plan.id}/files?limit=1`);
		expect(response.status).toBe(200);
		const page = (await response.json()) as {
			items: RevertPlanFileMetadata[];
			executable: boolean;
		};
		expect(page.executable).toBe(false);
		expect(page.items).toHaveLength(1);
		expect(page.items[0].identityJson).toEqual(originalIdentity);
		expect(page.items[0].identityJson.deviceId).toBe("local");
		expect((await bytes(page.items[0].expectedStateJson)).toString()).toBe("new\n");
		expect((await bytes(page.items[0].desiredStateJson)).toString()).toBe("old\n");
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test("same physical path on a second recorded device remains a separate unsupported candidate", async () => {
		const { path } = await fixture();
		const effect = effects()[0];
		const operation = db
			.select()
			.from(schema.fileChangeOperations)
			.where(eq(schema.fileChangeOperations.id, effect.operationId))
			.get();
		const localScope = scope();
		if (!operation || !effect.executionReceiptJson) throw new Error("Missing actual evidence");
		const call = await toolContext("Write", path, { file_path: path, content: "remote" });
		const scopeId = generateId();
		const operationId = generateId();
		const mutationId = generateId();
		const identity = {
			...effect.identityJson,
			scopeId,
			deviceId: "remote",
			workspaceInstanceId: generateId(),
		};
		const binding = { ...effect.executionReceiptJson.executionBinding, deviceId: "remote" };
		db.insert(schema.fileChangeScopes)
			.values({
				...localScope,
				id: scopeId,
				deviceId: "remote",
				workspaceInstanceId: identity.workspaceInstanceId,
			})
			.run();
		db.insert(schema.fileChangeOperations)
			.values({
				...operation,
				id: operationId,
				sourceId: call.toolCallId,
				toolCallId: call.toolCallId,
				executionBindingJson: binding,
			})
			.run();
		db.insert(schema.fileChangeEffects)
			.values({
				...effect,
				id: generateId(),
				operationId,
				scopeId,
				identityJson: identity,
				fileKey: fileChangeIdentityKey(identity),
				mutationId,
				executionReceiptJson: {
					...effect.executionReceiptJson,
					mutationId,
					executionBinding: binding,
				},
			})
			.run();
		db.update(schema.narratorToolCalls)
			.set({ status: "success", executionDeviceId: "remote", fileChangeOperationId: operationId })
			.where(eq(schema.narratorToolCalls.id, call.toolCallId))
			.run();
		const before = history();
		await refused(await prepare(), "REVERT_PLANNER_UNSUPPORTED_BACKEND");
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("cached source identity is read afresh and missing source is never recreated by preview", async () => {
		await fixture();
		const source = join(getNarraforkHome(), "file-change-source.json");
		const original = await readFile(source);
		restorers.push(() => writeFile(source, original, { mode: 0o600 }));
		await writeFile(source, JSON.stringify({ version: 1, id: randomUUID() }));
		await refused(await prepare(), "REVERT_PLANNER_NAMESPACE_UNAVAILABLE");
		await unlink(source);
		await refused(await prepare(), "REVERT_PLANNER_NAMESPACE_UNAVAILABLE");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test.skipIf(process.platform === "win32")(
		"cached 0775 appdata remains allowed but unsafe blob permissions are not repaired",
		async () => {
			await fixture();
			const directory = getNarraforkHome();
			const blobRoot = join(directory, "file-change-blobs");
			const originalDataMode = (await lstat(directory)).mode & 0o7777;
			const originalBlobMode = (await lstat(blobRoot)).mode & 0o7777;
			restorers.push(async () => {
				await chmod(directory, originalDataMode);
				await chmod(blobRoot, originalBlobMode);
			});
			await chmod(directory, 0o775);
			await chmod(blobRoot, 0o775);
			await refused(await prepare(), "REVERT_PLANNER_NAMESPACE_UNAVAILABLE");
			expect((await lstat(blobRoot)).mode & 0o777).toBe(0o775);
			await chmod(blobRoot, originalBlobMode);
			expect((await prepared()).status).toBe("prepared");
		},
	);
	test("workspace directory replacement cannot reuse a matching current text", async () => {
		const { path } = await fixture();
		const old = `${workspace}-old`;
		await rename(workspace, old);
		await mkdir(workspace);
		await writeFile(path, "new\n");
		restorers.push(() => rm(old, { recursive: true, force: true }));
		const before = history();
		await refused(await prepare(), "REVERT_PLANNER_STALE");
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("legacy tool evidence and retired scopes cannot produce prepared plans", async () => {
		const { call } = await fixture();
		const tool = db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.id, call.toolCallId))
			.get();
		if (!tool) throw new Error("Missing tool");
		db.update(schema.narratorToolCalls)
			.set({ fileChangeOperationId: null })
			.where(eq(schema.narratorToolCalls.id, call.toolCallId))
			.run();
		await refused(await prepare(), "REVERT_PLANNER_EVIDENCE_INCOMPLETE");
		db.update(schema.narratorToolCalls)
			.set({ fileChangeOperationId: tool.fileChangeOperationId })
			.where(eq(schema.narratorToolCalls.id, call.toolCallId))
			.run();
		const ownScope = scope();
		db.update(schema.fileChangeScopes)
			.set({ status: "retired" })
			.where(eq(schema.fileChangeScopes.id, ownScope.id))
			.run();
		await refused(await prepare(), "REVERT_PLANNER_EVIDENCE_INCOMPLETE");
	});
});

describe("live/durable coordinator checks and unchanged state", () => {
	test("HTTP abort during real local read never saves a prepared plan", async () => {
		const { path } = await fixture();
		const before = history();
		const controller = new AbortController();
		const read = fileChangeLocalIo.read;
		let readFinished: Promise<unknown> | undefined;
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation((...args) => {
			const pending = read(...args).then((observed) => {
				controller.abort(new Error("cancel HTTP preview"));
				return observed;
			});
			readFinished = pending;
			return pending;
		});
		try {
			await refused(
				await http("revert-plans", "POST", request(), token, controller.signal),
				"REVERT_PREVIEW_CANCELLED",
			);
		} finally {
			await readFinished?.catch(() => {});
			spy.mockRestore();
		}
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("actual active write lease blocks preview, without consuming another fence", async () => {
		const { path } = await fixture();
		const ownScope = scope();
		const binding = localFileChangeRuntimeBinding();
		if (!binding) throw new Error("Missing runtime");
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const writer = runtime.coordinator.withWrite(
			{ scope: ownScope, runtime: binding },
			async () => {
				entered();
				await gate;
			},
		);
		await started;
		const fence = scope().fencingToken;
		try {
			await refused(await prepare(), "REVERT_PLANNER_ACTIVE_WRITER");
			expect(scope().fencingToken).toBe(fence);
		} finally {
			release();
			await writer;
		}
		expect((await prepared()).status).toBe("prepared");
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("registered activity remains a blocker without pretending the external filesystem is quiescent", async () => {
		await fixture();
		const ownScope = scope();
		const binding = localFileChangeRuntimeBinding();
		if (!binding) throw new Error("Missing runtime");
		const activity = runtime.coordinator.registerActivity({ scope: ownScope, runtime: binding });
		try {
			await refused(await prepare(), "REVERT_PLANNER_ACTIVE_WRITER");
			expect(runtime.coordinator.capture(ownScope).externalFilesystemQuiescence).toBe("unknown");
		} finally {
			runtime.coordinator.endActivity(activity);
		}
	});
	test("another old scope covering the same path cannot hide its durable recovery barrier", async () => {
		await fixture();
		const previous = {
			...scope(),
			id: generateId(),
			workspaceInstanceId: generateId(),
			status: "needs_verification" as const,
		};
		db.insert(schema.fileChangeScopes).values(previous).run();
		restorers.push(() => {
			db.update(schema.fileChangeScopes)
				.set({ status: "retired" })
				.where(eq(schema.fileChangeScopes.id, previous.id))
				.run();
		});
		await refused(await prepare(), "REVERT_PLANNER_ACTIVE_WRITER");
	});
	test("activity between read and final guard invalidates a matching byte observation", async () => {
		const { path } = await fixture();
		const ownScope = scope();
		const binding = localFileChangeRuntimeBinding();
		if (!binding) throw new Error("Missing runtime");
		const read = fileChangeLocalIo.read;
		let observed = false;
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (...args) => {
			const result = await read(...args);
			if (!observed) {
				observed = true;
				const activity = runtime.coordinator.registerActivity({
					scope: ownScope,
					runtime: binding,
				});
				runtime.coordinator.endActivity(activity);
			}
			return result;
		});
		try {
			await refused(await prepare(), "REVERT_PLANNER_STALE");
		} finally {
			spy.mockRestore();
		}
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
	test("plan DB failure preserves disk and history and cannot advertise completion", async () => {
		const { path } = await fixture();
		const before = history();
		const trigger = `preview_fail_${narratorId.replaceAll("-", "_")}`;
		sqlite.exec(
			`CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON revert_operations WHEN NEW.narrator_id='${narratorId}' BEGIN SELECT RAISE(ABORT,'preview test save failure'); END`,
		);
		restorers.push(() => {
			sqlite.exec(`DROP TRIGGER ${trigger}`);
		});
		await refused(await prepare());
		expect(history()).toBe(before);
		expect(await readFile(path, "utf8")).toBe("new\n");
	});
});

describe("strict preview request/response surface", () => {
	test("workspace, unrevert, skipRevert, caller proofs and spoofed principals are rejected", async () => {
		await fixture();
		const before = history();
		for (const extra of [
			{ revertScope: "workspace" },
			{ kind: "unrevert" },
			{ skipRevert: true },
			{ principal: { userId: otherId, isAdmin: true } },
			{ projectId },
			{ subjectKey: "human:admin" },
			{ manifestProof: { computation: "complete" } },
			{ confirmOutsideRoots: true },
		]) {
			const response = await prepare(extra);
			expect(response.status).toBe(400);
			await refused(response);
		}
		expect(history()).toBe(before);
	});
	test("request byte budget runs before the general 128MiB attachment body collector", async () => {
		await fixture();
		const huge = "x".repeat(FILE_CHANGE_LIMITS.summaryBytes + 1);
		const response = await http("revert-plans", "POST", request({ idempotencyKey: huge }));
		expect(response.status).toBe(413);
		expect((await response.json()).code).toBe("REVERT_PREVIEW_REQUEST_TOO_LARGE");
		expect(ownPlans()).toHaveLength(0);
	});
	test("file pagination stays strict; raw/delete stay absent and legacy unbound plans cannot apply", async () => {
		const { path } = await fixture();
		const plan = await prepared();
		const before = history();
		for (const query of [
			"limit=101",
			"limit=0",
			"limit=abc",
			"cursor=bad",
			"cursor=../secret",
			"subjectKey=human:someone",
		])
			expect((await http(`revert-plans/${plan.id}/files?${query}`)).status).toBe(400);
		for (const endpoint of [`revert-plans/${plan.id}/raw-dump`, `revert-plans/${plan.id}/delete`])
			expect(
				(await http(endpoint, endpoint.endsWith("raw-dump") ? "GET" : "POST", undefined)).status,
			).toBe(404);
		// A valid new apply request must explicitly reject the old preview-only
		// manifest. Merely deleting the historical apply-404 assertion hides a bypass.
		for (const action of ["revert_files", "delete_tool_block", "rollback_to_block"] as const) {
			const body = await boundedJson(await apply(plan, action), 409);
			expect(body.code).toMatch(/ACTION/);
		}
		expect(journalFiles(plan).every((file) => file.receiptJson === null)).toBe(true);
		expect(await readFile(path, "utf8")).toBe("new\n");
		expect(history()).toBe(before);
	});
	test("schemas reject nested unknowns and unsafe integers without normalizing the original selector", () => {
		const body = request({ selector: { kind: "messages", messageIds: ["b", "a", "b"] } });
		expect(createRevertPlanSchema.parse(body).selector).toEqual({
			kind: "messages",
			messageIds: ["b", "a", "b"],
		});
		for (const extra of [
			{ expectedMessageVersion: Number.MAX_SAFE_INTEGER + 1 },
			{ idempotencyKey: "中".repeat(100) },
			{ selector: { kind: "all", complete: true } },
			{ selector: { kind: "tool_calls", toolCallIds: [] } },
			{ kind: "rollback_to_block", selector: { kind: "all" } },
		])
			expect(createRevertPlanSchema.safeParse(request(extra)).success).toBe(false);
		expect(revertPlanFilesQuerySchema.parse({ limit: "100", cursor: "a".repeat(64) })).toEqual({
			limit: 100,
			cursor: "a".repeat(64),
		});
	});
});
