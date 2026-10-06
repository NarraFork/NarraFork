import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStorage, PluginStorageError } from "@server/services/plugin-storage";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-storage-"));
	roots.push(root);
	return root;
}

const userScope = { type: "user" as const, id: "user-1" };
const otherUserScope = { type: "user" as const, id: "user-2" };

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginStorage", () => {
	test("isolates scopes and binds every operation to the constructor plugin namespace", async () => {
		const root = await makeRoot();
		const storage = new PluginStorage({ pluginId: "com.example.storage", root });
		await storage.set({ scope: userScope, key: "value", value: { owner: "one" } });
		await storage.set({ scope: otherUserScope, key: "value", value: { owner: "two" } });

		expect((await storage.get({ scope: userScope, key: "value" }))?.value).toEqual({
			owner: "one",
		});
		expect((await storage.get({ scope: otherUserScope, key: "value" }))?.value).toEqual({
			owner: "two",
		});
		expect((await storage.list({ scope: userScope })).items.map((item) => item.key)).toEqual([
			"value",
		]);
		await expect(
			storage.get({
				pluginId: "com.other.plugin",
				scope: userScope,
				key: "value",
			} as never),
		).rejects.toMatchObject({ reason: "PLUGIN_NAMESPACE_MISMATCH" });
		const other = new PluginStorage({ pluginId: "com.other.plugin", root });
		expect(await other.get({ scope: userScope, key: "value" })).toBeUndefined();
	});

	test("enforces key, JSON schema, depth, value, entry and byte quotas", async () => {
		const root = await makeRoot();
		const storage = new PluginStorage({
			pluginId: "com.example.quota",
			root,
			limits: {
				maxValueBytes: 24,
				maxScopeBytes: 30,
				maxPluginBytes: 40,
				maxEntriesPerScope: 2,
				maxEntriesPerPlugin: 3,
				maxJsonDepth: 2,
			},
			valueSchema: {
				safeParse(value: unknown) {
					return {
						success:
							typeof value === "object" &&
							value !== null &&
							"ok" in value &&
							(value as { ok?: unknown }).ok === true,
					};
				},
			},
		});

		await expect(
			storage.set({ scope: userScope, key: "bad", value: { ok: false } }),
		).rejects.toMatchObject({
			reason: "SCHEMA_REJECTED",
		});
		await expect(
			storage.set({
				scope: userScope,
				key: "deep",
				value: { ok: true, nested: { nested: { x: 1 } } },
			}),
		).rejects.toMatchObject({
			reason: "INVALID_JSON",
		});
		await expect(
			storage.set({ scope: userScope, key: "large", value: { ok: "x".repeat(30) } }),
		).rejects.toMatchObject({
			reason: "VALUE_TOO_LARGE",
		});
		await expect(
			storage.set({ scope: userScope, key: "../escape", value: { ok: true } }),
		).rejects.toMatchObject({
			reason: "INVALID_KEY",
		});

		await storage.set({ scope: userScope, key: "one", value: { ok: true } });
		await storage.set({ scope: userScope, key: "two", value: { ok: true } });
		await expect(
			storage.set({ scope: userScope, key: "three", value: { ok: true } }),
		).rejects.toMatchObject({
			reason: "QUOTA_EXCEEDED",
		});
	});

	test("serializes concurrent writes across storage instances without losing records", async () => {
		const root = await makeRoot();
		const first = new PluginStorage({ pluginId: "com.example.concurrent", root });
		const second = new PluginStorage({ pluginId: "com.example.concurrent", root });
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				(index % 2 === 0 ? first : second).set({
					scope: userScope,
					key: `key-${index}`,
					value: { index },
				}),
			),
		);

		const listed = await first.list({ scope: userScope, limit: 100 });
		expect(listed.items).toHaveLength(20);
		expect((await second.get({ scope: userScope, key: "key-19" }))?.value).toEqual({ index: 19 });
	});

	test("supports optimistic revisions and cursor-bounded metadata lists", async () => {
		const root = await makeRoot();
		const storage = new PluginStorage({ pluginId: "com.example.revision", root });
		const created = await storage.set({ scope: userScope, key: "a", value: 1 });
		expect(created.revision).toBe(1);
		const updated = await storage.set({
			scope: userScope,
			key: "a",
			value: 2,
			expectedRevision: 1,
		});
		expect(updated.revision).toBe(2);
		await expect(
			storage.set({ scope: userScope, key: "a", value: 3, expectedRevision: 1 }),
		).rejects.toMatchObject({
			code: "STORAGE_CONFLICT",
			reason: "REVISION_CONFLICT",
		});

		await storage.set({ scope: userScope, key: "b", value: { hidden: true } });
		await storage.set({ scope: userScope, key: "c", value: { hidden: true } });
		const first = await storage.list({ scope: userScope, limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.items[0]).not.toHaveProperty("value");
		expect(first.hasMore).toBe(true);
		const second = await storage.list({ scope: userScope, limit: 1, cursor: first.nextCursor });
		expect(second.items).toHaveLength(1);
		expect(second.items[0].key).not.toBe(first.items[0].key);
		await expect(
			storage.list({ scope: otherUserScope, limit: 1, cursor: first.nextCursor }),
		).rejects.toMatchObject({
			reason: "INVALID_CURSOR",
		});
	});

	test("recovers corrupt data fail-closed and preserves the corrupt document", async () => {
		const root = await makeRoot();
		const storage = new PluginStorage({ pluginId: "com.example.recovery", root });
		await mkdir(root, { recursive: true });
		await writeFile(storage.storagePath, "{not-json", { mode: 0o644 });

		expect(await storage.get({ scope: userScope, key: "value" })).toBeUndefined();
		expect(
			(await readdir(root)).some((name) => name.startsWith("com.example.recovery.json.corrupt-")),
		).toBe(true);
		expect(JSON.parse(await readFile(storage.storagePath, "utf8")).scopes).toEqual({});
	});

	test("does not replace the previous file when atomic rename fails and supports purge", async () => {
		const root = await makeRoot();
		const stable = new PluginStorage({ pluginId: "com.example.purge", root });
		await stable.set({ scope: userScope, key: "one", value: 1 });
		await stable.set({ scope: otherUserScope, key: "two", value: 2 });
		const before = await readFile(stable.storagePath, "utf8");
		const failing = new PluginStorage({
			pluginId: "com.example.purge",
			root,
			renameFile: async () => {
				throw new Error("simulated rename failure");
			},
		});
		await expect(failing.set({ scope: userScope, key: "three", value: 3 })).rejects.toThrow(
			"simulated rename failure",
		);
		expect(await readFile(stable.storagePath, "utf8")).toBe(before);
		expect(await stable.purge({ scope: userScope })).toBe(1);
		expect(await stable.get({ scope: userScope, key: "one" })).toBeUndefined();
		expect((await stable.get({ scope: otherUserScope, key: "two" }))?.value).toBe(2);
		expect(await stable.purge()).toBe(1);
		expect(await stable.get({ scope: otherUserScope, key: "two" })).toBeUndefined();
	});

	test("keeps the host namespace fixed even when callers pass forged plugin fields", async () => {
		const root = await makeRoot();
		const storage = new PluginStorage({ pluginId: "com.example.fixed", root });
		await expect(
			storage.set({ pluginId: "com.other.plugin", scope: userScope, key: "x", value: 1 } as never),
		).rejects.toBeInstanceOf(PluginStorageError);
	});
});
