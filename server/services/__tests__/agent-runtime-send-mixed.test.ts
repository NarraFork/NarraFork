import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { delegationRegistration } from "../../lib/validators/runtime-registration";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const ws = { ...(await import("../../websocket/narrator-ws")) };
const broadcasts: Array<{ narratorId: string; type: string; model?: string }> = [];
mock.module("../../websocket/narrator-ws", () => ({
	...ws,
	broadcastToNarrator: (narratorId: string, message: { type: string; model?: string }) => {
		broadcasts.push({ narratorId, type: message.type, model: message.model });
	},
}));
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const inbox = await import("../agent-runtime/inbox");
const settingsModule = await import("../../lib/settings");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { getExecutionOwner, setRunHold, tryClaimExecution } = await import(
	"../agent-runtime/ownership"
);
const { activeNarrators } = await import("../narrator-session-state");
const { sendTool } = await import("../../lib/agent/tools/send");
const { compileDelegationCeiling } = await import("../custom-subagent-service");
const ceiling = await compileDelegationCeiling("general");
const store = createMailboxStore(db);
/** A turn in flight: the session's live abort controller (the same for every session). */
function liveTurn(narratorId: string, controller: AbortController) {
	activeNarrators.set(narratorId, {
		narratorId,
		alive: true,
		abortController: controller,
	} as unknown as import("../narrator-session-state").ActiveNarrator);
}
const ids = [
	"parent-root",
	"sender-child",
	"sibling-a",
	"sibling-b",
	"foreign-root",
	"foreign-child",
];
const time = "2026-09-09T00:00:00.000Z";
let serial = 0;
beforeEach(() => {
	broadcasts.length = 0;
	for (const id of ids) {
		setRunHold(id, undefined);
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	cleanDb(sqlite);
	for (const id of ids) {
		const primary = id.endsWith("root");
		const parent = primary ? null : id === "foreign-child" ? "foreign-root" : "parent-root";
		db.insert(narrators)
			.values({
				id,
				title: id === "sibling-a" ? "Alpha analyst" : id,
				type: primary ? "primary" : "subagent",
				variant: primary ? "primary" : "subagent:general",
				parentNarratorId: parent,
				policySourceNarratorId: parent,
				runtimeRegistrationJson: parent ? delegationRegistration(parent, "general") : null,
				traits: withRuntimePolicyTrait(
					id === "sibling-a" ? ["subagent-alias:alpha"] : [],
					parent ? ceiling : null,
				),
				status: "working",
				isBackground: false,
				createdAt: time,
				updatedAt: time,
			})
			.run();
	}
	tryClaimExecution("parent-root", "run");
});
afterAll(() => {
	for (const id of ids) {
		setRunHold(id, undefined);
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	sqlite.close();
});
function input(
	callerNarratorId = "sender-child",
	targets = ["parent", "sibling-a"],
): Parameters<typeof sendSubagentMessageDetailed>[0] {
	const id = `source-${++serial}`;
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: callerNarratorId,
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${id}-tool`,
			narratorId: callerNarratorId,
			messageId: id,
			toolUseId: `${id}-use`,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: time,
		})
		.run();
	return {
		callerNarratorId,
		ids: targets,
		toolUseId: `${id}-use`,
		toolCallBinding: { toolCallId: `${id}-tool`, attempt: 1 },
		message: "same report",
		signal: new AbortController().signal,
		locale: "en",
	};
}
function rows(id?: string) {
	return id
		? db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, id))
				.all()
		: db.select().from(narratorBufferedMessages).all();
}

test("foreground child sends parent+sibling in one call, all durable, parent owner unchanged", async () => {
	const owner = getExecutionOwner("parent-root");
	const request = input();
	const notices: Array<import("@shared/communication-tool").SendDeliveryTarget> = [];
	let count = 0;
	request.onTargetsResolved = (n) => {
		count = n;
	};
	request.onDeliveryResolved = (notice) => notices.push(notice);
	const result = await sendSubagentMessageDetailed(request);
	expect(result.targets.map((target) => [target.id, target.status])).toEqual([
		["parent-root", "queued"],
		["sibling-a", "queued"],
	]);
	expect(count).toBe(2);
	expect(notices).toHaveLength(2);
	expect(rows()).toHaveLength(2);
	expect(getExecutionOwner("parent-root")).toBe(owner);
	expect(result.output).toContain("safe input boundary");
	for (const target of result.targets)
		expect(target).toMatchObject({
			deliveryId: expect.any(String),
			deliveryMessageId: expect.any(String),
			revision: 1,
		});
	expect(
		rows().every(
			(row) =>
				row.kind === "agent_message" &&
				row.state === "queued" &&
				row.sourceToolCallId === request.toolCallBinding?.toolCallId,
		),
	).toBe(true);
});

test("parent/main/id and sibling alias/title/id deduplicate by actual recipient", async () => {
	const result = await sendSubagentMessageDetailed(
		input("sender-child", ["parent", "main", "parent-root", "alpha", "Alpha analyst", "sibling-a"]),
	);
	expect(result.targets.map((target) => target.id)).toEqual(["parent-root", "sibling-a"]);
	expect(rows()).toHaveLength(2);
});

test("whole-call selector authorization rejects foreign or missing targets before any parent enqueue", async () => {
	for (const target of ["foreign-child", "nonexistent"]) {
		await expect(
			sendSubagentMessageDetailed(input("sender-child", ["parent", target])),
		).rejects.toThrow();
		expect(rows()).toHaveLength(0);
	}
});

test("one archived target retains both earlier parent and later sibling successes", async () => {
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "sibling-a")).run();
	const result = await sendSubagentMessageDetailed(
		input("sender-child", ["parent", "sibling-a", "sibling-b"]),
	);
	expect(result.targets.map((target) => target.status)).toEqual(["queued", "failed", "queued"]);
	expect(
		rows()
			.map((row) => row.narratorId)
			.sort(),
	).toEqual(["parent-root", "sibling-b"]);
});

test("full parent queue does not prevent sibling delivery and no old entry is evicted", async () => {
	for (let i = 0; i < 50; i++)
		store.enqueue({
			kind: "agent_message",
			narratorId: "parent-root",
			sourceNarratorId: "sender-child",
			sourceToolCallId: `prior-${i}`,
			sourceAttempt: 1,
			sourceKey: "send",
			text: "prior",
			projectedByteSize: 5,
		});
	const result = await sendSubagentMessageDetailed(input());
	expect(result.targets.map((target) => target.status)).toEqual(["failed", "queued"]);
	expect(rows("parent-root")).toHaveLength(50);
	expect(rows("sibling-a")).toHaveLength(1);
});

test("a taken-over target still receives the message, alongside parent and later sibling", async () => {
	// Rejecting a Send to a taken-over subagent silently dropped the instruction:
	// nothing was queued. It must be delivered like to any running subagent.
	setRunHold("sibling-a", { released: false });
	const result = await sendSubagentMessageDetailed(
		input("sender-child", ["sibling-a", "parent", "sibling-b"]),
	);
	expect(result.targets.map((target) => target.status)).toEqual(["queued", "queued", "queued"]);
	expect(rows("sibling-a")).toHaveLength(1);
	expect(rows()).toHaveLength(3);
	expect(result.output).toContain("taken over by the user");
});

test("doInterrupt is ignored for a taken-over child: queued, user's turn untouched", async () => {
	setRunHold("sibling-a", { released: false });
	const turn = new AbortController();
	liveTurn("sibling-a", turn);
	tryClaimExecution("sibling-a", "run");
	const request = input("parent-root", ["sibling-a"]);
	const result = await sendSubagentMessageDetailed({ ...request, doInterrupt: true });
	expect(result.targets.map((target) => target.status)).toEqual(["queued"]);
	expect(turn.signal.aborted).toBe(false);
	expect(rows("sibling-a")).toHaveLength(1);
	expect(result.output).toContain("doInterrupt was ignored");
});

test("child interrupt and primary foreign interrupt fail whole-call before enqueue", async () => {
	await expect(sendSubagentMessageDetailed({ ...input(), doInterrupt: true })).rejects.toThrow();
	await expect(
		sendSubagentMessageDetailed({
			...input("parent-root", ["sibling-a", "foreign-child"]),
			doInterrupt: true,
		}),
	).rejects.toThrow();
	expect(rows()).toHaveLength(0);
});

test("same attempt fanout retry reuses each delivery and never re-interrupts child", async () => {
	const mixed = input();
	const first = await sendSubagentMessageDetailed(mixed);
	const repeated = await sendSubagentMessageDetailed(mixed);
	expect(repeated.targets.map((target) => target.deliveryId)).toEqual(
		first.targets.map((target) => target.deliveryId),
	);
	expect(rows()).toHaveLength(2);
	const controller = new AbortController();
	liveTurn("sibling-b", controller);
	const primary = { ...input("parent-root", ["sibling-b"]), doInterrupt: true };
	await sendSubagentMessageDetailed(primary);
	expect(controller.signal.aborted).toBe(true);
	const replacement = new AbortController();
	liveTurn("sibling-b", replacement);
	await sendSubagentMessageDetailed(primary);
	expect(replacement.signal.aborted).toBe(false);
});

test("database failure at one recipient preserves before/after recipient successes", async () => {
	sqlite.exec(
		"CREATE TEMP TRIGGER reject_mixed_recipient BEFORE INSERT ON narrator_buffered_messages WHEN NEW.narrator_id = 'sibling-a' BEGIN SELECT RAISE(ABORT, 'recipient disk fault'); END",
	);
	try {
		const result = await sendSubagentMessageDetailed(
			input("sender-child", ["parent", "sibling-a", "sibling-b"]),
		);
		expect(result.targets.map((target) => target.status)).toEqual(["queued", "failed", "queued"]);
		expect(result.targets[1]?.error).toContain("recipient disk fault");
	} finally {
		sqlite.exec("DROP TRIGGER reject_mixed_recipient");
	}
	expect(rows()).toHaveLength(2);
});

test("retry after one archived recipient becomes eligible preserves previous successes", async () => {
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "sibling-a")).run();
	const request = input();
	const first = await sendSubagentMessageDetailed(request);
	db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "sibling-a")).run();
	const second = await sendSubagentMessageDetailed(request);
	expect(first.targets.map((target) => target.status)).toEqual(["queued", "failed"]);
	expect(second.targets.map((target) => target.status)).toEqual(["queued", "queued"]);
	expect(second.targets[0]?.deliveryId).toBe(first.targets[0]?.deliveryId);
	expect(rows("parent-root")).toHaveLength(1);
	expect(rows("sibling-a")).toHaveLength(1);
});

test("parent aliases cannot be captured by a sibling title", async () => {
	db.update(narrators).set({ title: "parent" }).where(eq(narrators.id, "sibling-b")).run();
	const result = await sendSubagentMessageDetailed(input("sender-child", ["parent", "sibling-b"]));
	expect(result.targets.map((target) => target.id)).toEqual(["parent-root", "sibling-b"]);
	expect(rows()).toHaveLength(2);
});

test("missing or stale exact receipt never falls back to text/provider tool-use identity", async () => {
	const request = input();
	await sendSubagentMessageDetailed({ ...request, toolCallBinding: undefined });
	expect(rows()).toHaveLength(0);
	const stale = await sendSubagentMessageDetailed({
		...request,
		toolCallBinding: { toolCallId: request.toolCallBinding?.toolCallId ?? "missing", attempt: 2 },
	});
	expect(stale.targets.every((target) => target.status === "failed")).toBe(true);
	expect(rows()).toHaveLength(0);
});

function stopTarget(reason: "error" | "user_interrupt", id = "sibling-a") {
	db.update(narrators)
		.set({ status: "idle", lastStopReason: reason })
		.where(eq(narrators.id, id))
		.run();
}
async function settled(condition: () => boolean) {
	for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(5);
	expect(condition()).toBe(true);
}

test("Send to an error-stopped child reports blocked, keeps the message and tells its page", async () => {
	stopTarget("error");
	const result = await sendSubagentMessageDetailed(input("parent-root", ["sibling-a"]));
	expect(result.targets).toEqual([
		expect.objectContaining({ id: "sibling-a", status: "blocked", blockedReason: "error" }),
	]);
	expect(result.output).toContain("NOT running");
	expect(result.output).toContain("resume=true");
	expect(result.output).not.toContain("retained for the next eligible turn");
	expect(rows("sibling-a").map((row) => row.state)).toEqual(["queued"]);
	await settled(() =>
		broadcasts.some((b) => b.narratorId === "sibling-a" && b.type === "agent_inbox_changed"),
	);
	expect((await inbox.listPendingAgentMessages("sibling-a")).messages).toEqual([
		expect.objectContaining({ preview: "same report", truncated: false }),
	]);
});

test("resume=true restarts an error-stopped child through the explicit override only", async () => {
	stopTarget("error");
	const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(true);
	try {
		const result = await sendSubagentMessageDetailed({
			...input("parent-root", ["sibling-a"]),
			resume: true,
		});
		expect(wake).toHaveBeenCalledWith("sibling-a", "en", { resumeStopped: ["error"] });
		expect(result.targets[0]).toMatchObject({ status: "started", resumed: true });
		expect(result.output).toContain("resumed after its failed last turn");
	} finally {
		wake.mockRestore();
	}
});

test("resume=true cannot override a stop the user made", async () => {
	stopTarget("user_interrupt");
	const result = await sendSubagentMessageDetailed({
		...input("parent-root", ["sibling-a"]),
		resume: true,
	});
	expect(result.targets[0]).toMatchObject({ status: "blocked", blockedReason: "user_interrupt" });
	expect(result.output).toContain("cannot override the user's stop");
	expect(rows("sibling-a")).toHaveLength(1);
});

test("resume and model require control of the target: a child cannot steer its sibling", async () => {
	stopTarget("error");
	for (const extra of [{ resume: true }, { model: "test:other" }])
		await expect(
			sendSubagentMessageDetailed({ ...input("sender-child", ["sibling-a"]), ...extra }),
		).rejects.toThrow("not a direct child");
	expect(rows()).toHaveLength(0);
});

test("model switches a child before delivery and announces it to an idle page", async () => {
	const visible = spyOn(settingsModule, "getSubagentVisibleModels").mockReturnValue([
		"test:model",
		"test:other",
	]);
	try {
		const result = await sendSubagentMessageDetailed({
			...input("parent-root", ["sibling-a"]),
			model: "test:other",
		});
		expect(result.targets[0]).toMatchObject({ status: "queued", model: "test:other" });
		expect(result.output).toContain("Model switched to test:other (applies from its next");
		expect(db.select().from(narrators).where(eq(narrators.id, "sibling-a")).get()?.model).toBe(
			"test:other",
		);
		expect(broadcasts).toContainEqual({
			narratorId: "sibling-a",
			type: "model_changed",
			model: "test:other",
		});
		await sendSubagentMessageDetailed({ ...input("parent-root", ["sibling-a"]), model: "parent" });
		expect(db.select().from(narrators).where(eq(narrators.id, "sibling-a")).get()?.model).toBe(
			"__parent__",
		);
	} finally {
		visible.mockRestore();
	}
});

test("an unknown or out-of-pool model rejects the whole call before any write", async () => {
	const visible = spyOn(settingsModule, "getSubagentVisibleModels").mockReturnValue([
		"test:model",
		"test:pooled",
	]);
	const pools = settingsModule.settings.agent.subagentAllowedModels;
	const siblingModels = () =>
		db
			.select()
			.from(narrators)
			.all()
			.filter((row) => row.id.startsWith("sibling"))
			.map((row) => row.model);
	const before = siblingModels();
	try {
		await expect(
			sendSubagentMessageDetailed({
				...input("parent-root", ["sibling-a", "sibling-b"]),
				model: "test:missing",
			}),
		).rejects.toThrow("not available to subagents");
		settingsModule.settings.agent.subagentAllowedModels = {
			explore: [],
			plan: [],
			general: ["test:pooled"],
		};
		await expect(
			sendSubagentMessageDetailed({
				...input("parent-root", ["sibling-a"]),
				model: "test:model",
			}),
		).rejects.toThrow('not in the allowed "general" subagent model pool');
		expect(rows()).toHaveLength(0);
		expect(siblingModels()).toEqual(before);
		const allowed = await sendSubagentMessageDetailed({
			...input("parent-root", ["sibling-a"]),
			model: "test:pooled",
		});
		expect(allowed.targets[0]).toMatchObject({ status: "queued", model: "test:pooled" });
	} finally {
		settingsModule.settings.agent.subagentAllowedModels = pools;
		visible.mockRestore();
	}
});

test("model cannot change a child the user has taken over", async () => {
	setRunHold("sibling-a", { released: false });
	await expect(
		sendSubagentMessageDetailed({ ...input("parent-root", ["sibling-a"]), model: "test:other" }),
	).rejects.toThrow("taken over by the user");
	expect(rows()).toHaveLength(0);
});

test("tool instructions expose mixed async destinations and deferred foreground parent semantics", () => {
	expect(sendTool.description).toContain("mix parent and sibling");
	expect(sendTool.description).toContain("do not start a second parent loop");
});
