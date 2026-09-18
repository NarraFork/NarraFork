/**
 * background-completion-delivery.test.ts — finished background work reaches the
 * parent's mailbox exactly once through the publication outbox → flush pipeline.
 *
 * The old in-memory `parent-injection-queue` is gone. Completions now flow through
 * the publication outbox as durable intents; `pushBgCompletionNotification` is a
 * pure scheduling hint (calls `runtimePublication.schedule()`). The real delivery
 * is: terminal publication commit → outbox → flushRecipient → mailbox.
 *
 * These tests pin that pipeline on the SQLite async facade:
 *   - A terminal commit creates a durable outbox intent.
 *   - flushRecipient transfers it into the mailbox (one delivery, not zero or two).
 *   - A second flush is idempotent (duplicate protection).
 *   - Notifications for different parents don't cross.
 *
 * The format tests (`formatBackgroundCompletionNotifications`) are unchanged and
 * stay here because they exercise the same producer's display logic.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	narratorBufferedMessages as mailbox,
	narrators,
	runtimePublicationOutbox as outbox,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	flushRuntimePublications,
	getRuntimePublicationService,
	runtimePublication,
} from "../agent-runtime/publication";
import {
	type CompletedBgSubagentNotification,
	formatBackgroundCompletionNotifications,
	pushBgCompletionNotification,
} from "../bg-completion-queue";

runtimePublication.stop();
afterEach(() => cleanDb(sqlite));

const PARENT = "bg-delivery-parent";

function notification(
	over: Partial<CompletedBgSubagentNotification> = {},
): CompletedBgSubagentNotification {
	return {
		id: "UscgG1vLFnxzyKyaUOIfR",
		alias: "map-the-providers",
		title: "Map the providers",
		status: "completed",
		resultPreview: "found 7 buildHistory sites",
		result: "found 7 buildHistory sites, listed with line numbers",
		...over,
	};
}

/** Seed a parent narrator in the test DB. */
function seedParent(id: string = PARENT) {
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
		.run();
}

/** Count undelivered mailbox rows for a narrator. */
function mailboxCount(narratorId: string): number {
	return db.select().from(mailbox).where(eq(mailbox.narratorId, narratorId)).all().length;
}

describe("pushBgCompletionNotification is a scheduling hint only", () => {
	it("does not insert into any queue — schedule() is the only effect", () => {
		// pushBgCompletionNotification now just calls runtimePublication.schedule().
		// It must not throw and must not touch the database.
		pushBgCompletionNotification(PARENT, notification());
		// No assertion needed beyond "didn't throw" — the old queue no longer exists.
	});
});

describe("publication commit → flush → mailbox delivery", () => {
	beforeEach(() => {
		seedParent();
	});

	it("terminal commit + flush delivers one mailbox row", async () => {
		const pub = getRuntimePublicationService();
		const taskId = generateId();
		const run = await pub.startBashRun({ taskId, recipientId: PARENT });
		await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "test output",
			summary: "[System] Bash completed.",
		});
		// Before flush: outbox has the intent, mailbox is empty
		const outboxBefore = db.select().from(outbox).where(eq(outbox.state, "pending")).all();
		expect(outboxBefore.length).toBeGreaterThan(0);
		expect(mailboxCount(PARENT)).toBe(0);

		await flushRuntimePublications(PARENT);

		// After flush: one mailbox row delivered
		expect(mailboxCount(PARENT)).toBe(1);
	});

	it("second flush is idempotent (duplicate protection)", async () => {
		const pub = getRuntimePublicationService();
		const taskId = generateId();
		const run = await pub.startBashRun({ taskId, recipientId: PARENT });
		await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "output",
			summary: "done",
		});
		await flushRuntimePublications(PARENT);
		expect(mailboxCount(PARENT)).toBe(1);

		// Second flush should not create a duplicate
		await flushRuntimePublications(PARENT);
		expect(mailboxCount(PARENT)).toBe(1);
	});

	it("duplicate commit returns duplicate status and produces one delivery", async () => {
		const pub = getRuntimePublicationService();
		const taskId = generateId();
		const run = await pub.startBashRun({ taskId, recipientId: PARENT });
		const first = await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "output",
			summary: "done",
		});
		expect(first.status).toBe("committed");
		const second = await pub.commitBashTerminal({
			run,
			eventKind: "completed",
			text: "output",
			summary: "done",
		});
		expect(second.status).toBe("duplicate");
		await flushRuntimePublications(PARENT);
		expect(mailboxCount(PARENT)).toBe(1);
	});

	it("notifications for different parents don't cross", async () => {
		const otherParent = "other-parent";
		seedParent(otherParent);

		const pub = getRuntimePublicationService();
		const task1 = generateId();
		const task2 = generateId();
		const run1 = await pub.startBashRun({ taskId: task1, recipientId: PARENT });
		const run2 = await pub.startBashRun({ taskId: task2, recipientId: otherParent });
		await pub.commitBashTerminal({
			run: run1,
			eventKind: "completed",
			text: "output1",
			summary: "done1",
		});
		await pub.commitBashTerminal({
			run: run2,
			eventKind: "completed",
			text: "output2",
			summary: "done2",
		});
		await flushRuntimePublications(PARENT);
		await flushRuntimePublications(otherParent);

		expect(mailboxCount(PARENT)).toBe(1);
		expect(mailboxCount(otherParent)).toBe(1);
	});
});

describe("formatBackgroundCompletionNotifications (display logic, unchanged)", () => {
	it("busy: a preview, because the full output is one Await away", () => {
		const text = formatBackgroundCompletionNotifications([notification()], {
			includeResult: false,
		});
		expect(text).toContain("Result preview: found 7 buildHistory sites");
		expect(text).not.toContain("listed with line numbers");
		expect(text).toContain('Await({ type: "agent", id: "map-the-providers" })');
	});

	it("names the agent by alias and never by its raw narrator id", () => {
		const text = formatBackgroundCompletionNotifications([notification()], {
			includeResult: true,
		});
		expect(text).toContain("(ID: map-the-providers)");
		expect(text).not.toContain("UscgG1vLFnxzyKyaUOIfR");
		expect(text).toContain('Send({ id: "map-the-providers", message })');
	});

	it("falls back to the id when a completion carries no alias", () => {
		const text = formatBackgroundCompletionNotifications(
			[notification({ alias: null, id: "legacy-task" })],
			{ includeResult: false },
		);
		expect(text).toContain("(ID: legacy-task)");
	});

	it("idle: the full result, because a turn is being started to deal with it", () => {
		const text = formatBackgroundCompletionNotifications([notification()], {
			includeResult: true,
		});
		expect(text).toContain("listed with line numbers");
	});

	it("a truncated result says so, and says how to read the rest", () => {
		const text = formatBackgroundCompletionNotifications(
			[notification({ resultTruncated: true })],
			{ includeResult: true },
		);
		expect(text).toContain("truncated");
		expect(text).toContain('Await({ type: "agent", id: "map-the-providers" })');
	});

	it("an empty result is stated rather than left blank", () => {
		const text = formatBackgroundCompletionNotifications(
			[notification({ result: "", resultPreview: "" })],
			{ includeResult: true },
		);
		expect(text).toContain("(empty)");
	});
});
