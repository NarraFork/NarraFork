import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rowsAsHistory } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import { getDbPath } from "../../db/connection";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";

// The production request builder and prefix worker share preload's isolated FILE DB.
// Nothing replaces the run/executor, ownership, authorization, or durable CAS.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const { acceptUserMessage, closeNarrator, hasPendingBufferedWork } = await import(
	"../narrator-session"
);
const { activeNarrators, resetActiveUpstreamSession, withNarratorMutationAdmission } = await import(
	"../narrator-session-state"
);
const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { runCustomCompact } = await import("../narrator-compact");
const identity = await import("../narrator-conversation-identity");
const originalPreflight = identity.ensureConversationIdentityPersisted;
const narratorId = "identity-runtime";
const userId = "identity-principal";
const model = "identityruntimefixture:model";
const timestamp = "2026-11-03T00:00:00.000Z";
const originalSettings = {
	autoContinuationMode: settings.agent.autoContinuationMode,
	summaryModel: settings.agent.summaryModel,
	maxTransientRetries: settings.agent.maxTransientRetries,
	retryBackoffCeilMs: settings.agent.retryBackoffCeilMs,
};

type Capture = {
	conversationId: string;
	persistedId: string | null;
	liveId: string | undefined;
	principal: string | null | undefined;
	runPrincipal: string | null | undefined;
	owner: ReturnType<typeof getExecutionOwner>;
};
const requests: Capture[] = [];
const releases = new Set<() => void>();
let beforeResponse: ((params: ChatParams) => Promise<"empty" | undefined>) | undefined;
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt(history, prompt) {
		history.unshift({ role: "system", content: prompt });
	},
	async *chat(params) {
		const active = activeNarrators.get(narratorId);
		requests.push({
			conversationId: params.conversationId,
			persistedId: row().apiConversationId,
			liveId: active?.conversationId,
			principal: active?._currentUserId,
			runPrincipal: getRunControl(narratorId)?.principal,
			owner: getExecutionOwner(narratorId),
		});
		params.onRequestStart?.();
		if ((await beforeResponse?.(params)) === "empty") return;
		yield { text: "Completed the identity fixture request." };
	},
	generate: async () => "Summary of the identity fixture history.",
	generateWithMeta: async () => ({ text: "Summary of the identity fixture history." }),
	generateWithHistory: async () => "Summary of the identity fixture history.",
};
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "identityruntimefixture" ? adapter : null),
	listReadiness: () => [],
});

function row() {
	const value = db.select().from(narrators).where(eq(narrators.id, narratorId)).get();
	if (!value) throw new Error("Missing identity-runtime narrator fixture");
	return value;
}
function gate() {
	const result = Promise.withResolvers<void>();
	releases.add(result.resolve);
	return result;
}
async function waitUntil(check: () => boolean, label: string) {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out: ${label}; requests=${requests.length}; status=${row().status}`);
		await Bun.sleep(10);
	}
}
async function idle(count: number) {
	await waitUntil(
		() =>
			requests.length === count &&
			row().status === "idle" &&
			!getExecutionOwner(narratorId) &&
			!hasPendingBufferedWork(narratorId),
		"run fully torn down",
	);
}
async function start() {
	await acceptUserMessage(
		narratorId,
		"Verify the conversation identity through the actual runtime.",
		{
			userId,
			locale: "en",
			replyInUserLanguage: false,
			humanReplyContext: { locale: "en", replyInUserLanguage: false },
		},
	);
}
function expectDurable(capture: Capture) {
	expect(capture.conversationId.length).toBeGreaterThan(0);
	expect(capture.persistedId).toBe(capture.conversationId);
	expect(capture.liveId).toBe(capture.conversationId);
	expect(capture.principal).toBe(userId);
	expect(capture.runPrincipal).toBe(userId);
	expect(capture.owner).toBeDefined();
}

beforeEach(async () => {
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	settings.agent.autoContinuationMode = "off";
	settings.agent.summaryModel = model;
	settings.agent.maxTransientRetries = 1;
	settings.agent.retryBackoffCeilMs = 1;
	requests.length = 0;
	beforeResponse = undefined;
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", createdAt: timestamp })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model,
			ownerUserId: userId,
			permissionMode: "default",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.env.HOME,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	for (const release of releases) release();
	releases.clear();
	beforeResponse = undefined;
	closeNarrator(narratorId);
	await waitUntil(() => !getExecutionOwner(narratorId), "cleanup execution owner");
	activeNarrators.delete(narratorId);
	await backgroundOccupancyStore.flush();
	await closePrefixSnapshotStore();
	Object.assign(settings.agent, originalSettings);
	mock.restore();
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	unregister();
});

test("first provider call waits for real preflight and cold DB recovery works before teardown", async () => {
	const entered = gate();
	const releaseClaim = gate();
	const releaseResponse = gate();
	let preflights = 0;
	spyOn(identity, "ensureConversationIdentityPersisted").mockImplementation(async (...args) => {
		preflights++;
		if (preflights === 1) {
			entered.resolve();
			await releaseClaim.promise;
		}
		return originalPreflight(...args);
	});
	beforeResponse = async () => {
		await releaseResponse.promise;
	};
	await start();
	await waitUntil(() => preflights > 0, "request reached identity preflight");
	await entered.promise;
	expect(requests).toHaveLength(0);
	expect(row().apiConversationId).toBeNull();
	expect(activeNarrators.get(narratorId)?._persistedConversationId).toBeNull();
	releaseClaim.resolve();
	await waitUntil(() => requests.length === 1, "first provider chat");
	expectDurable(requests[0]);
	expect(getExecutionOwner(narratorId)).toBe(requests[0].owner);
	expect(activeNarrators.get(narratorId)?._loopRunning).toBe(true);
	const coldConnection = new Database(getDbPath(), { readonly: true });
	try {
		const recovered = coldConnection
			.query<{ id: string | null }, [string]>(
				"SELECT api_conversation_id AS id FROM narrators WHERE id = ?",
			)
			.get(narratorId);
		expect(recovered?.id).toBe(requests[0].conversationId);
	} finally {
		coldConnection.close();
	}
	releaseResponse.resolve();
	await idle(1);
}, 20_000);

test("same-loop empty-response retry reclaims the live identity after real background compact", async () => {
	for (const [id, seq] of [
		["identity-old", 0],
		["identity-boundary", 1],
	] as const) {
		db.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: [{ type: "text", text: id }],
				contentText: id,
				createdBy: userId,
				createdAt: timestamp,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `${id}-ref`, narratorId, messageId: id, seq })
			.run();
	}
	const afterCompact: Array<{
		stored: string | null;
		live: string | undefined;
		baseline: string | null | undefined;
	}> = [];
	beforeResponse = async () => {
		if (requests.length !== 1) return;
		await runCustomCompact(narratorId, "en", "identity-boundary", { mode: "background", userId });
		const active = activeNarrators.get(narratorId);
		afterCompact.push({
			stored: row().apiConversationId,
			live: active?.conversationId,
			baseline: active?._persistedConversationId,
		});
		// Empty upstream response retries inside the SAME real agent loop; it does
		// not pass through fresh-run initialization or an outer teardown.
		return "empty";
	};
	await start();
	await idle(2);
	expect(afterCompact).toEqual([
		{ stored: null, live: requests[0].conversationId, baseline: null },
	]);
	expectDurable(requests[0]);
	expectDurable(requests[1]);
	expect(requests[1].conversationId).toBe(requests[0].conversationId);
	expect(requests[1].owner).toBe(requests[0].owner);
	expect(row().apiConversationId).toBe(requests[0].conversationId);
}, 20_000);

test("the old run teardown cannot resurrect an identity explicitly cleared during its last request", async () => {
	let cleared = false;
	beforeResponse = async () => {
		await withNarratorMutationAdmission(narratorId, async () => {
			await db
				.update(narrators)
				.set({ apiConversationId: null, contextSummary: "history explicitly replaced" })
				.where(eq(narrators.id, narratorId));
			resetActiveUpstreamSession(narratorId, { persistedIdentityCleared: true });
			cleared = true;
		});
	};
	await start();
	await idle(1);
	expect(cleared).toBe(true);
	expectDurable(requests[0]);
	expect(row().apiConversationId).toBeNull();
}, 20_000);
