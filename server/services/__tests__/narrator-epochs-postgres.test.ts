import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DbMessage } from "@shared/agent-protocol/types";
import { z } from "zod/v4";
import { type EpochRecord, snapshotToolDefinitions } from "../../lib/agent/tool-loading";
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
	test("failed epoch writes abort assembly instead of sending changed definitions", async () => {
		const opened = await reconcileEpoch(input());
		expect(opened).toMatchObject({ changed: true, epoch: { markerId: "epoch-0" } });
		const history = markerRows();
		const changedCandidates = [{ ...definition, description: "changed" }];
		failWrite = true;
		await expect(reconcileEpoch(input(history, changedCandidates))).rejects.toThrow(
			"Tool epoch could not be saved",
		);
		expect(markers).toHaveLength(1);
		failWrite = false;
		expect(await changed(input(history, changedCandidates))).toBe(true);
	});
	test("first resident request freezes its definition, then schema change opens an explicit boundary", async () => {
		expect(await changed(input())).toBe(true);
		expect(markers[0].definitionSnapshots?.[0].description).toBe("original");
		expect(await changed(input(markerRows()))).toBe(false);
		// The registry still says "original": the request's own candidate view is authoritative.
		expect(await changed(input(markerRows(), [{ ...definition, description: "changed" }]))).toBe(
			true,
		);
		expect(markers[1].definitionSnapshots?.[0].description).toBe("changed");
		expect(reads).toContain("step");
	});
	test("compact epoch reloads only its projected snapshot", async () => {
		compactEpoch = {
			reason: "compact",
			target: "test",
			toolNames: [name],
			definitionSnapshots: snapshotToolDefinitions([name]),
		};
		expect((await toolLoadingEpochOf("pg-narrator", []))?.definitionSnapshots).toEqual(
			compactEpoch.definitionSnapshots,
		);
		expect(await changed(input())).toBe(false);
	});
	test("legacy epoch missing an MCP snapshot is upgraded exactly once", async () => {
		compactEpoch = { reason: "compact", target: "test", toolNames: [name] };
		expect(await changed(input())).toBe(true);
		expect(markers[0].definitionSnapshots).toHaveLength(1);
		expect(await changed(input(markerRows()))).toBe(false);
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
