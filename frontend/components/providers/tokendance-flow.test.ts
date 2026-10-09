import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "../../lib/api";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import { createSnapshot, providersStateFromSettings } from "./providers-reducer";
import {
	claimTokenDanceDraft,
	clearTokenDanceFlow,
	completeTokenDanceCallback,
	setTokenDanceDraftOwner,
	startTokenDanceLogin,
	TOKENDANCE_FLOW_MARKER,
	tokenDanceCallbackUrl,
	tokenDanceDraftSnapshot,
} from "./tokendance-flow";

const state = providersStateFromSettings({ customApiProviders: [], nugProviders: [], agent: {} });
const snapshot = tokenDanceDraftSnapshot(state, createSnapshot(state));
const cleanup: Array<() => void> = [];
let storage: Map<string, string>;
let assigned: string[];
function patch(key: string, value: unknown) {
	const old = Object.getOwnPropertyDescriptor(globalThis, key);
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	cleanup.push(() =>
		old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key),
	);
}
beforeEach(() => {
	setTokenDanceDraftOwner(undefined);
	setTokenDanceDraftOwner("alice");
	storage = new Map();
	assigned = [];
	const location = {
		origin: "https://self.example",
		href: "https://self.example/nf/settings/providers",
		pathname: "/nf/settings/providers",
		search: "",
		assign: (url: string) => {
			assigned.push(url);
		},
	};
	patch("location", location);
	patch("document", { baseURI: "https://self.example/nf/" });
	patch("window", {
		location,
		history: {
			state: { router: true },
			replaceState: (_state: unknown, _title: string, url: string) => {
				location.pathname = url;
				location.search = "";
			},
		},
	});
	patch("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storage.set(key, value);
		},
		removeItem: (key: string) => {
			storage.delete(key);
		},
	});
	const start = spyOn(api, "tokenDanceOAuthStart").mockResolvedValue({
		flowId: "random-flow",
		authorizeUrl: "https://tokendance.space/authorize",
		expiresAt: Date.now() + 60_000,
	});
	const cancel = spyOn(api, "tokenDanceOAuthCancel").mockResolvedValue({ ok: true });
	cleanup.push(
		() => start.mockRestore(),
		() => cancel.mockRestore(),
	);
});
afterEach(() => {
	clearTokenDanceFlow("random-flow");
	for (const undo of cleanup.splice(0).reverse()) undo();
});
describe("TokenDance same-tab security and claim lifecycle", () => {
	test("callback uses actual origin and app mount, storage contains only random flow ID", async () => {
		await startTokenDanceLogin(snapshot);
		expect(tokenDanceCallbackUrl()).toBe(
			"https://self.example/nf/settings/providers/tokendance/callback",
		);
		expect([...storage]).toEqual([[TOKENDANCE_FLOW_MARKER, "random-flow"]]);
		expect(assigned).toEqual(["https://tokendance.space/authorize"]);
		expect(api.tokenDanceOAuthStart).toHaveBeenCalledWith({
			callbackUrl: tokenDanceCallbackUrl(),
			draftSnapshot: snapshot,
		});
	});
	test("navigation failure cancels pending flow and preserves input snapshot", async () => {
		window.location.assign = () => {
			throw new Error("blocked");
		};
		const before = JSON.stringify(snapshot);
		await expect(startTokenDanceLogin(snapshot)).rejects.toThrow("navigation failed");
		expect(api.tokenDanceOAuthCancel).toHaveBeenCalledWith("random-flow");
		expect(storage.size).toBe(0);
		expect(JSON.stringify(snapshot)).toBe(before);
	});
	test("start rejection, including backend snapshot bounds, leaves page and marker untouched", async () => {
		spyOn(api, "tokenDanceOAuthStart").mockRejectedValue(new Error("snapshot too large"));
		await expect(startTokenDanceLogin(snapshot)).rejects.toThrow();
		expect(assigned).toEqual([]);
		expect(storage.size).toBe(0);
	});
	for (const outcome of ["success", "failure", "denied", "mismatch"] as const)
		test(`callback ${outcome} clears query before complete and sends code once under StrictMode`, async () => {
			await startTokenDanceLogin(snapshot);
			const complete = spyOn(api, "tokenDanceOAuthComplete").mockImplementation(async () => {
				expect(window.location.search).toBe("");
				if (outcome === "failure") throw new Error("upstream secret: must never show");
				return { connected: true, modelsRefreshed: true };
			});
			cleanup.push(() => complete.mockRestore());
			Object.assign(window.location, {
				pathname: "/nf/settings/providers/tokendance/callback",
				search: `?state=${outcome === "mismatch" ? "wrong-flow" : "random-flow"}${outcome === "denied" ? "&error=access_denied" : "&code=opaque-code"}&key=must-strip`,
			});
			const first = completeTokenDanceCallback();
			const second = completeTokenDanceCallback();
			expect(first).toBe(second);
			expect(await first).toBe(outcome === "success");
			expect(complete).toHaveBeenCalledTimes(
				outcome === "success" || outcome === "failure" ? 1 : 0,
			);
			expect(window.location.search).toBe("");
			expect([...storage]).toEqual([[TOKENDANCE_FLOW_MARKER, "random-flow"]]);
		});
	test("restore promise is deduplicated, fresh settings precede claim, pending cancellation follows", async () => {
		const calls: string[] = [];
		const settings = spyOn(api, "getSettings").mockImplementation(async () => {
			calls.push("settings");
			return {};
		});
		const restore = spyOn(api, "tokenDanceDraftRestore").mockImplementation(async () => {
			calls.push("restore");
			return { status: "pending", draftSnapshot: snapshot };
		});
		const cancel = spyOn(api, "tokenDanceOAuthCancel").mockImplementation(async () => {
			calls.push("cancel");
			return {};
		});
		cleanup.push(
			() => settings.mockRestore(),
			() => restore.mockRestore(),
			() => cancel.mockRestore(),
		);
		const first = claimTokenDanceDraft("random-flow", "alice");
		const second = claimTokenDanceDraft("random-flow", "alice");
		expect(first).toBe(second);
		expect((await first).restore.draftSnapshot).toEqual(snapshot);
		expect(calls).toEqual(["settings", "restore", "cancel"]);
		expect(restore).toHaveBeenCalledTimes(1);
	});
	test("Alice's completed claim is not reused after Bob signs in with the same flow marker", async () => {
		const settings = spyOn(api, "getSettings").mockResolvedValue({});
		const restore = spyOn(api, "tokenDanceDraftRestore").mockResolvedValue({
			status: "completed",
			draftSnapshot: { ...snapshot, addPage: { draft: { apiKey: "alice-secret" } } },
		});
		cleanup.push(
			() => settings.mockRestore(),
			() => restore.mockRestore(),
		);
		expect(
			(await claimTokenDanceDraft("random-flow", "alice")).restore.draftSnapshot?.addPage,
		).toEqual({ draft: { apiKey: "alice-secret" } });
		setTokenDanceDraftOwner("bob");
		restore.mockRejectedValue(new Error("owner forbidden"));
		await expect(claimTokenDanceDraft("random-flow", "bob")).rejects.toThrow("owner forbidden");
		expect(restore).toHaveBeenCalledTimes(2);
	});
	for (const nextOwner of [undefined, "bob"])
		test(`an in-flight Alice claim is discarded on logout/actor change (${nextOwner ?? "logout"})`, async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const settings = spyOn(api, "getSettings").mockResolvedValue({});
			const restore = spyOn(api, "tokenDanceDraftRestore").mockImplementation(async () => {
				await gate;
				return {
					status: "completed",
					draftSnapshot: { ...snapshot, addPage: { draft: { apiKey: "alice-secret" } } },
				};
			});
			cleanup.push(
				() => settings.mockRestore(),
				() => restore.mockRestore(),
			);
			const pending = claimTokenDanceDraft("random-flow", "alice");
			const result = pending.then(
				(value) => ({ value, error: undefined }),
				(error) => ({ value: undefined, error }),
			);
			await Promise.resolve();
			setTokenDanceDraftOwner(nextOwner);
			release();
			const settled = await result;
			expect(settled.value).toBeUndefined();
			expect(settled.error).toBeInstanceOf(Error);
			expect(settled.error.message).toContain("owner changed");
		});
	test("snapshot serializes sets, preserves other key edits and excludes platform credentials", () => {
		const local = {
			...state,
			tokendance: { apiKey: "never-copy", backendKey: "never-copy" },
			hiddenModels: new Set(["other:model"]),
		};
		const value = tokenDanceDraftSnapshot(local, createSnapshot(state), {
			draft: { apiKey: "other-input" },
		});
		expect(value.draft.hiddenModels).toEqual(["other:model"]);
		expect(JSON.stringify(value)).not.toContain("never-copy");
		expect(value.addPage?.draft).toEqual({ apiKey: "other-input" });
	});
	test("English/Chinese recovery and action labels have matching keys", () => {
		expect(Object.keys(en.tokendance).sort()).toEqual(Object.keys(zh.tokendance).sort());
		for (const value of [...Object.values(en.tokendance), ...Object.values(zh.tokendance)])
			expect(value.trim()).not.toBe("");
	});
});
