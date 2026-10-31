import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { contextUpdateOf } from "@shared/prefix-context";
import { z } from "zod/v4";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { currentCompactMessageId } from "../narrator-epochs";
import * as snapshots from "../narrator-prefix-snapshots";
import { narratorService } from "../narrator-service";
import { buildContextManagementHooks } from "../narrator-session";
import { buildRuntimeHistory } from "./history";
import * as preparation from "./prepare-prefix-request";

const { narratorPersistence } = await import("../narrator-persistence");
const originalProviders = settings.anthropicProviders;
const provider = "prefix-request-tests";
beforeEach(() => {
	settings.anthropicProviders = [
		...(originalProviders ?? []),
		{
			id: provider,
			name: "Prefix request tests",
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

const tool = {
	name: "PreparedPrefixRead",
	description: "Static read declaration",
	parameters: z.object({}),
	rawJsonSchema: { type: "object", properties: {} },
	execute: async () => ({ output: "ok" }),
};

async function narrator() {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, cwd: "/tmp", createdAt: now, updatedAt: now });
	return id;
}

describe("shared prefix request preparation", () => {
	test("real snapshot work exceeding ten seconds prepares first and later requests without losing summary metadata", async () => {
		const narratorId = await narrator();
		const controller = new AbortController();
		const startedAt = Date.now();
		let now = startedAt;
		let workspace = "/repo/a";
		let refreshes = 0;
		let summary = "The prior conversation summary.";
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const writeText = snapshots.putPrefixText;
		const snapshot = spyOn(snapshots, "putPrefixText").mockImplementation(async (text, signal) => {
			expect(signal).toBe(controller.signal);
			const hash = await writeText(text, signal);
			// Real writes still run; only elapsed wall time is simulated. No ten-second sleep.
			now += 6_000;
			return hash;
		});
		const prepare = spyOn(preparation, "preparePrefixRequest");
		const loading = () => ({
			managed: new Set<string>(),
			current: new Set<string>(),
			candidates: [tool],
		});
		const buildPrefixPrompt = async () => ({
			contract: `Fixed contract\n\n## Conversation Context\n\n${summary}`,
			parts: [{ key: "workspace", text: workspace }],
			compactMessageId: await currentCompactMessageId(narratorId),
			summaryChars: summary.length,
			usedCompactSummary: true,
		});
		const common = {
			narratorId,
			locale: "en" as const,
			getModel: () => "claude-sonnet-4",
			getProvider: () => provider,
			getToolLoading: loading,
			refreshToolLoading: async () => {
				refreshes++;
			},
			buildPrefixPrompt,
		};
		try {
			const first = await preparation.preparePrefixRequest({
				...common,
				signal: controller.signal,
			});
			expect(now - startedAt).toBeGreaterThan(10_000);
			expect(first.reconciled?.opened).toBe(true);
			expect(first.prompt?.summaryChars).toBe(summary.length);
			expect(first.prompt?.usedCompactSummary).toBe(true);
			const systemPrompt = first.reconciled?.systemPrompt ?? "";
			expect(systemPrompt).toContain(summary);
			const systemChars = systemPrompt.length - (first.prompt?.summaryChars ?? 0);
			expect(systemChars + summary.length).toBe(systemPrompt.length);
			const projected = await buildRuntimeHistory({
				narratorId,
				model: common.getModel(),
				provider,
				attachmentSignal: controller.signal,
				sourceMessages: first.sourceMessages,
				toolLoading: first.toolLoading,
			});
			expect(projected.toolLoading?.baseToolNames).toEqual([tool.name]);

			workspace = "/repo/b";
			const hooks = buildContextManagementHooks({ ...common, attachmentSignal: controller.signal });
			const later = await hooks.rebuildRequestHistory();
			expect(later.systemPrompt).toBe(systemPrompt);
			expect(later.toolLoading?.epochMarkerId).toBe(projected.toolLoading?.epochMarkerId);
			expect(prepare).toHaveBeenCalledTimes(2);
			expect(refreshes).toBe(2);
			const updates = later.rows.flatMap((row) =>
				Array.isArray(row.contentJson) ? row.contentJson.map(contextUpdateOf).filter(Boolean) : [],
			);
			expect(updates).toHaveLength(1);
			expect(updates[0]?.changes).toContainEqual({ key: "workspace", value: "/repo/b" });
			// A no-op request takes the coordinator's authoritative source view, not a pre-read.
			await hooks.rebuildRequestHistory();
			expect(prepare).toHaveBeenCalledTimes(3);
			expect(refreshes).toBe(3);

			const previousSummary = summary;
			summary = "The newly compacted context has a different summary length.";
			await narratorPersistence.persistPlanMessage(narratorId, summary);
			const compacted = await preparation.preparePrefixRequest({
				...common,
				signal: controller.signal,
			});
			expect(compacted.prompt?.summaryChars).toBe(summary.length);
			expect(compacted.prompt?.compactMessageId).not.toBeNull();
			expect(compacted.reconciled?.systemPrompt).toContain(summary);
			expect(compacted.reconciled?.systemPrompt).not.toContain(previousSummary);
			expect(compacted.toolLoading?.epoch?.markerId).not.toBe(first.toolLoading?.epoch?.markerId);
		} finally {
			prepare.mockRestore();
			snapshot.mockRestore();
			clock.mockRestore();
		}
	});

	test("queued loading changes are captured together with the prompt under the real queue", async () => {
		const { serializeToolChanges } = await import("../tool-loading-service");
		const narratorId = await narrator();
		const optional = { ...tool, name: "PreparedPrefixOptional" };
		let current: string[] = [];
		const captures: string[][] = [];
		let release!: () => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loading = serializeToolChanges(narratorId, async () => {
			entered();
			await held;
			current = [optional.name];
		});
		await ready;
		const pending = preparation.preparePrefixRequest({
			narratorId,
			locale: "en",
			getModel: () => "claude-sonnet-4",
			getProvider: () => provider,
			getToolLoading: () => {
				captures.push([...current]);
				return {
					managed: new Set([optional.name]),
					current: new Set(current),
					candidates: [tool, optional],
				};
			},
			buildPrefixPrompt: async () => ({
				contract: "queue contract",
				parts: [{ key: "test.selection", text: current.join(", ") }],
				compactMessageId: null,
			}),
		});
		release();
		await loading;
		const prepared = await pending;
		expect(captures).toEqual([[], [optional.name]]);
		expect([...(prepared.toolLoading?.current ?? [])]).toEqual([optional.name]);
		expect(prepared.prompt?.parts).toContainEqual({ key: "test.selection", text: optional.name });
		expect(prepared.toolLoading?.epoch?.baseToolNames).toEqual([tool.name, optional.name]);
	});

	test("a real compact during snapshot work rebuilds the prompt and its summary metadata", async () => {
		const narratorId = await narrator();
		const nextSummary = "The compact that won during snapshot construction.";
		let compacted = false;
		let promptBuilds = 0;
		const writeText = snapshots.putPrefixText;
		const snapshot = spyOn(snapshots, "putPrefixText").mockImplementation(async (text, signal) => {
			const hash = await writeText(text, signal);
			if (!compacted) {
				compacted = true;
				await narratorPersistence.persistPlanMessage(narratorId, nextSummary);
			}
			return hash;
		});
		try {
			const prepared = await preparation.preparePrefixRequest({
				narratorId,
				locale: "en",
				getModel: () => "claude-sonnet-4",
				getProvider: () => provider,
				signal: new AbortController().signal,
				getToolLoading: () => ({ managed: new Set(), current: new Set(), candidates: [tool] }),
				buildPrefixPrompt: async () => {
					promptBuilds++;
					const compactMessageId = await currentCompactMessageId(narratorId);
					const row = await narratorService.getById(narratorId);
					return {
						contract: row.contextSummary ?? "before compact",
						parts: [{ key: "workspace", text: "/race" }],
						compactMessageId,
						summaryChars: row.contextSummary?.length ?? 0,
					};
				},
			});
			expect(promptBuilds).toBe(2);
			expect(prepared.prompt?.summaryChars).toBe(nextSummary.length);
			expect(prepared.prompt?.compactMessageId).toBe(await currentCompactMessageId(narratorId));
			expect(prepared.reconciled?.systemPrompt).toContain(nextSummary);
			expect(prepared.reconciled?.systemPrompt).not.toContain("before compact");
			expect(
				prepared.sourceMessages.some(
					(message) => message.id === prepared.toolLoading?.epoch?.markerId,
				),
			).toBe(true);
		} finally {
			snapshot.mockRestore();
		}
	});

	test("cancellation after progressing snapshot work prevents projection", async () => {
		const narratorId = await narrator();
		const controller = new AbortController();
		const writeText = snapshots.putPrefixText;
		const snapshot = spyOn(snapshots, "putPrefixText").mockImplementation(async (text, signal) => {
			const hash = await writeText(text, signal);
			controller.abort(new Error("cancel progressing prefix"));
			return hash;
		});
		try {
			await expect(
				preparation.preparePrefixRequest({
					narratorId,
					locale: "en",
					getModel: () => "claude-sonnet-4",
					getProvider: () => provider,
					signal: controller.signal,
					getToolLoading: () => ({ managed: new Set(), current: new Set(), candidates: [tool] }),
					buildPrefixPrompt: async () => ({
						contract: "cancel contract",
						parts: [{ key: "workspace", text: "/cancel" }],
					}),
				}),
			).rejects.toThrow();
			expect(controller.signal.aborted).toBe(true);
			expect(await narratorService.getModelHistorySinceLastCompact(narratorId)).toHaveLength(0);
		} finally {
			snapshot.mockRestore();
		}
	});

	test("first and later request entry points delegate reconciliation to the same preparer", async () => {
		const initial = await Bun.file(new URL("./orchestrator.ts", import.meta.url)).text();
		const later = await Bun.file(new URL("../narrator-session.ts", import.meta.url)).text();
		for (const source of [initial, later]) {
			expect(source).toContain("await preparePrefixRequest({");
			expect(source).not.toContain("await reconcileEpoch({");
			expect(source).not.toContain("Model history preparation exceeded 10s budget");
		}
	});
});
