import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, narratorProjectLinks, narrators, projects, users } from "../../db/schema";
import { toDatabaseReadUnavailablePayload } from "../../lib/app-error-response";
import * as workerPool from "../../lib/db-worker/pool";
import { AppError, ForbiddenError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { executionPolicyRepository } from "../execution-policy/repository";
import { loadNarratorForAccess } from "../narrator-acl";
import { resolveProjectIdForNarratorId } from "../narrator-project";
import { loadProjectForAccess } from "../project-acl";

const id = { user: generateId(), project: generateId(), root: generateId(), child: generateId() };
const principal = { userId: id.user, isAdmin: false };

beforeAll(async () => {
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: id.user, username: id.user, passwordHash: "x", createdAt: now });
	await db.insert(projects).values({
		id: id.project,
		name: id.project,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db
		.insert(narrators)
		.values({ id: id.root, visibility: "private", createdAt: now, updatedAt: now });
	await db.insert(narrators).values({
		id: id.child,
		type: "subagent",
		aclRootNarratorId: id.root,
		parentNarratorId: id.root,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorProjectLinks).values({
		narratorId: id.root,
		projectId: id.project,
		role: "primary",
		source: "cwd",
		directory: "/authority-budget",
		updatedAt: now,
	});
	for (const [scopeType, scopeId] of [
		["project", id.project],
		["narrator", id.root],
	] as const) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType,
			scopeId,
			principalType: "user",
			principalId: id.user,
			capability: "write",
			createdAt: now,
		});
	}
});

afterAll(async () => {
	await db.delete(aclGrants).where(eq(aclGrants.principalId, id.user));
	await db.delete(narratorProjectLinks).where(eq(narratorProjectLinks.narratorId, id.root));
	await db.delete(narrators).where(eq(narrators.id, id.child));
	await db.delete(narrators).where(eq(narrators.id, id.root));
	await db.delete(projects).where(eq(projects.id, id.project));
	await db.delete(users).where(eq(users.id, id.user));
});

describe("authority read budgets", () => {
	test("one signal and deadline span delegated narrator, indexed project and ACL grant reads", async () => {
		const reads = spyOn(workerPool, "runReadTask");
		const options = { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 };
		try {
			expect((await loadNarratorForAccess(id.child, principal, "write")).id).toBe(id.child);
			expect(reads.mock.calls.length).toBeGreaterThan(0);
			reads.mockClear();
			expect((await loadNarratorForAccess(id.child, principal, "write", options)).id).toBe(
				id.child,
			);
			expect((await loadProjectForAccess(id.project, principal, "write", options)).id).toBe(
				id.project,
			);
			expect(reads.mock.calls.length).toBeGreaterThanOrEqual(10);
			for (const [, params, readOptions] of reads.mock.calls) {
				expect(params.kind).toBe("selectRows");
				expect(readOptions?.signal).toBe(options.signal);
				expect(readOptions?.deadlineAt).toBe(options.deadlineAt);
			}
		} finally {
			reads.mockRestore();
		}
	});

	test("empty first-row reads retain null/not-found semantics", async () => {
		const options = { deadlineAt: Date.now() + 10_000 };
		const missing = generateId();
		expect(await resolveProjectIdForNarratorId(missing, options)).toBeNull();
		expect(
			await loadNarratorForAccess(missing, principal, "read", options).catch(
				(error: unknown) => error,
			),
		).toMatchObject({ statusCode: 404 });
		expect(
			await loadProjectForAccess(missing, principal, "read", options).catch(
				(error: unknown) => error,
			),
		).toMatchObject({ statusCode: 404 });
	});

	test("worker failures never retry the authority read inline", async () => {
		for (const reason of ["unavailable", "disabled", "worker_exited", "timeout"]) {
			const error = new workerPool.WorkersUnavailableError(reason);
			const reads = spyOn(workerPool, "runReadTask").mockRejectedValueOnce(error);
			try {
				expect(
					await loadNarratorForAccess(id.child, principal, "write", {}).catch(
						(caught: unknown) => caught,
					),
				).toBe(error);
				expect(reads).toHaveBeenCalledTimes(1);
			} finally {
				reads.mockRestore();
			}
		}
	});

	test("cancelled and exhausted budgets cannot obtain an authorization", async () => {
		const controller = new AbortController();
		const cancelled = new Error("authorization cancelled");
		controller.abort(cancelled);
		expect(
			await loadNarratorForAccess(id.child, principal, "read", { signal: controller.signal }).catch(
				(error: unknown) => error,
			),
		).toBe(cancelled);
		expect(
			await loadNarratorForAccess(id.child, principal, "read", {
				deadlineAt: Date.now() - 1,
			}).catch((error: unknown) => error),
		).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
	});

	test("403 denials are never classified as transient reader failures", async () => {
		for (const error of [
			new ForbiddenError("denied"),
			new AppError("denied", 403, "DB_READ_TASK_TIMEOUT"),
		]) {
			const reads = spyOn(workerPool, "runReadTask").mockRejectedValueOnce(error);
			try {
				const rejected = await loadNarratorForAccess(id.child, principal, "write", {}).catch(
					(caught: unknown) => caught,
				);
				expect(rejected).toBe(error);
				expect(toDatabaseReadUnavailablePayload(rejected)).toBeNull();
				expect(reads).toHaveBeenCalledTimes(1);
			} finally {
				reads.mockRestore();
			}
		}
	});

	test("execution-policy keeps the existing worker task and forwards the caller budget", async () => {
		const reads = spyOn(workerPool, "runReadTask");
		const options = {
			signal: new AbortController().signal,
			deadlineAt: Date.now() + 10_000,
			timeoutMs: 2_000,
			executionPolicy: "worker-required" as const,
		};
		try {
			expect((await executionPolicyRepository.load(id.root, options)).narratorId).toBe(id.root);
			expect(reads).toHaveBeenCalledTimes(1);
			expect(reads.mock.calls[0]?.[1]).toEqual({
				kind: "executionPolicyFacts",
				narratorId: id.root,
			});
			expect(reads.mock.calls[0]?.[2]).toMatchObject({
				signal: options.signal,
				deadlineAt: options.deadlineAt,
				timeoutMs: 2_000,
			});
			expect(
				await executionPolicyRepository
					.load(generateId(), options)
					.catch((error: unknown) => error),
			).toBeInstanceOf(Error);
		} finally {
			reads.mockRestore();
		}
	});
});
