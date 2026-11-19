import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { isPoolCooldownActive, poolFailureState, selectPoolEntry } from "../credential-pool";

const entries = [
	{ id: "a", priority: 2, tier: 0 },
	{ id: "b", priority: 1, tier: 1 },
	{ id: "c", priority: 1, tier: 0 },
];

const now = 100_000;
afterEach(() => mock.restore());

describe("shared credential selection", () => {
	test("priority chooses the lowest number and preserves tie order and identity", () => {
		expect(selectPoolEntry(entries, { now })).toBe(entries[1]);
		expect(entries.map(({ id }) => id)).toEqual(["a", "b", "c"]);
	});

	test("disabled, archived and already tried credentials never participate", () => {
		expect(
			selectPoolEntry(
				[
					{ id: "disabled", priority: 0, disabled: true },
					{ id: "archived", priority: 0, archivedAt: 1 },
					...entries,
				],
				{ now, exclude: new Set(["b"]) },
			)?.id,
		).toBe("c");
		expect(selectPoolEntry(entries, { now, exclude: new Set(["a", "b", "c"]) })).toBeUndefined();
	});

	test("a healthy affinity wins over priority or tier but never overrides exclusion", () => {
		expect(selectPoolEntry(entries, { now, stickyId: "a" })).toBe(entries[0]);
		expect(selectPoolEntry(entries, { now, stickyId: "a", exclude: new Set(["a"]) })).toBe(
			entries[1],
		);
	});

	test("balanced ignores priority and can choose every available credential", () => {
		const random = spyOn(Math, "random");
		for (let i = 0; i < entries.length; i++) {
			random.mockReturnValue((i + 0.5) / entries.length);
			expect(selectPoolEntry(entries, { now, mode: "balanced" })).toBe(entries[i]);
		}
	});

	test("tier-balanced randomizes only within the best service-supplied tier", () => {
		const random = spyOn(Math, "random").mockReturnValue(0);
		const options = {
			now,
			mode: "tier-balanced" as const,
			tierRank: (entry: (typeof entries)[number]) => entry.tier,
		};
		expect(selectPoolEntry(entries, options)).toBe(entries[0]);
		random.mockReturnValue(0.9);
		expect(selectPoolEntry(entries, options)).toBe(entries[2]);
		expect(selectPoolEntry(entries, { ...options, stickyId: "b" })).toBe(entries[1]);
	});

	test("cooling credentials cannot retain affinity while another is ready", () => {
		const cooldownUntil = (entry: (typeof entries)[number]) =>
			entry.id === "a" ? now + 10 : undefined;
		expect(selectPoolEntry(entries, { now, stickyId: "a", cooldownUntil })).toBe(entries[1]);
		expect(selectPoolEntry(entries, { now: now + 10, stickyId: "a", cooldownUntil })).toBe(
			entries[0],
		);
	});

	test("only key pools fall back to the earliest cooling credential", () => {
		const cooldownUntil = (entry: (typeof entries)[number]) => now + (entry.id === "c" ? 10 : 20);
		expect(selectPoolEntry(entries, { now, cooldownUntil })).toBeUndefined();
		expect(
			selectPoolEntry(entries, { now, cooldownUntil, stickyId: "a", fallbackToCooling: true }),
		).toBe(entries[2]);
		expect(
			selectPoolEntry(entries, {
				now,
				cooldownUntil,
				exclude: new Set(["c"]),
				fallbackToCooling: true,
			}),
		).toBe(entries[0]);
	});

	test("empty or disabled-only pools have no fallback", () => {
		expect(selectPoolEntry([], { now, fallbackToCooling: true })).toBeUndefined();
		expect(
			selectPoolEntry([{ id: "off", priority: 0, disabled: true }], {
				now,
				fallbackToCooling: true,
			}),
		).toBeUndefined();
	});
});

describe("shared credential health decisions", () => {
	test("consecutive failures disable exactly at the configured threshold", () => {
		expect(poolFailureState({ kind: "failure" }, 1, 3, now)).toEqual({ failureCount: 2 });
		expect(poolFailureState({ kind: "failure" }, 2, 3, now)).toEqual({
			failureCount: 3,
			disabledReason: "too_many_failures",
		});
	});

	test("rejected and banned credentials require explicit recovery", () => {
		for (const kind of ["invalid", "banned"] as const) {
			expect(poolFailureState({ kind }, 0, 3, now)).toEqual({
				failureCount: 3,
				disabledReason: kind,
			});
		}
	});

	test("quota exhaustion preserves an unknown reset instead of inventing one", () => {
		expect(poolFailureState({ kind: "quota", resetsAt: now + 500 }, 0, 3, now)).toEqual({
			failureCount: 3,
			disabledReason: "quota_exhausted",
			quotaResetsAt: now + 500,
		});
		expect(poolFailureState({ kind: "quota" }, 0, 3, now).quotaResetsAt).toBeUndefined();
	});

	test("temporary failures retain their reason without permanently disabling a key", () => {
		for (const reason of ["quota", "forbidden", "rate_limited"] as const) {
			expect(poolFailureState({ kind: "cooldown", reason, ms: 500 }, 0, 3, now)).toEqual({
				failureCount: 0,
				cooldown: { reason, until: now + 500 },
			});
		}
		expect(isPoolCooldownActive(now + 500, now + 499)).toBe(true);
		expect(isPoolCooldownActive(now + 500, now + 500)).toBe(false);
		expect(isPoolCooldownActive(undefined, now)).toBe(false);
	});
});
