import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

describe("text selection popover wiring", () => {
	it("does not install the terminal-send popover in the conversation", () => {
		const panel = read("../NarratorPanel.tsx");
		expect(panel).not.toContain("SelectionPopover");
		expect(panel).not.toContain("sendToTerminal");
		// Message-block selection remains a separate feature.
		expect(panel).toContain("handleBatchCopy");
	});

	it("retains terminal selection actions and the chat bridge", () => {
		const terminal = read("../../terminal/TerminalPanel.tsx");
		expect(terminal).toContain("<SelectionPopover");
		expect(terminal).toContain("onAction={handleSendSelection}");
		expect(terminal).toContain('label={t("sendToChat")}');
		expect(terminal).toContain("externalSelection={xtermSelection}");
	});

	it("does not expose the removed write bridge on desktop, workspace or mobile", () => {
		for (const path of [
			"../dock/NarratorDockContext.tsx",
			"../dock/panels.tsx",
			"../workspace/workspace-dock.tsx",
			"../../terminal/NarratorTerminal.tsx",
			"../../../routes/narrators/$narratorId.tsx",
		]) {
			const source = read(path);
			expect(source).not.toContain("writeTerminalStdin");
			expect(source).not.toContain("onWriteRef");
			expect(source).not.toContain("onSendToTerminal");
		}
	});
});
