/**
 * compact-exit-drains-queue.test.ts — the REAL compact run must consume the queue on
 * its way out, on every exit.
 *
 * `compact-queue-drain.test.ts` pins the drain function's own behaviour by calling it
 * directly, which cannot notice the failure that actually matters: the hook not being
 * wired into `runCustomCompact` at all. A missing hook is invisible — compaction keeps
 * working, and the only symptom is a user message that is accepted, shown as queued,
 * and then never answered until something else happens to wake the narrator.
 *
 * So this file drives the real run and asserts the call. The cancel path is covered
 * separately because it exits through `doRunCustomCompact`'s abort branch rather than
 * the success return, and a hook placed on the success path only would silently strand
 * exactly the messages a user queued and then changed their mind about mid-compact.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, projects } from "../../db/schema";
import { settings } from "../../lib/settings";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: () => {},
}));

/**
 * Record drain calls instead of running the resumed turn.
 *
 * The drain module is mocked (not `narrator-session`) so this test observes exactly the
 * boundary it is about: did the compact run reach the drain?
 */
let drainCalls: string[] = [];
const realDrainModule = { ...(await import("../compact-queue-drain")) };
mock.module("../compact-queue-drain", () => ({
	...realDrainModule,
	drainQueuedMessagesAfterCompact: async (narratorId: string) => {
		drainCalls.push(narratorId);
	},
}));

const { narratorContext } = await import("../narrator-context");
const { cancelCompact, compactLocks, runCustomCompact } = await import("../narrator-compact");
const { claimConversationIdentity, createConversationIdentityStore } = await import(
	"../narrator-conversation-identity"
);
const { sqliteContextQuery } = await import("../context-composition-history");
const { activeNarrators, withNarratorMutationAdmission } = await import(
	"../narrator-session-state"
);

const realGenerateCompactSummary = narratorContext.generateCompactSummary.bind(narratorContext);
const NARRATOR_ID = "n-compact-exit";

function seed(): void {
	const now = new Date().toISOString();
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: NARRATOR_ID,
			contextProjectId: "p1",
			cwd: "/tmp/repo",
			type: "primary",
			inheritMode: "fresh",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	for (const [id, text, seq] of [
		["m-before", "before", 0],
		["m-target", "target", 1],
	] as const) {
		db.insert(narratorMessages)
			.values({
				id,
				narratorId: NARRATOR_ID,
				role: "user",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.run();
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
			[`r-${id}`, NARRATOR_ID, id, seq],
		);
	}
}

beforeEach(() => {
	cleanDb(sqlite);
	compactLocks.clear();
	drainCalls = [];
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
});

afterEach(() => {
	compactLocks.clear();
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
});

afterAll(() => {
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.module("../compact-queue-drain", () => realDrainModule);
	mock.restore();
});

describe("runCustomCompact drains the queue on exit", () => {
	test("a successful compact reaches the drain", async () => {
		seed();
		narratorContext.generateCompactSummary = async () => ({
			summary: "a summary",
			contextPercent: 10,
		});

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });

		expect(drainCalls).toEqual([NARRATOR_ID]);
		expect(compactLocks.has(NARRATOR_ID)).toBe(false);
	});

	test("compact generates outside admission but publishes its clear and live reset together", async () => {
		seed();
		let summaryStarted!: () => void;
		const summaryReady = new Promise<void>((resolve) => {
			summaryStarted = resolve;
		});
		let release!: () => void;
		const releaseClaim = new Promise<void>((resolve) => {
			release = resolve;
		});
		let claimed!: () => void;
		const claimReady = new Promise<void>((resolve) => {
			claimed = resolve;
		});
		const previousProviders = settings.anthropicProviders;
		settings.anthropicProviders = [
			...(previousProviders ?? []),
			{
				id: "compact-identity-test",
				name: "Compact identity test",
				prefix: "compact-identity-test",
				apiKey: "isolated-no-network",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-5-5",
				officialApi: false,
			},
		];
		const active = {
			alive: true,
			model: "claude-sonnet-5-5",
			provider: "compact-identity-test",
			_enabledOptionalTools: new Set<string>(),
			conversationId: "stable-before-compact",
			_persistedConversationId: null,
		} as import("../narrator-session-state").ActiveNarrator;
		activeNarrators.set(NARRATOR_ID, active);
		const store = createConversationIdentityStore(sqliteContextQuery(sqlite));
		narratorContext.generateCompactSummary = async () => {
			summaryStarted();
			return { summary: "new compact", contextPercent: 10 };
		};
		const claim = withNarratorMutationAdmission(NARRATOR_ID, async () => {
			// The remote summary must start while this short admission is held.
			await summaryReady;
			await claimConversationIdentity(store, NARRATOR_ID, active);
			claimed();
			await releaseClaim;
		});
		const compact = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		try {
			await claimReady;
			expect((await store.read(NARRATOR_ID)).conversationId).toBe("stable-before-compact");
			expect(active._persistedConversationId).toBe("stable-before-compact");
			release();
			await claim;
			await compact;
			expect((await store.read(NARRATOR_ID)).conversationId).toBeNull();
			expect(active._persistedConversationId).toBeNull();
			expect(active.conversationId).toBe("stable-before-compact");
			expect(active._resetUpstreamSessionOnNextRequest).toBe(true);
		} finally {
			release();
			await Promise.allSettled([claim, compact]);
			activeNarrators.delete(NARRATOR_ID);
			settings.anthropicProviders = previousProviders;
		}
	});

	test("a cancelled compact reaches the drain too, so nothing is stranded", async () => {
		seed();
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		narratorContext.generateCompactSummary = (_narratorId, _locale, _messages, signal) => {
			started();
			return new Promise((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Compact summary aborted", "AbortError")),
					{ once: true },
				);
			});
		};

		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		await requestStarted;
		expect(cancelCompact(NARRATOR_ID)).toBe(true);
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });

		expect(drainCalls).toEqual([NARRATOR_ID]);
		expect(compactLocks.has(NARRATOR_ID)).toBe(false);
	});
});
