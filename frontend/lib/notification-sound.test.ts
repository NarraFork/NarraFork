import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getToken, setToken } from "./api";
import {
	DEFAULT_SOUND_MAX_CONCURRENT,
	getActiveSoundCount,
	playBuiltinSound,
	playCustomSound,
	resetActiveSoundCount,
	resolveMaxConcurrent,
	resolveVolumeMultiplier,
} from "./notification-sound";

describe("notification sound playback", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	test("clears stale token when custom sound fetch returns unauthorized", async () => {
		const store = new Map<string, string>();
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => {
					store.set(key, value);
				},
				removeItem: (key: string) => {
					store.delete(key);
				},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response("", {
					status: 401,
					statusText: "Unauthorized",
				}),
			configurable: true,
		});

		setToken("stale-token");
		expect(getToken()).toBe("stale-token");

		await playCustomSound("/api/notification-sounds/sound-id");

		expect(getToken()).toBeNull();
		// A failed fetch must not leak the reserved concurrency slot.
		expect(getActiveSoundCount()).toBe(0);
	});
});

describe("volume + concurrency resolution", () => {
	test("volume percentage maps to a clamped 0..1 multiplier", () => {
		expect(resolveVolumeMultiplier(100)).toBe(1);
		expect(resolveVolumeMultiplier(50)).toBe(0.5);
		expect(resolveVolumeMultiplier(0)).toBe(0);
		expect(resolveVolumeMultiplier(-20)).toBe(0);
		expect(resolveVolumeMultiplier(500)).toBe(1);
	});

	test("missing or invalid volume falls back to full volume", () => {
		expect(resolveVolumeMultiplier(undefined)).toBe(1);
		expect(resolveVolumeMultiplier(null)).toBe(1);
		expect(resolveVolumeMultiplier(Number.NaN)).toBe(1);
	});

	test("concurrency limit is clamped into the supported range", () => {
		expect(resolveMaxConcurrent(1)).toBe(1);
		expect(resolveMaxConcurrent(10)).toBe(10);
		expect(resolveMaxConcurrent(0)).toBe(1);
		expect(resolveMaxConcurrent(999)).toBe(10);
		expect(resolveMaxConcurrent(undefined)).toBe(DEFAULT_SOUND_MAX_CONCURRENT);
		expect(resolveMaxConcurrent(Number.NaN)).toBe(DEFAULT_SOUND_MAX_CONCURRENT);
	});
});

// Built-in playback runs through a fake AudioContext whose oscillators never
// fire "ended", so every started sound keeps holding its concurrency slot. That
// models the real problem: a burst of notifications arriving while sounds are
// still playing.
describe("built-in sound concurrency limit", () => {
	const g = globalThis as typeof globalThis & { AudioContext?: unknown };
	const originalAudioContext = g.AudioContext;
	let started = 0;
	let lastGainValue = 0;

	class FakeAudioContext {
		state = "running";
		currentTime = 0;
		destination = {};
		resume() {}
		createGain() {
			const gain = {
				value: 0,
				setValueAtTime: () => {},
				linearRampToValueAtTime: () => {},
			};
			return {
				get gain() {
					return gain;
				},
				connect: () => {},
				disconnect: () => {},
			};
		}
		createOscillator() {
			return {
				type: "sine" as OscillatorType,
				frequency: { value: 0 },
				connect: (node: { gain: { value: number } }) => {
					lastGainValue = node.gain.value;
				},
				addEventListener: () => {},
				disconnect: () => {},
				start: () => {
					started += 1;
				},
				stop: () => {},
			};
		}
	}

	beforeEach(() => {
		started = 0;
		lastGainValue = 0;
		resetActiveSoundCount();
		Object.defineProperty(g, "AudioContext", { value: FakeAudioContext, configurable: true });
	});

	afterEach(() => {
		resetActiveSoundCount();
		if (originalAudioContext === undefined) Reflect.deleteProperty(g, "AudioContext");
		else
			Object.defineProperty(g, "AudioContext", {
				value: originalAudioContext,
				configurable: true,
			});
	});

	test("drops sounds beyond the configured limit", () => {
		for (let i = 0; i < 5; i++) {
			playBuiltinSound("gentle", { maxConcurrent: 2 });
		}
		// "gentle" has 3 notes, so exactly 2 admitted sounds => 6 oscillators.
		expect(getActiveSoundCount()).toBe(2);
		expect(started).toBe(6);
	});

	test("a limit of 1 lets only one sound through", () => {
		playBuiltinSound("gentle", { maxConcurrent: 1 });
		playBuiltinSound("gentle", { maxConcurrent: 1 });
		expect(getActiveSoundCount()).toBe(1);
		expect(started).toBe(3);
	});

	test("bypassLimit ignores the cap (settings preview)", () => {
		playBuiltinSound("gentle", { maxConcurrent: 1 });
		playBuiltinSound("gentle", { maxConcurrent: 1, bypassLimit: true });
		expect(started).toBe(6);
	});

	test("zero volume plays nothing and reserves no slot", () => {
		playBuiltinSound("gentle", { volume: 0, maxConcurrent: 2 });
		expect(started).toBe(0);
		expect(getActiveSoundCount()).toBe(0);
	});

	test("volume scales the oscillator gain", () => {
		playBuiltinSound("gentle", { volume: 50, maxConcurrent: 2 });
		expect(lastGainValue).toBeCloseTo(0.15, 5);
	});

	// A built-in sound that never reports completion (a suspended AudioContext with
	// no user gesture yet would do this for real) must not hold its slot for the
	// generic unknown-duration ceiling: two such failures would otherwise mute all
	// notifications for many seconds. The slot is bounded by the sound's own length.
	test("a sound that never signals completion frees its slot on its own timescale", async () => {
		playBuiltinSound("gentle", { maxConcurrent: 1 });
		playBuiltinSound("gentle", { maxConcurrent: 1 });
		// The second one was dropped: the first still holds the only slot.
		expect(getActiveSoundCount()).toBe(1);
		expect(started).toBe(3);

		// "gentle" is 3 notes of 150ms x {1, 1, 1.5} plus a 20ms gap each = 545ms,
		// and the slot adds a 500ms grace, so it is released well before 2s. It is
		// still held at 200ms, proving the release is not immediate either.
		await Bun.sleep(200);
		expect(getActiveSoundCount()).toBe(1);

		await Bun.sleep(1_400);
		expect(getActiveSoundCount()).toBe(0);
		// With the slot free, a later notification is audible again.
		playBuiltinSound("gentle", { maxConcurrent: 1 });
		expect(started).toBe(6);
	});
});
