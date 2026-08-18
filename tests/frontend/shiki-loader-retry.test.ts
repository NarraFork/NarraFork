/**
 * `cacheSuccessfulResult` — why a failed Shiki load must not be cached.
 *
 * The bug this fixes: `getCore()` and `loadShiki()` both stored their result in a
 * MODULE-level variable, including `null` from a failed attempt. Nothing ever
 * cleared it, so a single transient failure (a cold PWA start where the inlined
 * Oniguruma WASM chunk times out, a flaky mobile network) disabled syntax
 * highlighting for the rest of the session. And because the failure path renders
 * a plain `<Code>` block, there was no error to see — the app just looked like it
 * had decided that file needed no colours. Fully restarting the PWA was the only
 * cure, which is the signature of cached module state rather than a network fault.
 *
 * Every assertion here is invisible in the happy path: nothing observable changes
 * until a load fails, so a regression would only ever surface as a user
 * restarting the app to get their colours back.
 */

import { describe, expect, test } from "bun:test";
import { cacheSuccessfulResult } from "../../frontend/lib/shiki-loader";

/** A settable module-level slot, mirroring `corePromise` / `shikiPromise`. */
function makeSlot<T>() {
	let slot: Promise<T | null> | null = null;
	return {
		read: () => slot,
		write: (promise: Promise<T | null> | null) => {
			slot = promise;
		},
		get current() {
			return slot;
		},
	};
}

describe("cacheSuccessfulResult", () => {
	test("caches a successful result and never restarts the work", async () => {
		const slot = makeSlot<string>();
		let starts = 0;
		const start = () => {
			starts++;
			return Promise.resolve("core");
		};

		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBe("core");
		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBe("core");
		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBe("core");

		// Single-flight must be preserved: re-creating the highlighter core per code
		// block would be far worse than the bug being fixed.
		expect(starts).toBe(1);
		expect(slot.current).not.toBeNull();
	});

	// The regression itself.
	test("a null result is evicted so the next call retries", async () => {
		const slot = makeSlot<string>();
		let starts = 0;
		const start = () => {
			starts++;
			return Promise.resolve(starts === 1 ? null : "core");
		};

		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBeNull();
		// The eviction is what makes the retry reachable at all.
		expect(slot.current).toBeNull();

		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBe("core");
		expect(starts).toBe(2);
	});

	test("recovers after several consecutive failures", async () => {
		const slot = makeSlot<string>();
		let starts = 0;
		const start = () => {
			starts++;
			return Promise.resolve(starts < 4 ? null : "core");
		};

		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBeNull();
		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBeNull();
		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBeNull();
		// A failure streak must not become permanent — that was the whole bug.
		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBe("core");
		expect(starts).toBe(4);
	});

	// `getCore` maps its own rejection to null, but this helper also guards
	// `loadShiki`, whose body can reject on an unexpected error. A rejected promise
	// left in the slot would be re-thrown to every later caller forever.
	test("a rejected attempt is evicted too", async () => {
		const slot = makeSlot<string>();
		let starts = 0;
		const start = () => {
			starts++;
			return starts === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("core");
		};

		await expect(cacheSuccessfulResult(slot.read, slot.write, start)).rejects.toThrow("boom");
		// Let the eviction callback run before asserting the slot is clear.
		await Promise.resolve();
		expect(slot.current).toBeNull();

		expect(await cacheSuccessfulResult(slot.read, slot.write, start)).toBe("core");
	});

	test("concurrent callers share one attempt", async () => {
		const slot = makeSlot<string>();
		let starts = 0;
		const start = () => {
			starts++;
			return Promise.resolve("core");
		};

		const [a, b, c] = await Promise.all([
			cacheSuccessfulResult(slot.read, slot.write, start),
			cacheSuccessfulResult(slot.read, slot.write, start),
			cacheSuccessfulResult(slot.read, slot.write, start),
		]);

		expect([a, b, c]).toEqual(["core", "core", "core"]);
		expect(starts).toBe(1);
	});

	/**
	 * Eviction compares promise IDENTITY before clearing. Without that check, a
	 * failure resolving late would wipe the slot a newer successful attempt had
	 * already installed — turning the fix into an intermittent version of the same
	 * bug, which is strictly harder to diagnose than the original.
	 */
	test("a late failure does not evict a newer successful attempt", async () => {
		const slot = makeSlot<string>();
		let releaseFirst: (value: string | null) => void = () => {};
		const first = new Promise<string | null>((resolve) => {
			releaseFirst = resolve;
		});

		const firstCall = cacheSuccessfulResult(slot.read, slot.write, () => first);

		// Simulate the first attempt having been evicted (as a failure would be) and
		// a second, successful attempt taking its place.
		slot.write(null);
		const second = await cacheSuccessfulResult(slot.read, slot.write, () =>
			Promise.resolve("core"),
		);
		expect(second).toBe("core");
		const cachedAfterSuccess = slot.current;

		// Now the stale first attempt fails.
		releaseFirst(null);
		await firstCall;
		await Promise.resolve();

		expect(slot.current).toBe(cachedAfterSuccess);
		expect(slot.current).not.toBeNull();
	});
});
