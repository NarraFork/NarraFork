import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DbMessage } from "@shared/agent-protocol/types";
import { z } from "zod/v4";
import type { EpochRecord, ToolDefinitionSnapshot } from "../../lib/agent/tool-loading";
import { toolRegistry } from "../../lib/agent/tool-registry";

const realDb = { ...(await import("../../db")) };
await import("../narrator-service");
const realStore = { ...(await import("../narrator-store")) };
const realSnapshots = { ...(await import("../narrator-prefix-snapshots")) };
const snapshots = new Map<string, ToolDefinitionSnapshot[]>();
// This suite mocks PG query/publication behavior, not a connection. Real PG snapshot
// roundtrips and GC are covered by narrator-prefix-tool-snapshots.test.ts.
mock.module("../narrator-prefix-snapshots", () => ({
	...realSnapshots,
	putPrefixToolDefinitions: async (definitions: readonly ToolDefinitionSnapshot[]) => {
		const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(definitions)).digest("hex");
		snapshots.set(hash, structuredClone([...definitions]));
		return hash;
	},
	getPrefixToolDefinitions: async (hash: string) => {
		const definitions = snapshots.get(hash);
		if (!definitions) throw new Error(`Missing test snapshot: ${hash}`);
		return definitions;
	},
	withPrefixSnapshotPublication: async <T>(
		hashes: readonly string[],
		publish: () => Promise<T>,
	) => {
		for (const hash of hashes) expect(snapshots.has(hash)).toBe(true);
		return publish();
	},
}));
let compactEpoch: EpochRecord | undefined;
let markers: EpochRecord[] = [];
let failWrite = false;
let reads: string[] = [];
const query = (kind: string) => ({
	from: () => ({
		innerJoin: () => ({
			where: () => ({
				orderBy: () => ({
					limit: async (limit: number) => {
						expect(limit).toBe(1);
						reads.push(kind);
						return kind === "epoch" && compactEpoch ? [{ epoch: compactEpoch }] : [];
					},
				}),
			}),
		}),
	}),
});
mock.module("../../db", () => ({
	...realDb,
	activeDatabaseBackend: "postgres",
	db: {
		select: (selection: Record<string, unknown>) => query("epoch" in selection ? "epoch" : "step"),
	},
	sqlite: {
		prepare: () => {
			throw new Error("PG must not call SQLite");
		},
	},
}));
mock.module("../narrator-store", () => ({
	narratorStore: {
		openEpoch: async (_id: string, epoch: EpochRecord) => {
			if (failWrite) throw new Error("storage unavailable");
			markers.push(epoch);
			return { id: `epoch-${markers.length - 1}` };
		},
		appendToolChange: async () => {},
	},
}));
const { reconcileEpoch, toolLoadingEpochOf } = await import("../narrator-epochs");
const name = "mcp__pg_epoch__run";
const definition = {
	name,
	description: "original",
	parameters: z.object({}),
	rawJsonSchema: { type: "object", properties: {} },
	execute: async () => ({ output: "ok" }),
};
const input = (messages: DbMessage[] = [], candidates = [definition]) => ({
	narratorId: "pg-narrator",
	messages,
	managed: new Set([name]),
	current: [name],
	candidates,
	registryRevision: toolRegistry.revision,
	model: "test",
	provider: "test",
	noticeText: () => "notice",
	resolveTarget: (model: string) => ({ fingerprint: model, cacheTtlMs: null }),
});
const changed = async (...args: Parameters<typeof reconcileEpoch>) =>
	(await reconcileEpoch(...args)).changed;
const markerRows = (): DbMessage[] =>
	markers.map((epoch, i) => ({
		id: `epoch-${i}`,
		role: "system",
		contentJson: [{ type: "epoch", epoch }],
		contentText: "",
		parentToolUseId: null,
		messageUuid: null,
	}));
beforeEach(() => {
	compactEpoch = undefined;
	failWrite = false;
	markers = [];
	reads = [];
	snapshots.clear();
	toolRegistry.register(definition);
});
afterAll(() => {
	toolRegistry.unregister(name);
	mock.module("../../db", () => realDb);
	mock.module("../narrator-store", () => realStore);
	mock.module("../narrator-prefix-snapshots", () => realSnapshots);
	mock.restore();
});

describe("PostgreSQL MCP epochs", () => {
	test("failed epoch writes stop assembly without changing the saved boundary", async () => {
		await reconcileEpoch(input());
		const history = markerRows();
		const switched = { ...input(history), model: "new-model" };
		failWrite = true;
		await expect(reconcileEpoch(switched)).rejects.toThrow("Could not save the tool epoch");
		expect(markers).toHaveLength(1);
		failWrite = false;
		expect(await changed(switched)).toBe(true);
		expect(markers[1]).toMatchObject({ reason: "target", target: "new-model" });
	});

	test("registry changes preserve the epoch and its frozen definitions", async () => {
		const opened = await reconcileEpoch(input());
		expect(opened).toMatchObject({ changed: true, opened: true, epoch: { markerId: "epoch-0" } });
		expect(markers[0]).toMatchObject({
			reason: "initial",
			target: "test",
			toolNames: [name],
			registryRevision: toolRegistry.revision,
		});
		expect(await changed(input(markerRows()))).toBe(false);
		toolRegistry.register({ ...definition, description: "updated schema" });
		const resumed = await reconcileEpoch(input(markerRows()));
		expect(resumed.changed).toBe(false);
		expect(markers).toHaveLength(1);
		expect(resumed.epoch?.definitionSnapshots).toEqual([
			{ name, description: "original", parameters: definition.rawJsonSchema },
		]);
	});

	test("the request's captured revision is not replaced after an async boundary", async () => {
		const captured = input();
		toolRegistry.register({ ...definition, description: "newer registry" });
		await reconcileEpoch(captured);
		expect(markers[0].registryRevision).toBe(captured.registryRevision);
		expect(markers[0].registryRevision).not.toBe(toolRegistry.revision);
		expect(await changed(input(markerRows()))).toBe(false);
	});

	test("legacy compact snapshots remain readable without dropping frozen content", async () => {
		compactEpoch = {
			reason: "compact",
			target: "test",
			toolNames: [name],
			definitionSnapshots: [
				{ name, description: "original", parameters: definition.rawJsonSchema },
			],
		};
		expect((await toolLoadingEpochOf("pg-narrator", []))?.definitionSnapshots).toEqual(
			compactEpoch.definitionSnapshots,
		);
		const resumed = await reconcileEpoch(input());
		expect(resumed.changed).toBe(false);
		expect(resumed.epoch?.definitionSnapshots).toEqual(compactEpoch.definitionSnapshots);
		expect(markers).toHaveLength(0);
	});

	test("restart and cache expiry do not open another epoch", async () => {
		compactEpoch = {
			reason: "compact",
			target: "test",
			toolNames: [name],
			registryRevision: "previous-process:7",
		};
		expect(await changed(input())).toBe(false);
		expect(
			await changed({
				...input(),
				now: Number.MAX_SAFE_INTEGER,
				resolveTarget: () => ({ fingerprint: "test", cacheTtlMs: 1 }),
			}),
		).toBe(false);
		expect(markers).toHaveLength(0);
	});

	test("empty managed tools still establish and reuse a baseline epoch", async () => {
		const empty = { ...input(), managed: new Set<string>(), current: [] };
		const first = await reconcileEpoch(empty);
		expect(first).toMatchObject({ changed: true, opened: true, epoch: { toolNames: [] } });
		expect(await changed({ ...empty, messages: markerRows() })).toBe(false);
		expect(reads).toContain("epoch");
		expect(markers).toHaveLength(1);
	});
});
