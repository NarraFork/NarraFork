/**
 * Every request of a session run is the projection of its persisted rows.
 *
 * The loop used to extend a provider-format history in memory between requests, and a
 * rebuild from the database (the next pass, a compact, a model switch) produced
 * different bytes: tool results in another order, reminders that were never stored,
 * images that only lived in memory. Now each request after the first is rebuilt from
 * the rows, so within a pass:
 *   - a request only appends to the one before it (the prompt cache keeps its prefix);
 *   - nothing persisted travels as separate current text;
 *   - a rebuild after the run reproduces every request as its prefix.
 *
 * Runs the real orchestrator, loop, event handler and provider history builders; only
 * the network call is scripted.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { openSchemaCopyAt } from "../../../tests/sqlite-schema-image";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { narrators, users } from "../../db/schema";
import { AnthropicProvider } from "../../lib/agent/anthropic-provider";
import { GeminiInteractionsProvider } from "../../lib/agent/gemini-interactions-provider";
import { GeminiProvider } from "../../lib/agent/gemini-provider";
import { OpenAIProvider } from "../../lib/agent/openai-provider";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "../../lib/agent/provider";
import { setUploadsDirForTests } from "../../lib/uploads";

const databaseRoot = mkdtempSync(join(tmpdir(), "nf-parity-database-"));
const template = getTestDb();
const sqlite = openSchemaCopyAt(template.sqlite, join(databaseRoot, "parity.sqlite"));
// Schema images omit triggers; retain the migrated fixture's real history/queue behavior.
for (const trigger of template.sqlite
	.query<{ sql: string }, []>(
		"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
	)
	.all())
	sqlite.exec(trigger.sql);
template.sqlite.close();
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { settings } = await import("../../lib/settings");
const { startNarratorRun } = await import("../agent-runtime/run");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const { activeNarrators } = await import("../narrator-session-state");
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const { clearModelHistorySourceCacheForTest } = await import(
	"../agent-runtime/model-history-source"
);

const TOOL = "ParityProbe";
const IMAGE_TOOL = "ParityCapture";
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const NOW = "2026-10-01T00:00:00.000Z";
const NARRATOR = "parity";

interface Captured {
	content: string;
	history: unknown[];
	toolResults: unknown[];
}

const modes: Array<{ name: string; prefix: string; base: ProviderAdapter }> = [
	{
		name: "anthropic relay",
		prefix: "parity-relay",
		base: new AnthropicProvider({
			id: "parity-relay",
			name: "Parity relay",
			prefix: "parity-relay",
			apiKey: "unused",
			baseUrl: "https://example.invalid",
			defaultModel: "claude-sonnet-4",
			officialApi: false,
		}),
	},
	{
		name: "anthropic official",
		prefix: "parity-official",
		base: new AnthropicProvider({
			id: "parity-official",
			name: "Parity official",
			prefix: "parity-official",
			apiKey: "unused",
			baseUrl: "https://example.invalid",
			defaultModel: "claude-sonnet-4",
			officialApi: true,
		}),
	},
	{
		name: "responses",
		prefix: "parity-responses",
		base: new OpenAIProvider({
			id: "parity-responses",
			name: "Parity responses",
			prefix: "parity-responses",
			apiKey: "unused",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "gpt-5",
			apiMode: "responses",
		}),
	},
	{
		name: "completions",
		prefix: "parity-completions",
		base: new OpenAIProvider({
			id: "parity-completions",
			name: "Parity completions",
			prefix: "parity-completions",
			apiKey: "unused",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "gpt-5",
			apiMode: "completions",
		}),
	},
	{
		name: "gemini",
		prefix: "parity-gemini",
		base: new GeminiProvider({
			id: "parity-gemini",
			name: "Parity gemini",
			prefix: "parity-gemini",
			apiKey: "unused",
			baseUrl: "https://example.invalid",
			defaultModel: "gemini-2.5-pro",
		}),
	},
	{
		name: "gemini interactions",
		prefix: "parity-interactions",
		base: new GeminiInteractionsProvider({
			id: "parity-interactions",
			name: "Parity interactions",
			prefix: "parity-interactions",
			apiKey: "unused",
			baseUrl: "https://example.invalid",
			defaultModel: "gemini-2.5-pro",
			geminiTransport: "interactions",
		}),
	},
];

let captured: Captured[] = [];
let script: (index: number) => ParsedStreamEvent[] = () => [{ text: "finished" }];

function scripted(base: ProviderAdapter): ProviderAdapter {
	return {
		formatTools: base.formatTools.bind(base),
		buildHistory: base.buildHistory.bind(base),
		injectSystemPrompt: base.injectSystemPrompt.bind(base),
		async *chat(params: ChatParams) {
			params.onRequestStart?.();
			captured.push(
				structuredClone({
					content: params.content,
					history: params.history,
					toolResults: params.toolResults,
				}),
			);
			for (const event of script(captured.length - 1)) yield event;
		},
		generate: async () => "",
		generateWithMeta: async () => ({ text: "" }),
		generateWithHistory: async () => "",
	};
}

const adapters = new Map(modes.map((mode) => [mode.prefix, scripted(mode.base)]));
const unregister = registerExternalProviderResolver({
	resolve: (prefix) => adapters.get(prefix) ?? null,
	listReadiness: () => [],
});
toolRegistry.register({
	name: TOOL,
	description: "No-I/O probe",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => ({ output: `probed ${args.value}` }),
});
toolRegistry.register({
	name: IMAGE_TOOL,
	description: "Returns one image",
	parameters: z.object({}),
	execute: async () => ({ output: "captured", images: [{ format: "png", base64: PNG }] }),
});

let cwd = "";
const originalMaxTurns = settings.agent.maxTurns;
beforeEach(() => {
	clearModelHistorySourceCacheForTest();
	cleanDb(sqlite);
	cwd = mkdtempSync(join(tmpdir(), "nf-request-parity-"));
	setUploadsDirForTests(join(cwd, "uploads"));
	captured = [];
	settings.agent.autoContinuationMode = "off";
	settings.agent.maxTurns = originalMaxTurns;
	db.insert(users)
		.values({ id: "owner", username: "owner", passwordHash: "x", createdAt: NOW })
		.run();
});
afterEach(async () => {
	await (await import("../narrator-prefix-snapshots")).closePrefixSnapshotStore();
	getExecutionOwner(NARRATOR)?.release();
	activeNarrators.delete(NARRATOR);
	setUploadsDirForTests(null);
	rmSync(cwd, { recursive: true, force: true });
	cleanDb(sqlite);
});
afterAll(() => {
	unregister();
	toolRegistry.unregister(TOOL);
	toolRegistry.unregister(IMAGE_TOOL);
	clearModelHistorySourceCacheForTest();
	mock.module("../../db", () => realDb);
	sqlite.close();
	rmSync(databaseRoot, { recursive: true, force: true });
});

function call(id: string, value: string): ParsedStreamEvent {
	return { toolUses: [{ toolUseId: id, name: TOOL, input: { value }, outputIndex: 1 }] };
}

async function run(prefix: string): Promise<void> {
	db.insert(narrators)
		.values({
			id: NARRATOR,
			ownerUserId: "owner",
			cwd,
			model: `${prefix}:model`,
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			runtimeRegistrationJson: { version: 1 },
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	const handle = await startNarratorRun({
		narratorId: NARRATOR,
		locale: "en",
		text: "inspect both values",
		principal: "owner",
		deliver: false,
	});
	expect(handle.started).toBe(true);
	expect((await handle.completion).hasError).toBe(false);
}

/** Requests only append, carry nothing beside the rows, and a rebuild reproduces the last. */
async function expectRebuiltRequests(prefix: string): Promise<void> {
	for (const request of captured.slice(1)) {
		// Everything the model saw before is a row by now; nothing rides beside it.
		expect(request.content).toBe("");
		expect(request.toolResults).toEqual([]);
	}
	// Only appended: the prefix of every request is the request before it.
	for (let index = 1; index < captured.length; index++) {
		const previous = captured[index - 1]?.history ?? [];
		expect(captured[index]?.history.slice(0, previous.length)).toEqual(previous);
	}
	// A rebuild after the run, without the pass's system prompt entry, starts with the
	// last request exactly.
	const rebuilt = await buildRuntimeHistory({
		narratorId: NARRATOR,
		model: `${prefix}:model`,
		provider: prefix,
	});
	const last = captured.at(-1)?.history.slice(1) ?? [];
	expect(rebuilt.history.slice(0, last.length)).toEqual(last);
}

const IMAGE_RESULT_PROTOCOLS = new Set([
	"parity-relay",
	"parity-official",
	"parity-responses",
	"parity-interactions",
]);

describe.each(modes)("$name", ({ prefix }) => {
	test("each request extends the previous one and a rebuild reproduces it", async () => {
		script = (index) =>
			index === 0
				? [{ text: "Checking a." }, call("call_a", "a")]
				: index === 1
					? [call("call_b", "b")]
					: [{ text: "Both probed." }];
		await run(prefix);
		expect(captured).toHaveLength(3);

		await expectRebuiltRequests(prefix);
		const text = JSON.stringify(captured[2]?.history);
		expect(text).toContain("probed a");
		expect(text).toContain("probed b");
	});

	test("tool images, a broken call and the turn nudge are rebuilt the way they were sent", async () => {
		settings.agent.maxTurns = 6;
		script = (index) => {
			switch (index) {
				case 0:
					return [
						{ text: "Two at once." },
						{
							toolUses: [
								{ toolUseId: "call_a", name: TOOL, input: { value: "a" }, outputIndex: 1 },
								{ toolUseId: "call_img", name: IMAGE_TOOL, input: {}, outputIndex: 2 },
							],
						},
					];
				case 1:
					return [
						{
							toolUses: [
								{ toolUseId: "call_bad", name: TOOL, input: { _raw: '{"value":' }, outputIndex: 0 },
							],
						},
					];
				case 5:
					return [{ text: "Wrapping up." }];
				default:
					return [call(`call_${index}`, `v${index}`)];
			}
		};
		await run(prefix);
		expect(captured).toHaveLength(6);
		await expectRebuiltRequests(prefix);
		const last = JSON.stringify(captured[5]?.history);
		expect(last).toContain("probed a");
		// Images ride where the protocol accepts them in a tool result.
		expect(last.includes(PNG)).toBe(IMAGE_RESULT_PROTOCOLS.has(prefix));
		// The broken call is left out; a notice says why.
		expect(last).not.toContain("call_bad");
		expect(last).toContain("had invalid or missing input and were not executed");
		// The nudge is a notice after the step at 80% of the budget, sent once.
		expect(last.split("You have used 5 of 6 turns")).toHaveLength(2);
		expect(JSON.stringify(captured[4]?.history)).not.toContain("You have used");
	});
});
