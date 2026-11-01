import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { contextUpdateOf, renderContextUpdate } from "@shared/prefix-context";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../db";
import {
	narratorBlockAssets,
	narratorBlocks,
	narratorMessageRefs,
	narrators,
} from "../../db/schema";
import { epochRecordOf } from "../../lib/agent/tool-loading";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { getPrefixToolDefinitions } from "../narrator-prefix-snapshots";

// The normal test preload supplies an isolated on-disk SQLite database. Do not
// replace the DB module: the history/snapshot workers must see the same database.
const { narratorService } = await import("../narrator-service");
const { loadContextUpdate, PrefixContextChangedError, reconcileEpoch } = await import(
	"../narrator-epochs"
);
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const originalProviders = settings.anthropicProviders;
const provider = "prefix-epoch-tests";
beforeEach(() => {
	settings.anthropicProviders = [
		...(originalProviders ?? []),
		{
			id: provider,
			name: "Prefix epochs",
			prefix: provider,
			apiKey: "isolated-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "claude-sonnet-5-5",
			officialApi: false,
		},
	];
});
afterAll(() => {
	settings.anthropicProviders = originalProviders;
});

const baseTool = {
	name: "PrefixRead",
	description: "Read original",
	parameters: z.object({}),
	rawJsonSchema: { type: "object", properties: {} },
	execute: async () => ({ output: "ok" }),
};
const optionalTool = { ...baseTool, name: "PrefixOptional", description: "Optional original" };
async function fixture() {
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: narratorId, cwd: "/tmp", createdAt: now, updatedAt: now });
	const input = {
		narratorId,
		messages: [],
		managed: new Set([optionalTool.name]),
		current: [] as string[],
		candidates: [baseTool, optionalTool],
		model: "claude-sonnet-5-5",
		provider,
		registryRevision: "initial-registry",
		prompt: { contract: "Fixed safety contract", parts: [{ key: "workspace", text: "/repo/a" }] },
		noticeText: (kind: "tool_loaded" | "tool_unloaded", name: string) => `${kind}: ${name}`,
		resolveTarget: (model: string, provider: string) => ({
			fingerprint: `${provider}:${model}`,
			cacheTtlMs: 1,
		}),
	};
	return { narratorId, input };
}
const history = (id: string) => narratorService.getModelHistorySinceLastCompact(id);
const updates = async (id: string) => {
	const records = (await history(id)).flatMap((message) =>
		Array.isArray(message.contentJson)
			? message.contentJson.flatMap((block) => {
					const update = contextUpdateOf(block);
					return update ? [{ message, update }] : [];
				})
			: [],
	);
	return Promise.all(
		records.map(async ({ message, update }) => ({
			message,
			update: await loadContextUpdate(update),
		})),
	);
};

describe("unified prefix epochs with real SQLite history", () => {
	test("initial baseline is durable; concurrent changes and retries append only once", async () => {
		const { narratorId, input } = await fixture();
		const initial = await reconcileEpoch(input);
		expect(initial).toMatchObject({ changed: true, opened: true, epoch: { reason: "initial" } });
		expect(initial.epoch?.prefix).toBeDefined();
		expect(initial.systemPrompt).toContain("/repo/a");
		expect((await history(narratorId)).filter((message) => message.role === "system")).toHaveLength(
			1,
		);
		const moved = {
			...input,
			prompt: { ...input.prompt, parts: [{ key: "workspace", text: "/repo/b" }] },
		};
		const concurrent = await Promise.all([reconcileEpoch(moved), reconcileEpoch(moved)]);
		expect(concurrent.map((result) => result.changed).sort()).toEqual([false, true]);
		for (const result of concurrent) {
			expect(result.epoch?.markerId).toBe(initial.epoch?.markerId);
			expect(result.systemPrompt).toBe(initial.systemPrompt);
		}
		const persisted = await updates(narratorId);
		expect(persisted).toHaveLength(1);
		expect(persisted[0].update).toMatchObject({
			epochId: initial.epoch?.markerId,
			changes: [{ key: "workspace", value: "/repo/b" }],
		});
		expect(persisted[0].update.modelText ?? persisted[0].message.contentText).toBe(
			renderContextUpdate(persisted[0].update.changes),
		);
		expect((await reconcileEpoch(moved)).changed).toBe(false);
		expect((await updates(narratorId)).map(({ message }) => message.id)).toEqual([
			persisted[0].message.id,
		]);
		await reconcileEpoch(input);
		expect((await updates(narratorId)).map(({ update }) => update.changes)).toEqual([
			[{ key: "workspace", value: "/repo/b" }],
			[{ key: "workspace", value: "/repo/a" }],
		]);
	});

	test("large replacements remain complete through snapshot hydration and provider history", async () => {
		const { narratorId, input } = await fixture();
		const baseline = await reconcileEpoch(input);
		const content = "完整项目指令\n".repeat(50_000);
		const changed = await reconcileEpoch({
			...input,
			prompt: {
				...input.prompt,
				parts: [...input.prompt.parts, { key: "instructions.project", text: content }],
			},
		});
		const [persisted] = await updates(narratorId);
		expect(persisted.update.changes).toEqual([{ key: "instructions.project", value: content }]);
		expect(persisted.update.snapshotRef).toBeString();
		const assets = await db
			.select({ assetId: narratorBlockAssets.assetId, role: narratorBlockAssets.role })
			.from(narratorBlockAssets)
			.innerJoin(narratorBlocks, eq(narratorBlocks.id, narratorBlockAssets.blockId))
			.where(eq(narratorBlocks.messageId, persisted.message.id));
		expect(assets).toContainEqual({
			assetId: persisted.update.snapshotRef ?? "",
			role: "epoch_snapshot",
		});
		const raw = (persisted.message.contentJson as unknown[]).map(contextUpdateOf).find(Boolean);
		expect(raw?.changes).toEqual([]);
		expect(persisted.message.contentText).not.toContain(content);
		const projected = await buildRuntimeHistory({
			narratorId,
			model: input.model,
			provider,
			ownTurnPlacement: null,
			toolLoading: {
				managed: input.managed,
				current: [],
				candidates: input.candidates,
				epoch: changed.epoch,
			},
		});
		expect(
			projected.modelMessages
				.find((row) => row.id === persisted.message.id)
				?.contentText?.includes(content),
		).toBe(true);
		expect(changed.systemPrompt).toBe(baseline.systemPrompt);
	});

	test("registry revisions, elapsed cache age and empty managed sets never rotate the baseline", async () => {
		const { input } = await fixture();
		const empty = { ...input, managed: new Set<string>(), candidates: [baseTool] };
		const initial = await reconcileEpoch(empty);
		const resumed = await reconcileEpoch({
			...empty,
			registryRevision: "another-process:42",
			now: Number.MAX_SAFE_INTEGER,
			candidates: [{ ...baseTool, description: "registry changed" }],
			prompt: { ...input.prompt, contract: "A newer fixed contract waits for the next epoch." },
		});
		expect(resumed.changed).toBe(false);
		expect(resumed.epoch?.markerId).toBe(initial.epoch?.markerId);
		expect(resumed.systemPrompt).toBe(initial.systemPrompt);
		expect(resumed.epoch?.definitionSnapshots?.[0].description).toBe("Read original");
	});

	test("tool loads persist immutable snapshot references without changing baseline", async () => {
		const { narratorId, input } = await fixture();
		const initial = await reconcileEpoch(input);
		const loaded = { ...input, current: [optionalTool.name] };
		const result = await reconcileEpoch(loaded);
		expect(result.epoch?.markerId).toBe(initial.epoch?.markerId);
		expect(result.systemPrompt).toBe(initial.systemPrompt);
		const messages = await history(narratorId);
		const blocks = messages.flatMap((message) =>
			Array.isArray(message.contentJson) ? message.contentJson : [],
		);
		const load = blocks.find((block) => block.type === "tool_loaded") as
			| { definitionSnapshotRef?: string }
			| undefined;
		expect(load?.definitionSnapshotRef).toBeString();
		const snapshot = await getPrefixToolDefinitions(load?.definitionSnapshotRef ?? "");
		expect(snapshot[0]).toMatchObject({
			name: optionalTool.name,
			description: "Optional original",
		});
		const resumed = await reconcileEpoch({
			...loaded,
			candidates: [baseTool, { ...optionalTool, description: "new registry definition" }],
		});
		expect(resumed.changed).toBe(false);
		expect(
			resumed.epoch?.definitionSnapshots?.find((tool) => tool.name === optionalTool.name)
				?.description,
		).toBe("Optional original");
		expect((await history(narratorId)).length).toBe(messages.length);
	});

	test("unloading and reloading cannot replace a published tool definition", async () => {
		const { input } = await fixture();
		const initial = await reconcileEpoch(input);
		await reconcileEpoch({ ...input, current: [optionalTool.name] });
		await reconcileEpoch(input);
		const reloadedInput = {
			...input,
			current: [optionalTool.name],
			candidates: [baseTool, { ...optionalTool, description: "changed while unloaded" }],
		};
		await reconcileEpoch(reloadedInput);
		const recovered = await reconcileEpoch(reloadedInput);
		expect(recovered.changed).toBe(false);
		expect(recovered.epoch?.markerId).toBe(initial.epoch?.markerId);
		expect(
			recovered.epoch?.definitionSnapshots
				?.filter((tool) => tool.name === optionalTool.name)
				.map((tool) => tool.description),
		).toEqual(["Optional original"]);
	});

	test("model switches and successful compact establish new baselines and absorb updates", async () => {
		const { narratorId, input } = await fixture();
		const first = await reconcileEpoch(input);
		const moved = {
			...input,
			prompt: { ...input.prompt, parts: [{ key: "workspace", text: "/repo/b" }] },
		};
		await reconcileEpoch(moved);
		const ordinary = await narratorStore.appendInput(
			narratorId,
			"Historical work in /repo/a remains true.",
		);
		const switchedInput = { ...moved, model: "claude-opus-4-1" };
		const switched = await reconcileEpoch(switchedInput);
		expect(switched.epoch?.markerId).not.toBe(first.epoch?.markerId);
		expect(switched.epoch?.reason).toBe("target");
		expect(switched.systemPrompt).toContain("/repo/b");
		const activeUpdate = await narratorStore.appendNotice(narratorId, "Current update", [
			{
				type: "context_update",
				epochId: switched.epoch?.markerId,
				changes: [{ key: "mode", value: "review" }],
			},
		]);
		const sourceMessages = await history(narratorId);
		const projected = await buildRuntimeHistory({
			narratorId,
			model: switchedInput.model,
			provider,
			ownTurnPlacement: null,
			sourceMessages,
			toolLoading: {
				managed: input.managed,
				current: [],
				candidates: input.candidates,
				epoch: switched.epoch,
			},
		});
		const oldUpdates = await updates(narratorId);
		expect(projected.modelMessages.map((row) => row.id)).not.toContain(oldUpdates[0].message.id);
		expect(projected.modelMessages.map((row) => row.id)).toContain(ordinary.id);
		expect(projected.modelMessages.map((row) => row.id)).toContain(activeUpdate.id);
		expect(projected.sourceMessages).toHaveLength(sourceMessages.length);
		const compact = await narratorPersistence.persistCompactingMessage(narratorId);
		const pendingCompact = await reconcileEpoch(switchedInput);
		expect(pendingCompact.epoch?.markerId).toBe(switched.epoch?.markerId);
		expect(pendingCompact.systemPrompt).toBe(switched.systemPrompt);
		expect(
			await narratorPersistence.finalizeCompactingMessage(
				compact.id,
				narratorId,
				"Finished work summary",
			),
		).not.toBeNull();
		const compacted = await reconcileEpoch({
			...switchedInput,
			prompt: { ...moved.prompt, contract: "Fixed safety contract\nFinished work summary" },
		});
		expect(compacted.epoch?.reason).toBe("compact");
		expect(compacted.epoch?.markerId).not.toBe(switched.epoch?.markerId);
		expect(compacted.systemPrompt).toContain("Finished work summary");
		expect(
			(await updates(narratorId)).some(
				({ update }) => update.epochId === compacted.epoch?.markerId,
			),
		).toBe(false);
		const afterCompact = await buildRuntimeHistory({
			narratorId,
			model: switchedInput.model,
			provider,
			ownTurnPlacement: null,
			toolLoading: {
				managed: input.managed,
				current: [],
				candidates: input.candidates,
				epoch: compacted.epoch,
			},
		});
		expect(
			afterCompact.modelMessages
				.flatMap((row) => (Array.isArray(row.contentJson) ? row.contentJson : []))
				.map(contextUpdateOf)
				.filter(Boolean),
		).toHaveLength(0);
	});

	test("a compact retained model-switch marker cannot hide the latest summary boundary", async () => {
		const { narratorId, input } = await fixture();
		await reconcileEpoch(input);
		const retainedTurn = await narratorStore.appendInput(
			narratorId,
			"Retain this last turn and its model-switch marker.",
		);
		const switchedInput = { ...input, model: "claude-opus-4-1" };
		const switched = await reconcileEpoch(switchedInput);
		await reconcileEpoch({
			...switchedInput,
			prompt: { ...input.prompt, parts: [{ key: "workspace", text: "/repo/b" }] },
		});
		const [oldUpdate] = await updates(narratorId);
		const compact = await narratorPersistence.persistCompactingMessage(narratorId, retainedTurn.id);
		const summary = "Newest summary must replace the retained pre-compact baseline.";
		const finished = await narratorPersistence.finalizeCompactingMessage(
			compact.id,
			narratorId,
			summary,
		);
		expect(finished).not.toBeNull();
		const retainedHistory = await history(narratorId);
		expect(retainedHistory.map((row) => row.id)).toContain(switched.epoch?.markerId ?? "");
		expect(retainedHistory.map((row) => row.id)).toContain(oldUpdate.message.id);
		const fresh = {
			...switchedInput,
			prompt: {
				contract: `Fixed safety contract\n${summary}`,
				parts: [{ key: "workspace", text: "/repo/b" }],
				compactMessageId: finished?.id ?? compact.id,
			},
		};
		const rebuilt = await reconcileEpoch(fresh);
		expect(rebuilt.epoch?.reason).toBe("compact");
		expect(rebuilt.epoch?.markerId).not.toBe(switched.epoch?.markerId);
		expect(rebuilt.epoch?.compactMessageId).toBe(finished?.id);
		expect(rebuilt.systemPrompt).toContain(summary);
		expect(rebuilt.systemPrompt).toContain("/repo/b");
		const rows = await history(narratorId);
		const stored = rows.find((row) => row.id === rebuilt.epoch?.markerId);
		const record = Array.isArray(stored?.contentJson)
			? stored.contentJson.map(epochRecordOf).find(Boolean)
			: undefined;
		expect(record?.compactMessageId).toBe(finished?.id);
		expect((await reconcileEpoch(fresh)).changed).toBe(false);
		const projected = await buildRuntimeHistory({
			narratorId,
			model: fresh.model,
			provider,
			ownTurnPlacement: null,
			toolLoading: {
				managed: input.managed,
				current: [],
				candidates: input.candidates,
				epoch: rebuilt.epoch,
			},
		});
		expect(projected.modelMessages.map((row) => row.id)).toContain(retainedTurn.id);
		expect(projected.modelMessages.map((row) => row.id)).not.toContain(oldUpdate.message.id);
	});

	test("a stale compact token rejects preparation before publishing a baseline or update", async () => {
		const { narratorId, input } = await fixture();
		await reconcileEpoch(input);
		const first = await narratorPersistence.persistCompactingMessage(narratorId);
		await narratorPersistence.finalizeCompactingMessage(first.id, narratorId, "Earlier summary");
		const captured = {
			...input,
			prompt: { ...input.prompt, contract: "Earlier summary", compactMessageId: first.id },
		};
		await reconcileEpoch(captured);
		const next = await narratorPersistence.persistCompactingMessage(narratorId);
		await narratorPersistence.finalizeCompactingMessage(next.id, narratorId, "Current summary");
		const refsBefore = await db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId));
		const historyBefore = await history(narratorId);
		const rejected = await reconcileEpoch({
			...captured,
			model: "claude-opus-4-1",
			prompt: { ...captured.prompt, parts: [{ key: "workspace", text: "/stale-context" }] },
		}).catch((error: unknown) => error);
		expect(rejected).toBeInstanceOf(PrefixContextChangedError);
		expect(
			await db
				.select()
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId)),
		).toEqual(refsBefore);
		expect((await history(narratorId)).map((row) => row.id)).toEqual(
			historyBefore.map((row) => row.id),
		);
		expect(await updates(narratorId)).toHaveLength(0);
		const refreshed = await reconcileEpoch({
			...input,
			prompt: { ...input.prompt, contract: "Current summary", compactMessageId: next.id },
		});
		expect(refreshed.epoch?.compactMessageId).toBe(next.id);
		expect(refreshed.systemPrompt).toContain("Current summary");
	});

	test("forked message references reuse the same baseline and published state", async () => {
		const { narratorId, input } = await fixture();
		const initial = await reconcileEpoch(input);
		const moved = {
			...input,
			prompt: { ...input.prompt, parts: [{ key: "workspace", text: "/repo/b" }] },
		};
		await reconcileEpoch(moved);
		const fork = await fixture();
		const refs = await db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId));
		await db
			.insert(narratorMessageRefs)
			.values(refs.map((ref) => ({ ...ref, id: generateId(), narratorId: fork.narratorId })));
		const resumed = await reconcileEpoch({ ...moved, narratorId: fork.narratorId });
		expect(resumed.changed).toBe(false);
		expect(resumed.epoch?.markerId).toBe(initial.epoch?.markerId);
		expect(resumed.epoch?.prefix).toEqual(initial.epoch?.prefix);
		expect(resumed.systemPrompt).toBe(initial.systemPrompt);
		expect((await history(fork.narratorId)).map((row) => row.id)).toEqual(
			(await history(narratorId)).map((row) => row.id),
		);
	});
});

for (const change of ["device", "resident"] as const) {
	test(`automatic ${change} changes cannot publish undeclared tools on a replace-only target`, async () => {
		const { narratorId, input: original } = await fixture();
		const input = { ...original, model: "claude-sonnet-4" };
		const first = await reconcileEpoch(input);
		expect(first.epoch?.strategy).toBe("replace_tools");
		const deviceTool = { ...baseTool, name: "PrefixNewDevice" };
		const changed =
			change === "device"
				? { ...input, candidates: [...input.candidates, deviceTool] }
				: { ...input, current: [optionalTool.name] };
		const name = change === "device" ? deviceTool.name : optionalTool.name;
		const next = await reconcileEpoch(changed);
		expect(next.epoch?.markerId).toBe(first.epoch?.markerId);
		expect(next.systemPrompt).toBe(first.systemPrompt);
		const rows = await history(narratorId);
		expect(
			rows.some(
				(row) =>
					Array.isArray(row.contentJson) &&
					row.contentJson.some(
						(block) => block?.type === "tool_loaded" && block.toolNames?.includes(name),
					),
			),
		).toBe(false);
		const notices = await updates(narratorId);
		const availability = notices
			.at(-1)
			?.update.changes.find((part) => part.key === "tools.availability")?.value;
		expect(availability).toContain("Unavailable in this model");
		expect(availability).toContain(name);
		expect((await reconcileEpoch(changed)).changed).toBe(false);
	});
}
