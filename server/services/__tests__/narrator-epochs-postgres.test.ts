import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DbMessage } from "@shared/agent-protocol/types";
import { z } from "zod/v4";
import type { EpochRecord } from "../../lib/agent/tool-loading";
import { toolRegistry } from "../../lib/agent/tool-registry";

const realDb = { ...(await import("../../db")) };
await import("../narrator-service");
const realStore = { ...(await import("../narrator-store")) };
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
	resolveTarget: () => ({ fingerprint: "test", cacheTtlMs: null }),
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
	toolRegistry.register(definition);
});
afterAll(() => {
	toolRegistry.unregister(name);
	mock.module("../../db", () => realDb);
	mock.module("../narrator-store", () => realStore);
	mock.restore();
});

describe("PostgreSQL MCP epochs", () => {
	test("failed epoch writes stop assembly without changing the saved boundary", async () => {
		await reconcileEpoch(input());
		const history = markerRows();
		const changedCandidates = [{ ...definition, description: "changed" }];
		toolRegistry.register(changedCandidates[0]);
		failWrite = true;
		await expect(reconcileEpoch(input(history, changedCandidates))).rejects.toThrow(
			"Could not save the tool epoch",
		);
		expect(markers).toHaveLength(1);
		failWrite = false;
		expect(await changed(input(history, changedCandidates))).toBe(true);
	});

	test("resident tools keep a small stable epoch until the registry changes", async () => {
		const opened = await reconcileEpoch(input());
		expect(opened).toMatchObject({ changed: true, opened: true, epoch: { markerId: "epoch-0" } });
		expect(markers[0]).toEqual({
			reason: "manual",
			target: "test",
			toolNames: [name],
			registryRevision: toolRegistry.revision,
		});
		expect(await changed(input(markerRows()))).toBe(false);
		toolRegistry.register({ ...definition, description: "updated schema" });
		expect(await changed(input(markerRows()))).toBe(true);
		expect(await changed(input(markerRows()))).toBe(false);
		expect(markers[1].definitionSnapshots).toBeUndefined();
	});

	test("the request's captured revision is not replaced after an async boundary", async () => {
		const captured = input();
		toolRegistry.register({ ...definition, description: "newer registry" });
		await reconcileEpoch(captured);
		expect(markers[0].registryRevision).toBe(captured.registryRevision);
		expect(markers[0].registryRevision).not.toBe(toolRegistry.revision);
		expect(await changed(input(markerRows()))).toBe(true);
	});

	test("legacy compact snapshots remain readable, then migrate once to a names-only epoch", async () => {
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
		expect(await changed(input())).toBe(true);
		expect(markers[0].definitionSnapshots).toBeUndefined();
		expect(await changed(input(markerRows()))).toBe(false);
	});

	test("restart opens one new epoch even when tool names are unchanged", async () => {
		compactEpoch = {
			reason: "compact",
			target: "test",
			toolNames: [name],
			registryRevision: "previous-process:7",
		};
		expect(await changed(input())).toBe(true);
		expect(await changed(input(markerRows()))).toBe(false);
		expect(markers).toHaveLength(1);
	});

	test("empty managed tools share one result without epoch reads or writes", async () => {
		const empty = { ...input(), managed: new Set<string>(), current: [] };
		const first = await reconcileEpoch(empty);
		expect(await reconcileEpoch(empty)).toBe(first);
		expect(first).toEqual({ changed: false, epoch: undefined });
		expect(reads).toEqual([]);
		expect(markers).toEqual([]);
	});
});
