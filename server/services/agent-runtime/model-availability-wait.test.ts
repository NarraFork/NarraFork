import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	FOLLOW_DEFAULT_MODEL,
	reloadSettings,
	resolveEffectiveModel,
	saveSettings,
	settings,
	subscribeSettingsChanges,
} from "../../lib/settings";
import {
	type ModelAvailabilityWaitTarget,
	waitForModelAvailabilityOrChange,
} from "./model-availability-wait";

function harness(listeners = new Set<() => void>()) {
	const target: ModelAvailabilityWaitTarget = { abortController: new AbortController() };
	let changed = false;
	let current = true;
	let pollSignal: AbortSignal | undefined;
	let finish!: (value: "available" | "aborted") => void;
	const start = () =>
		waitForModelAvailabilityOrChange({
			target,
			isCurrent: () => current,
			hasModelChanged: () => changed,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			wait: (signal) => {
				pollSignal = signal;
				return new Promise<"available" | "aborted">((resolve) => {
					finish = resolve;
					if (signal.aborted) resolve("aborted");
					else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
				});
			},
		});
	return {
		target,
		listeners,
		start,
		change: () => {
			changed = true;
		},
		expire: () => {
			current = false;
		},
		finish: () => finish("available"),
		pollSignal: () => pollSignal,
		emit: () => {
			for (const listener of listeners) listener();
		},
	};
}

describe("model availability wait", () => {
	test("concrete model switch cancels polling, not the turn; repeated events are harmless", async () => {
		const h = harness();
		const result = h.start();
		h.change();
		h.target._modelUnavailableWaitCancel?.();
		h.emit();
		h.emit();
		expect(await result).toBe("changed");
		expect(h.target.abortController.signal.aborted).toBe(false);
		expect(h.pollSignal()?.aborted).toBe(true);
		expect(h.listeners.size).toBe(0);
		expect(h.target._modelUnavailableWaitCancel).toBeUndefined();
	});

	test("default changes wake every follower but leave fixed models waiting", async () => {
		const listeners = new Set<() => void>();
		const followers = [harness(listeners), harness(listeners)];
		const fixed = harness(listeners);
		const results = followers.map((h) => h.start());
		const fixedResult = fixed.start();
		for (const h of followers) h.change();
		fixed.emit();
		expect(await Promise.all(results)).toEqual(["changed", "changed"]);
		expect(fixed.pollSignal()?.aborted).toBe(false);
		expect(listeners.size).toBe(1);
		fixed.finish();
		expect(await fixedResult).toBe("available");
		expect(listeners.size).toBe(0);
	});

	test("switch before registration is not lost", async () => {
		const h = harness();
		h.change();
		expect(await h.start()).toBe("changed");
		expect(h.listeners.size).toBe(0);
	});

	test("real abort takes precedence over a model change", async () => {
		const h = harness();
		const result = h.start();
		h.change();
		h.emit();
		h.target.abortController.abort();
		expect(await result).toBe("aborted");
		expect(h.listeners.size).toBe(0);
	});

	test("already aborted turn and expired owner never resume", async () => {
		const aborted = harness();
		aborted.target.abortController.abort();
		expect(await aborted.start()).toBe("aborted");
		const stale = harness();
		stale.expire();
		expect(await stale.start()).toBe("aborted");
		const expired = harness();
		const result = expired.start();
		expired.expire();
		expired.finish();
		expect(await result).toBe("aborted");
		expect(expired.listeners.size).toBe(0);
	});

	test("expired owner is released by the next settings event", async () => {
		const h = harness();
		const result = h.start();
		h.expire();
		h.emit();
		expect(await result).toBe("aborted");
		expect(h.listeners.size).toBe(0);
	});

	test("subscription failure clears installed callback", async () => {
		const target: ModelAvailabilityWaitTarget = { abortController: new AbortController() };
		await expect(
			waitForModelAvailabilityOrChange({
				target,
				isCurrent: () => true,
				hasModelChanged: () => false,
				subscribe: () => {
					throw new Error("subscribe failed");
				},
				wait: async () => "available",
			}),
		).rejects.toThrow("subscribe failed");
		expect(target._modelUnavailableWaitCancel).toBeUndefined();
	});

	test("poller failure cleans callback, subscription and abort listener", async () => {
		const target: ModelAvailabilityWaitTarget = { abortController: new AbortController() };
		let cleaned = false;
		let signal: AbortSignal | undefined;
		await expect(
			waitForModelAvailabilityOrChange({
				target,
				isCurrent: () => true,
				hasModelChanged: () => false,
				subscribe: () => () => {
					cleaned = true;
				},
				wait: async (value) => {
					signal = value;
					throw new Error("poll failed");
				},
			}),
		).rejects.toThrow("poll failed");
		expect(cleaned).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(target._modelUnavailableWaitCancel).toBeUndefined();
	});
});

describe("persisted settings notification integration", () => {
	test("save and reload wake all default followers but not a fixed model", async () => {
		const original = structuredClone(settings);
		const next = structuredClone(settings);
		next.agent.defaultModel = "openai:wait-test-old";
		saveSettings(next);
		const start = (ref: string) => {
			const target: ModelAvailabilityWaitTarget = { abortController: new AbortController() };
			const initial = resolveEffectiveModel(ref);
			const result = waitForModelAvailabilityOrChange({
				target,
				isCurrent: () => true,
				hasModelChanged: () => resolveEffectiveModel(ref) !== initial,
				subscribe: subscribeSettingsChanges,
				wait: (signal) =>
					new Promise<"aborted">((resolve) => {
						if (signal.aborted) resolve("aborted");
						else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
					}),
			});
			return { target, result };
		};
		const followers = [start(FOLLOW_DEFAULT_MODEL), start(FOLLOW_DEFAULT_MODEL)];
		const fixed = start("openai:wait-test-old");
		try {
			next.agent.defaultModel = "openai:wait-test-new";
			saveSettings(next);
			expect(await Promise.all(followers.map((h) => h.result))).toEqual(["changed", "changed"]);
			expect(fixed.target._modelUnavailableWaitCancel).toBeDefined();
			// Disk now contains new; simulate stale in-memory state and reload it.
			settings.agent.defaultModel = "openai:wait-test-stale";
			const reloaded = start(FOLLOW_DEFAULT_MODEL);
			reloadSettings();
			expect(await reloaded.result).toBe("changed");
			expect(resolveEffectiveModel(FOLLOW_DEFAULT_MODEL)).toBe("openai:wait-test-new");
		} finally {
			for (const h of [...followers, fixed]) h.target.abortController.abort();
			await fixed.result;
			saveSettings(original);
		}
	});
});

// Source-level guards supplement behavioral tests without loading the live DB/session runtime.
describe("model wait runtime wiring", () => {
	test("shared primary/subagent orchestrator listens to settings and compares default resolution", () => {
		const source = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
		expect(source).toContain('profile.kind === "subagent"');
		expect(source).toContain("const turnModelRef = active._modelRef;");
		expect(source).toContain("subscribe: subscribeSettingsChanges");
		expect(source).toContain(
			"resolveEffectiveModel(turnModelRef, active.provider) !== turnEffectiveModel",
		);
		expect(source).toContain("isCurrent: () => active.alive && owner.isCurrent()");
	});
	test("explicit model update notifies the wait only after replacing runtime model", () => {
		const source = readFileSync(new URL("../narrator-session.ts", import.meta.url), "utf8");
		const update = source.slice(source.indexOf("export function updateNarratorModel("));
		expect(update.indexOf("active.model = effectiveModel;")).toBeLessThan(
			update.indexOf("active._modelUnavailableWaitCancel?.();"),
		);
	});
});
