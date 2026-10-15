import { describe, expect, test } from "bun:test";
import {
	HIDDEN_CONNECTION_RELEASE_MS,
	isDocumentHidden,
	shouldReleaseHiddenConnection,
} from "../../frontend/lib/browser-connection-budget";

describe("hidden tab connection budget", () => {
	test("keeps the socket across a short hide", () => {
		expect(shouldReleaseHiddenConnection(HIDDEN_CONNECTION_RELEASE_MS - 1)).toBe(false);
		expect(shouldReleaseHiddenConnection(0)).toBe(false);
	});

	test("releases the socket once the tab has stayed in the background", () => {
		expect(shouldReleaseHiddenConnection(HIDDEN_CONNECTION_RELEASE_MS)).toBe(true);
		expect(shouldReleaseHiddenConnection(HIDDEN_CONNECTION_RELEASE_MS + 1)).toBe(true);
	});

	test("ignores a non-finite elapsed time", () => {
		expect(shouldReleaseHiddenConnection(Number.NaN)).toBe(false);
		expect(shouldReleaseHiddenConnection(Number.POSITIVE_INFINITY)).toBe(false);
	});

	test("treats only the hidden visibility state as background", () => {
		expect(isDocumentHidden("hidden")).toBe(true);
		expect(isDocumentHidden("visible")).toBe(false);
		expect(isDocumentHidden(undefined)).toBe(false);
	});
});
