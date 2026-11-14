import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../../tests/preload";
import { db } from "../../db";
import {
	fileChangeOperations,
	narratorMessageRefs,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { ToolExecutionTarget } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";

// Import the service first: persistence and the service have a pre-existing cycle.
// Dynamic imports preserve this order when Biome sorts the static imports.
const { narratorService } = await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { readEnvelopeBody } = await import("../narrator-body-writes");
const { claimNarratorRuntime, isNarratorRuntimeBusy } = await import("../narrator-session-state");
const { applyLocalRevertPlan, prepareLocalRevertAction } = await import(
	"../revert-planner-local-access"
);
const { closeRevertBodyWorkers } = await import("../revert-selection-service");
const { closeRevertManifestWorkers } = await import("../revert-transaction-worker");
const { localBackend } = await import("../../lib/agent/execution/local-backend");
const { writeTool } = await import("../../lib/agent/tools/write");

let workspace: string;
let userId: string;
let parentId: string;
let releaseSource: (() => void) | undefined;
const now = () => new Date().toISOString();

beforeEach(async () => {
	workspace = await mkdtemp(join(testEnvironment.isolatedHome, "live-fork-revert-"));
	userId = generateId();
	parentId = generateId();
	settings.workspace.treeSnapshotsEnabled = false;
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "test", role: "admin", createdAt: now() })
		.run();
	db.insert(narrators)
		.values({
			id: parentId,
			ownerUserId: userId,
			cwd: workspace,
			status: "working",
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	releaseSource = claimNarratorRuntime(parentId, "live-fork-regression");
});

afterEach(async () => {
	releaseSource?.();
	releaseSource = undefined;
	await rm(workspace, { recursive: true, force: true });
});

afterAll(async () => {
	await closeRevertBodyWorkers();
	await closeRevertManifestWorkers();
});

async function liveStep() {
	const partial = await narratorPersistence.createPartialAssistantMessage(parentId, {
		uuid: generateId(),
		session_id: "source-session",
	});
	await narratorPersistence.appendBlockToMessage(partial.id, parentId, {
		type: "text",
		id: "keep-output",
		revision: 1,
		text: "keep this output",
		completed: true,
	});
	await narratorPersistence.appendBlockToMessage(partial.id, parentId, {
		type: "reasoning",
		id: "live-reasoning",
		revision: 1,
		text: "reasoning at fork time",
		completed: false,
	});
	return partial;
}

function forkMessageId(forkId: string): string {
	const ref = db
		.select({ messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, forkId))
		.get();
	if (!ref) throw new Error("Fork has no inherited message");
	return ref.messageId;
}

function version(id: string): number {
	const row = db
		.select({ version: narrators.messageVersion })
		.from(narrators)
		.where(eq(narrators.id, id))
		.get();
	if (!row) throw new Error("Narrator disappeared");
	return row.version;
}

async function preview(forkId: string, messageId: string) {
	const result = await prepareLocalRevertAction(
		{ userId, isAdmin: true },
		forkId,
		{
			action: "rollback_to_block",
			messageId,
			blockIndex: 0,
			idempotencyKey: generateId(),
		},
		AbortSignal.timeout(15_000),
	);
	if (!result.plan?.planHash) throw new Error(`No rollback plan: ${JSON.stringify(result)}`);
	expect(result.plan.coverageComplete).toBe(true);
	return { ...result.plan, planHash: result.plan.planHash };
}

describe("live fork history rollback through real services", () => {
	for (const mode of ["full", "selected"] as const)
		test(`${mode} fork keeps its confirmed rollback valid while the source keeps streaming`, async () => {
			const partial = await liveStep();
			const fork =
				mode === "full"
					? await narratorService.forkNarrator(parentId, null, {
							inheritMode: "full",
							forkMessageId: partial.id,
						})
					: await narratorService.forkFromMessages(parentId, [partial.id]);
			const messageId = forkMessageId(fork.id);
			expect(messageId).not.toBe(partial.id);
			const forkBody = readEnvelopeBody(db, messageId);
			const plan = await preview(fork.id, messageId);
			const forkVersion = version(fork.id);

			await narratorPersistence.appendBlockToMessage(partial.id, parentId, {
				type: "reasoning",
				id: "live-reasoning",
				revision: 2,
				text: "source continued after the preview",
				completed: false,
			});
			expect(readEnvelopeBody(db, messageId)).toEqual(forkBody);
			expect(version(fork.id)).toBe(forkVersion);
			expect(isNarratorRuntimeBusy(parentId)).toBe(true);

			const result = await applyLocalRevertPlan(
				{ userId, isAdmin: true },
				fork.id,
				plan.id,
				{ planHash: plan.planHash, action: "rollback_to_block" },
				AbortSignal.timeout(15_000),
			);
			expect(result.status).toBe("committed");
			expect(result.historyCommitted).toBe(true);
			expect(readEnvelopeBody(db, forkMessageId(fork.id))).toEqual([
				{
					type: "text",
					id: "keep-output",
					revision: 1,
					text: "keep this output",
					completed: true,
				},
			]);
			expect(JSON.stringify(readEnvelopeBody(db, partial.id))).toContain(
				"source continued after the preview",
			);
			expect(isNarratorRuntimeBusy(parentId)).toBe(true);
		}, 30_000);

	for (const kind of ["stable", "copied"] as const)
		test(`${kind} fork can restore a settled file receipt after the source narrator is removed`, async () => {
			const partial = await liveStep();
			const path = join(workspace, "retained-origin.txt");
			await writeFile(path, "original file\n");
			const toolUseId = generateId();
			const input = { file_path: path, content: "source edit\n" };
			const toolCallId = await narratorPersistence.appendBlockToMessage(partial.id, parentId, {
				type: "tool_use",
				id: toolUseId,
				name: "Write",
				input,
			});
			if (!toolCallId) throw new Error("Expected a real tool attempt");
			const resolved = await localBackend.resolvePathIdentity(path);
			const executionTarget: ToolExecutionTarget = {
				deviceId: "local",
				backendKind: "local",
				cwd: workspace,
				pathFlavor: localBackend.pathFlavor,
				lexicalPath: resolved.lexicalPath,
				canonicalPath: resolved.canonicalPath,
				runtimeGeneration: localBackend.runtimeGeneration,
				selectionSource: "local_default",
			};
			db.update(narratorToolCalls)
				.set({
					status: "running",
					executionStartedAt: now(),
					executionDeviceId: "local",
					executionCwd: workspace,
					executionPathFlavor: executionTarget.pathFlavor,
					resolvedFilePath: path,
					canonicalFilePath: resolved.canonicalPath,
					runtimeGeneration: executionTarget.runtimeGeneration,
				})
				.where(eq(narratorToolCalls.id, toolCallId))
				.run();
			const written = await writeTool.execute(input, {
				narratorId: parentId,
				userId,
				cwd: workspace,
				locale: "en",
				currentToolUseId: toolUseId,
				toolCallBinding: { toolCallId, attempt: 1 },
				executionTarget,
				requestPermission: async () => ({ behavior: "allow" }),
				signal: AbortSignal.timeout(15_000),
			});
			expect(written.isError).not.toBe(true);
			await narratorPersistence.updateToolCallResult(
				toolUseId,
				{ status: "success", output: written.output },
				partial.id,
				toolCallId,
			);
			const copied =
				kind === "copied"
					? await narratorService.forkNarrator(parentId, null, {
							inheritMode: "full",
							forkMessageId: partial.id,
						})
					: undefined;
			await narratorPersistence.appendBlockToMessage(partial.id, parentId, {
				type: "reasoning",
				id: "live-reasoning",
				revision: 2,
				text: "reasoning at fork time",
				completed: true,
			});
			const stable = await narratorService.forkNarrator(parentId, null, {
				inheritMode: "full",
				forkMessageId: partial.id,
			});
			expect(forkMessageId(stable.id)).toBe(partial.id);
			const target = copied ?? stable;
			const operationId = db
				.select({ id: narratorToolCalls.fileChangeOperationId })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, toolCallId))
				.get()?.id;
			if (!operationId) throw new Error("Write did not record its file evidence");
			releaseSource?.();
			releaseSource = undefined;
			await narratorService.remove(parentId);
			expect(
				db
					.select({ origin: narratorToolCalls.executionOriginToolCallId })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.id, toolCallId))
					.get()?.origin,
			).toBe(toolCallId);
			expect(
				db
					.select({ narratorId: fileChangeOperations.narratorId })
					.from(fileChangeOperations)
					.where(eq(fileChangeOperations.id, operationId))
					.get()?.narratorId,
			).toBeNull();
			const plan = await preview(target.id, forkMessageId(target.id));
			expect(plan.expectedFileCount).toBe(1);
			const result = await applyLocalRevertPlan(
				{ userId, isAdmin: true },
				target.id,
				plan.id,
				{ planHash: plan.planHash, action: "rollback_to_block" },
				AbortSignal.timeout(15_000),
			);
			expect(result.status).toBe("committed");
			expect(result.historyCommitted).toBe(true);
			expect(await readFile(path, "utf8")).toBe("original file\n");
		}, 30_000);

	test("a real change to the fork's selected body still rejects its old plan", async () => {
		const partial = await liveStep();
		const fork = await narratorService.forkNarrator(parentId, null, {
			inheritMode: "full",
			forkMessageId: partial.id,
		});
		const messageId = forkMessageId(fork.id);
		const sourceBody = readEnvelopeBody(db, partial.id);
		const plan = await preview(fork.id, messageId);
		await narratorPersistence.appendBlockToMessage(messageId, fork.id, {
			type: "reasoning",
			id: "live-reasoning",
			revision: 2,
			text: "the selected history really changed",
			completed: false,
		});
		const changedBody = readEnvelopeBody(db, messageId);
		const error = await applyLocalRevertPlan(
			{ userId, isAdmin: true },
			fork.id,
			plan.id,
			{ planHash: plan.planHash, action: "rollback_to_block" },
			AbortSignal.timeout(15_000),
		).catch((cause: unknown) => cause);
		expect(error).toMatchObject({ code: expect.stringContaining("STALE") });
		expect(readEnvelopeBody(db, messageId)).toEqual(changedBody);
		expect(readEnvelopeBody(db, partial.id)).toEqual(sourceBody);
		expect(isNarratorRuntimeBusy(parentId)).toBe(true);
	}, 30_000);
});
