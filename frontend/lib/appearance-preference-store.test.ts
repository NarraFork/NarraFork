import { describe, expect, test } from "bun:test";
import {
	APPEARANCE_KEYS,
	appearanceDefinition,
	isAccountAppearanceValues,
} from "@shared/appearance-preferences";
import { type AppearancePatch, AppearancePreferenceStore } from "./appearance-preference-store";

function fixture() {
	const entries = new Map<string, string>();
	const storage = {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => {
			entries.set(key, value);
		},
	};
	const writes: AppearancePatch[] = [];
	const store = new AppearancePreferenceStore(() => storage);
	const send = async (patch: AppearancePatch) => {
		writes.push(structuredClone(patch));
	};
	const prefs = { terminalFontSize: 14, wordWrapCode: true, appearancePreferences: {} };
	return { entries, storage, writes, store, send, prefs };
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("appearance preference scopes", () => {
	test("defaults preserve existing scopes, and merely loading never uploads", async () => {
		const f = fixture();
		f.entries.set("narrafork_oled", "true");
		f.store.hydrate("alice", f.prefs, f.send);
		for (const key of APPEARANCE_KEYS)
			expect(f.store.isSynced(key)).toBe(appearanceDefinition(key).defaultSync);
		expect(f.store.get("narrafork_oled")).toBe(true);
		expect(f.store.get("terminalFontSize")).toBe(14);
		await f.store.flush();
		expect(f.writes).toEqual([]);
	});

	test("existing account value wins on opt-in, including false and zero", async () => {
		const f = fixture();
		f.entries.set("narrafork_oled", "true");
		f.store.hydrate(
			"alice",
			{ ...f.prefs, appearancePreferences: { narrafork_oled: false, narrafork_blur_in_ms: 0 } },
			f.send,
		);
		f.store.setCustomEnabled(true);
		f.store.setSynced("narrafork_oled", true);
		f.store.setSynced("narrafork_blur_in_ms", true);
		expect(f.store.get("narrafork_oled")).toBe(false);
		expect(f.store.get("narrafork_blur_in_ms")).toBe(0);
		await f.store.flush();
		expect(f.writes).toEqual([]);
	});

	test("explicitly opting in seeds a missing account key, then writes only changed keys", async () => {
		const f = fixture();
		f.entries.set("narrafork_oled", "true");
		f.store.hydrate("alice", f.prefs, f.send);
		f.store.setCustomEnabled(true);
		f.store.setSynced("narrafork_oled", true);
		await f.store.flush();
		expect(f.writes).toEqual([{ appearancePreferences: { narrafork_oled: true } }]);
		f.store.set("narrafork_oled", false);
		await f.store.flush();
		expect(f.writes[1]).toEqual({ appearancePreferences: { narrafork_oled: false } });
		expect(f.entries.get("narrafork_oled")).toBe("false");
	});

	test("off restores defaults, on restores choices and independent local values", async () => {
		const f = fixture();
		f.store.hydrate("alice", f.prefs, f.send);
		f.store.setCustomEnabled(true);
		f.store.setSynced("terminalFontSize", false);
		f.store.set("terminalFontSize", 23);
		expect(f.store.get("terminalFontSize")).toBe(23);
		f.store.setCustomEnabled(false);
		expect(f.store.isSynced("terminalFontSize")).toBe(true);
		expect(f.store.get("terminalFontSize")).toBe(14);
		f.store.setCustomEnabled(true);
		expect(f.store.isSynced("terminalFontSize")).toBe(false);
		expect(f.store.get("terminalFontSize")).toBe(23);
		await f.store.flush();
		expect(f.writes).toEqual([]);
		const reloaded = new AppearancePreferenceStore(() => f.storage);
		reloaded.hydrate("alice", f.prefs, f.send);
		expect(reloaded.customEnabled).toBe(true);
		expect(reloaded.get("terminalFontSize")).toBe(23);
	});

	test("editing default account values does not overwrite a remembered independent local value", async () => {
		const f = fixture();
		f.store.hydrate("alice", f.prefs, f.send);
		f.store.setCustomEnabled(true);
		f.store.setSynced("terminalFontSize", false);
		f.store.set("terminalFontSize", 23);
		f.store.setCustomEnabled(false);
		f.store.set("terminalFontSize", 16);
		await f.store.flush();
		expect(f.store.get("terminalFontSize")).toBe(16);
		f.store.setCustomEnabled(true);
		expect(f.store.get("terminalFontSize")).toBe(23);
	});

	test("synced remote updates affect the value; local overrides remain independent", () => {
		const f = fixture();
		f.store.hydrate("alice", f.prefs, f.send);
		f.store.hydrate("alice", { ...f.prefs, terminalFontSize: 18 }, f.send);
		expect(f.store.get("terminalFontSize")).toBe(18);
		f.store.setCustomEnabled(true);
		f.store.setSynced("terminalFontSize", false);
		f.store.hydrate("alice", { ...f.prefs, terminalFontSize: 26 }, f.send);
		expect(f.store.get("terminalFontSize")).toBe(18);
	});

	test("fixed scopes cannot be changed; read-only state cannot edit policies", () => {
		const f = fixture();
		f.store.setCustomEnabled(true);
		expect(f.store.customEnabled).toBe(false);
		f.store.hydrate("alice", f.prefs, f.send);
		f.store.setSynced("narrafork_oled", true);
		expect(f.store.isSynced("narrafork_oled")).toBe(false);
		f.store.setCustomEnabled(true);
		f.store.setSynced("narrafork_wakelock", true);
		f.store.setSynced("language", false);
		expect(f.store.isSynced("narrafork_wakelock")).toBe(false);
		expect(f.store.isSynced("language")).toBe(true);
	});

	test("existing mutation payloads route local display overrides without altering unrelated data", async () => {
		const f = fixture();
		f.store.hydrate("alice", f.prefs, f.send);
		f.store.setCustomEnabled(true);
		f.store.setSynced("terminalFontSize", false);
		const rest = f.store.splitPatch({
			terminalFontSize: 22,
			wordWrapCode: false,
			notifyOnDone: false,
			language: "zh-CN",
		});
		expect(rest).toEqual({ notifyOnDone: false, language: "zh-CN" });
		await f.store.flush();
		expect(f.writes).toEqual([{ wordWrapCode: false }]);
		expect(f.store.get("terminalFontSize")).toBe(22);
	});
});

describe("appearance synchronization resilience", () => {
	test("failed writes retain effective values, do not loop, and retry explicitly", async () => {
		const f = fixture();
		let attempts = 0;
		f.store.hydrate("alice", f.prefs, async () => {
			attempts++;
			throw new Error("offline");
		});
		f.store.set("terminalFontSize", 20);
		await f.store.flush();
		expect(attempts).toBe(1);
		expect(f.store.error).toBeInstanceOf(Error);
		expect(f.store.get("terminalFontSize")).toBe(20);
		f.store.hydrate("alice", f.prefs, f.send);
		expect(f.store.get("terminalFontSize")).toBe(20);
		expect(f.writes).toEqual([]);
		f.store.retry();
		await f.store.flush();
		expect(f.writes).toEqual([{ terminalFontSize: 20 }]);
		expect(f.store.error).toBeNull();
	});

	test("rapid edits are serialized, newer pending edits survive an older success", async () => {
		const f = fixture();
		const gate = deferred();
		f.store.hydrate("alice", f.prefs, async (patch) => {
			f.writes.push(patch);
			if (f.writes.length === 1) await gate.promise;
		});
		f.store.set("terminalFontSize", 20);
		await Promise.resolve();
		f.store.set("terminalFontSize", 24);
		f.store.hydrate("alice", f.prefs, f.send);
		expect(f.store.get("terminalFontSize")).toBe(24);
		gate.resolve();
		await f.store.flush();
		expect(f.writes).toEqual([{ terminalFontSize: 20 }, { terminalFontSize: 24 }]);
		expect(f.store.get("terminalFontSize")).toBe(24);
	});

	test("another tab's old same-value acknowledgement cannot discard this tab's newer ABA edit", async () => {
		const f = fixture();
		const other = new AppearancePreferenceStore(() => f.storage);
		const first = deferred();
		const second = deferred();
		const aWrites: number[] = [];
		const bWrites: number[] = [];
		let accountValue = 14;
		f.store.hydrate("alice", f.prefs, async (patch) => {
			const value = patch.terminalFontSize as number;
			aWrites.push(value);
			await first.promise;
			accountValue = value;
		});
		other.hydrate("alice", f.prefs, async (patch) => {
			const value = patch.terminalFontSize as number;
			bWrites.push(value);
			if (bWrites.length === 1) await second.promise;
			accountValue = value;
		});
		f.store.set("terminalFontSize", 20);
		await Promise.resolve();
		other.set("terminalFontSize", 24);
		await Promise.resolve();
		expect(aWrites).toEqual([20]);
		expect(bWrites).toEqual([24]);
		// Both earlier PATCHes are already in flight; this 20 is a new operation.
		other.set("terminalFontSize", 20);
		first.resolve();
		await f.store.flush();
		other.onStorage("narrafork_appearance_sync_v1:/:alice");
		second.resolve();
		await other.flush();
		expect(aWrites).toEqual([20]);
		expect(bWrites).toEqual([24, 20]);
		expect(accountValue).toBe(20);
		expect(other.get("terminalFontSize")).toBe(20);
	});

	test("an old-account completion cannot update or send edits as the new account", async () => {
		const f = fixture();
		const gate = deferred();
		let oldSignal: AbortSignal | undefined;
		f.store.hydrate("alice", f.prefs, async (_patch, signal) => {
			oldSignal = signal;
			await gate.promise;
		});
		f.store.set("terminalFontSize", 20);
		await Promise.resolve();
		f.store.hydrate("bob", { ...f.prefs, terminalFontSize: 12 }, f.send);
		expect(oldSignal?.aborted).toBe(true);
		gate.resolve();
		await f.store.flush();
		expect(f.store.get("terminalFontSize")).toBe(12);
		expect(f.writes).toEqual([]);
	});

	test("account mirrors are never imported as another user's legacy values", () => {
		const f = fixture();
		f.entries.set("narrafork_oled", "true");
		f.store.hydrate("alice", f.prefs, f.send);
		expect(f.store.get("narrafork_oled")).toBe(true);
		f.store.hydrate("bob", f.prefs, f.send);
		expect(f.store.get("narrafork_oled")).toBe(false);
		f.store.hydrate("alice", f.prefs, f.send);
		expect(f.store.get("narrafork_oled")).toBe(true);
	});

	test("same-origin storage events update policies and independent values without a page reload", () => {
		const f = fixture();
		const other = new AppearancePreferenceStore(() => f.storage);
		f.store.hydrate("alice", f.prefs, f.send);
		other.hydrate("alice", f.prefs, f.send);
		f.store.setCustomEnabled(true);
		f.store.setSynced("terminalFontSize", false);
		f.store.set("terminalFontSize", 21);
		other.onStorage("narrafork_appearance_sync_v1:/:alice");
		expect(other.customEnabled).toBe(true);
		expect(other.isSynced("terminalFontSize")).toBe(false);
		expect(other.get("terminalFontSize")).toBe(21);
	});

	test("unrelated tab edits are merged even before storage events are delivered", () => {
		const f = fixture();
		const other = new AppearancePreferenceStore(() => f.storage);
		f.store.hydrate("alice", f.prefs, f.send);
		other.hydrate("alice", f.prefs, f.send);
		f.store.set("narrafork_oled", true);
		other.set("narrafork_advanced_anim", false);
		f.store.onStorage("narrafork_appearance_sync_v1:/:alice");
		expect(f.store.get("narrafork_oled")).toBe(true);
		expect(f.store.get("narrafork_advanced_anim")).toBe(false);
	});

	test("invalid caches and unavailable localStorage remain bounded and usable", () => {
		const f = fixture();
		f.entries.set(
			"narrafork_appearance_sync_v1:/:alice",
			JSON.stringify({
				customEnabled: true,
				values: { terminalFontSize: 100000, narrafork_oled: "false" },
			}),
		);
		f.store.hydrate("alice", f.prefs, f.send);
		expect(f.store.get("terminalFontSize")).toBe(14);
		expect(f.store.get("narrafork_oled")).toBe(false);
		const unavailable = new AppearancePreferenceStore(() => {
			throw new Error("disabled");
		});
		unavailable.hydrate("alice", f.prefs, f.send);
		unavailable.setCustomEnabled(true);
		unavailable.setSynced("terminalFontSize", false);
		unavailable.set("terminalFontSize", 22);
		expect(unavailable.get("terminalFontSize")).toBe(22);
	});

	test("account JSON accepts only bounded formerly-local presentation values", () => {
		expect(isAccountAppearanceValues({ narrafork_oled: false, narrafork_blur_in_ms: 0 })).toBe(
			true,
		);
		for (const invalid of [
			null,
			[],
			{ terminalFontSize: 14 },
			{ narrafork_fullscreen: true },
			{ unknown: true },
			{ narrafork_oled: "true" },
			{ narrafork_blur_in_ms: 2001 },
			{ pluginTheme: "x".repeat(257) },
		]) {
			expect(isAccountAppearanceValues(invalid)).toBe(false);
		}
	});
});
