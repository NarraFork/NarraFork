import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { contextUpdateOf } from "@shared/prefix-context";
import { z } from "zod/v4";
import { narrators } from "../../db/schema";
import * as workerRead from "../../db/worker-read";
import { ToolEpochError } from "../../lib/agent/tool-loading";
import { generateId } from "../../lib/id";
import {
	historyPreparationFailure,
	ModelHistoryPreparation,
	ModelHistoryTimeoutError,
} from "../../lib/model-history-preparation";
import { settings } from "../../lib/settings";
import { closeRuntimeTestDb, getRuntimeTestDb } from "../__tests__/agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { currentCompactMessageId } = await import("../narrator-epochs");
const snapshots = await import("../narrator-prefix-snapshots");
const { narratorService } = await import("../narrator-service");
const { buildContextManagementHooks } = await import("../narrator-session");
const { buildRuntimeHistory } = await import("./history");
const preparation = await import("./prepare-prefix-request");
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
afterAll(async () => {
	settings.anthropicProviders = originalProviders;
	await closeRuntimeTestDb(sqlite, { sessionTails: true });
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
	test("the request entry allows a source read to cross ten seconds and forwards only cancellation", async () => {
		const narratorId = await narrator();
		const controller = new AbortController();
		const startedAt = Date.now();
		let now = startedAt;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const realSignature = workerRead.readDomainTask;
		const signature = spyOn(workerRead, "readDomainTask").mockImplementation(async (...args) => {
			const result = await realSignature(...args);
			if (args[1] === "modelHistorySignature") now += 11_000;
			return result;
		});
		const read = spyOn(narratorService, "getModelHistorySinceLastCompact");
		try {
			const prepared = await preparation.preparePrefixRequest({
				narratorId,
				locale: "en",
				getModel: () => "claude-sonnet-4",
				getProvider: () => provider,
				signal: controller.signal,
			});
			expect(now - startedAt).toBeGreaterThan(10_000);
			expect(prepared.sourceMessages).toEqual([]);
			expect(read).toHaveBeenCalledWith(narratorId, undefined, { signal: controller.signal });
		} finally {
			read.mockRestore();
			signature.mockRestore();
			clock.mockRestore();
		}
	});
	test("source reads share observation and cancellation without a total hydration deadline", async () => {
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const controller = new AbortController();
		const observation = new ModelHistoryPreparation({
			narratorId: "prefix-source-budget",
			kind: "rebuild",
			signal: controller.signal,
			timeoutMs: null,
		});
		const phase = spyOn(observation, "phase");
		const readTimes: number[] = [];
		const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
			async (_narratorId, _limit, options) => {
				expect(options?.preparation).toBe(observation);
				expect(options?.signal).toBe(observation.signal);
				expect(options?.deadline).toBeUndefined();
				readTimes.push(now);
				return [];
			},
		);
		try {
			const options = {
				narratorId: "prefix-source-budget",
				locale: "en" as const,
				getModel: () => "claude-sonnet-4",
				getProvider: () => provider,
				preparation: observation,
			};
			await preparation.preparePrefixRequest(options);
			now += 45_000;
			await preparation.preparePrefixRequest(options);
			expect(readTimes[1] - readTimes[0]).toBe(45_000);
			expect(phase.mock.calls).toEqual([["source"], ["source"]]);
			expect(observation.signal.aborted).toBe(false);
			expect(observation.deadline).toBe(Infinity);
			const cancellation = new Error("cancel source preparation");
			controller.abort(cancellation);
			await expect(preparation.preparePrefixRequest(options)).rejects.toThrow(cancellation);
			expect(load).toHaveBeenCalledTimes(2);
		} finally {
			load.mockRestore();
			phase.mockRestore();
			observation.finish();
			clock.mockRestore();
		}
	});

	for (const outcome of ["success", "cancelled", "timeout"] as const) {
		test(`unchanged production prefix source forwards budget, phases and ${outcome} metrics`, async () => {
			const narratorId = await narrator();
			const options = {
				narratorId,
				locale: "en" as const,
				getModel: () => "claude-sonnet-4",
				getProvider: () => provider,
				getToolLoading: () => ({
					managed: new Set<string>(),
					current: new Set<string>(),
					candidates: [tool],
				}),
				buildPrefixPrompt: async () => ({
					contract: "Production source budget contract",
					parts: [{ key: "workspace", text: "/source-budget" }],
				}),
			};
			const initial = await preparation.preparePrefixRequest(options);
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			const controller = new AbortController();
			const logs: Record<string, unknown>[] = [];
			const observation = new ModelHistoryPreparation({
				narratorId,
				kind: "rebuild",
				signal: controller.signal,
				timeoutMs: null,
				warn: (_message, fields) => logs.push(fields),
			});
			const phase = spyOn(observation, "phase");
			const count = spyOn(observation, "count");
			const cancellation = new Error("cancel authoritative prefix source");
			const sourceTimeout = new ModelHistoryTimeoutError();
			const readHistory = narratorService.getModelHistorySinceLastCompact.bind(narratorService);
			let authoritativeRows: Awaited<ReturnType<typeof readHistory>> | undefined;
			const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
				async (id, limit, readOptions) => {
					expect(readOptions?.preparation).toBe(observation);
					expect(readOptions?.signal).toBe(observation.signal);
					expect(readOptions?.deadline).toBe(now + 10_000);
					expect(phase.mock.calls.at(-1)).toEqual(["source"]);
					if (outcome === "cancelled") {
						controller.abort(cancellation);
						expect(readOptions?.signal?.reason).toBe(cancellation);
					}
					if (outcome === "timeout") throw sourceTimeout;
					authoritativeRows = await readHistory(id, limit, readOptions);
					return authoritativeRows;
				},
			);
			try {
				const work = preparation.preparePrefixRequest({
					...options,
					preparation: observation,
					buildPrefixPrompt: async () => {
						// Prompt work is outside the source read's freshly allocated query budget.
						now += 45_000;
						return options.buildPrefixPrompt();
					},
				});
				if (outcome === "success") {
					const result = await work;
					if (authoritativeRows === undefined) {
						throw new Error("Authoritative prefix source was not loaded");
					}
					expect(result.reconciled?.changed).toBe(false);
					expect(result.sourceMessages).toBe(authoritativeRows);
					expect(result.toolLoading?.epoch?.markerId).toBe(initial.toolLoading?.epoch?.markerId);
					expect(count.mock.calls.length).toBeGreaterThan(0);
					expect(observation.signal.aborted).toBe(false);
					observation.finish();
				} else {
					let failure: unknown;
					try {
						await work;
					} catch (error) {
						failure = error;
						observation.finish(error);
					}
					expect(failure).toBeInstanceOf(Error);
					expect(historyPreparationFailure(failure)?.outcome).toBe(outcome);
					if (outcome === "timeout") {
						expect(failure).toBeInstanceOf(ToolEpochError);
						expect(failure).toMatchObject({ cause: sourceTimeout });
						expect(observation.signal.aborted).toBe(false);
					} else {
						expect(observation.signal.reason).toBe(cancellation);
					}
				}
				expect(load).toHaveBeenCalledTimes(1);
				expect(observation.deadline).toBe(Infinity);
				expect(logs.at(-1)).toMatchObject({
					preparationId: observation.preparationId,
					outcome,
				});
				expect((await readHistory(narratorId)).map((row) => row.id)).toEqual(
					initial.sourceMessages.map((row) => row.id),
				);
			} finally {
				load.mockRestore();
				count.mockRestore();
				phase.mockRestore();
				observation.finish();
				clock.mockRestore();
			}
		});
	}

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
		const prepare = spyOn(preparation, "preparePrefixRequest");
		const snapshot = spyOn(snapshots, "putPrefixText").mockImplementation(async (text, signal) => {
			expect(signal).toBe(prepare.mock.calls.at(-1)?.[0].signal);
			expect(signal?.aborted).toBe(false);
			const hash = await writeText(text, signal);
			// Real writes still run; only elapsed wall time is simulated. No ten-second sleep.
			now += 6_000;
			return hash;
		});
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
			const laterOptions = prepare.mock.calls[1]?.[0];
			expect(laterOptions?.signal).toBe(laterOptions?.preparation?.signal);
			expect(laterOptions?.signal).not.toBe(controller.signal);
			expect(laterOptions?.preparation?.deadline).toBe(Infinity);
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

	for (const entryPoint of ["direct", "rebuild"] as const) {
		test(`${entryPoint} cancellation after progressing snapshot work prevents projection`, async () => {
			const narratorId = await narrator();
			const controller = new AbortController();
			const cancellation = new Error("cancel progressing prefix");
			const writeText = snapshots.putPrefixText;
			const snapshot = spyOn(snapshots, "putPrefixText").mockImplementation(
				async (text, signal) => {
					const hash = await writeText(text, signal);
					expect(signal).toBeDefined();
					if (entryPoint === "direct") expect(signal).toBe(controller.signal);
					else expect(signal).not.toBe(controller.signal);
					controller.abort(cancellation);
					expect(signal?.aborted).toBe(true);
					expect(signal?.reason).toBe(cancellation);
					return hash;
				},
			);
			try {
				const options = {
					narratorId,
					locale: "en" as const,
					getModel: () => "claude-sonnet-4",
					getProvider: () => provider,
					getToolLoading: () => ({
						managed: new Set<string>(),
						current: new Set<string>(),
						candidates: [tool],
					}),
					buildPrefixPrompt: async () => ({
						contract: "cancel contract",
						parts: [{ key: "workspace", text: "/cancel" }],
					}),
				};
				const work =
					entryPoint === "direct"
						? preparation.preparePrefixRequest({ ...options, signal: controller.signal })
						: buildContextManagementHooks({
								...options,
								attachmentSignal: controller.signal,
							}).rebuildRequestHistory();
				await expect(work).rejects.toThrow();
				expect(controller.signal.aborted).toBe(true);
				expect(await narratorService.getModelHistorySinceLastCompact(narratorId)).toHaveLength(0);
			} finally {
				snapshot.mockRestore();
			}
		});
	}

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
