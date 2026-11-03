import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { historyStrings, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";

// Real file-backed store, replay/recovery admission, reflection loop and tool execution.
// Only the provider is scripted; identity persistence always executes real SQL.
const { db, sqlite } = await import("../../db");
const { settings } = await import("../../lib/settings");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { reExecuteDeniedToolCall, executePersistedToolCall, closeNarrator } = await import(
	"../narrator-session"
);
const { activeNarrators } = await import("../narrator-session-state");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const identity = await import("../narrator-conversation-identity");
const realClaim = identity.ensureConversationIdentityPersisted;
const id = "identity-replay";
const userId = "identity-replay-owner";
const model = "identityreplayfixture:model";
const time = "2026-11-03T00:00:00.000Z";
const plan = "Implement the already approved isolated fixture change, then run its focused test.";
const originals = {
	autoContinuationMode: settings.agent.autoContinuationMode,
	planReflectionAutoApprove: settings.agent.planReflectionAutoApprove,
	planModeAllowInlinePlan: settings.agent.planModeAllowInlinePlan,
	planReflectionAllowAutoCompact: settings.agent.planReflectionAllowAutoCompact,
};
let decision: "ExitPlanRevise" | "ExitPlanConfirmAndCompact" = "ExitPlanRevise";
const requests: Array<{
	id: string;
	stored: string | null;
	reflection: boolean;
	principal: string | null | undefined;
}> = [];
const releases = new Set<() => void>();
let holdResponse: Promise<void> | undefined;
const adapter: ProviderAdapter = {
	formatTools: (tools) => tools.map((tool) => ({ name: tool.name })),
	buildHistory: rowsAsHistory,
	injectSystemPrompt(history, systemPrompt) {
		history.unshift({ role: "system", content: systemPrompt });
	},
	async *chat(params) {
		const reflection = `${params.content}\n${historyStrings(params.history)}`.includes(
			"Pending reflection ID:",
		);
		if (requests.length > 3) throw new Error("Unexpected extra replay fixture request");
		requests.push({
			id: params.conversationId,
			stored: narrator().apiConversationId,
			reflection,
			principal: activeNarrators.get(id)?._currentUserId,
		});
		params.onRequestStart?.();
		await holdResponse;
		if (reflection) {
			yield {
				toolUseChunk: {
					toolUseId: `decision-${requests.length}`,
					name: decision,
					input: JSON.stringify(
						decision === "ExitPlanRevise"
							? { confirm: true, feedback: "Clarify the isolated verification step." }
							: { confirm: true, reflection: "The plan is bounded and ready." },
					),
					stop: true,
				},
			};
		} else {
			yield { text: "Completed the approved plan." };
		}
	},
	generate: async () => "Replay fixture",
	generateWithMeta: async () => ({ text: "Replay fixture" }),
	generateWithHistory: async () => "Replay fixture",
};
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "identityreplayfixture" ? adapter : null),
	listReadiness: () => [],
});
function narrator() {
	const row = db.select().from(narrators).where(eq(narrators.id, id)).get();
	if (!row) throw new Error("Missing replay fixture narrator");
	return row;
}
function gate() {
	const deferred = Promise.withResolvers<void>();
	releases.add(deferred.resolve);
	return deferred;
}
async function waitUntil(check: () => boolean, label: string) {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error(
				`Timed out: ${label}; requests=${requests.length}; status=${narrator().status}`,
			);
		await Bun.sleep(10);
	}
}
async function seed(recovery: boolean, storedId: string | null = null) {
	db.update(narrators).set({ apiConversationId: storedId }).where(eq(narrators.id, id)).run();
	db.insert(narratorMessages)
		.values({
			id: "replay-message",
			narratorId: id,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "replay-use", name: "ExitPlanMode", input: { plan } }],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "replay-ref", narratorId: id, messageId: "replay-message", seq: 1 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "replay-tool",
			narratorId: id,
			messageId: "replay-message",
			toolUseId: "replay-use",
			toolName: "ExitPlanMode",
			inputJson: { plan },
			executionIdentityVersion: 1,
			executionAttempt: 1,
			status: recovery ? "initializing" : "fail",
			permissionDecidedBy: recovery ? null : "user",
			createdAt: time,
		})
		.run();
}
function replay(autoContinue = false) {
	return reExecuteDeniedToolCall(id, "replay-use", "en", false, userId, {
		autoContinue,
		persistedToolCallId: "replay-tool",
		permissionMode: "normal",
	});
}
function recover() {
	return executePersistedToolCall({ narratorId: id, toolCallId: "replay-tool", userId });
}

beforeEach(async () => {
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	settings.agent.autoContinuationMode = "off";
	settings.agent.planReflectionAutoApprove = true;
	settings.agent.planModeAllowInlinePlan = true;
	settings.agent.planReflectionAllowAutoCompact = true;
	requests.length = 0;
	holdResponse = undefined;
	decision = "ExitPlanRevise";
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", createdAt: time })
		.run();
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			traits: ["standalone", "plan"],
			model,
			ownerUserId: userId,
			permissionMode: "acceptEdits",
			planReflectionAutoApproveOverride: "on",
			replyContext: { locale: "en", replyInUserLanguage: false },
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.env.HOME,
			createdAt: time,
			updatedAt: time,
		})
		.run();
	backgroundOccupancyStore.refreshNarrator(id);
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	for (const release of releases) release();
	releases.clear();
	holdResponse = undefined;
	sqlite.run("DROP TRIGGER IF EXISTS fail_replay_identity");
	closeNarrator(id);
	await waitUntil(() => !getExecutionOwner(id), "replay cleanup");
	activeNarrators.delete(id);
	await backgroundOccupancyStore.flush();
	await closePrefixSnapshotStore();
	Object.assign(settings.agent, originals);
	mock.restore();
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	unregister();
});

for (const entry of ["recovery", "replay"] as const) {
	test(`${entry} of an unstarted persisted reflection awaits identity without prefix hooks and remains durable after dispose`, async () => {
		await seed(true);
		const releaseClaim = gate();
		const releaseResponse = gate();
		let entered = false;
		spyOn(identity, "ensureConversationIdentityPersisted").mockImplementation(async (...args) => {
			entered = true;
			await releaseClaim.promise;
			return realClaim(...args);
		});
		holdResponse = releaseResponse.promise;
		const running = entry === "recovery" ? recover() : replay();
		await waitUntil(() => entered, "reflection identity preflight");
		expect(requests).toHaveLength(0);
		expect(narrator().apiConversationId).toBeNull();
		releaseClaim.resolve();
		await waitUntil(() => requests.length === 1, "reflection provider");
		expect(requests[0]).toMatchObject({
			reflection: true,
			stored: requests[0].id,
			principal: userId,
		});
		expect(narrator().apiConversationId).toBe(requests[0].id);
		releaseResponse.resolve();
		expect((await running).ok).toBe(true);
		expect(requests).toHaveLength(1);
		expect(activeNarrators.has(id)).toBe(false);
		expect(narrator().apiConversationId).toBe(requests[0].id);
	}, 20_000);
}

test("real storage failure prevents recovered reflection from reaching the provider", async () => {
	await seed(true);
	sqlite.run(`CREATE TRIGGER fail_replay_identity BEFORE UPDATE OF api_conversation_id ON narrators
		WHEN NEW.id = 'identity-replay' AND NEW.api_conversation_id IS NOT NULL
		BEGIN SELECT RAISE(ABORT, 'replay identity storage failure'); END`);
	const result = await recover();
	expect(result.ok).toBe(true);
	expect(requests).toHaveLength(0);
	expect(narrator().apiConversationId).toBeNull();
	const tool = db
		.select()
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, "replay-tool"))
		.get();
	expect(tool?.status).toBe("fail");
	expect(JSON.stringify(tool?.permissionSuggestions)).toContain("failed");
	expect(activeNarrators.has(id)).toBe(false);
}, 20_000);

test("reexecuted ExitPlanMode compact resets the baseline atomically and automatic continuation reclaims the same key", async () => {
	await seed(true, "stable-plan-key");
	decision = "ExitPlanConfirmAndCompact";
	const result = await replay(true);
	expect(result.ok).toBe(true);
	await waitUntil(
		() => !getExecutionOwner(id) && narrator().status === "idle",
		"automatic plan continuation",
	);
	expect(requests).toHaveLength(2);
	expect(requests[0]).toMatchObject({
		id: "stable-plan-key",
		stored: "stable-plan-key",
		reflection: true,
		principal: userId,
	});
	expect(requests[1]).toMatchObject({
		id: "stable-plan-key",
		stored: "stable-plan-key",
		reflection: false,
		principal: userId,
	});
	expect(narrator().apiConversationId).toBe("stable-plan-key");
	const compacts = db
		.select({ text: narratorMessages.contentText })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.isCompact, 1))
		.all();
	expect(compacts.some((marker) => marker.text?.includes(plan))).toBe(true);
}, 20_000);
