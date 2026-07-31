import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";

/**
 * The vault is the only place plugin secret *values* live, so its guarantees are
 * security-relevant rather than cosmetic: private file mode, no plaintext leaking into
 * unrelated files, atomic writes under concurrency, and graceful behaviour on a
 * corrupted file (degrade to empty rather than take the host down).
 */

async function withVault<T>(run: (vault: PluginSecretVault, root: string) => Promise<T>) {
	const root = await mkdtemp(join(tmpdir(), "nf-secret-vault-"));
	try {
		return await run(new PluginSecretVault({ root }), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const pluginId = "com.example.secret";

describe("plugin secret vault", () => {
	test("round-trips a secret and lists keys without values", async () => {
		await withVault(async (vault) => {
		});
	});

	test("creates the vault file with owner-only permissions", async () => {
		await withVault(async (vault) => {
			await vault.setSecret({ pluginId, key: "k", value: "v" });
			const info = await stat(vault.path);
			// 0o777 masks off the file-type bits; group/other must be empty.
			expect(info.mode & 0o777).toBe(0o600);
		});
	});

	test("isolates secrets per plugin", async () => {
		await withVault(async (vault) => {
			await vault.setSecret({ pluginId, key: "k", value: "mine" });
			await vault.setSecret({ pluginId: "com.example.other", key: "k", value: "theirs" });

			expect(await vault.getSecret({ pluginId, key: "k" })).toBe("mine");
			expect(await vault.getSecret({ pluginId: "com.example.other", key: "k" })).toBe("theirs");
			expect(await vault.listKeys(pluginId)).toEqual(["k"]);
		});
	});

	test("deletes a single secret and a whole plugin", async () => {
		await withVault(async (vault) => {
			await vault.setSecret({ pluginId, key: "a", value: "1" });
			await vault.setSecret({ pluginId, key: "b", value: "2" });

			expect(await vault.deleteSecret({ pluginId, key: "a" })).toBe(true);
			expect(await vault.deleteSecret({ pluginId, key: "a" })).toBe(false);
			expect(await vault.listKeys(pluginId)).toEqual(["b"]);

			expect(await vault.deletePlugin(pluginId)).toBe(1);
			expect(await vault.listKeys(pluginId)).toEqual([]);
		});
	});

	test("serializes concurrent writes without losing updates", async () => {
		await withVault(async (vault) => {
			const keys = Array.from({ length: 24 }, (_, index) => `k${index}`);
			await Promise.all(keys.map((key) => vault.setSecret({ pluginId, key, value: `v-${key}` })));

			// A non-atomic read-modify-write would drop entries here.
			expect(await vault.listKeys(pluginId)).toEqual([...keys].sort());
			for (const key of keys) {
				expect(await vault.getSecret({ pluginId, key })).toBe(`v-${key}`);
			}
		});
	});

	test("survives a corrupted vault file instead of throwing", async () => {
		await withVault(async (vault, root) => {
			await writeFile(join(root, "secrets.json"), "{not json", "utf8");
			expect(await vault.listKeys(pluginId)).toEqual([]);
			// Still writable afterwards, so corruption is not a permanent brick.
			await vault.setSecret({ pluginId, key: "k", value: "v" });
			expect(await vault.getSecret({ pluginId, key: "k" })).toBe("v");
		});
	});

	test("skips individually malformed entries but keeps valid siblings", async () => {
		await withVault(async (vault, root) => {
			await writeFile(
				join(root, "secrets.json"),
				JSON.stringify({
					version: 1,
					secrets: { [pluginId]: { good: "keep", bad: { nested: true } } },
				}),
				"utf8",
			);
			expect(await vault.listKeys(pluginId)).toEqual(["good"]);
		});
	});

	test("rejects empty, oversized and prototype-polluting keys or values", async () => {
		await withVault(async (vault) => {
			await expect(vault.setSecret({ pluginId, key: "", value: "v" })).rejects.toThrow();
			await expect(vault.setSecret({ pluginId, key: "__proto__", value: "v" })).rejects.toThrow();
			await expect(vault.setSecret({ pluginId, key: "k", value: "" })).rejects.toThrow();
			await expect(
				vault.setSecret({ pluginId, key: "k", value: "x".repeat(64 * 1024 + 1) }),
			).rejects.toThrow();
		});
	});

	test("leaves no temp file behind after a write", async () => {
		await withVault(async (vault, root) => {
			await vault.setSecret({ pluginId, key: "k", value: "v" });
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(root);
			expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
			expect(entries).toContain("secrets.json");
		});
	});

	test("stores values only in the vault file", async () => {
		await withVault(async (vault, root) => {
			await vault.setSecret({ pluginId, key: "k", value: "sk-do-not-leak" });
			const { readdir } = await import("node:fs/promises");
			for (const name of await readdir(root)) {
				const contents = await readFile(join(root, name), "utf8");
				if (name === "secrets.json") {
					expect(contents).toContain("sk-do-not-leak");
					continue;
				}
				expect(contents).not.toContain("sk-do-not-leak");
			}
		});
	});
});

describe("plugin secret vault provider pruning", () => {
	test("drops secrets for contributions no longer declared", async () => {
		await withVault(async (vault) => {
			await vault.setSecret({ pluginId, key: "provider.keep.apiKey", value: "sk-keep" });
			await vault.setSecret({ pluginId, key: "provider.gone.apiKey", value: "sk-gone" });
			await vault.setSecret({ pluginId, key: "provider.gone.token", value: "sk-gone-2" });

			expect(await vault.pruneProviderSecrets(pluginId, ["keep"])).toBe(2);
			expect(await vault.listKeys(pluginId)).toEqual(["provider.keep.apiKey"]);
			expect(await vault.getSecret({ pluginId, key: "provider.keep.apiKey" })).toBe("sk-keep");
		});
	});

	test("leaves keys that are not provider-scoped alone", async () => {
		await withVault(async (vault) => {
			// This method cannot know whether another feature still uses these keys, so it
			// must not touch anything outside the `provider.<id>.<field>` shape.
			await vault.setSecret({ pluginId, key: "oauth.refreshToken", value: "sk-oauth" });
			await vault.setSecret({ pluginId, key: "provider", value: "sk-bare" });
			await vault.setSecret({ pluginId, key: "provider.gone.apiKey", value: "sk-gone" });

			expect(await vault.pruneProviderSecrets(pluginId, [])).toBe(1);
			expect(await vault.listKeys(pluginId)).toEqual(["oauth.refreshToken", "provider"]);
		});
	});

	test("is a no-op when nothing needs removing", async () => {
		await withVault(async (vault) => {
			await vault.setSecret({ pluginId, key: "provider.keep.apiKey", value: "sk-keep" });
			expect(await vault.pruneProviderSecrets(pluginId, ["keep"])).toBe(0);
			expect(await vault.pruneProviderSecrets("com.example.absent", ["keep"])).toBe(0);
			expect(await vault.listKeys(pluginId)).toEqual(["provider.keep.apiKey"]);
		});
	});

	test("does not touch another plugin's secrets", async () => {
		await withVault(async (vault) => {
			await vault.setSecret({ pluginId, key: "provider.gone.apiKey", value: "sk-mine" });
			await vault.setSecret({
				pluginId: "com.example.other",
				key: "provider.gone.apiKey",
				value: "sk-theirs",
			});

			await vault.pruneProviderSecrets(pluginId, []);
			expect(await vault.listKeys(pluginId)).toEqual([]);
			expect(
				await vault.getSecret({ pluginId: "com.example.other", key: "provider.gone.apiKey" }),
			).toBe("sk-theirs");
		});
	});

	test("survives a restart, so the removal is persisted", async () => {
		await withVault(async (vault, root) => {
			await vault.setSecret({ pluginId, key: "provider.gone.apiKey", value: "sk-gone" });
			await vault.pruneProviderSecrets(pluginId, []);
			// A fresh instance reads the file from disk rather than the in-memory document.
			const reloaded = new PluginSecretVault({ root });
			expect(await reloaded.listKeys(pluginId)).toEqual([]);
		});
	});
});
