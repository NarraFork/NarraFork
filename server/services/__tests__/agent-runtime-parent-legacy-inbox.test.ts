import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessages,
	narrators,
} from "../../db/schema";
import { hotSafe } from "../../lib/hot-safe";
import type { PendingInjection } from "../parent-injection-queue";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const before = new Date(Date.now() - 60_000).toISOString();
db.insert(narrators).values({ id: "recipient", createdAt: before, updatedAt: before }).run();
for (const id of ["legacy-terminal", "wrong-run"])
	db.insert(backgroundTasks)
		.values({
			id,
			type: "bash",
			parentNarratorId: "recipient",
			status: "completed",
			createdAt: before,
			startedAt: before,
			completedAt: before,
			updatedAt: before,
			output: "stored old result",
		})
		.run();
const valid: PendingInjection = {
	kind: "bg_bash",
	task: {
		id: "legacy-terminal",
		type: "bash",
		title: "old shell",
		alias: "old-shell",
		status: "completed",
		outputPreview: "stored old result",
	},
};
const mismatch: PendingInjection = {
	kind: "bg_bash",
	task: {
		id: "wrong-run",
		type: "bash",
		title: "old shell",
		alias: null,
		status: "failed",
		outputPreview: "old failure",
	},
};
const legacy = hotSafe(
	"narrafork:parent-injection-queue",
	() => new Map<string, PendingInjection[]>(),
);
legacy.set("recipient", [
	{
		kind: "subagent_message",
		message: {
			fromId: "legacy-sender",
			fromTitle: null,
			fromType: "general",
			text: "old progress retained for human review",
			timestamp: before,
		},
	},
	mismatch,
	valid,
]);
const { migrateLegacyParentInjections, drainPendingInjections } = await import(
	"../parent-injection-queue"
);
const { runtimePublication } = await import("../agent-runtime/publication");
runtimePublication.setWake(undefined);
afterAll(() => {
	runtimePublication.stop();
	sqlite.close();
});

test("unbound legacy terminal diagnostic is durable before removal and valid next entry migrates once", () => {
	migrateLegacyParentInjections("recipient");
	expect(legacy.get("recipient")).toBeUndefined();
	const diagnostics = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, "recipient"))
		.all();
	expect(
		diagnostics.some(
			(row) => row.role === "disp" && row.contentText?.includes("could not be migrated"),
		),
	).toBe(true);
	expect(
		diagnostics.some((row) => row.contentText?.includes("old progress retained for human review")),
	).toBe(true);
	runtimePublication.flushRecipient("recipient");
	const rows = db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, "recipient"))
		.all();
	expect(rows).toHaveLength(1);
	expect(JSON.parse(rows[0]?.metadataJson ?? "{}").taskId).toBe("legacy-terminal");
	migrateLegacyParentInjections("recipient");
	drainPendingInjections("recipient");
	drainPendingInjections("recipient");
	expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(1);
	expect(
		db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, "recipient")).all(),
	).toHaveLength(diagnostics.length);
});
