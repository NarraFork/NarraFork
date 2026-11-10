import { describe, expect, test } from "bun:test";
import { SessionAffinity } from "../session-affinity";

const now = 1_000_000;

describe("SessionAffinity", () => {
	test("a session keeps its credential until it expires", () => {
		const affinity = new SessionAffinity<string>({ maxEntries: 10, ttlMs: 1000 });
		affinity.set("s", "key-a", now);
		expect(affinity.get("s", now + 500)).toBe("key-a");
		expect(affinity.get("s", now + 1001)).toBeUndefined();
		expect(affinity.size).toBe(0);
	});

	test("rebinding refreshes the age and evicts the oldest past the cap", () => {
		const affinity = new SessionAffinity<string>({ maxEntries: 2 });
		affinity.set("a", "k", now);
		affinity.set("b", "k", now + 10);
		affinity.set("a", "k", now + 20); // a becomes newest again
		affinity.set("c", "k", now + 30);
		expect(affinity.get("a", now + 40)).toBe("k");
		expect(affinity.get("b", now + 40)).toBeUndefined();
		expect(affinity.get("c", now + 40)).toBe("k");
	});

	test("evictValue forgets every session that used a credential", () => {
		const affinity = new SessionAffinity<string>({ maxEntries: 10 });
		affinity.set("s1", "key-a", now);
		affinity.set("s2", "key-b", now);
		affinity.set("s3", "key-a", now);
		affinity.evictValue("key-a");
		expect(affinity.get("s1", now)).toBeUndefined();
		expect(affinity.get("s2", now)).toBe("key-b");
		expect(affinity.get("s3", now)).toBeUndefined();
		expect(affinity.size).toBe(1);
	});

	test("delete and clear", () => {
		const affinity = new SessionAffinity<string>({ maxEntries: 10 });
		affinity.set("s", "k", now);
		affinity.delete("s");
		expect(affinity.get("s", now)).toBeUndefined();
		affinity.set("s", "k", now);
		affinity.clear();
		expect(affinity.size).toBe(0);
	});
});
