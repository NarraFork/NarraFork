import { describe, expect, test } from "bun:test";
import {
	getRenderableMessageOrder,
	hasRenderableMessageOrderAnomaly,
} from "../../frontend/components/narrator/message-order-utils";
import type { MessagesPage } from "../../frontend/components/narrator/narrator-panel-types";
import { makeMessage } from "./narrator-timeline.fixtures";

function page(messages: MessagesPage["messages"]): MessagesPage {
	return { messages, hasMore: false, nextCursor: null };
}

function msg(id: string, seq: number) {
	return makeMessage({
		id,
		seq,
		role: "assistant",
		contentJson: [{ type: "text", text: id }],
		createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, seq)).toISOString(),
	});
}

describe("message-order-utils", () => {
	test("正常分页顺序不触发规范化", () => {
		const pages = [page([msg("m3", 3), msg("m4", 4)]), page([msg("m1", 1), msg("m2", 2)])];

		expect(hasRenderableMessageOrderAnomaly(pages)).toBe(false);
		const ordered = getRenderableMessageOrder(pages);
		expect(ordered.normalized).toBe(false);
		expect(ordered.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
	});

	test("around 窗口混入最新实时消息后加载 newer 页时按 seq 恢复顺序", () => {
		const pages = [
			page([msg("m121", 121), msg("m122", 122)]),
			page([msg("m100", 100), msg("m101", 101), msg("m200", 200)]),
		];

		expect(hasRenderableMessageOrderAnomaly(pages)).toBe(true);
		const ordered = getRenderableMessageOrder(pages);
		expect(ordered.normalized).toBe(true);
		expect(ordered.messages.map((m) => m.id)).toEqual(["m100", "m101", "m121", "m122", "m200"]);
	});
});
