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

describe("write priority", () => {
	/*
	 * The reported bug in storage terms: a narrator whose draft the user typed lost
	 * its local mirror because every OTHER narrator the tab opened wrote an empty
	 * mirror on hydration. Those empty writes were the most recent, so a
	 * recency-only cap evicted the one entry that held text. Nothing errored — the
	 * composer simply blanked on switch-back and hydration re-applied the server copy.
	 */
	test("a durable entry outlives cap overflow driven by disposable writes", () => {
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		writeSession("narrator-draft", "typed", "text the user wrote", "durable");
		flush();
		for (let i = 0; i < cap + 4; i++) {
			writeSession("narrator-draft", `empty${i}`, "", "disposable");
			flush();
		}
		expect(readSession("narrator-draft", "typed")).toBe("text the user wrote");
	});

	test("disposable entries are evicted before durable ones under the cap", () => {
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		// Fill the namespace with disposable entries, then add durable ones. Each
		// durable insert must consume a disposable slot, never another durable one.
		for (let i = 0; i < cap; i++) {
			writeSession("narrator-draft", `d${i}`, `disposable-${i}`, "disposable");
			flush();
		}
		for (let i = 0; i < cap; i++) {
			writeSession("narrator-draft", `k${i}`, `durable-${i}`, "durable");
			flush();
		}
		for (let i = 0; i < cap; i++) {
			expect(readSession("narrator-draft", `k${i}`)).toBe(`durable-${i}`);
		}
	});

	test("the default priority is durable", () => {
		// A call site that never considers priority must get the safe tier: the
		// opposite default would make every unannotated write first to be dropped.
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		writeSession("narrator-draft", "unannotated", "kept");
		flush();
		for (let i = 0; i < cap - 1; i++) {
			writeSession("narrator-draft", `later${i}`, `x${i}`, "disposable");
			flush();
		}
		writeSession("narrator-draft", "overflow", "pushes past the cap", "disposable");
		flush();
		expect(readSession("narrator-draft", "unannotated")).toBe("kept");
	});

	test("a disposable entry becomes durable once it holds text", () => {
		// Priority describes the VALUE, not the key: the empty mirror of a narrator
		// the user then types into must stop being cheap to evict.
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		writeSession("narrator-draft", "n1", "", "disposable");
		flush();
		writeSession("narrator-draft", "n1", "now typed", "durable");
		flush();
		for (let i = 0; i < cap + 2; i++) {
			writeSession("narrator-draft", `other${i}`, "", "disposable");
			flush();
		}
		expect(readSession("narrator-draft", "n1")).toBe("now typed");
	});

	test("entries adopted from a previous page lifecycle are treated as durable", () => {
		// Priority is a write-time hint and is not stored, so a reload has no way to
		// recover it. Guessing "disposable" would make refreshing the tab the thing
		// that discards a typed draft.
		writeSession("narrator-draft", "survivor", "typed before reload", "durable");
		flush();
		resetSessionStoreForTest(); // simulates a reload: storage kept, module state lost
		const cap = SESSION_STORE_LIMITS.NAMESPACE_KEY_CAPS["narrator-draft"];
		for (let i = 0; i < cap + 2; i++) {
			writeSession("narrator-draft", `fresh${i}`, "", "disposable");
			flush();
		}
		expect(readSession("narrator-draft", "survivor")).toBe("typed before reload");
	});

	test("a disposable write still lands in storage", () => {
		// The empty mirror is what stops a cleared draft from resurrecting on reload,
		// so "cheap to evict" must not become "not written".
		writeSession("narrator-draft", "cleared", "", "disposable");
		flush();
		expect(readSession("narrator-draft", "cleared")).toBe("");
	});

	test("a quota cliff drops disposable entries before durable ones", () => {
		writeSession("narrator-draft", "typed", "z".repeat(3_000), "durable");
		writeSession("narrator-draft", "spare", "w".repeat(3_000), "disposable");
		flush();
		quotaChars = 7_000;
		writeSession("narrator-draft", "incoming", "y".repeat(3_000), "durable");
		flush();
		expect(readSession("narrator-draft", "incoming")).toBe("y".repeat(3_000));
		expect(readSession("narrator-draft", "typed")).toBe("z".repeat(3_000));
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
