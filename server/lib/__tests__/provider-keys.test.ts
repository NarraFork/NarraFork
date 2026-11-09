import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNarraforkPath } from "../narrafork-home";
import { getProviderKeyStore, ProviderKeyStore } from "../provider-keys";
import { readSecretJSON } from "../secret-store";
import { saveSettings, settings } from "../settings";
import {
	absorbProviderKeys,
	COMMAND_CODE_KEY_OWNER,
	nugKeyOwner,
	platformInstanceKeyOwner,
	searchKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../settings/provider-keys-projection";
import type {
	CustomApiProviderConfig,
	NarraForkSettings,
	NUGProviderConfig,
} from "../settings/types";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore() {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-provider-keys-"));
	dirs.push(dir);
	const path = join(dir, "provider-keys.json");
	return { path, store: new ProviderKeyStore(path) };
}

const provider = (id: string, apiKey: string): CustomApiProviderConfig => ({
	id,
	name: `Provider ${id}`,
	prefix: `p${id}`,
	apiKey,
	baseUrl: "https://api.example.com/v1",
	defaultModel: "m",
	protocol: "completions-compatible",
});

const nug = (id: string, apiKey: string): NUGProviderConfig => ({
	id,
	name: `NUG ${id}`,
	prefix: `n${id}`,
	apiKey,
	baseUrl: "http://127.0.0.1:7790",
	defaultModel: "m",
});

describe("provider key store", () => {
	test("first-key sync creates under the provider id, replaces, and clears only when asked", () => {
		const { store } = freshStore();
		expect(store.syncFirstKeys([{ id: "prov1", apiKey: "sk-1" }], { clearOnEmpty: true })).toBe(
			true,
		);
		expect(store.list("prov1").map((k) => [k.id, k.apiKey])).toEqual([["prov1", "sk-1"]]);

		store.add("prov1", { apiKey: "sk-2", label: "backup" });
		store.syncFirstKeys([{ id: "prov1", apiKey: "sk-1b" }], { clearOnEmpty: true });
		expect(store.list("prov1").map((k) => k.apiKey)).toEqual(["sk-1b", "sk-2"]);

		// Settings read back from disk carry no key: that must not delete anything.
		store.syncFirstKeys([{ id: "prov1", apiKey: "" }], { clearOnEmpty: false });
		expect(store.list("prov1")).toHaveLength(2);
		// Clearing the field in settings removes the first key; the next one moves up.
		store.syncFirstKeys([{ id: "prov1", apiKey: "" }], { clearOnEmpty: true });
		expect(store.firstKey("prov1")).toBe("sk-2");
	});

	test("reorder, disable and a new secret reviving an invalid key", () => {
		const { store } = freshStore();
		const a = store.add("p", { apiKey: "a" });
		const b = store.add("p", { apiKey: "b" });
		store.reorder("p", [b.id]);
		expect(store.list("p").map((k) => k.id)).toEqual([b.id, a.id]);
		store.update(a.id, { disabled: true, disabledReason: "invalid" });
		expect(store.get(a.id)?.disabledReason).toBe("invalid");
		store.update(a.id, { apiKey: "a2" });
		expect(store.get(a.id)?.disabled).toBeUndefined();
	});

	test("persists encrypted, reloads, and never overwrites a file it cannot read", () => {
		const { path, store } = freshStore();
		store.add("p", { apiKey: "sk-secret" });
		expect(readFileSync(path, "utf8")).not.toContain("sk-secret");
		expect(new ProviderKeyStore(path).firstKey("p")).toBe("sk-secret");

		const foreign = JSON.stringify({
			format: "narrafork.secret.v1",
			cipher: "aes-256-gcm",
			iv: "x",
			tag: "x",
			data: "x",
		});
		writeFileSync(path, foreign);
		const broken = new ProviderKeyStore(path);
		expect(broken.readable).toBe(false);
		expect(() => broken.add("p", { apiKey: "k" })).toThrow();
		expect(broken.syncFirstKeys([{ id: "p", apiKey: "k" }], { clearOnEmpty: true })).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(foreign);
	});
});

describe("settings projection", () => {
	test("settings.json keeps no key; memory shows the first key and follows the store", () => {
		const saved = structuredClone(settings.customApiProviders);
		try {
			saveSettings({ ...settings, customApiProviders: [provider("projA", "sk-projected")] });
			const disk = JSON.parse(readFileSync(getNarraforkPath("settings.json"), "utf8"));
			expect(JSON.stringify(disk)).not.toContain("sk-projected");
			expect(disk.customApiProviders[0].apiKey).toBe("");
			expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-projected");
			expect(settings.openaiProviders?.find((p) => p.id === "projA")?.apiKey).toBe("sk-projected");
			const stored = readSecretJSON(getNarraforkPath("provider-keys.json")) as Array<{
				id: string;
				apiKey: string;
			}>;
			expect(stored.find((k) => k.id === "projA")?.apiKey).toBe("sk-projected");

			// Removing the first key in the key list promotes the next one everywhere.
			const store = getProviderKeyStore();
			store.add("projA", { apiKey: "sk-second" });
			store.remove("projA");
			expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-second");
		} finally {
			saveSettings({ ...settings, customApiProviders: saved });
			getProviderKeyStore().removeProvider("projA");
		}
	});

	test("NUG, TokenDance, Command Code and search keys leave settings.json too", () => {
		const saved = {
			nugProviders: structuredClone(settings.nugProviders),
			tokendance: structuredClone(settings.tokendance),
			commandCode: structuredClone(settings.commandCode),
			search: structuredClone(settings.search),
		};
		const search = settings.search ?? { channels: [], customProviders: [] };
		try {
			saveSettings({
				...settings,
				nugProviders: [nug("nugA", "sk-nug")],
				tokendance: { apiKey: "sk-td", disabled: false, generation: 1 },
				commandCode: { apiKey: "sk-cc" },
				search: {
					...search,
					customProviders: [
						{ id: "srchA", name: "S", protocol: "tavily", baseUrl: "", apiKey: "sk-srch" },
						{ id: "srchB", name: "No key", protocol: "tavily", baseUrl: "" },
					],
				},
			});
			const text = readFileSync(getNarraforkPath("settings.json"), "utf8");
			for (const secret of ["sk-nug", "sk-td", "sk-cc", "sk-srch"]) {
				expect(text).not.toContain(secret);
			}
			const disk = JSON.parse(text);
			expect(disk.commandCode).not.toHaveProperty("apiKey");
			expect(disk.search.customProviders[0]).not.toHaveProperty("apiKey");

			expect(settings.nugProviders?.[0]?.apiKey).toBe("sk-nug");
			expect(settings.tokendance?.apiKey).toBe("sk-td");
			expect(settings.commandCode?.apiKey).toBe("sk-cc");
			expect(settings.search?.customProviders[0]?.apiKey).toBe("sk-srch");
			// An optional key that was never set stays absent, not "".
			expect(settings.search?.customProviders[1]).not.toHaveProperty("apiKey");

			const store = getProviderKeyStore();
			expect(store.firstKey(nugKeyOwner("nugA"))).toBe("sk-nug");
			expect(store.firstKey(TOKENDANCE_KEY_OWNER)).toBe("sk-td");
			expect(store.firstKey(COMMAND_CODE_KEY_OWNER)).toBe("sk-cc");
			expect(store.firstKey(searchKeyOwner("srchA"))).toBe("sk-srch");

			// Clearing a key in settings clears it in the store; deleting an entry drops its key.
			saveSettings({
				...settings,
				nugProviders: [],
				tokendance: { apiKey: "", disabled: false, generation: 2 },
				search: { ...search, customProviders: [] },
			});
			expect(store.list(nugKeyOwner("nugA"))).toEqual([]);
			expect(store.list(TOKENDANCE_KEY_OWNER)).toEqual([]);
			expect(store.list(searchKeyOwner("srchA"))).toEqual([]);
			expect(store.firstKey(COMMAND_CODE_KEY_OWNER)).toBe("sk-cc");
		} finally {
			saveSettings({ ...settings, ...saved });
			const store = getProviderKeyStore();
			for (const owner of [
				nugKeyOwner("nugA"),
				TOKENDANCE_KEY_OWNER,
				COMMAND_CODE_KEY_OWNER,
				searchKeyOwner("srchA"),
			]) {
				store.removeProvider(owner);
			}
		}
	});

	test("平台实例的密钥按实例 id 存进 key store，删掉实例即删掉密钥", () => {
		const saved = structuredClone(settings.agent?.platformInstances);
		const instance = {
			id: "platform-inst",
			platform: "CommandCode" as const,
			suffix: "2",
			prefix: "cc-2",
			disabled: false,
			config: { apiKey: "sk-inst" },
		};
		try {
			saveSettings({ ...settings, agent: { ...settings.agent, platformInstances: [instance] } });
			const text = readFileSync(getNarraforkPath("settings.json"), "utf8");
			expect(text).not.toContain("sk-inst");
			expect(JSON.parse(text).agent.platformInstances[0].config).not.toHaveProperty("apiKey");
			// 内存里仍是可用的真实密钥，读单字段的代码不需要改。
			expect(settings.agent.platformInstances?.[0]?.config.apiKey).toBe("sk-inst");
			const store = getProviderKeyStore();
			expect(store.firstKey(platformInstanceKeyOwner("platform-inst"))).toBe("sk-inst");

			saveSettings({ ...settings, agent: { ...settings.agent, platformInstances: [] } });
			expect(store.list(platformInstanceKeyOwner("platform-inst"))).toEqual([]);
		} finally {
			saveSettings({ ...settings, agent: { ...settings.agent, platformInstances: saved } });
			getProviderKeyStore().removeProvider(platformInstanceKeyOwner("platform-inst"));
		}
	});

	test("keys still in settings.json move into the store on load", () => {
		const loaded = {
			customApiProviders: [provider("legacyA", "sk-legacy")],
		} as NarraForkSettings;
		try {
			expect(absorbProviderKeys(loaded)).toBe(true);
			expect(getProviderKeyStore().firstKey("legacyA")).toBe("sk-legacy");
			// Next load: the file no longer has the key, and memory still does.
			const reloaded = {
				customApiProviders: [provider("legacyA", "")],
			} as NarraForkSettings;
			expect(absorbProviderKeys(reloaded)).toBe(false);
			expect(reloaded.customApiProviders?.[0]?.apiKey).toBe("sk-legacy");
		} finally {
			getProviderKeyStore().removeProvider("legacyA");
		}
	});

	test("legacy single keys move on load, and a file without them keeps memory intact", () => {
		const loaded = {
			nugProviders: [nug("legacyN", "sk-n")],
			tokendance: { apiKey: "sk-t", disabled: false, generation: 0 },
			commandCode: { apiKey: "sk-c" },
			search: {
				channels: [],
				customProviders: [{ id: "legacyS", name: "S", protocol: "x", baseUrl: "", apiKey: "sk-s" }],
			},
		} as unknown as NarraForkSettings;
		const owners = [
			nugKeyOwner("legacyN"),
			TOKENDANCE_KEY_OWNER,
			COMMAND_CODE_KEY_OWNER,
			searchKeyOwner("legacyS"),
		];
		const store = getProviderKeyStore();
		const before = owners.map((owner) => store.list(owner).map((key) => ({ ...key })));
		try {
			expect(absorbProviderKeys(loaded)).toBe(true);
			expect(owners.map((owner) => store.firstKey(owner))).toEqual([
				"sk-n",
				"sk-t",
				"sk-c",
				"sk-s",
			]);
			const reloaded = {
				nugProviders: [nug("legacyN", "")],
				tokendance: { apiKey: "", disabled: false, generation: 0 },
				commandCode: {},
				search: {
					channels: [],
					customProviders: [{ id: "legacyS", name: "S", protocol: "x", baseUrl: "" }],
				},
			} as unknown as NarraForkSettings;
			expect(absorbProviderKeys(reloaded)).toBe(false);
			expect(reloaded.nugProviders?.[0]?.apiKey).toBe("sk-n");
			expect(reloaded.tokendance?.apiKey).toBe("sk-t");
			expect(reloaded.commandCode?.apiKey).toBe("sk-c");
			expect(reloaded.search?.customProviders[0]?.apiKey).toBe("sk-s");
		} finally {
			owners.forEach((owner, index) => {
				store.removeProvider(owner);
				for (const key of before[index] ?? []) store.add(owner, key);
			});
		}
	});
});
