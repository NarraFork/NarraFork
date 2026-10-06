/**
 * abandoned-tool-cleanup.test.ts — never-started non-terminal tool rows expire.
 *
 * Pins the stuck-Send shape: status pending/initializing/running with
 * execution_started_at NULL and no live permission wait must become fail after
 * TTL, so update checkpoint and recovery UI stop treating them as live work.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const {
	ABANDONED_TOOL_CALL_ERROR,
	ABANDONED_TOOL_CALL_TTL_MS,
	cleanupAbandonedToolCalls,
	isAbandonedNeverStartedToolCall,
} = await import("../abandoned-tool-cleanup");

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const NARRATOR = "abandoned-cleanup-narrator";
const MESSAGE = "abandoned-cleanup-message";

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

beforeEach(async () => {
	cleanDb(sqlite);
	const now = new Date(NOW).toISOString();
	await db.insert(narrators).values({
		id: NARRATOR,
		variant: "subagent:explore",
		type: "subagent",
		status: "waiting",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: MESSAGE,
		narratorId: NARRATOR,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
});

afterEach(() => {
	cleanDb(sqlite);
});

async function seedToolCall(over: {
	id: string;
	status: "initializing" | "pending" | "running" | "success" | "fail";
	createdAt: string;
	executionStartedAt?: string | null;
	toolName?: string;
}) {
	await db.insert(narratorToolCalls).values({
		id: over.id,
		narratorId: NARRATOR,
		messageId: MESSAGE,
		toolUseId: `${over.id}-use`,
		toolName: over.toolName ?? "Send",
		status: over.status,
		executionStartedAt: over.executionStartedAt ?? null,
		createdAt: over.createdAt,
	});
}

describe("isAbandonedNeverStartedToolCall", () => {
	test("matches never-started non-terminal rows past TTL", () => {
		const old = new Date(NOW - ABANDONED_TOOL_CALL_TTL_MS - 1_000).toISOString();
		expect(isAbandonedNeverStartedToolCall({ status: "pending", createdAt: old, now: NOW })).toBe(
			true,
		);
		expect(
			isAbandonedNeverStartedToolCall({ status: "initializing", createdAt: old, now: NOW }),
		).toBe(true);
	});

	test("ignores started, terminal, and fresh rows", () => {
		const old = new Date(NOW - ABANDONED_TOOL_CALL_TTL_MS - 1_000).toISOString();
		const fresh = new Date(NOW - 1_000).toISOString();
		expect(
			isAbandonedNeverStartedToolCall({
				status: "running",
				createdAt: old,
				executionStartedAt: old,
				now: NOW,
			}),
		).toBe(false);
		expect(isAbandonedNeverStartedToolCall({ status: "success", createdAt: old, now: NOW })).toBe(
			false,
		);
		expect(isAbandonedNeverStartedToolCall({ status: "pending", createdAt: fresh, now: NOW })).toBe(
			false,
		);
	});
});

describe("cleanupAbandonedToolCalls", () => {
	test("fails stale pending Send and leaves live/fresh/started rows alone", async () => {
		const old = new Date(NOW - ABANDONED_TOOL_CALL_TTL_MS - 60_000).toISOString();
		const fresh = new Date(NOW - 1_000).toISOString();
		await seedToolCall({ id: "stuck-send", status: "pending", createdAt: old, toolName: "Send" });
		await seedToolCall({
			id: "live-permission",
			status: "pending",
			createdAt: old,
			toolName: "Bash",
		});
		await seedToolCall({ id: "fresh-pending", status: "pending", createdAt: fresh });
		await seedToolCall({
			id: "started-running",
			status: "running",
			createdAt: old,
			executionStartedAt: old,
		});
		await seedToolCall({ id: "already-success", status: "success", createdAt: old });

		const result = await cleanupAbandonedToolCalls({
			now: NOW,
			livePendingToolCallIds: new Set(["live-permission"]),
		});
		expect(result.cleaned).toBe(1);
		expect(result.skippedLive).toBe(1);

		const stuck = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "stuck-send"),
		});
		expect(stuck?.status).toBe("fail");
		expect(stuck?.errorMessage).toBe(ABANDONED_TOOL_CALL_ERROR);
		expect(stuck?.completedAt).toBeTruthy();

		const live = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "live-permission"),
		});
		expect(live?.status).toBe("pending");

		const freshRow = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "fresh-pending"),
		});
		expect(freshRow?.status).toBe("pending");

		const started = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "started-running"),
		});
		expect(started?.status).toBe("running");

		const success = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, "already-success"),
		});
		expect(success?.status).toBe("success");
	});
});
