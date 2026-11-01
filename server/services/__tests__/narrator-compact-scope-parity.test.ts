/**
 * Compaction scope and compaction failure follow the run registration, not how a
 * session was created. Each case runs for a delegated session and for a session
 * without a parent that registered the same destination; both must behave the same.
 *
 * - Compact boundaries and the display/catch-up history count the session's own turns
 *   (`isTopLevelMessage`: unplaced, or placed under the tool call its run delivers to)
 *   and nothing nested under other calls.
 * - A blocking compact that fails while a run owns the session leaves the terminal to
 *   that run: the finalizer settles status once and delivers once, so the caller's
 *   tool call is neither left pending nor answered twice. An idle session has no
 *   other reporter and records the failure on its own row.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";

// Prefix/history workers need the same file-backed database as the run/compact paths.
const { db, sqlite } = await import("../../db");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const executor = await import("../narrator-executor");
const { narratorService } = await import("../narrator-service");
const { narratorContext } = await import("../narrator-context");
const { compactLocks, runCustomCompact } = await import("../narrator-compact");
const { startNarratorRun } = await import("../agent-runtime/run");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const { activeNarrators } = await import("../narrator-session-state");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Never calls a model");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

const CALLER = "scope-parity-caller";
const ID = "scope-parity-session";
const ORIGIN = "scope-parity-origin";
const ORIGIN_ROW = "scope-parity-origin-row";
const NOW = "2026-10-01T00:00:00.000Z";
const realSummary = narratorContext.generateCompactSummary.bind(narratorContext);
let cwd: string;
let seq = 0;

const shapes = [
	{
		name: "delegated session",
		row: { type: "subagent", variant: "subagent:general", parentNarratorId: CALLER },
	},
	{ name: "session without a parent", row: { type: "primary", variant: "primary" } },
] as const;
type Shape = (typeof shapes)[number];

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	compactLocks.clear();
	seq = 0;
	settings.agent.autoContinuationMode = "off";
	cwd = mkdtempSync(join(tmpdir(), "nf-compact-parity-"));
});
afterEach(async () => {
	getExecutionOwner(ID)?.release();
	activeNarrators.delete(ID);
	narratorContext.generateCompactSummary = realSummary;
	mock.restore();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(() => {
	unregisterProvider();
});

function message(
	id: string,
	role: "user" | "assistant",
	parentToolUseId: string | null,
	narratorId = ID,
) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role,
			contentJson: [{ type: "text", text: id }],
			contentText: id,
			parentToolUseId,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId, messageId: id, seq: seq++ })
		.run();
}

/** The caller's running Agent call the session's run delivers to. */
function callerCall() {
	message("caller-turn", "assistant", null, CALLER);
	db.update(narratorMessages)
		.set({ contentJson: [{ type: "tool_use", id: ORIGIN, name: "Agent", input: {} }] })
		.where(eq(narratorMessages.id, "caller-turn"))
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: ORIGIN_ROW,
			narratorId: CALLER,
			messageId: "caller-turn",
			toolUseId: ORIGIN,
			toolName: "Agent",
			inputJson: {},
			outputJson: "PENDING",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			createdAt: NOW,
		})
		.run();
}

/** A session whose run registered the caller's call as its destination. */
function seed(shape: Shape) {
	db.insert(narrators)
		.values([
			{ id: CALLER, variant: "primary", cwd, createdAt: NOW, updatedAt: NOW },
			{
				id: ID,
				...shape.row,
				cwd,
				status: "idle",
				model: "test:model",
				autoContinuationOverride: "off",
				runtimeRegistrationJson: {
					version: 1,
					run: {
						logicalRunId: "registered-run",
						deliverTo: { narratorId: CALLER, toolUseId: ORIGIN },
					},
				},
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	callerCall();
}

/** Three own exchanges under the destination, with a nested transcript in between. */
function transcript() {
	for (let i = 1; i <= 3; i++) {
		message(`own-user-${i}`, "user", ORIGIN);
		message(`nested-${i}`, "assistant", "nested-call");
		message(`own-reply-${i}`, "assistant", ORIGIN);
	}
}

/** What a session sees for the same rows: boundaries, display page, catch-up stream. */
async function scopeOf() {
	const page = await narratorService.getPretextDocumentPage(ID, { limit: 100 });
	const after = await narratorService.getMessagesAfter(ID, { parentLastMessageId: "own-user-1" });
	return {
		boundary: await narratorService.getCompactBoundaryMessage(ID, 1),
		emergency: await narratorService.getEmergencyCompactBoundaryMessage(ID),
		page: page.messages.map((row: { id: string }) => row.id),
		after: after.topLevel.map((row: { id: string }) => row.id),
	};
}

const scopes: Record<string, Awaited<ReturnType<typeof scopeOf>>> = {};

for (const shape of shapes) {
	describe(shape.name, () => {
		test("compact boundaries and history scope count own turns only", async () => {
			seed(shape);
			transcript();
			const scope = await scopeOf();
			// keepPairs=1 keeps the last own exchange; the nested rows never count.
			expect(scope.boundary).toBe("own-user-3");
			expect(scope.emergency).toBe("own-reply-3");
			expect(scope.page).toEqual([
				"own-user-1",
				"own-reply-1",
				"own-user-2",
				"own-reply-2",
				"own-user-3",
				"own-reply-3",
			]);
			expect(scope.after).toEqual(scope.page.slice(1));
			scopes[shape.name] = scope;
		});

		test("a blocking compact failure during a run is settled and delivered once", async () => {
			seed(shape);
			transcript();
			narratorContext.generateCompactSummary = async () => {
				throw new Error("summary model down");
			};
			let compactError: unknown;
			spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
				// The pass hits a blocking compact (e.g. reasoning-only recovery) that fails;
				// the pass reports the failure as its outcome.
				compactError = await runCustomCompact(ID, "en", "own-user-3", {
					mode: "blocking",
				}).catch((error: unknown) => error);
				return { finalText: "Compact failed", hasError: true, shouldUpdateTitle: false };
			});
			const handle = await startNarratorRun({
				narratorId: ID,
				locale: "en",
				text: "work",
				binding: {
					deliverTo: { narratorId: CALLER, toolUseId: ORIGIN, toolCallId: ORIGIN_ROW, attempt: 1 },
					principal: { userId: null },
				},
			});
			const terminal = await handle.terminal;
			expect(String(compactError)).toContain("summary model down");
			expect(terminal.hasError).toBe(true);
			expect(terminal.interrupted).toBe(false);
			// The finalizer owns the status: an error, not an interruption.
			const row = db.select().from(narrators).where(eq(narrators.id, ID)).get();
			expect(row?.status).toBe("idle");
			expect(String(row?.substatus)).toContain("error");
			expect(String(row?.substatus)).not.toContain("interrupted");
			// Delivered exactly once to the caller's call, which is no longer pending.
			const output = db
				.select()
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, ORIGIN_ROW))
				.get()?.outputJson;
			expect(output).not.toBe("PENDING");
			const terminals = db
				.select()
				.from(runtimePublicationOutbox)
				.where(eq(runtimePublicationOutbox.logicalRunId, terminal.logicalRunId ?? ""))
				.all()
				.filter((entry) => entry.eventKind !== "started" && entry.state !== "reserved");
			expect(terminals).toHaveLength(1);
		});

		test("a blocking compact failure on an idle session is recorded on the session", async () => {
			seed(shape);
			transcript();
			narratorContext.generateCompactSummary = async () => {
				throw new Error("summary model down");
			};
			await expect(runCustomCompact(ID, "en", "own-user-3", { mode: "blocking" })).rejects.toThrow(
				"summary model down",
			);
			const row = db.select().from(narrators).where(eq(narrators.id, ID)).get();
			expect(row?.status).toBe("idle");
			expect(String(row?.substatus)).toContain("error");
			expect(String(row?.errorMessage)).toContain("Compact failed");
			// No run, so nothing is delivered to the caller.
			expect(
				db.select().from(narratorToolCalls).where(eq(narratorToolCalls.id, ORIGIN_ROW)).get()
					?.outputJson,
			).toBe("PENDING");
		});
	});
}

test("both shapes see the same compaction scope", () => {
	expect(Object.keys(scopes)).toHaveLength(2);
	expect(scopes[shapes[0].name]).toEqual(scopes[shapes[1].name]);
});

test("a session that delivers nowhere counts only unplaced rows", async () => {
	db.insert(narrators)
		.values({ id: ID, variant: "primary", cwd, status: "idle", createdAt: NOW, updatedAt: NOW })
		.run();
	for (let i = 1; i <= 3; i++) {
		message(`own-user-${i}`, "user", null);
		message(`placed-${i}`, "assistant", ORIGIN);
		message(`own-reply-${i}`, "assistant", null);
	}
	expect(await narratorService.getCompactBoundaryMessage(ID, 1)).toBe("own-user-3");
	const page = await narratorService.getPretextDocumentPage(ID, { limit: 100 });
	expect(page.messages.map((row: { id: string }) => row.id)).not.toContain("placed-1");
});
