import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { WorktreeCreateRequest } from "@shared/narrator-worktrees";
import {
	draftFingerprint,
	RECEIPT_KEY,
	RECEIPT_MAX_BYTES,
	RECEIPT_MAX_COUNT,
	RECEIPT_SCOPE_LIMIT,
	RECEIPT_TTL_MS,
	WorktreeReceiptStore,
} from "./worktree-receipt-store";

const scope = { userId: "user", narratorId: "n", deviceId: "local", repositoryKey: "repo" };
const request = (id: string): WorktreeCreateRequest => ({
	requestId: id,
	expectedRevision: 4,
	workspaceKey: "wk",
	destinationPath: "/target",
	branch: { kind: "new", name: "summary-frozen" },
});
function setup() {
	const values = new Map<string, string>();
	let now = 1;
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	return {
		values,
		storage,
		store: new WorktreeReceiptStore(storage, () => now),
		expire: () => {
			now += RECEIPT_TTL_MS;
		},
	};
}
test("refresh preserves only original proposal and a digest, never requirement body", async () => {
	const s = setup();
	const fingerprint = await draftFingerprint({ requirement: "private request" });
	s.store.put(scope, request("one"), fingerprint);
	const reloaded = new WorktreeReceiptStore(s.storage).list(scope);
	expect(reloaded[0]?.request).toEqual(request("one"));
	expect(s.values.get(RECEIPT_KEY)).not.toContain("private request");
	expect(() => s.store.put(scope, request("new-id"), fingerprint)).toThrow(
		"worktree.pendingNotice",
	);
	expect(reloaded).toHaveLength(1);
});
test("store projects minimal fields and normalizes an equivalent draft without leaking extra prompt fields", async () => {
	const s = setup();
	const contaminated = {
		...request("one"),
		requirement: "must not persist",
		branch: { kind: "new" as const, name: "fixed", requirement: "nested private" },
	};
	const contaminatedScope = { ...scope, requirement: "scope private" };
	s.store.put(
		contaminatedScope,
		contaminated,
		await draftFingerprint({ name: " fix ", requirement: " repair " }),
	);
	expect(s.values.get(RECEIPT_KEY)).not.toContain("private");
	expect(s.values.get(RECEIPT_KEY)).not.toContain("must not persist");
	expect(await draftFingerprint({ name: "fix", requirement: "repair" })).toBe(
		await draftFingerprint({ requirement: " repair ", name: " fix " }),
	);
});
test("plaintext HTTP crypto without subtle retains canonical SHA-256 and stores/reloads the same scoped proposal", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
	try {
		expect(globalThis.crypto.subtle).toBeUndefined();
		expect(typeof globalThis.crypto.getRandomValues).toBe("function");
		const fingerprint = await draftFingerprint({ requirement: " repair ", name: " fix " });
		expect(fingerprint).toBe(
			createHash("sha256")
				.update(JSON.stringify({ name: "fix", requirement: "repair" }))
				.digest("hex"),
		);
		const s = setup();
		s.store.put(scope, request("http-receipt"), fingerprint);
		const receipt = new WorktreeReceiptStore(s.storage).list(scope)[0];
		expect(receipt?.request).toEqual(request("http-receipt"));
		expect(receipt?.fingerprint).toBe(fingerprint);
		expect(s.store.list({ ...scope, userId: "other" })).toEqual([]);
		expect(s.values.get(RECEIPT_KEY)).not.toContain("repair");
	} finally {
		if (original) Object.defineProperty(globalThis, "crypto", original);
		else Reflect.deleteProperty(globalThis, "crypto");
	}
});
test("logout and owner/narrator/device/repository isolation", async () => {
	const s = setup();
	s.store.put(scope, request("one"), await draftFingerprint({ name: "one" }));
	for (const key of ["userId", "narratorId", "deviceId", "repositoryKey"] as const)
		expect(s.store.list({ ...scope, [key]: "other" })).toEqual([]);
});
test("scope overflow retains every pending receipt and closes creation", async () => {
	const s = setup();
	for (let i = 0; i < RECEIPT_SCOPE_LIMIT; i++)
		s.store.put(scope, request(String(i)), await draftFingerprint({ i }));
	expect(() => s.store.put(scope, request("extra"), "a".repeat(64))).toThrow(
		"worktree.pendingLimit",
	);
	expect(s.store.list(scope)).toHaveLength(RECEIPT_SCOPE_LIMIT);
});
test("global count and byte overflow close creation without eviction", async () => {
	const s = setup();
	for (let i = 0; i < RECEIPT_MAX_COUNT; i++)
		s.store.put(
			{ ...scope, narratorId: String(i) },
			request(String(i)),
			await draftFingerprint({ i }),
		);
	expect(() => s.store.put(scope, request("extra"), "a".repeat(64))).toThrow(
		"worktree.pendingLimit",
	);
	expect(JSON.parse(s.values.get(RECEIPT_KEY) ?? "[]")).toHaveLength(RECEIPT_MAX_COUNT);
	const bounded = setup();
	expect(() =>
		bounded.store.put(
			scope,
			{ ...request("large"), destinationPath: "x".repeat(RECEIPT_MAX_BYTES) },
			"a".repeat(64),
		),
	).toThrow("worktree.pendingLimit");
	expect(bounded.store.list(scope)).toEqual([]);
});
test("TTL blocks new creation but keeps the same receipt available for reconciliation", async () => {
	const s = setup();
	s.store.put(scope, request("old"), await draftFingerprint({ name: "old" }));
	s.expire();
	expect(() => s.store.put(scope, request("new"), "b".repeat(64))).toThrow(
		"worktree.receiptExpired",
	);
	expect(s.store.list(scope)[0]?.request.requestId).toBe("old");
	s.store.remove(scope, "old");
	s.store.put(scope, request("new"), "b".repeat(64));
	expect(s.store.list(scope)[0]?.request.requestId).toBe("new");
});
test("quota, read-only and corrupt/oversized storage fail closed", () => {
	for (const storage of [
		{
			getItem: () => "[]",
			setItem: () => {
				throw new Error("quota");
			},
		},
		{ getItem: () => "[]", setItem: () => {} },
		{ getItem: () => "corrupt", setItem: () => {} },
		{ getItem: () => " ".repeat(RECEIPT_MAX_BYTES + 1), setItem: () => {} },
	])
		expect(() =>
			new WorktreeReceiptStore(storage).put(scope, request("one"), "a".repeat(64)),
		).toThrow("worktree.receiptStorage");
});
