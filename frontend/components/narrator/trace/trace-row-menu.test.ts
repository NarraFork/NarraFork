/**
 * trace-row-menu.test.ts — guards the fork coordinate for folded trace rows.
 *
 * Fork must key off the LOCAL message id, not the SDK `messageUuid`: only
 * assistant messages carry a uuid, so a uuid-gated menu silently hides fork on
 * user messages, and passing an id through a uuid-typed parameter made the
 * backend reject the request ("Fork message not found").
 */

import { describe, expect, test } from "bun:test";
import { buildTraceRowActions } from "./trace-row-menu";

describe("buildTraceRowActions", () => {
	test("binds fork to the message id when the row has an SDK uuid", () => {
		const seen: string[] = [];
		const actions = buildTraceRowActions(
			{ messageId: "msg-1", messageUuid: "sdk-uuid-1" },
			{ onForkFromMessage: (id) => seen.push(id) },
		);
		actions.onForkFromMessage?.();
		expect(seen).toEqual(["msg-1"]);
	});

	test("still offers fork when the row has no SDK uuid (user messages)", () => {
		const seen: string[] = [];
		const actions = buildTraceRowActions(
			{ messageId: "msg-2", messageUuid: null },
			{ onForkFromMessage: (id) => seen.push(id) },
		);
		expect(actions.onForkFromMessage).toBeDefined();
		actions.onForkFromMessage?.();
		expect(seen).toEqual(["msg-2"]);
	});

	test("omits fork when no handler is supplied", () => {
		const actions = buildTraceRowActions({ messageId: "msg-3" }, {});
		expect(actions.onForkFromMessage).toBeUndefined();
	});

	test("keeps passing the uuid to ask-in-passing as context", () => {
		const seen: Array<[string | null, string]> = [];
		const actions = buildTraceRowActions(
			{ messageId: "msg-4", messageUuid: "sdk-uuid-4" },
			{ onAskInPassing: (uuid, id) => seen.push([uuid, id]) },
		);
		actions.onAskInPassing?.();
		expect(seen).toEqual([["sdk-uuid-4", "msg-4"]]);
	});
});
