import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	flush,
	resetSessionStoreForTest,
	SESSION_STORE_LIMITS,
	writeSession,
} from "@frontend/lib/session-store";
import { getDraftImageAttachmentKey } from "./draft-image-attachments";
import {
	classifyDraftRevisionConflict,
	cleanupLegacyNarratorInputStorage,
	getNarratorDraftStorageId,
	getNarratorInputDraftKey,
	getNarratorInputHistoryKey,
	MAX_LOCAL_DRAFT_MIRROR_CHARS,
	persistNarratorInputDraft,
	purgeLegacyNarratorInputStorage,
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
	resetSessionStoreForTest();
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

	test("removes legacy narrator-only and pre-facade user-scoped keys", () => {
		values.set("narrafork_draft_narrator-1", "legacy text");
		values.set("narrafork_input_history_narrator-1", '["legacy history"]');
		values.set(getNarratorInputDraftKey("user-a", "narrator-1"), "pre-facade text");
		values.set(getNarratorInputHistoryKey("user-a", "narrator-1"), '["pre-facade"]');
		cleanupLegacyNarratorInputStorage("user-a", "narrator-1");
		expect(values.has("narrafork_draft_narrator-1")).toBe(false);
		expect(values.has("narrafork_input_history_narrator-1")).toBe(false);
		expect(values.has(getNarratorInputDraftKey("user-a", "narrator-1"))).toBe(false);
		expect(values.has(getNarratorInputHistoryKey("user-a", "narrator-1"))).toBe(false);
	});
});

describe("legacy key purge", () => {
	test("sweeps every accumulated pre-facade draft and history key", () => {
		// The reported hang came from exactly this shape: one draft plus one history
		// entry per narrator the tab had ever opened, with nothing able to expire them.
		for (let i = 0; i < 30; i++) {
			values.set(getNarratorInputDraftKey("user-a", `narrator-${i}`), "x".repeat(1_000));
			values.set(getNarratorInputHistoryKey("user-a", `narrator-${i}`), '["entry"]');
		}
		expect(purgeLegacyNarratorInputStorage()).toBe(60);
		expect(values.size).toBe(0);
	});

	test("leaves unrelated keys alone", () => {
		values.set("narrafork_token", "auth");
		values.set(getNarratorInputDraftKey("user-a", "narrator-1"), "draft");
		purgeLegacyNarratorInputStorage();
		expect(values.get("narrafork_token")).toBe("auth");
	});

	test("MIGRATES input history instead of dropping it", () => {
		// A draft has a server copy (hydration restores it); history does not, so a
		// plain sweep would silently cost the user their up-arrow recall.
		values.set(getNarratorInputHistoryKey("user-a", "narrator-1"), '["second","first"]');
		const migrated: Array<{ storageId: string; entries: string[] }> = [];
		purgeLegacyNarratorInputStorage((storageId, entries) => migrated.push({ storageId, entries }));
		expect(migrated).toEqual([
			{
				storageId: getNarratorDraftStorageId("user-a", "narrator-1"),
				entries: ["second", "first"],
			},
		]);
		// The legacy key is still reclaimed — migration is not a reason to keep it.
		expect(values.has(getNarratorInputHistoryKey("user-a", "narrator-1"))).toBe(false);
	});

	test("does not migrate a DRAFT key, only history", () => {
		values.set(getNarratorInputDraftKey("user-a", "narrator-1"), '{"text":"draft"}');
		const migrated: string[] = [];
		purgeLegacyNarratorInputStorage((storageId) => migrated.push(storageId));
		expect(migrated).toEqual([]);
	});

	test("cannot migrate a pre-user-scoped key: it names no owner", () => {
		// `narrafork_input_history_<narratorId>` has no user in it, so adopting it
		// would file one account's text under an id that means something else.
		values.set("narrafork_input_history_narrator-1", '["orphan"]');
		const migrated: string[] = [];
		expect(purgeLegacyNarratorInputStorage((storageId) => migrated.push(storageId))).toBe(1);
		expect(migrated).toEqual([]);
		expect(values.size).toBe(0);
	});

	test("an unreadable legacy list still frees the quota", () => {
		values.set(getNarratorInputHistoryKey("user-a", "narrator-1"), "not json");
		const migrated: string[] = [];
		expect(purgeLegacyNarratorInputStorage((storageId) => migrated.push(storageId))).toBe(1);
		expect(migrated).toEqual([]);
		expect(values.size).toBe(0);
	});
});

describe("local mirror size limit", () => {
	test("mirrors a draft within the local limit", () => {
		const text = "y".repeat(MAX_LOCAL_DRAFT_MIRROR_CHARS);
		expect(persistNarratorInputDraft("user-a", "narrator-1", text, 1, null)).toBe(true);
		expect(readNarratorInputDraft("user-a", "narrator-1").text).toBe(text);
	});

	test("refuses to mirror a draft past the local limit", () => {
		// The server sync path still carries it; only the browser copy is skipped.
		// Writing bodies this large per keystroke is what saturated the main thread.
		const text = "y".repeat(MAX_LOCAL_DRAFT_MIRROR_CHARS + 1);
		expect(persistNarratorInputDraft("user-a", "narrator-1", text, 1, null)).toBe(false);
	});

	test("a typed draft survives visiting enough other narrators to overflow the cap", () => {
		/*
		 * The reported symptom: type into a narrator, switch narrators a few times,
		 * come back to a BLANK composer that then "restored" an older server copy.
		 *
		 * Every narrator opened mirrors its draft during hydration, and for one nobody
		 * typed into that mirror is empty. Those empty writes were the most recent, so
		 * a recency-only key cap evicted the single mirror that held text. Hydration
		 * then found no local base revision and — correctly, given what it could see —
		 * took the server revision as authoritative.
		 */
		persistNarratorInputDraft("user-a", "narrator-typed", "text the user wrote", 5, "t5");
		flush();
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		for (let i = 0; i < cap + 4; i++) {
			persistNarratorInputDraft("user-a", `narrator-visited-${i}`, "", 0, null);
			flush();
		}
		expect(readNarratorInputDraft("user-a", "narrator-typed")).toEqual({
			text: "text the user wrote",
			serverRevision: 5,
			serverUpdatedAt: "t5",
		});
	});

	test("a cleared draft is still mirrored, so it cannot resurrect on reload", () => {
		// The empty mirror is cheap to evict, NOT skipped: without it, hydration would
		// find the older non-empty copy and put the cleared text back.
		persistNarratorInputDraft("user-a", "narrator-1", "typed", 1, null);
		flush();
		persistNarratorInputDraft("user-a", "narrator-1", "", 2, null);
		flush();
		expect(readNarratorInputDraft("user-a", "narrator-1")).toEqual({
			text: "",
			serverRevision: 2,
			serverUpdatedAt: null,
		});
	});

	test("clears a smaller stored copy when the draft outgrows the limit", () => {
		persistNarratorInputDraft("user-a", "narrator-1", "short", 1, null);
		flush();
		persistNarratorInputDraft(
			"user-a",
			"narrator-1",
			"y".repeat(MAX_LOCAL_DRAFT_MIRROR_CHARS + 1),
			1,
			null,
		);
		flush();
		// A stale prefix would be restored on reload and silently lose the rest.
		expect(readNarratorInputDraft("user-a", "narrator-1").text).toBe("");
	});
});

describe("storage id scoping", () => {
	test("cannot collide across user/narrator boundaries", () => {
		expect(getNarratorDraftStorageId("a_b", "c")).not.toBe(getNarratorDraftStorageId("a", "b_c"));
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
		// A v1 envelope can still be present under the CURRENT storage id: the
		// envelope version and the key shape moved independently, so the reader must
		// keep honouring version 1 rather than assuming the id implies version 2.
		writeSession(
			"narrator-draft",
			getNarratorDraftStorageId("user-a", "narrator-1"),
			JSON.stringify({ version: 1, text: "legacy local", serverUpdatedAt: "old" }),
		);
		flush();
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
