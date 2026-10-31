import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import type { ReconciledEpoch, ReconcileEpochInput } from "../narrator-epochs";

// Keep the real isolated on-disk database: history workers read it independently.
const { narratorService } = await import("../narrator-service");
const { reconcileEpoch } = await import("../narrator-epochs");
const { narratorPersistence } = await import("../narrator-persistence");
const { loadPrefixState } = await import("../narrator-prefix-state");
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const { clearModelHistorySourceCacheForTest } = await import(
	"../agent-runtime/model-history-source"
);
const originalProviders = settings.anthropicProviders;
const provider = "sender-context-integration";

beforeEach(() => {
	settings.anthropicProviders = [
		...(originalProviders ?? []),
		{
			id: provider,
			name: "Sender context integration",
			prefix: provider,
			apiKey: "isolated-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "claude-sonnet-4",
			officialApi: false,
		},
	];
});
afterAll(() => {
	settings.anthropicProviders = originalProviders;
});

async function human(username = `Alice-${generateId()}`) {
	const id = generateId();
	await db.insert(users).values({
		id,
		username,
		passwordHash: "private-test-password",
		createdAt: new Date().toISOString(),
	});
	return { id, username };
}

async function fixture() {
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: narratorId, cwd: "/tmp", createdAt: now, updatedAt: now });
	const input: ReconcileEpochInput = {
		narratorId,
		messages: [],
		managed: new Set<string>(),
		current: [],
		candidates: [],
		model: "claude-sonnet-4",
		provider,
		prompt: { contract: "Fixed contract", parts: [{ key: "workspace", text: "/repo" }] },
		noticeText: (kind, name) => `${kind}: ${name}`,
		resolveTarget: (model, provider) => ({ fingerprint: `${provider}:${model}`, cacheTtlMs: 1 }),
	};
	return input;
}

async function persist(input: ReconcileEpochInput, userId: string | undefined, text: string) {
	return narratorPersistence.persistUserMessage(
		input.narratorId,
		text,
		undefined,
		undefined,
		userId,
	);
}

async function rename(userId: string, username: string) {
	await db.update(users).set({ username }).where(eq(users.id, userId));
	// A cached source can otherwise hide the live join change and give a false pass.
	clearModelHistorySourceCacheForTest();
}

function runtime(input: ReconcileEpochInput, epoch?: ReconciledEpoch["epoch"]) {
	return buildRuntimeHistory({
		narratorId: input.narratorId,
		model: input.model,
		provider: input.provider,
		ownTurnPlacement: null,
		toolLoading: { managed: input.managed, current: [], candidates: input.candidates, epoch },
	});
}

async function names(input: ReconcileEpochInput, result: ReconciledEpoch) {
	const epoch = result.epoch;
	if (!epoch?.prefix) throw new Error("Expected persisted prefix epoch");
	const messages = await narratorService.getModelHistorySinceLastCompact(input.narratorId);
	const state = await loadPrefixState({ ...epoch, prefix: epoch.prefix }, messages);
	return JSON.parse(state.parts.get("senders") ?? "{}");
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (value && typeof value === "object") return Object.values(value).map(textOf).join("\n");
	return "";
}

function marker(user: { id: string; username: string }) {
	return `<sender kind="human" id="${user.id}"${user.username ? ` name="${user.username}"` : ""} />`;
}

describe("persisted sender context across epochs and cold history reads", () => {
	test("rename keeps same-epoch wire bytes, while changing model refreshes the name", async () => {
		const input = await fixture();
		const alice = await human();
		const row = await persist(input, alice.id, "original request");
		const initial = await reconcileEpoch(input);
		const before = await runtime(input, initial.epoch);
		expect(await names(input, initial)).toEqual({ [alice.id]: alice.username });
		expect(textOf(before.history)).toContain(marker(alice));

		const renamed = `Renamed-${generateId()}`;
		await rename(alice.id, renamed);
		const resumed = await reconcileEpoch(input);
		expect(resumed.changed).toBe(false);
		expect(resumed.epoch?.markerId).toBe(initial.epoch?.markerId);
		expect(resumed.systemPrompt).toBe(initial.systemPrompt);
		const after = await runtime(input, resumed.epoch);
		expect(after.sourceMessages.find((message) => message.id === row.id)?.creator?.username).toBe(
			renamed,
		);
		expect(JSON.stringify(after.history)).toBe(JSON.stringify(before.history));
		expect(after.currentInputText).toBe(before.currentInputText);
		expect(after.currentInputText).toBe(`${marker(alice)}\noriginal request`);
		expect(await names(input, resumed)).toEqual({ [alice.id]: alice.username });

		const nextInput = { ...input, model: "claude-opus-4" };
		const next = await reconcileEpoch(nextInput);
		expect(next.opened).toBe(true);
		expect(next.epoch?.reason).toBe("target");
		expect(next.epoch?.markerId).not.toBe(initial.epoch?.markerId);
		expect(await names(nextInput, next)).toEqual({ [alice.id]: renamed });
		const refreshed = await runtime(nextInput, next.epoch);
		expect(refreshed.currentInputText).toBe(
			`${marker({ ...alice, username: renamed })}\noriginal request`,
		);
		expect(JSON.stringify(refreshed.history)).not.toBe(JSON.stringify(before.history));
	});

	test("a newly participating user is appended once without unfreezing existing people", async () => {
		const input = await fixture();
		const alice = await human();
		const original = await persist(input, alice.id, "Alice request");
		const initial = await reconcileEpoch(input);
		const before = await runtime(input, initial.epoch);
		await rename(alice.id, `Alice-renamed-${generateId()}`);
		const bob = await human(`Bob-${generateId()}`);
		await persist(input, bob.id, "Bob request");
		const joined = await reconcileEpoch(input);
		expect(joined.changed).toBe(true);
		expect(joined.opened).toBe(false);
		expect(joined.epoch?.markerId).toBe(initial.epoch?.markerId);
		expect(joined.systemPrompt).toBe(initial.systemPrompt);
		expect(await names(input, joined)).toEqual({
			[alice.id]: alice.username,
			[bob.id]: bob.username,
		});
		const after = await runtime(input, joined.epoch);
		expect(after.modelMessages.find((message) => message.id === original.id)).toEqual(
			before.modelMessages.find((message) => message.id === original.id),
		);
		expect(textOf(after.history)).toContain(marker(alice));
		expect(textOf(after.history)).toContain(marker(bob));
		await rename(bob.id, `Bob-renamed-${generateId()}`);
		const resumed = await reconcileEpoch(input);
		expect(resumed.changed).toBe(false);
		const restarted = await runtime(input, resumed.epoch);
		expect(JSON.stringify(restarted.history)).toBe(JSON.stringify(after.history));
		expect(restarted.currentInputText).toBe(after.currentInputText);
	});

	test("unknown names freeze as absent; missing identity and legacy history remain compatible", async () => {
		const input = await fixture();
		const unknown = await human("");
		await persist(input, undefined, "legacy anonymous request");
		await persist(input, unknown.id, "unknown-name request");
		const legacy = await runtime(input);
		expect(legacy.currentInputText).toBe(`${marker(unknown)}\nunknown-name request`);
		const initial = await reconcileEpoch(input);
		expect(await names(input, initial)).toEqual({ [unknown.id]: "" });
		const before = await runtime(input, initial.epoch);
		const renamed = `Known-${generateId()}`;
		await rename(unknown.id, renamed);
		const resumed = await reconcileEpoch(input);
		expect(resumed.changed).toBe(false);
		const after = await runtime(input, resumed.epoch);
		expect(JSON.stringify(after.history)).toBe(JSON.stringify(before.history));
		expect(after.currentInputText).toBe(`${marker(unknown)}\nunknown-name request`);
		expect(textOf(after.history)).toContain('<sender kind="human" />');
		// Explicitly absent epoch retains the pre-prefix live-join behavior.
		const withoutEpoch = await runtime(input);
		expect(withoutEpoch.currentInputText).toBe(
			`${marker({ ...unknown, username: renamed })}\nunknown-name request`,
		);
	});
});
