import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	flush,
	readSession,
	removeSession,
	resetSessionStoreForTest,
	retainSession,
	SESSION_STORE_LIMITS,
	sessionStoreStats,
	writeSession,
} from "./session-store";

const globalObject = globalThis as typeof globalThis & { sessionStorage?: Storage };
const originalSessionStorage = globalObject.sessionStorage;

let values: Map<string, string>;
/** Simulated hard quota in characters; Infinity disables the cliff. */
let quotaChars = Number.POSITIVE_INFINITY;
let setItemCalls = 0;

function installStorage() {
	values = new Map();
	quotaChars = Number.POSITIVE_INFINITY;
	setItemCalls = 0;
	Object.defineProperty(globalObject, "sessionStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			removeItem: (key: string) => {
				values.delete(key);
			},
			setItem: (key: string, value: string) => {
				setItemCalls++;
				let total = value.length;
				for (const [k, v] of values) if (k !== key) total += v.length;
				if (total > quotaChars) {
					const error = new Error("QuotaExceededError");
					error.name = "QuotaExceededError";
					throw error;
				}
				values.set(key, value);
			},
		} satisfies Storage,
	});
}

beforeEach(() => {
	installStorage();
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

describe("write coalescing", () => {
	test("many writes to one key produce a single physical write", () => {
		// The keystroke path: the reported IME stall came from one synchronous
		// full-value setItem per character.
		for (let i = 0; i < 50; i++) writeSession("narrator-draft", "n1", `draft-${i}`);
		expect(setItemCalls).toBe(0);
		flush();
		expect(setItemCalls).toBe(1);
		expect(readSession("narrator-draft", "n1")).toBe("draft-49");
	});

	test("a read observes a queued write before it is flushed", () => {
		writeSession("narrator-draft", "n1", "queued");
		expect(readSession("narrator-draft", "n1")).toBe("queued");
	});

	test("a queued removal is visible to a read before flush", () => {
		writeSession("narrator-draft", "n1", "text");
		flush();
		removeSession("narrator-draft", "n1");
		expect(readSession("narrator-draft", "n1")).toBeNull();
	});
});

describe("value size cap", () => {
	test("an oversized value is not stored", () => {
		writeSession("narrator-draft", "n1", "x".repeat(SESSION_STORE_LIMITS.MAX_VALUE_CHARS + 1));
		flush();
		expect(readSession("narrator-draft", "n1")).toBeNull();
	});

	test("an oversized value removes a previously stored one instead of leaving it stale", () => {
		writeSession("narrator-draft", "n1", "small");
		flush();
		writeSession("narrator-draft", "n1", "x".repeat(SESSION_STORE_LIMITS.MAX_VALUE_CHARS + 1));
		flush();
		expect(readSession("narrator-draft", "n1")).toBeNull();
	});
});

describe("namespace key caps", () => {
	test("visiting many narrators keeps only a bounded working set", () => {
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		for (let i = 0; i < cap + 12; i++) {
			writeSession("narrator-draft", `n${i}`, `draft-${i}`);
			flush();
		}
		expect(sessionStoreStats().byNamespace["narrator-draft"]).toBeLessThanOrEqual(cap);
	});

	test("the most recently written narrator survives the cap", () => {
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		for (let i = 0; i < cap + 5; i++) {
			writeSession("narrator-draft", `n${i}`, `draft-${i}`);
			flush();
		}
		expect(readSession("narrator-draft", `n${cap + 4}`)).toBe(`draft-${cap + 4}`);
	});

	test("one namespace overflowing does not evict another", () => {
		writeSession("narrator-draft", "keep", "important");
		flush();
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["permission-draft"];
		for (let i = 0; i < cap + 20; i++) {
			writeSession("permission-draft", `p${i}`, `feedback-${i}`);
			flush();
		}
		expect(readSession("narrator-draft", "keep")).toBe("important");
	});
});

describe("quota handling", () => {
	test("a quota cliff evicts and retries instead of silently dropping the write", () => {
		writeSession("narrator-draft", "old", "x".repeat(4_000));
		flush();
		// Squeeze the hard limit so the next write cannot fit alongside the old one.
		quotaChars = 5_000;
		writeSession("narrator-draft", "new", "y".repeat(4_000));
		flush();
		expect(readSession("narrator-draft", "new")).toBe("y".repeat(4_000));
		expect(sessionStoreStats().quotaFailures).toBeGreaterThan(0);
	});

	test("an unstorable value leaves no stale entry behind", () => {
		writeSession("narrator-draft", "n1", "first");
		flush();
		quotaChars = 1;
		writeSession("narrator-draft", "n1", "second");
		flush();
		expect(readSession("narrator-draft", "n1")).toBeNull();
	});
});

describe("retain", () => {
	test("drops every narrator outside the keep list", () => {
		for (const id of ["a", "b", "c"]) {
			writeSession("narrator-draft", id, `draft-${id}`);
		}
		flush();
		retainSession("narrator-draft", ["b"]);
		expect(readSession("narrator-draft", "a")).toBeNull();
		expect(readSession("narrator-draft", "b")).toBe("draft-b");
		expect(readSession("narrator-draft", "c")).toBeNull();
	});

	test("does not touch other namespaces", () => {
		writeSession("narrator-draft", "a", "draft");
		writeSession("permission-draft", "p1", "feedback");
		flush();
		retainSession("narrator-draft", []);
		expect(readSession("permission-draft", "p1")).toBe("feedback");
	});
});

describe("foreign keys", () => {
	test("never evicts keys this module does not own", () => {
		values.set("narrafork_token", "auth-token");
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		for (let i = 0; i < cap + 20; i++) {
			writeSession("narrator-draft", `n${i}`, "x".repeat(1_000));
			flush();
		}
		expect(values.get("narrafork_token")).toBe("auth-token");
	});
});

describe("reload adoption", () => {
	test("budget accounting survives a module reset (the reload case)", () => {
		writeSession("narrator-draft", "n1", "persisted");
		flush();
		// A reload keeps sessionStorage but resets module state. Without adoption
		// the budget would restart at zero against an already-populated area.
		resetSessionStoreForTest();
		expect(readSession("narrator-draft", "n1")).toBe("persisted");
		expect(sessionStoreStats().chars).toBeGreaterThan(0);
	});

	test("removes entries whose namespace is no longer recognised", () => {
		values.set(`${SESSION_STORE_LIMITS.KEY_PREFIX}retired-ns.x`, "stale");
		resetSessionStoreForTest();
		readSession("narrator-draft", "probe");
		expect(values.has(`${SESSION_STORE_LIMITS.KEY_PREFIX}retired-ns.x`)).toBe(false);
	});
});

describe("unavailable storage", () => {
	test("degrades to a no-op when sessionStorage throws on access", () => {
		Object.defineProperty(globalObject, "sessionStorage", {
			configurable: true,
			get() {
				throw new Error("blocked");
			},
		});
		resetSessionStoreForTest();
		expect(() => writeSession("narrator-draft", "n1", "text")).not.toThrow();
		expect(() => flush()).not.toThrow();
		expect(readSession("narrator-draft", "n1")).toBeNull();
		installStorage();
	});
});
