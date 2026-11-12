import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import { registerAutoSourceProbe, resolveEffectiveModel, settings } from "../../lib/settings";
import { delegationRegistration } from "../../lib/validators/runtime-registration";

// Keep this heavy import graph out of the pure routing tests. No module mocks:
// activation, persisted history, inheritance and the preload-isolated DB are real.
const { db, sqlite } = await import("../../db");
const { ensureNarrator } = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { lastServedProvider } = await import("../auto-sticky-source");

const AUTO = "auto:claude-opus-4-6";
const NUG2 = "nug2:claude-opus-4-6";
const NUGJP = "nugjp:claude-opus-4-6";
const now = "2026-11-06T10:00:00.000Z";
let available: Record<string, boolean>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

// As in settings/auto-model-routing.test.ts, only the source facts are injected.
// A source's recovery changes routing priority, not a persisted session's affinity.
function bindAutoSourceProbe() {
	registerAutoSourceProbe((provider) => ({
		available: available[provider] ?? false,
		subscription: false,
	}));
}

function seedNarrator(id: string, model: string | null, parent?: string) {
	db.insert(narrators)
		.values({
			id,
			model,
			type: parent ? "subagent" : "primary",
			variant: parent ? "subagent:general" : "primary",
			...(parent && {
				parentNarratorId: parent,
				policySourceNarratorId: parent,
				subagentType: "general",
				runtimeRegistrationJson: delegationRegistration(parent, "general"),
			}),
			cwd: testEnvironment.isolatedHome,
			traits: ["standalone"],
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedMessage(
	narratorId: string,
	seq: number,
	role: "assistant" | "user" | "system",
	provider: string | null,
	isCompact = false,
) {
	const id = `${narratorId}-message-${seq}`;
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role,
			provider,
			contentJson: [{ type: "text", text: isCompact ? "compact summary" : "fixture reply" }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId, messageId: id, seq, isCompact: isCompact ? 1 : 0 })
		.run();
	return id;
}

function evict(id: string) {
	const active = activeNarrators.get(id);
	active?.abortController.abort();
	activeNarrators.delete(id);
}

async function startOnNugjp(id: string) {
	available.nug2 = false;
	const active = await ensureNarrator(id, "en");
	expect(active.model).toBe(NUGJP);
	expect(active.provider).toBe("nugjp");
	seedMessage(id, 1, "assistant", "nugjp");
	// The newest row is not necessarily an assistant reply.
	seedMessage(id, 2, "user", null);
	evict(id);
	available.nug2 = true;
	// A fresh session now prefers the recovered source.
	expect(resolveEffectiveModel(AUTO)).toBe(NUG2);
	return active;
}

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
	expect(testEnvironment.narraforkHome).not.toBe(testEnvironment.realNarraforkHome);
	settings.agent.hiddenModels = [];
	settings.agent.disabledProviders = [];
	settings.agent.autoExcludedProviders = [];
	settings.customApiProviders = ["nug2", "nugjp"].map((prefix) => ({
		id: `sticky-activation-${prefix}`,
		name: prefix,
		prefix,
		apiKey: "fixture-never-used",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "claude-opus-4-6",
		protocol: "completions-compatible" as const,
	}));
	settings.agent.customModels = [NUG2, NUGJP].map((value) => ({
		value,
		label: value,
		provider: value.slice(0, value.indexOf(":")),
	}));
	settings.agent.defaultModel = AUTO;
	settings.agent.summaryModel = AUTO;
	settings.agent.subagentAllowedModels = { explore: [], plan: [], general: [] };
	settings.agent.subagentModels = { explore: "", plan: "" };
	available = { nug2: true, nugjp: true };
	bindAutoSourceProbe();
	const forbidNetwork = () => {
		throw new Error("Activation must not contact a real provider");
	};
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(forbidNetwork, { preconnect: forbidNetwork }),
	);
});

afterEach(async () => {
	for (const id of activeNarrators.keys()) evict(id);
	await closePrefixSnapshotStore();
	registerAutoSourceProbe(null);
	const fetchCalls = fetchSpy.mock.calls.length;
	fetchSpy.mockRestore();
	expect(fetchCalls).toBe(0);
});

afterAll(async () => {
	await closePrefixSnapshotStore();
});

describe("real ensureNarrator auto-source affinity after eviction", () => {
	for (const model of [AUTO, null, "__default__", "__summary__"]) {
		test(`${model ?? "legacy null"} keeps its own nugjp reply after nug2 recovers`, async () => {
			seedNarrator("session", model);
			const old = await startOnNugjp("session");
			const rebuilt = await ensureNarrator("session", "en");
			expect(rebuilt).not.toBe(old);
			expect(rebuilt.model).toBe(NUGJP);
			expect(rebuilt.provider).toBe("nugjp");
			expect(rebuilt._modelSelectionRef).toBe(model ?? "__default__");
		});
	}

	for (const parentModel of [AUTO, null, "__default__"]) {
		test(`FOLLOW_PARENT_MODEL (${parentModel ?? "null default"}) uses the child's own affinity`, async () => {
			seedNarrator("parent", parentModel);
			seedMessage("parent", 1, "assistant", "nug2");
			seedNarrator("child", FOLLOW_PARENT_MODEL, "parent");
			const old = await startOnNugjp("child");
			const rebuilt = await ensureNarrator("child", "en");
			expect(rebuilt).not.toBe(old);
			expect(rebuilt.model).toBe(NUGJP);
			expect(rebuilt.provider).toBe("nugjp");
			expect(rebuilt._modelSelectionRef).toBe(FOLLOW_PARENT_MODEL);
			expect(activeNarrators.has("parent")).toBe(false);
		});
	}

	test("a compact boundary releases affinity and the rebuilt session selects recovered nug2", async () => {
		seedNarrator("session", AUTO);
		await startOnNugjp("session");
		seedMessage("session", 3, "system", null, true);
		expect(await lastServedProvider("session")).toBeUndefined();
		const rebuilt = await ensureNarrator("session", "en");
		expect(rebuilt.model).toBe(NUG2);
		expect(rebuilt.provider).toBe("nug2");
	});

	test("a fork's shared prefix does not inherit its source's nugjp affinity", async () => {
		seedNarrator("source", AUTO);
		await startOnNugjp("source");
		seedNarrator("fork", AUTO);
		db.insert(narratorMessageRefs)
			.values({
				id: "fork-prefix-ref",
				narratorId: "fork",
				messageId: "source-message-1",
				seq: 1,
				isCompact: 0,
			})
			.run();
		expect(await lastServedProvider("fork")).toBeUndefined();
		expect((await ensureNarrator("fork", "en")).model).toBe(NUG2);
		expect((await ensureNarrator("source", "en")).model).toBe(NUGJP);
	});

	test("a genuinely unavailable nugjp releases affinity to recovered nug2", async () => {
		seedNarrator("session", AUTO);
		await startOnNugjp("session");
		available.nugjp = false;
		expect(await lastServedProvider("session")).toBe("nugjp");
		const rebuilt = await ensureNarrator("session", "en");
		expect(rebuilt.model).toBe(NUG2);
		expect(rebuilt.provider).toBe("nug2");
	});

	test("an explicit provider is never overwritten by the persisted nugjp affinity", async () => {
		seedNarrator("pinned", NUG2);
		seedMessage("pinned", 1, "assistant", "nugjp");
		expect(await lastServedProvider("pinned")).toBe("nugjp");
		const rebuilt = await ensureNarrator("pinned", "en");
		expect(rebuilt.model).toBe(NUG2);
		expect(rebuilt.provider).toBe("nug2");
		expect(rebuilt._modelSelectionRef).toBe(NUG2);
	});
});
