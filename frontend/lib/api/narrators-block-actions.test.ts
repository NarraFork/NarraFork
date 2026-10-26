import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./index";

/**
 * Actions on a message element act on the whole block holding it, through the block-id
 * routes, when the row the action was picked on names that block (§5.5); an element of a
 * row the server did not name keeps the index routes.
 */
describe("block-addressed actions", () => {
	const g = globalThis as typeof globalThis & { localStorage?: Storage; fetch: typeof fetch };
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;
	let requests: Array<{ url: string; method: string; body: unknown }>;
	let reply: unknown;

	beforeEach(() => {
		requests = [];
		reply = { ok: true };
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (url: unknown, init: RequestInit = {}) => {
				requests.push({
					url: String(url),
					method: init.method ?? "GET",
					body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
				});
				return Response.json(reply);
			},
		});
	});
	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) Reflect.deleteProperty(g, "localStorage");
		else
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
	});

	test("a block action without the block's id is refused before any request", async () => {
		await expect(
			api.previewRevertAction("n1", {
				action: "delete_tool_block",
				messageId: "st1",
				blockIndex: 2,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow("needs the block's id");
		expect(requests).toEqual([]);
	});

	test("a message-wide preview keeps the message route", async () => {
		await api.previewRevertAction("n1", {
			action: "edit_and_regenerate",
			messageId: "st1",
			idempotencyKey: "key-1",
		});
		expect(requests.map(({ url, body }) => [url, body])).toEqual([
			[
				"/api/narrators/n1/revert-action-preview",
				{ action: "edit_and_regenerate", messageId: "st1", idempotencyKey: "key-1" },
			],
		]);
	});

	test("deleting an element deletes its whole block by id", async () => {
		reply = {
			ok: true,
			deleted: 1,
			failed: 0,
			results: [{ blockId: "bR", messageId: "st1", messageDeleted: false }],
		};
		expect(
			await api.deleteMessageBlock("n1", { messageId: "st1", blockIndex: 1, blockId: "bR" }),
		).toEqual({ ok: true, messageDeleted: false });
		expect(requests[0]).toEqual({
			url: "/api/narrators/n1/blocks",
			method: "DELETE",
			body: { blockIds: ["bR"], skipRevert: true },
		});
	});

	test("a selection of elements deletes each block once", async () => {
		reply = { ok: true, deleted: 2, failed: 0, results: [] };
		await api.deleteMessageBlocks("n1", [
			{ messageId: "st1", blockIndex: 0, blockId: "bR" },
			{ messageId: "st1", blockIndex: 1, blockId: "bR" },
			{ messageId: "st1", blockIndex: 3, blockId: "bX" },
		]);
		expect(requests[0].body).toEqual({ blockIds: ["bR", "bX"], skipRevert: true });
	});

	test("rollback and the file-restore preview name the block", async () => {
		await api.rollbackToBlock(
			"n1",
			{ messageId: "st1", blockIndex: 3, blockId: "bX" },
			{ skipRevert: true },
		);
		await api.previewRevertAction("n1", {
			action: "delete_tool_block",
			messageId: "st1",
			blockIndex: 2,
			blockId: "bT",
			idempotencyKey: "key-1",
		});
		expect(requests.map(({ url, body }) => [url, body])).toEqual([
			["/api/narrators/n1/blocks/rollback", { blockIds: ["bX"], skipRevert: true }],
			[
				"/api/narrators/n1/blocks/revert-action-preview",
				{ action: "delete_tool_block", blockIds: ["bT"], idempotencyKey: "key-1" },
			],
		]);
	});

	test("editing an input regenerates from its input block", async () => {
		await api.editAndRegenerate("n1", "in1", "go again", {
			skipRevert: true,
			inputBlockId: "bIn",
		});
		await api.editAndRegenerate("n1", "in1", "go again", { skipRevert: true });
		expect(requests.map(({ url, body }) => [url, body])).toEqual([
			[
				"/api/narrators/n1/blocks/bIn/edit-and-regenerate",
				{ content: "go again", skipRevert: true },
			],
			["/api/narrators/n1/edit-and-regenerate/in1", { content: "go again", skipRevert: true }],
		]);
	});
});
