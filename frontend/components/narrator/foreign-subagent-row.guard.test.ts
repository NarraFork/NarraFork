/**
 * Guards the ONE rule every realtime message entry point must apply: a row carrying
 * `parentToolUseId` is a SUBAGENT's row, dual-broadcast to its parent's page, and it is
 * not a message of the conversation that page is showing (`isForeignSubagentRow`).
 *
 * Both failures are silent. The message list counted such a row as a structural change
 * it could never apply, so the parent's scroll-to-bottom badge climbed with messages
 * scrolling down could never reveal; the panel hook read it as an assistant answer and
 * cleared the parent's queue/retry chips while the parent was still working.
 */

import { describe, expect, it } from "bun:test";

function read(name: string): Promise<string> {
	return Bun.file(new URL(name, import.meta.url)).text();
}

describe("foreign subagent rows", () => {
	it("the message list declines them on both realtime entry points", async () => {
		const shell = await read("./vlist/PretextExactMessageList.tsx");
		expect(shell).toContain('from "../message/nested-rows"');
		// onMessage / onUserMessage and onMessageUpdated both route through it.
		expect(shell.match(/isForeignSubagentRow\(message, !!isSubagent\)/g)?.length).toBe(2);
	});

	it("the panel hook never derives this conversation's state from them", async () => {
		const hook = await read("./useNarratorPanelWS.ts");
		expect(hook).toContain('from "./message/nested-rows"');
		expect(hook).toContain("isForeignSubagentRow(wsData.message, !!isSubagent)");
		// The guard must precede the assistant-answer side effects it protects.
		const guard = hook.indexOf("isForeignSubagentRow(wsData.message, !!isSubagent)");
		const clears = hook.indexOf('if (wsData.message?.role === "assistant")');
		expect(guard).toBeGreaterThan(-1);
		expect(clears).toBeGreaterThan(guard);
	});
});
