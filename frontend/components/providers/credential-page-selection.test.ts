import { describe, expect, test } from "bun:test";
import {
	getCredentialPageSelectionState,
	toggleCredentialPageSelection,
} from "./credential-page-selection";

describe("credential page selection", () => {
	test("selects only the current page while preserving previous-page selections", () => {
		const selected = new Set(["page-1-a"]);
		const next = toggleCredentialPageSelection(selected, ["page-2-a", "page-2-b"]);

		expect([...next].sort()).toEqual(["page-1-a", "page-2-a", "page-2-b"]);
	});

	test("clears only the current page when every current-page item is selected", () => {
		const selected = new Set(["page-1-a", "page-2-a", "page-2-b"]);
		const next = toggleCredentialPageSelection(selected, ["page-2-a", "page-2-b"]);

		expect([...next]).toEqual(["page-1-a"]);
	});

	test("reports partial selection for the current page", () => {
		expect(getCredentialPageSelectionState(new Set(["a"]), ["a", "b"])).toEqual({
			allSelected: false,
			someSelected: true,
		});
	});
});
