import { expect, test } from "bun:test";
import { narratorWsMessageSchema } from "../websocket";

test("message subscription restoration carries a strictly boolean reader-state request", () => {
	const frame = {
		type: "subscribe",
		narratorIds: ["narrator"],
		kind: "messages",
		version: 4,
		restoreState: true,
	};
	expect(narratorWsMessageSchema.parse(frame)).toMatchObject({ restoreState: true, version: 4 });
	expect(narratorWsMessageSchema.safeParse({ ...frame, restoreState: "true" }).success).toBe(false);
	expect(
		narratorWsMessageSchema.safeParse({ type: "subscribe", narratorIds: ["narrator"] }).success,
	).toBe(true);
});
