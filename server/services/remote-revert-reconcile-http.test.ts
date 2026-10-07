import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db } from "../db";
import {
	fileChangeScopes,
	narrators,
	revertOperationFiles,
	revertOperations,
	users,
} from "../db/schema";
import { createToken } from "../lib/auth";
import { generateId } from "../lib/id";
import { createFileChangeIdentity } from "./file-change-identity";

// Real authenticated HTTP and disposable preload DB. Native receipt reconciliation
// is independently exercised by remote-workspace-history-runtime.test.ts and the
// official Go fixture; these tests do not substitute fake native proof for it.
let root: string;
let narratorId: string;
let userId: string;
let otherId: string;
let planId: string;
let token: string;
let otherToken: string;
const planHash = "a".repeat(64);

beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(testEnvironment.isolatedHome, "reconcile-http-"));
	userId = generateId();
	otherId = generateId();
	narratorId = generateId();
	planId = generateId();
	const now = new Date().toISOString();
	for (const id of [userId, otherId]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "test", role: "user", createdAt: now })
			.run();
	}
	db.insert(narrators)
		.values({
			id: narratorId,
			title: "reconcile HTTP fixture",
			cwd: root,
			ownerUserId: userId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(revertOperations)
		.values({
			id: planId,
			narratorId,
			requestedBySubjectKey: `human:${userId}`,
			idempotencyKey: planId,
			requestDigest: "b".repeat(64),
			kind: "history_delete",
			scope: "narrator",
			selectorKind: "all",
			planHash,
			status: "committed",
			expiresAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	token = await createToken(userId, "user");
	otherToken = await createToken(otherId, "user");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function request(body: unknown, bearer = token, id = planId) {
	return app.request(`http://localhost/api/narrators/${narratorId}/revert-plans/${id}/reconcile`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

test("reconcile requires real authentication and narrator write access", async () => {
	expect((await request({ planHash }, "")).status).toBe(401);
	const denied = await request({ planHash }, otherToken);
	expect([403, 404]).toContain(denied.status);
	expect(
		db.select().from(revertOperations).where(eq(revertOperations.id, planId)).get()?.status,
	).toBe("committed");
});

test("reconcile accepts only the exact hash envelope and valid immutable plan id", async () => {
	for (const body of [
		{},
		{ planHash: "bad" },
		{ planHash, deviceId: "local" },
		{ planHash, actorUserId: userId },
		{ planHash, root },
		{ planHash, force: true },
	]) {
		expect((await request(body)).status).toBe(400);
	}
	expect((await request({ planHash }, token, "bad-id")).status).toBe(400);
});

test("reconcile rejects malformed and oversized JSON before control admission", async () => {
	const endpoint = `http://localhost/api/narrators/${narratorId}/revert-plans/${planId}/reconcile`;
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	expect((await app.request(endpoint, { method: "POST", headers, body: "{" })).status).toBe(400);
	expect(
		(
			await app.request(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ planHash, padding: "x".repeat(1024 * 1024) }),
			})
		).status,
	).toBe(413);
});

test("wrong owner, hash, missing plan and uncommitted plan cannot admit recovery", async () => {
	expect((await request({ planHash: "c".repeat(64) })).status).toBe(404);
	expect((await request({ planHash }, token, generateId())).status).toBe(404);
	db.update(revertOperations)
		.set({ requestedBySubjectKey: `human:${otherId}` })
		.where(eq(revertOperations.id, planId))
		.run();
	expect((await request({ planHash })).status).toBe(404);
	db.update(revertOperations)
		.set({ requestedBySubjectKey: `human:${userId}`, status: "prepared" })
		.where(eq(revertOperations.id, planId))
		.run();
	expect((await request({ planHash })).status).toBe(404);
});

test("metadata-only committed plan does not invent a remote barrier release", async () => {
	const response = await request({ planHash });
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({ planId, status: "committed", barrierReleased: false });
});

test("missing original remote lease retains the recorded barrier instead of inferring recovery", async () => {
	const scopeId = generateId();
	const timestamp = new Date().toISOString();
	const scope = {
		id: scopeId,
		sourceInstanceId: generateId(),
		deviceId: "remote-reconcile-fixture",
		workspaceInstanceId: generateId(),
		pathFlavor: "posix" as const,
		canonicalRoot: "/recorded/remote/root",
	};
	db.insert(fileChangeScopes)
		.values({
			...scope,
			displayRoot: scope.canonicalRoot,
			status: "active",
			fencingToken: 7,
			activeLeaseId: "original-lease-with-missing-row",
			activeLeaseEpoch: "original-epoch",
			activeMutationCount: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	const identity = createFileChangeIdentity(scope, {
		deviceId: scope.deviceId,
		pathFlavor: "posix",
		lexicalPath: `${scope.canonicalRoot}/a.txt`,
		canonicalPath: `${scope.canonicalRoot}/a.txt`,
		objectRole: "entry",
	});
	db.insert(revertOperationFiles)
		.values({
			id: generateId(),
			revertOperationId: planId,
			scopeId,
			fileKey: "missing-lease-file",
			identityJson: identity,
			sequence: 0,
			expectedStateJson: { kind: "absent" },
			desiredStateJson: { kind: "absent" },
			applyMutationId: generateId(),
			applyRequestDigest: "d".repeat(64),
			compensateMutationId: generateId(),
			compensateRequestDigest: "e".repeat(64),
			status: "verified",
			updatedAt: timestamp,
		})
		.run();
	const response = await request({ planHash });
	expect(response.status).toBe(409);
	const body = await response.json();
	expect(body.status).toBe("recovery_required");
	expect(body.barrierReleased).toBe(false);
	expect(body.reason).toContain("No unique original remote revert lease");
	const retained = db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, scopeId)).get();
	expect(retained?.activeLeaseId).toBe("original-lease-with-missing-row");
	expect(retained?.activeMutationCount).toBe(1);
	expect(retained?.fencingToken).toBe(7);
});
