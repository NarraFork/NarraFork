import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { DbReadError } from "../../lib/db-worker/errors";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const workerFixture = getNarratorWorkerTestDb();
const { db, sqlite } = workerFixture;
await workerFixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite, activeDatabaseBackend: "sqlite" }));

const workerReads = await import("../../db/worker-read");
const detailReads = spyOn(workerReads, "readDomainTask");
const network = spyOn(globalThis, "fetch").mockRejectedValue(
	new Error("Tool detail reads must not call the model network"),
);
// The service must initialize before the persistence module in the route import graph.
const { narratorService } = await import("../narrator-service");
const { narratorRoutes } = await import("../../routes/narrators");
const { stopBlockSyncSweep } = await import("../narrator-block-sync");

// Real Worker queries use their own connection, never this caller-thread handle.
const prepare = sqlite.prepare.bind(sqlite);
const callerReads = spyOn(sqlite, "prepare").mockImplementation(
	(...args: Parameters<typeof sqlite.prepare>) => {
		if (/\bselect\b[\s\S]*\bnarrator_tool_calls\b/i.test(args[0]))
			throw new Error("Tool detail SQL must execute in the read Worker");
		return prepare(...args);
	},
);

const NOW = "2026-10-24T00:00:00.000Z";
const OWNER = "detail-worker-owner";
const NARRATOR = "detail-worker-narrator";
let sequence = 0;

beforeEach(() => {
	cleanDb(sqlite);
	detailReads.mockClear();
	network.mockClear();
	sequence = 0;
	db.insert(users)
		.values({ id: OWNER, username: OWNER, passwordHash: "test-only", createdAt: NOW })
		.run();
	db.insert(narrators)
		.values({
			id: NARRATOR,
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});
afterEach(() => {
	expect(network).not.toHaveBeenCalled();
});
afterAll(async () => {
	stopBlockSyncSweep();
	callerReads.mockRestore();
	detailReads.mockRestore();
	network.mockRestore();
	mock.module("../../db", () => realDbModule);
	await workerFixture.close();
});

function tool(toolUseId = "detail-provider-id", narratorId = NARRATOR, messageId = generateId()) {
	const id = generateId();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Read" }],
			createdAt: NOW,
		})
		.onConflictDoNothing()
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: ++sequence })
		.onConflictDoNothing()
		.run();
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Read",
			inputJson: { row: id },
			outputJson: { complete: `result-${id}` },
			executionIdentityVersion: 1,
			status: "success",
			createdAt: NOW,
		})
		.run();
	return { id, messageId, toolUseId };
}

function appFor(userId = OWNER) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		Response.json(
			{
				error: error.message,
				code:
					error instanceof AppError || error instanceof DbReadError ? error.code : "INTERNAL_ERROR",
			},
			{ status: error instanceof AppError ? error.statusCode : 500 },
		),
	);
	app.route("/api/narrators", narratorRoutes);
	return app;
}

function toolPath(
	toolUseId: string,
	reference: Record<string, string>,
	surface: "detail" | "preview",
) {
	const suffix = surface === "preview" ? "/file-edit-preview" : "";
	return `/api/narrators/${NARRATOR}/tool-calls/${toolUseId}${suffix}?${new URLSearchParams(reference)}`;
}

function expectWorkerRead(
	toolUseId: string,
	reference: Record<string, string> | null,
	task: "narratorToolDetail" | "narratorToolPreview",
) {
	expect(detailReads).toHaveBeenCalledWith(
		sqlite,
		task,
		{ narratorId: NARRATOR, toolUseId, reference },
		{ executionPolicy: "worker-required", timeoutMs: 30_000 },
	);
}

for (const surface of ["detail", "preview"] as const) {
	const task = surface === "preview" ? "narratorToolPreview" : "narratorToolDetail";
	const idProperty = surface === "preview" ? "toolCallId" : "id";
	const readTool =
		surface === "preview"
			? narratorService.getToolCallPreviewMetadata.bind(narratorService)
			: narratorService.getToolCallDetail.bind(narratorService);
	const detailPath = (toolUseId: string, reference: Record<string, string> = {}) =>
		toolPath(toolUseId, reference, surface);

	describe(`tool ${surface} optional references across the Worker boundary`, () => {
		for (const selection of ["none", "message", "tool", "both"] as const) {
			test(`the real route reads a tool with ${selection} query references`, async () => {
				const stored = tool();
				const reference: Record<string, string> = {};
				if (selection === "message" || selection === "both") reference.messageId = stored.messageId;
				if (selection === "tool" || selection === "both") reference.toolCallId = stored.id;
				const response = await appFor().request(detailPath(stored.toolUseId, reference));
				expect(response.status).toBe(200);
				const body = await response.json();
				if (surface === "detail") {
					expect(body).toMatchObject({
						id: stored.id,
						messageId: stored.messageId,
						inputJson: { row: stored.id },
						outputJson: { complete: `result-${stored.id}` },
					});
				} else {
					// Read tools return before blob/git IO, leaving the metadata selector real.
					expect(body).toMatchObject({
						toolCallId: stored.id,
						toolUseId: stored.toolUseId,
						source: "unavailable",
						before: { reason: "unsupported" },
						after: { reason: "unsupported" },
					});
				}
				expectWorkerRead(stored.toolUseId, reference, task);
			});
		}

		test("direct callers may omit optional fields without mutating their reference", async () => {
			const stored = tool();
			for (const reference of [
				undefined,
				Object.freeze({}),
				Object.freeze({ toolCallId: undefined }),
				Object.freeze({ messageId: undefined }),
				Object.freeze({ toolCallId: undefined, messageId: undefined }),
			]) {
				expect((await readTool(NARRATOR, stored.toolUseId, reference)).id).toBe(stored.id);
				expectWorkerRead(stored.toolUseId, reference === undefined ? null : {}, task);
			}
		});

		test("repeated provider IDs retain exact row and message selection", async () => {
			const first = tool();
			const second = tool();
			const app = appFor();
			const ambiguous = await app.request(detailPath(first.toolUseId));
			expect(ambiguous.status).toBe(409);
			expect(await ambiguous.json()).toMatchObject({ code: "TOOL_CALL_DETAIL_SELECTION_REQUIRED" });
			const references: Record<string, string>[] = [
				{ messageId: second.messageId },
				{ toolCallId: second.id },
				{ toolCallId: second.id, messageId: second.messageId },
			];
			for (const reference of references) {
				const response = await app.request(detailPath(second.toolUseId, reference));
				expect(response.status).toBe(200);
				expect((await response.json())[idProperty]).toBe(second.id);
			}
			const mismatch = await app.request(
				detailPath(first.toolUseId, { toolCallId: first.id, messageId: second.messageId }),
			);
			expect(mismatch.status).toBe(404);
			const retry = tool(first.toolUseId, NARRATOR, first.messageId);
			const sameMessage = await app.request(
				detailPath(first.toolUseId, { messageId: first.messageId }),
			);
			expect(sameMessage.status).toBe(409);
			const exact = await app.request(detailPath(retry.toolUseId, { toolCallId: retry.id }));
			expect(exact.status).toBe(200);
			expect((await exact.json())[idProperty]).toBe(retry.id);
		});

		test("an exact foreign row reference does not grant visibility", async () => {
			const foreignId = generateId();
			db.insert(narrators)
				.values({ id: foreignId, ownerUserId: OWNER, createdAt: NOW, updatedAt: NOW })
				.run();
			const foreign = tool("foreign-provider-id", foreignId);
			const references: Record<string, string>[] = [
				{ toolCallId: foreign.id },
				{ messageId: foreign.messageId },
				{ toolCallId: foreign.id, messageId: foreign.messageId },
			];
			for (const reference of references) {
				const response = await appFor().request(detailPath(foreign.toolUseId, reference));
				expect(response.status).toBe(404);
			}
		});

		test("invalid values and unknown keys still fail strict domain validation", async () => {
			const stored = tool();
			for (const field of ["toolCallId", "messageId"] as const) {
				for (const value of ["", " ", "x".repeat(129), null, 7, false, [], {}]) {
					await expect(
						readTool(NARRATOR, stored.toolUseId, {
							toolCallId: undefined,
							messageId: undefined,
							[field]: value,
						} as never),
					).rejects.toMatchObject({ code: "DB_READ_INVALID" });
				}
			}
			for (const reference of [
				{ toolCallId: undefined, messageId: undefined, unexpected: undefined },
				{ toolCallId: stored.id, messageId: undefined, unexpected: "value" },
				"",
				7,
				false,
				[],
			]) {
				await expect(
					readTool(NARRATOR, stored.toolUseId, reference as never),
				).rejects.toMatchObject({ code: "DB_READ_INVALID" });
			}
			for (const field of ["toolCallId", "messageId"]) {
				for (const value of ["", "x".repeat(129)]) {
					const response = await appFor().request(detailPath(stored.toolUseId, { [field]: value }));
					expect(response.status).not.toBe(200);
					expect(await response.json()).toMatchObject({ code: "DB_READ_INVALID" });
				}
			}
		});
	});
}
