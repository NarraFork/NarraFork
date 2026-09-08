import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
import { FILE_CHANGE_LIMITS, type FileChangeState } from "@shared/file-change-protocol";
import { eq, inArray } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db, sqlite } from "../db";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { createToken } from "../lib/auth";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import { createRevertPlanSchema, revertPlanFilesQuerySchema } from "../lib/validators/narrators";
import { fileChangeIdentityKey } from "./file-change-identity";
import { fileChangeLocalIo } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import type { RevertPlanFileMetadata, RevertPlanSummary } from "./revert-plan-service";
import { RevertPlannerLocalAccess } from "./revert-planner-local-access";

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
function http(
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
async function toolContext(name: "Write" | "Edit", path: string, input: Record<string, unknown>) {
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
	const messageId = generateId();
	db.insert(schema.narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [
				{ type: "text", text: "keep" },
				{ type: "tool_use", id: toolUseId, name, input },
			],
			createdAt: now(),
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: ++sequence })
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
	return { ctx, toolCallId, messageId };
}
async function write(path: string, content: string) {
	const input = { file_path: path, content };
	const call = await toolContext("Write", path, input);
	const result = await writeTool.execute(input, call.ctx);
	expect(result.isError, String(result.output)).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success" })
		.where(eq(schema.narratorToolCalls.id, call.toolCallId))
		.run();
	return call;
}
async function edit(path: string, old_string: string, new_string: string) {
	const input = { file_path: path, old_string, new_string };
	const call = await toolContext("Edit", path, input);
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
	test("file pagination rejects invalid cursors and excessive limits; no raw/apply endpoint exists", async () => {
		await fixture();
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
		for (const endpoint of [
			`revert-plans/${plan.id}/raw-dump`,
			`revert-plans/${plan.id}/apply`,
			`revert-plans/${plan.id}/delete`,
		])
			expect(
				(await http(endpoint, endpoint.endsWith("raw-dump") ? "GET" : "POST", undefined)).status,
			).toBe(404);
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
