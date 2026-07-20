import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getDraftImageAttachmentKey } from "./draft-image-attachments";
import {
	classifyDraftRevisionConflict,
	cleanupLegacyNarratorInputStorage,
	getNarratorInputDraftKey,
	getNarratorInputHistoryKey,
	persistNarratorInputDraft,
	readNarratorInputDraft,
	resolveHydratedNarratorDraft,
} from "./narrator-draft-storage";

const globalObject = globalThis as typeof globalThis & { sessionStorage?: Storage };
const originalSessionStorage = globalObject.sessionStorage;
let values = new Map<string, string>();

beforeEach(() => {
	values = new Map();
	Object.defineProperty(globalObject, "sessionStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, value),
		} satisfies Storage,
	});
});

afterAll(() => {
	if (originalSessionStorage === undefined) {
		Reflect.deleteProperty(globalObject, "sessionStorage");
	} else {
		Object.defineProperty(globalObject, "sessionStorage", {
			configurable: true,
			value: originalSessionStorage,
		});
	}
});

describe("narrator draft browser isolation", () => {
	test("uses different text, history, and image keys for different users", () => {
		expect(getNarratorInputDraftKey("user-a", "narrator-1")).not.toBe(
			getNarratorInputDraftKey("user-b", "narrator-1"),
		);
		expect(getNarratorInputHistoryKey("user-a", "narrator-1")).not.toBe(
			getNarratorInputHistoryKey("user-b", "narrator-1"),
		);
		expect(getDraftImageAttachmentKey("user-a", "narrator-1")).not.toBe(
			getDraftImageAttachmentKey("user-b", "narrator-1"),
		);
		expect(getNarratorInputDraftKey("a_b", "c")).not.toBe(getNarratorInputDraftKey("a", "b_c"));
		expect(getDraftImageAttachmentKey("a_b", "c")).not.toBe(getDraftImageAttachmentKey("a", "b_c"));
	});

	test("does not read another user's stored draft", () => {
		persistNarratorInputDraft("user-a", "narrator-1", "secret-a", 3, "updated-a");
		expect(readNarratorInputDraft("user-a", "narrator-1")).toEqual({
			text: "secret-a",
			serverRevision: 3,
			serverUpdatedAt: "updated-a",
		});
		expect(readNarratorInputDraft("user-b", "narrator-1")).toEqual({
			text: "",
			serverRevision: null,
			serverUpdatedAt: null,
		});
	});

	test("removes legacy narrator-only text and history keys", () => {
		values.set("narrafork_draft_narrator-1", "legacy text");
		values.set("narrafork_input_history_narrator-1", '["legacy history"]');
		cleanupLegacyNarratorInputStorage("narrator-1");
		expect(values.has("narrafork_draft_narrator-1")).toBe(false);
		expect(values.has("narrafork_input_history_narrator-1")).toBe(false);
	});
});

describe("narrator draft revision conflict classification", () => {
	test("retries the latest request when the server revision came from the same editor", () => {
		expect(
			classifyDraftRevisionConflict({
				requestSequence: 2,
				latestSequence: 2,
				requestSourceId: "source-a",
				currentSourceId: "source-a",
			}),
		).toBe("retry");
	});

	test("ignores a stale request result instead of overriding newer sync state", () => {
		expect(
			classifyDraftRevisionConflict({
				requestSequence: 1,
				latestSequence: 2,
				requestSourceId: "source-a",
				currentSourceId: "source-b",
			}),
		).toBe("ignore");
	});

	test("reports a real conflict when another editor advanced the revision", () => {
		expect(
			classifyDraftRevisionConflict({
				requestSequence: 2,
				latestSequence: 2,
				requestSourceId: "source-a",
				currentSourceId: "source-b",
			}),
		).toBe("conflict");
	});
});

describe("narrator draft hydration conflict resolution", () => {
	test("keeps unsynced local edits based on the current server revision", () => {
		expect(
			resolveHydratedNarratorDraft({
				local: {
					text: "local unsynced",
					serverRevision: 1,
					serverUpdatedAt: "updated-1",
				},
				serverText: "server old",
				serverRevision: 1,
				currentInput: "local unsynced",
				localChangedSinceRequest: false,
			}),
		).toEqual({ text: "local unsynced", conflict: false });
	});

	test("accepts a newer server clear instead of resurrecting stale local text", () => {
		expect(
			resolveHydratedNarratorDraft({
				local: { text: "stale text", serverRevision: 1, serverUpdatedAt: "updated-1" },
				serverText: "",
				serverRevision: 2,
				currentInput: "stale text",
				localChangedSinceRequest: false,
			}),
		).toEqual({ text: "", conflict: false });
	});

	test("preserves input typed while the server request is in flight as a conflict", () => {
		expect(
			resolveHydratedNarratorDraft({
				local: { text: "before", serverRevision: 1, serverUpdatedAt: "updated-1" },
				serverText: "server newer",
				serverRevision: 2,
				currentInput: "typed during request",
				localChangedSinceRequest: true,
			}),
		).toEqual({ text: "typed during request", conflict: true });
	});

	test("preserves a version-1 local draft for an explicit conflict decision", () => {
		values.set(
			getNarratorInputDraftKey("user-a", "narrator-1"),
			JSON.stringify({ version: 1, text: "legacy local", serverUpdatedAt: "old" }),
		);
		const local = readNarratorInputDraft("user-a", "narrator-1");
		expect(local).toEqual({
			text: "legacy local",
			serverRevision: null,
			serverUpdatedAt: "old",
		});
		expect(
			resolveHydratedNarratorDraft({
				local,
				serverText: "server",
				serverRevision: 4,
				currentInput: local.text,
				localChangedSinceRequest: false,
			}),
		).toEqual({ text: "legacy local", conflict: true });
	});
});
