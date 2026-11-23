import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearToken, getToken, setToken } from "./api/client";
import {
	clearCurrentUserCache,
	readCurrentUserCache,
	writeCurrentUserCache,
} from "./current-user-cache";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let values: Map<string, string>;
const user = { id: "u1", username: "alice", role: "user", avatarColor: "blue" };
beforeEach(() => {
	values = new Map();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		},
	});
});
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
test("round trips only profile fields, never credentials", () => {
	writeCurrentUserCache({ ...user, token: "secret", passwordHash: "secret", tokenVersion: 2 });
	expect(readCurrentUserCache()).toEqual(user);
	expect([...values.values()].join()).not.toContain("secret");
	clearCurrentUserCache();
	expect(readCurrentUserCache()).toBeUndefined();
});
test("missing, corrupt, oversized and invalid entries are ignored", () => {
	expect(readCurrentUserCache()).toBeUndefined();
	for (const raw of ["{", "null", "[]", '{"id":"u1"}', "x".repeat(20_000)]) {
		values.set("narrafork_current_user_v1", raw);
		expect(readCurrentUserCache()).toBeUndefined();
		expect(values.size).toBe(0);
	}
	writeCurrentUserCache({ token: "secret" });
	expect(values.size).toBe(0);
});
test("blocked storage is harmless", () => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		get() {
			throw Error("blocked");
		},
	});
	expect(() => writeCurrentUserCache(user)).not.toThrow();
	expect(readCurrentUserCache()).toBeUndefined();
	expect(() => clearCurrentUserCache()).not.toThrow();
});
test("absent token, replacement token and logout discard cached identity", () => {
	writeCurrentUserCache(user);
	expect(getToken()).toBeNull();
	expect(readCurrentUserCache()).toBeUndefined();
	setToken("first");
	writeCurrentUserCache(user);
	setToken("second");
	expect(readCurrentUserCache()).toBeUndefined();
	writeCurrentUserCache(user);
	clearToken();
	expect(readCurrentUserCache()).toBeUndefined();
});
