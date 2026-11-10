import { describe, expect, test } from "bun:test";
import {
	clearedToolOutput,
	historyClearedText,
	isClearedToolOutput,
	isHistoryClearedContent,
	isHistoryClearedElement,
} from "./storage-retention";

const at = "2026-01-01T00:00:00.000Z";
describe("storage retention content markers", () => {
	test("message and tool markers survive serialization and remain separate", () => {
		const text = JSON.parse(JSON.stringify(historyClearedText(at)));
		expect(text.type).toBe("text");
		expect(isHistoryClearedElement(text)).toBe(true);
		expect(isHistoryClearedContent([text])).toBe(true);
		expect(isClearedToolOutput(text)).toBe(false);
		const tool = JSON.parse(JSON.stringify(clearedToolOutput(at)));
		expect(isClearedToolOutput(tool)).toBe(true);
		expect(isHistoryClearedContent([tool])).toBe(false);
	});
	test("ordinary text, empty bodies and partial markers retain their usual meaning", () => {
		for (const value of [null, {}, [], "[History cleared]", { historyClearVersion: 1 }]) {
			expect(isHistoryClearedElement(value)).toBe(false);
			expect(isClearedToolOutput(value)).toBe(false);
		}
		expect(isHistoryClearedContent([])).toBe(false);
		expect(isHistoryClearedContent([{ type: "text", text: "[History cleared]" }])).toBe(false);
	});
});
