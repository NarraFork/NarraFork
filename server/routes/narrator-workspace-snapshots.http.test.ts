import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteHistoryObject, RemoteHistoryReceipt } from "@shared/remote-history-protocol";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db, sqlite } from "../db";
import {
	aclGrants,
	fileChangeScopes,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	remoteTreeCaptures,
	revertOperations,
	users,
} from "../db/schema";
import { createToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { LocalFileChangeRuntime } from "../services/file-change-runtime";
import { remoteHistoryObjectId } from "../services/remote-history-service";
import {
	RemoteWorkspaceHistoryRuntime,
	withRemoteWorkspaceHistoryRuntime,
} from "../services/remote-workspace-history-runtime";
import { RemoteWorkspaceRestoreService } from "../services/remote-workspace-restore-service";
import {
	fingerprintRevertPlanFiles,
	type RevertPlanHeader,
	type RevertPlanManifestProof,
	RevertPlanService,
	revertPlanHeaderDigest,
} from "../services/revert-plan-service";

// Real app/auth/ACL and disposable preload SQLite. Registry-injected tests use
// actual restore authority/service. Dispatch-outcome tests explicitly simulate the
// service boundary only: they prove HTTP classification, NOT native success.
// Official native end-to-end proof belongs to remote-workspace-restore-service.test.ts.
let directory: string;
let userId: string;
let otherId: string;
let narratorId: string;
let toolCallId: string;
let scopeId: string;
let sourceInstanceId: string;
let workspaceInstanceId: string;
let token: string;
let otherToken: string;
let registry: RemoteWorkspaceHistoryRuntime;
const originalRoot = "/original/remote/root";
const treeDigest = "a".repeat(64);
const timestamp = "2026-09-01T00:00:00.000Z";
let backendCalls = 0;

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	directory = await mkdtemp(join(testEnvironment.isolatedHome, "workspace-snapshot-http-"));
	userId = generateId();
	otherId = generateId();
	narratorId = generateId();
	toolCallId = generateId();
	scopeId = generateId();
	sourceInstanceId = generateId();
	workspaceInstanceId = generateId();
	backendCalls = 0;
	for (const id of [userId, otherId])
		db.insert(users)
			.values({ id, username: id, passwordHash: "test", role: "user", createdAt: timestamp })
			.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			title: "snapshot HTTP fixture",
			cwd: directory,
			ownerUserId: userId,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	const messageId = generateId();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: "[]",
			createdAt: timestamp,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId: generateId(),
			toolName: "Bash",
			createdAt: timestamp,
		})
		.run();
	db.insert(fileChangeScopes)
		.values({
			id: scopeId,
			sourceInstanceId,
			workspaceInstanceId,
			deviceId: "snapshot-remote-fixture",
			canonicalRoot: originalRoot,
			displayRoot: "/display/alias",
			rootIdentityJson: { object: "original-root-identity" },
			pathFlavor: "posix",
			status: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	token = await createToken(userId, "user");
	otherToken = await createToken(otherId, "user");
	registry = new RemoteWorkspaceHistoryRuntime({
		db,
		auditRuntime: new LocalFileChangeRuntime({
			db,
			privateRoot: join(directory, "private-audit"),
			blobStoreOptions: { minimumFreeBytes: 0 },
		}),
		backend() {
			backendCalls++;
			throw new Error("Private backend unavailable: /must/not/leak");
		},
		async authorize() {
			throw new Error("No remote authority granted by HTTP fixture");
		},
	});
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function capture(overrides: Partial<typeof remoteTreeCaptures.$inferInsert> = {}) {
	const id = generateId();
	const descriptor: RemoteHistoryObject = {
		algorithm: "sha256",
		digest: treeDigest,
		sizeBytes: 100,
		sourceInstanceId,
		workspaceInstanceId,
		scopeId,
		objectId: remoteHistoryObjectId(scopeId, "tree", treeDigest, ""),
		kind: "tree",
		path: "",
	};
	const receipt: RemoteHistoryReceipt = {
		binding: {
			sourceInstanceId,
			workspaceInstanceId,
			scopeId,
			root: originalRoot,
			rootIdentity: "original-root-identity",
			fence: 0,
		},
		operationId: id,
		requestDigest: treeDigest,
		payloadDigest: treeDigest,
		kind: "capture",
		state: "settled",
		effects: [],
		tree: descriptor,
		captureKind: "whole_directory",
		coverage: "complete",
		consistency: "stable_double_scan",
		policyDigest: treeDigest,
		entryCount: 0,
		startedAt: timestamp,
		reason: "PRIVATE_RECEIPT_BODY",
	};
	db.insert(remoteTreeCaptures)
		.values({
			id,
			narratorId,
			toolCallId,
			attempt: 1,
			edge: "before",
			deviceId: "snapshot-remote-fixture",
			contextKey: "original-context-key",
			workspaceRevision: 7,
			sourceInstanceId,
			workspaceInstanceId,
			scopeId,
			rootIdentity: "original-root-identity",
			remoteOperationId: id,
			requestDigest: treeDigest,
			actorSubjectKey: `human:${userId}`,
			state: "complete",
			descriptorJson: descriptor,
			receiptMetadataJson: receipt,
			originContextVersion: 1,
			originProjectId: null,
			createdAt: timestamp,
			updatedAt: timestamp,
			...overrides,
		})
		.run();
	return { id, descriptor, receipt };
}
function request(path: string, body?: unknown, bearer = token) {
	return withRemoteWorkspaceHistoryRuntime(registry, () =>
		app.request(`http://localhost/api/narrators/${narratorId}/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
function confirmation(captureId: string) {
	return {
		kind: "snapshot_restore",
		captureId,
		deviceId: "snapshot-remote-fixture",
		root: originalRoot,
		rootIdentity: "original-root-identity",
		treeDigest,
	} as const;
}
function grant(capability: "read" | "write") {
	db.insert(aclGrants)
		.values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: narratorId,
			principalType: "user",
			principalId: otherId,
			capability,
			grantedBy: userId,
			createdAt: timestamp,
		})
		.run();
}

test("real authentication and independent read/write ACL gates", async () => {
	const item = capture();
	const body = { captureId: item.id, idempotencyKey: generateId() };
	expect((await request("workspace-snapshots", undefined, "")).status).toBe(401);
	expect((await request("workspace-snapshot-restores/preview", body, "")).status).toBe(401);
	expect((await request("workspace-snapshots", undefined, otherToken)).status).toBe(404);
	grant("read");
	const readable = await request("workspace-snapshots", undefined, otherToken);
	expect(readable.status).toBe(200);
	expect(await readable.json()).toEqual({ items: [] });
	expect((await request("workspace-snapshot-restores/preview", body, otherToken)).status).toBe(404);
	for (const phase of ["apply", "recover"])
		expect(
			(
				await request(
					`workspace-snapshot-restores/${generateId()}/${phase}`,
					{ planHash: treeDigest, confirmation: confirmation(item.id) },
					otherToken,
				)
			).status,
		).toBe(404);
	expect(backendCalls).toBe(0);
});

test("snapshot middleware does not shadow or rewrite unrelated narrator routes", async () => {
	const response = await request("permissions");
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).not.toBe("no-store");
	expect(backendCalls).toBe(0);
});

test("a real write grant forwards the fresh requesting human into the actual service", async () => {
	const item = capture({ actorSubjectKey: `human:${otherId}` });
	grant("write");
	const prepare = spyOn(RemoteWorkspaceRestoreService.prototype, "prepare");
	try {
		const response = await request(
			"workspace-snapshot-restores/preview",
			{ captureId: item.id, idempotencyKey: generateId() },
			otherToken,
		);
		expect(response.status).toBe(409);
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare.mock.calls[0]?.[0].principal).toEqual({ userId: otherId, isAdmin: false });
		expect(backendCalls).toBe(1);
	} finally {
		prepare.mockRestore();
	}
});

test("feed combines only this narrator actor and the actual requesting human", async () => {
	const ownerHuman = capture();
	const otherHuman = capture({ actorSubjectKey: `human:${otherId}` });
	const automatic = capture({ actorSubjectKey: `narrator:${narratorId}` });
	capture({ actorSubjectKey: `primary:${userId}` });
	capture({ actorSubjectKey: `narrator:${generateId()}` });
	grant("read");
	for (const [bearer, humanId] of [
		[token, ownerHuman.id],
		[otherToken, otherHuman.id],
	]) {
		const response = await request("workspace-snapshots", undefined, bearer);
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.items).toHaveLength(2);
		expect(result.items.map((item: { id: string }) => item.id).sort()).toEqual(
			[humanId, automatic.id].sort(),
		);
		for (const item of result.items) expect(item.restorableCandidate).toBe(true);
	}
	expect(backendCalls).toBe(0);
});

test("metadata feed caps at 32, keyset cursor has no duplicate ties, and SQL excludes raw payload/COUNT", async () => {
	const ids = Array.from({ length: 35 }, () => capture().id)
		.sort()
		.reverse();
	const prepare = spyOn(sqlite, "prepare");
	try {
		const first = await request("workspace-snapshots");
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const page = await first.json();
		expect(page.items).toHaveLength(32);
		expect(page.items.map((item: { id: string }) => item.id)).toEqual(ids.slice(0, 32));
		const next = await (await request(`workspace-snapshots?cursor=${page.nextCursor}`)).json();
		expect(next.items.map((item: { id: string }) => item.id)).toEqual(ids.slice(32));
		expect(next.nextCursor).toBeUndefined();
		expect(
			new Set([...page.items, ...next.items].map((item: { id: string }) => item.id)).size,
		).toBe(35);
		const output = JSON.stringify(page);
		for (const privateField of [
			"receiptMetadataJson",
			"descriptorJson",
			"PRIVATE_RECEIPT_BODY",
			"private-tree-object",
			"rawtree",
			"blob",
			"COUNT",
		])
			expect(output).not.toContain(privateField);
		const queries = prepare.mock.calls
			.map(([query]) => query)
			.filter((query) => query.includes('from "remote_tree_captures"'));
		expect(queries).toHaveLength(2);
		for (const query of queries) {
			expect(query).not.toMatch(/count\s*\(/i);
			expect(query).not.toContain("receipt_metadata_json");
			expect(query).toContain(" limit ?");
			expect(query).not.toMatch(/select\s+\*/i);
		}
	} finally {
		prepare.mockRestore();
	}
	expect(backendCalls).toBe(0);
});

test("immutable captured source survives current cwd/project switch and original project deletion", async () => {
	const originProjectId = generateId();
	const currentProjectId = generateId();
	for (const id of [originProjectId, currentProjectId])
		db.insert(projects)
			.values({
				id,
				name: id,
				ownerUserId: userId,
				visibility: "private",
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
	const original = capture({ originProjectId });
	db.update(narrators)
		.set({ cwd: "/different/current/cwd", contextProjectId: currentProjectId })
		.where(eq(narrators.id, narratorId))
		.run();
	db.delete(projects).where(eq(projects.id, originProjectId)).run();
	const response = await request("workspace-snapshots");
	expect(response.status).toBe(200);
	const item = (await response.json()).items[0];
	expect(item).toMatchObject({
		id: original.id,
		root: originalRoot,
		rootIdentity: "original-root-identity",
		sourceInstanceId,
		scopeId,
		contextKey: "original-context-key",
		workspaceRevision: 7,
		originProjectId,
		originContextVersion: 1,
		treeDigest,
	});
	expect(JSON.stringify(item)).not.toContain("/different/current/cwd");
	const preview = await request("workspace-snapshot-restores/preview", {
		captureId: original.id,
		idempotencyKey: generateId(),
	});
	expect(preview.status).toBe(404);
	expect(backendCalls).toBe(0);
});

test("legacy/partial/local/malformed digest and mismatched scope cannot claim restorable candidates", async () => {
	const legacy = capture({ originContextVersion: null });
	const partial = capture({ state: "partial" });
	const local = capture({ deviceId: "local" });
	const wrongScope = capture({ sourceInstanceId: generateId() });
	const malformed = capture();
	db.update(remoteTreeCaptures)
		.set({ descriptorJson: sql`${"{not JSON"}` })
		.where(eq(remoteTreeCaptures.id, malformed.id))
		.run();
	const oversized = capture();
	db.update(remoteTreeCaptures)
		.set({
			descriptorJson: sql`${JSON.stringify({ digest: treeDigest, padding: "x".repeat(20_000) })}`,
		})
		.where(eq(remoteTreeCaptures.id, oversized.id))
		.run();
	const response = await request("workspace-snapshots");
	expect(response.status).toBe(200);
	const items = (await response.json()).items;
	expect(items).toHaveLength(6);
	for (const item of items) expect(item.restorableCandidate).toBe(false);
	expect(items.find((item: { id: string }) => item.id === legacy.id).originProjectId).toBeNull();
	expect(items.find((item: { id: string }) => item.id === wrongScope.id).root).toBeNull();
	for (const id of [malformed.id, oversized.id])
		expect(items.find((item: { id: string }) => item.id === id).treeDigest).toBeNull();
	for (const id of [legacy.id, partial.id, local.id, wrongScope.id])
		expect(
			(
				await request("workspace-snapshot-restores/preview", {
					captureId: id,
					idempotencyKey: generateId(),
				})
			).status,
		).toBe(409);
	expect(backendCalls).toBe(0);
});

test("strict bounded canonical cursor and query validation", async () => {
	capture();
	const canonical = Buffer.from(
		JSON.stringify({ version: 1, createdAt: timestamp, id: generateId() }),
	).toString("base64url");
	const invalid = [
		"bad!",
		"a".repeat(257),
		`${canonical}=`,
		Buffer.from(JSON.stringify({ version: 2, createdAt: timestamp, id: generateId() })).toString(
			"base64url",
		),
		Buffer.from(
			JSON.stringify({ version: 1, createdAt: timestamp, id: generateId(), actorUserId: userId }),
		).toString("base64url"),
		Buffer.from(`{ "version": 1, "createdAt": "${timestamp}", "id": "${generateId()}" }`).toString(
			"base64url",
		),
	];
	for (const cursor of invalid)
		expect((await request(`workspace-snapshots?cursor=${encodeURIComponent(cursor)}`)).status).toBe(
			400,
		);
	for (const query of ["limit=0", "limit=33", "limit=1.5", "limit=", "actorUserId=x", "root=alias"])
		expect((await request(`workspace-snapshots?${query}`)).status).toBe(400);
	expect((await request("workspace-snapshots?limit=1")).status).toBe(200);
});

test("preview rejects unknown aliases, malformed ids, identifier abuse and malformed/oversized JSON", async () => {
	const item = capture();
	const body = { captureId: item.id, idempotencyKey: generateId() };
	for (const invalid of [
		{ ...body, captureId: "bad" },
		{ ...body, idempotencyKey: "x".repeat(129) },
		{ ...body, idempotencyKey: "unsafe / alias" },
		...["actorUserId", "projectId", "cwd", "root", "force"].map((field) => ({
			...body,
			[field]: "unsafe",
		})),
	])
		expect((await request("workspace-snapshot-restores/preview", invalid)).status).toBe(400);
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	for (const [body, status] of [
		["{", 400],
		[JSON.stringify({ padding: "x".repeat(70_000) }), 413],
	] as const) {
		const response = await app.request(
			`http://localhost/api/narrators/${narratorId}/workspace-snapshot-restores/preview`,
			{ method: "POST", headers, body },
		);
		expect(response.status).toBe(status);
	}
	expect(backendCalls).toBe(0);
});

test("chunked body limit rejects unknown-length oversized input before restore admission", async () => {
	let cancelled = false;
	const encoder = new TextEncoder();
	const chunks = [
		encoder.encode('{"padding":"'),
		encoder.encode("x".repeat(40_000)),
		encoder.encode("x".repeat(40_000)),
		encoder.encode('"}'),
	];
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks.shift();
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	const prepare = spyOn(RemoteWorkspaceRestoreService.prototype, "prepare");
	try {
		const response = await app.request(
			new Request(
				`http://localhost/api/narrators/${narratorId}/workspace-snapshot-restores/preview`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: stream,
				},
			),
		);
		expect(response.status).toBe(413);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(cancelled).toBe(true);
		expect(prepare).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
	}
});

test("apply/recover accept only exact consent fields and bound immutable plan ids", async () => {
	const item = capture();
	const body = { planHash: treeDigest, confirmation: confirmation(item.id) };
	for (const phase of ["apply", "recover"]) {
		const path = `workspace-snapshot-restores/${generateId()}/${phase}`;
		for (const invalid of [
			{ ...body, planHash: "bad" },
			{ ...body, actorUserId: userId },
			{ ...body, onMutationDispatch: true },
			{ ...body, possibleMutationDispatch: true },
			{ ...body, root: originalRoot },
			{ ...body, confirmation: { ...body.confirmation, force: true } },
			{ ...body, confirmation: { ...body.confirmation, root: "a\0b" } },
			{ ...body, confirmation: { ...body.confirmation, rootIdentity: "" } },
			{ ...body, confirmation: { ...body.confirmation, deviceId: "x".repeat(129) } },
			{ ...body, confirmation: { ...body.confirmation, kind: "revert" } },
		])
			expect((await request(path, invalid)).status).toBe(400);
		expect((await request(`workspace-snapshot-restores/bad/${phase}`, body)).status).toBe(400);
	}
	expect(backendCalls).toBe(0);
});

test("actual production restore authority rechecks original scope and cannot treat candidate as ready", async () => {
	const item = capture();
	const feed = await (await request("workspace-snapshots")).json();
	expect(feed.items[0].restorableCandidate).toBe(true);
	db.update(fileChangeScopes)
		.set({ canonicalRoot: "/changed/source/root" })
		.where(eq(fileChangeScopes.id, scopeId))
		.run();
	const preview = await request("workspace-snapshot-restores/preview", {
		captureId: item.id,
		idempotencyKey: generateId(),
	});
	expect(preview.status).toBe(409);
	expect((await preview.json()).code).toBe("WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE");
	expect(backendCalls).toBe(0);
	db.update(fileChangeScopes)
		.set({ canonicalRoot: originalRoot })
		.where(eq(fileChangeScopes.id, scopeId))
		.run();
	const unavailable = await request("workspace-snapshot-restores/preview", {
		captureId: item.id,
		idempotencyKey: generateId(),
	});
	expect(unavailable.status).toBe(409);
	expect(unavailable.headers.get("cache-control")).toBe("no-store");
	expect(await unavailable.text()).not.toContain("/must/not/leak");
	expect(backendCalls).toBe(1);
});

async function consentPlan(captureId: string) {
	const signal = AbortSignal.timeout(20_000);
	const namespace = await registry.auditNamespace(signal);
	const namespaceKey = namespace.catalog.getBudget()?.namespaceKey;
	if (!namespaceKey) throw new Error("Isolated namespace missing");
	const publish = (value: unknown) => {
		const bytes = new TextEncoder().encode(JSON.stringify(value));
		return namespace.store.putBytes(bytes, { expectedSize: bytes.byteLength, signal });
	};
	const owner = { subjectKey: `human:${userId}`, narratorId, projectId: null };
	const header: RevertPlanHeader = {
		...owner,
		idempotencyKey: generateId(),
		requestDigest: "b".repeat(64),
		kind: "revert",
		revertScope: "workspace",
		selectorKind: "all",
		selector: await publish({ fixture: "selector" }),
		historyManifest: await publish({ fixture: "no-history" }),
		expectedMessageVersion: 0,
		expectedFileCount: 0,
	};
	const fingerprint = fingerprintRevertPlanFiles([]);
	const proof: RevertPlanManifestProof = {
		source: "trusted_published_planner_v1",
		headerDigest: revertPlanHeaderDigest(header),
		orderedFilesDigest: fingerprint.orderedFilesDigest,
		fileEvidenceBytes: fingerprint.fileEvidenceBytes,
		computation: "complete",
		selectorCoverage: "complete",
		historyCoverage: "complete",
		omittedFiles: 0,
		unknownFiles: 0,
	};
	const plan = await publish({
		purpose: "remote_workspace_snapshot_restore_v1",
		owner,
		header,
		proof,
		confirmation: confirmation(captureId),
		changes: [],
		files: [],
	});
	return new RevertPlanService(db, { namespaceKey }).prepare(
		{ ...header, plan, manifestProof: proof },
		[],
		{ signal },
	);
}

test("actual apply and recover reject wrong explicit consent before any native dispatch", async () => {
	const item = capture();
	const plan = await consentPlan(item.id);
	const actualApply = RemoteWorkspaceRestoreService.prototype.apply;
	let dispatchObservers = 0;
	const apply = spyOn(RemoteWorkspaceRestoreService.prototype, "apply").mockImplementation(
		function (this: RemoteWorkspaceRestoreService, input) {
			return actualApply.call(this, {
				...input,
				onMutationDispatch() {
					dispatchObservers++;
					input.onMutationDispatch?.();
				},
			});
		},
	);
	const recover = spyOn(RemoteWorkspaceRestoreService.prototype, "recover");
	try {
		for (const phase of ["apply", "recover"]) {
			const response = await request(`workspace-snapshot-restores/${plan.id}/${phase}`, {
				planHash: plan.planHash,
				confirmation: { ...confirmation(item.id), treeDigest: "c".repeat(64) },
			});
			expect(response.status).toBe(409);
			expect((await response.json()).code).toBe("WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE");
		}
		expect(apply).toHaveBeenCalledTimes(1);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(apply.mock.calls[0]?.[0].principal).toEqual({ userId, isAdmin: false });
		expect(apply.mock.calls[0]?.[0].onMutationDispatch).toBeFunction();
		expect(dispatchObservers).toBe(0);
		await expect(apply.mock.results[0]?.value).rejects.toThrow("consent");
		await expect(recover.mock.results[0]?.value).rejects.toThrow("consent");
		expect(
			db
				.select({ status: revertOperations.status })
				.from(revertOperations)
				.where(eq(revertOperations.id, plan.id))
				.get()?.status,
		).toBe("prepared");
		expect(backendCalls).toBe(0);
	} finally {
		apply.mockRestore();
		recover.mockRestore();
	}
});

// These observer fault fixtures simulate only the service/HTTP boundary. No
// remote dispatch occurs and their synthetic result is not native commit proof.
test("HTTP classifies a possible dispatch followed by real ACL revocation as unknown", async () => {
	const item = capture();
	const planId = generateId();
	let observerCalled = false;
	const apply = spyOn(RemoteWorkspaceRestoreService.prototype, "apply").mockImplementation(
		async (input) => {
			input.onMutationDispatch?.();
			observerCalled = true;
			db.update(narrators).set({ ownerUserId: otherId }).where(eq(narrators.id, narratorId)).run();
			return { planId: input.planId, status: "committed", restoredFileCount: 1 };
		},
	);
	try {
		const response = await request(`workspace-snapshot-restores/${planId}/apply`, {
			planHash: treeDigest,
			confirmation: confirmation(item.id),
		});
		expect(observerCalled).toBe(true);
		expect(response.status).toBe(409);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json();
		expect(body.code).toBe("WORKSPACE_SNAPSHOT_RESTORE_OUTCOME_UNKNOWN");
		expect(body.error).toContain("retain the original restore receipt");
		expect(JSON.stringify(body)).not.toContain(originalRoot);
		expect(backendCalls).toBe(0);
	} finally {
		apply.mockRestore();
	}
});

test("HTTP sanitizes typed/plain/timeout faults after the real dispatch observer boundary", async () => {
	const item = capture();
	const privateMessage = `PRIVATE_PROOF:${originalRoot}:${treeDigest}`;
	const errors = [
		new Error(privateMessage),
		new AppError(privateMessage, 403, "FORBIDDEN"),
		new DOMException(privateMessage, "TimeoutError"),
		new DOMException(privateMessage, "AbortError"),
	];
	const apply = spyOn(RemoteWorkspaceRestoreService.prototype, "apply");
	try {
		for (const error of errors) {
			apply.mockImplementation(async (input) => {
				input.onMutationDispatch?.();
				throw error;
			});
			const response = await request(`workspace-snapshot-restores/${generateId()}/apply`, {
				planHash: treeDigest,
				confirmation: confirmation(item.id),
			});
			expect(response.status).toBe(409);
			const body = await response.json();
			expect(body.code).toBe("WORKSPACE_SNAPSHOT_RESTORE_OUTCOME_UNKNOWN");
			expect(JSON.stringify(body)).not.toContain(privateMessage);
			expect(JSON.stringify(body)).not.toContain(originalRoot);
			expect(JSON.stringify(body)).not.toContain(treeDigest);
		}
		expect(apply).toHaveBeenCalledTimes(errors.length);
		expect(backendCalls).toBe(0);
	} finally {
		apply.mockRestore();
	}
});

test("HTTP preserves typed preflight refusal when no dispatch observer has fired", async () => {
	const item = capture();
	const apply = spyOn(RemoteWorkspaceRestoreService.prototype, "apply").mockImplementation(
		async () => {
			throw new AppError("Preflight authority denied", 403, "FORBIDDEN");
		},
	);
	try {
		const response = await request(`workspace-snapshot-restores/${generateId()}/apply`, {
			planHash: treeDigest,
			confirmation: confirmation(item.id),
		});
		expect(response.status).toBe(403);
		expect((await response.json()).code).toBe("FORBIDDEN");
		expect(apply.mock.calls[0]?.[0].onMutationDispatch).toBeFunction();
		expect(backendCalls).toBe(0);
	} finally {
		apply.mockRestore();
	}
});
