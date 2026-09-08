import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { FileReferenceSnapshot } from "@shared/file-reference";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../db/schema";
import { setNugCachedModels } from "../../nug-model-cache";
import { settings } from "../../settings";
import { projectFileReferenceText } from "../file-reference-projection";
import type { DbMessage } from "../provider";

if (process.env.NARRAFORK_FILE_REFERENCE_FIXTURE !== "providers") {
	test("isolated file reference provider suite", () => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NARRAFORK_FILE_REFERENCE_FIXTURE: "providers",
		};
		delete env.NARRAFORK_HOME;
		const result = spawnSync(process.execPath, ["test", import.meta.path], {
			env,
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 512 * 1024,
		});
		if (result.error || result.status !== 0)
			throw new Error(`${result.error ?? "Fixture failed"}\n${result.stdout}\n${result.stderr}`);
		expect(result.status).toBe(0);
	}, 65_000);
} else {
	// Exercise real adapters through the unified buildHistory entry point. Their
	// history builders need no DB/network; importing the server must never open the
	// application's database just to run these tests.
	const sqlite = new Database(":memory:");
	const db = drizzle({ client: sqlite, schema });
	mock.module("../../../db", () => ({ db, sqlite }));
	const { buildHistory } = await import("../index");
	afterAll(() => sqlite.close());

	const base = {
		id: "refs",
		prefix: "refs",
		name: "Reference tests",
		apiKey: "not-a-secret",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "model",
	};
	const body = 'accepted source citeturn0search0\nconst x = "frozen";';
	const reference: FileReferenceSnapshot = {
		type: "file_reference",
		reference: { id: "ref", deviceId: "remote-A", path: "/missing.ts", label: "file" },
		snapshotText: body,
		snapshotHash: "sha256:fixed",
		capturedAt: "2026-09-01T00:00:00Z",
	};
	function user(id: string, text = "inspect", snapshots = [reference]): DbMessage {
		return {
			id,
			role: "user",
			contentText: text,
			contentJson: [...snapshots, { type: "text", text }],
			parentToolUseId: null,
			messageUuid: null,
		};
	}
	function assistant(): DbMessage {
		return {
			id: "assistant",
			role: "assistant",
			contentText: "read",
			parentToolUseId: null,
			messageUuid: null,
			contentJson: [
				{ type: "text", text: "read" },
				{ type: "tool_use", id: "tool", name: "Read", input: { file_path: "/plain" } },
			],
			toolCalls: [
				{
					toolUseId: "tool",
					toolName: "Read",
					inputJson: { file_path: "/plain" },
					outputJson: "tool result",
					status: "success",
				},
			],
		};
	}
	function occurrences(payload: unknown, needle: string): number {
		if (typeof payload === "string") return payload.split(needle).length - 1;
		if (Array.isArray(payload))
			return payload.reduce((sum, value) => sum + occurrences(value, needle), 0);
		if (payload && typeof payload === "object")
			return Object.values(payload).reduce<number>(
				(sum, value) => sum + occurrences(value, needle),
				0,
			);
		return 0;
	}

	type Mode =
		| "anthropic"
		| "official"
		| "completions"
		| "responses"
		| "codex-delegate"
		| "gemini"
		| "interactions"
		| "nug-anthropic"
		| "nug-openai"
		| "nug-responses"
		| "nug-codex";
	function configure(mode: Mode) {
		if (mode === "anthropic" || mode === "official")
			settings.anthropicProviders = [{ ...base, officialApi: mode === "official" }];
		else if (mode === "gemini" || mode === "interactions")
			settings.geminiProviders = [
				{ ...base, geminiTransport: mode === "gemini" ? "generate-content" : "interactions" },
			];
		else if (mode.startsWith("nug-")) {
			const channel = mode.slice(4);
			settings.nugProviders = [{ ...base, defaultModel: `${channel}:model` }];
			setNugCachedModels(base.id, [
				{ id: `${channel}:model`, channel, channelType: channel, model: "model" },
			]);
		} else
			settings.openaiProviders = [
				{
					...base,
					apiMode: mode === "codex-delegate" ? "codex" : (mode as "responses" | "completions"),
				},
			];
		return mode.startsWith("nug-") ? `${mode.slice(4)}:model` : "model";
	}
	beforeEach(() => {
		settings.anthropicProviders = [];
		settings.openaiProviders = [];
		settings.geminiProviders = [];
		settings.nugProviders = [];
	});

	for (const mode of [
		"anthropic",
		"official",
		"completions",
		"responses",
		"codex-delegate",
		"gemini",
		"interactions",
		"nug-anthropic",
		"nug-openai",
		"nug-responses",
		"nug-codex",
	] as const) {
		describe(mode, () => {
			test("historical and current material each appears once without rewriting stored bytes", async () => {
				const model = configure(mode);
				const current = { ...reference, reference: { ...reference.reference, id: "current" } };
				const messages = [user("history"), assistant(), user("current", "again", [current])];
				const original = structuredClone(messages);
				const built = await buildHistory(messages, `refs:${model}`, "refs", "n");
				expect(occurrences(built.history, body.split("\n")[0])).toBe(1);
				expect(occurrences([built.history, built.trailingToolResults], "tool result")).toBe(1);
				const currentText = projectFileReferenceText("again", [current]);
				expect(occurrences(currentText, body.split("\n")[0])).toBe(1);
				expect(occurrences([built.history, currentText], body.split("\n")[0])).toBe(2);
				expect(messages).toEqual(original);
			});

			test("restoring and resending the same occurrence keeps the older message, even before sys", async () => {
				const model = configure(mode);
				const current = projectFileReferenceText("inspect", [reference]);
				const sys: DbMessage = { ...user("sys", "standing reminder", []), role: "sys" };
				const built = await buildHistory(
					[user("old"), assistant(), user("new"), sys],
					`refs:${model}`,
					"refs",
					undefined,
					{ currentInput: current },
				);
				expect(occurrences(built.history, "const x")).toBe(1);
				expect(occurrences([built.history, current], "const x")).toBe(2);
			});

			test("an exact current input keeps referenced bytes once across tail sys and current turn", async () => {
				const model = configure(mode);
				const currentInput = projectFileReferenceText("inspect", [reference]);
				const sys: DbMessage = { ...user("sys", "standing reminder", []), role: "sys" };
				const messages = [user("current"), sys];
				const saved = structuredClone(messages);
				const built = await buildHistory(messages, `refs:${model}`, "refs", undefined, {
					currentInput,
				});
				expect(occurrences(built.history, "const x")).toBe(0);
				expect(occurrences([built.history, built.trailingUserText, currentInput], "const x")).toBe(
					1,
				);
				if (mode === "official") {
					expect(built.history).toContainEqual({ role: "system", content: "standing reminder" });
					expect(built.history).toContainEqual({ role: "user", content: "inspect" });
					expect(built.trailingUserText).toBeUndefined();
				} else if (mode === "anthropic" || mode === "nug-anthropic") {
					expect(built.trailingUserText).toBe("standing reminder");
				} else {
					const baseline = await buildHistory(messages, `refs:${model}`, "refs");
					expect(built.trailingUserText).toBe(baseline.trailingUserText);
					expect(occurrences([built.history, built.trailingUserText], "standing reminder")).toBe(
						occurrences([baseline.history, baseline.trailingUserText], "standing reminder"),
					);
				}
				expect(messages).toEqual(saved);
			});
		});
	}

	test("official history keeps snapshots when input differs or the tail is assistant", async () => {
		configure("official");
		const sys: DbMessage = { ...user("sys", "standing reminder", []), role: "sys" };
		const current = projectFileReferenceText("inspect", [reference]);
		for (const currentInput of [`${current} `, `other instructions\n${current}`, "inspect"]) {
			const built = await buildHistory([user("u"), sys], "refs:model", "refs", undefined, {
				currentInput,
			});
			expect(occurrences(built.history, "const x")).toBe(1);
		}
		const built = await buildHistory(
			[user("u"), assistant(), sys],
			"refs:model",
			"refs",
			undefined,
			{ currentInput: current },
		);
		expect(occurrences(built.history, "const x")).toBe(1);
	});

	test("official summary without currentInput still sees the complete accepted material", async () => {
		configure("official");
		const sys: DbMessage = { ...user("sys", "standing reminder", []), role: "sys" };
		const messages = [user("u"), sys];
		const currentInput = projectFileReferenceText("inspect", [reference]);
		await buildHistory(messages, "refs:model", "refs", undefined, { currentInput });
		const summaryHistory = await buildHistory(messages, "refs:model", "refs");
		expect(occurrences(summaryHistory.history, "const x")).toBe(1);
	});

	test("official trailing sys preserves its historical user row; compatible sys stays current", async () => {
		const sys: DbMessage = { ...user("sys", "standing reminder", []), role: "sys" };
		configure("official");
		const original = [user("user"), sys];
		const official = await buildHistory(original, "refs:model", "refs");
		expect(occurrences(official.history, "const x")).toBe(1);
		expect(official.history).toContainEqual({ role: "system", content: "standing reminder" });
		expect(official.trailingUserText).toBeUndefined();
		// This no-options path is also used by summaries: its history must retain
		// every snapshot even when a live caller could supply an exact current input.
		expect(projectFileReferenceText("inspect", [reference])).toContain("const x");
		configure("anthropic");
		const compatible = await buildHistory(original, "refs:model", "refs");
		expect(compatible.trailingUserText).toBe("standing reminder");
		expect(occurrences(compatible.history, "const x")).toBe(0);
	});
}
