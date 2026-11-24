import { afterEach, describe, expect, test } from "bun:test";
import type { BooleanOverride } from "../../lib/boolean-override";
import type { NarraForkEvent, NarraForkEventType } from "../../lib/event-bus";
import { executionPrincipalOf } from "../../lib/runtime-source";
import {
	createNarratorFastModeResolver,
	type NarratorFastModeDependencies,
	type NarratorFastModeRow,
	type ResolvedNarratorFastMode,
} from "../narrator-fast-mode";

class TestEvents {
	private listeners = new Map<string, Set<(event: never) => void>>();

	on<T extends NarraForkEventType>(
		type: T,
		handler: (event: Extract<NarraForkEvent, { type: T }>) => void,
	) {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(handler as (event: never) => void);
	}

	off<T extends NarraForkEventType>(
		type: T,
		handler: (event: Extract<NarraForkEvent, { type: T }>) => void,
	) {
		this.listeners.get(type)?.delete(handler as (event: never) => void);
	}

	emit(event: NarraForkEvent) {
		for (const listener of this.listeners.get(event.type) ?? []) listener(event as never);
	}

	get listenerCount() {
		return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}
}

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

function primary(
	override: unknown = "inherit",
	userId: string | null = "alice",
): NarratorFastModeRow {
	return { type: "primary", fastModeOverride: override, ownerUserId: userId };
}

function child(override: unknown = "inherit", rootId: string | null = "root"): NarratorFastModeRow {
	return { type: "subagent", fastModeOverride: override, aclRootNarratorId: rootId };
}

function registration(userId: string | null) {
	return { version: 1, run: { logicalRunId: "run", principal: { userId } } };
}

function harness(overrides: Partial<NarratorFastModeDependencies> = {}) {
	const rows = new Map<string, NarratorFastModeRow>([
		["root", primary()],
		["child", child()],
	]);
	const preferences = new Map<string, boolean>([
		["alice", true],
		["bob", false],
	]);
	const active = new Map<string, string | null | undefined>();
	const narratorReads = new Map<string, number>();
	const userReads = new Map<string, number>();
	const events = new TestEvents();
	const loadNarrator = async (id: string) => {
		narratorReads.set(id, (narratorReads.get(id) ?? 0) + 1);
		return structuredClone(rows.get(id));
	};
	const loadUserDefault = async (id: string) => {
		userReads.set(id, (userReads.get(id) ?? 0) + 1);
		return preferences.get(id) ?? false;
	};
	const resolver = createNarratorFastModeResolver({
		events,
		loadNarrator,
		loadUserDefault,
		getActivePrincipal: (id) => active.get(id),
		getPersistedPrincipal: (row) => executionPrincipalOf(row)?.userId,
		...overrides,
	});
	disposers.push(resolver.dispose);
	return {
		...resolver,
		rows,
		preferences,
		active,
		narratorReads,
		userReads,
		events,
		changeNarrator(id: string, row: NarratorFastModeRow) {
			rows.set(id, row);
			events.emit({ type: "narrator:fast_mode_changed", narratorId: id });
		},
		changeUser(id: string, value: boolean) {
			preferences.set(id, value);
			events.emit({ type: "user:fast_mode_default_changed", userId: id });
		},
	};
}

const enabled: ResolvedNarratorFastMode = {
	effectiveFastMode: true,
	fastModeSource: "primary",
	fastModeSourceNarratorId: "root",
};
const disabled: ResolvedNarratorFastMode = { ...enabled, effectiveFastMode: false };

function deferred<T>() {
	return Promise.withResolvers<T>();
}

describe("narrator fast mode inheritance", () => {
	for (const root of ["inherit", "on", "off"] as const) {
		for (const own of ["inherit", "on", "off"] as const) {
			test(`root ${root}, child ${own}: each explicit override wins`, async () => {
				const h = harness();
				h.rows.set("root", primary(root));
				h.rows.set("child", child(own));
				const effective = own === "inherit" ? root !== "off" : own === "on";
				expect(await h.resolveNarratorFastMode("child")).toEqual({
					effectiveFastMode: effective,
					fastModeSource: own === "inherit" ? "primary" : "override",
					fastModeSourceNarratorId: own === "inherit" ? "root" : null,
				});
				if (own !== "inherit") {
					expect(h.narratorReads.has("root")).toBe(false);
					expect(h.userReads.size).toBe(0);
				}
			});
		}
	}

	test("a child stays independent and resumes the root's current value on inherit", async () => {
		const h = harness();
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		h.changeNarrator("child", child("off"));
		h.changeNarrator("root", primary("on"));
		h.changeUser("alice", false);
		expect((await h.resolveNarratorFastMode("child")).effectiveFastMode).toBe(false);
		expect(h.narratorReads.get("root")).toBe(1);
		h.changeNarrator("child", child("inherit"));
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		h.changeNarrator("root", primary("inherit"));
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		expect(await h.resolveNarratorFastMode("root")).toEqual({
			effectiveFastMode: false,
			fastModeSource: "user-default",
			fastModeSourceNarratorId: null,
		});
	});

	test("nested children use aclRootNarratorId, not another child's override or policy source", async () => {
		const h = harness();
		h.rows.set("middle", child("off"));
		h.rows.set("nested", { ...child(), ownerUserId: "bob" });
		expect(await h.resolveNarratorFastMode("nested")).toEqual(enabled);
		expect(h.narratorReads.has("middle")).toBe(false);
		expect(h.userReads.has("bob")).toBe(false);
	});

	test("stored on/off remain explicit and legacy boolean mirrors are ignored", async () => {
		const h = harness();
		h.rows.set("child", { ...child("off"), ...{ fastMode: true } });
		expect((await h.resolveNarratorFastMode("child")).effectiveFastMode).toBe(false);
		h.changeNarrator("child", { ...child(null), ...{ fastMode: false } });
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
	});

	test("fork primaries follow their own override and execution owner", async () => {
		const h = harness();
		h.rows.set("fork", { ...primary("inherit", "bob"), aclRootNarratorId: "root" });
		expect((await h.resolveNarratorFastMode("fork")).effectiveFastMode).toBe(false);
		expect(h.narratorReads.has("root")).toBe(false);
		h.changeNarrator("root", primary("on"));
		expect((await h.resolveNarratorFastMode("fork")).effectiveFastMode).toBe(false);
	});
});

describe("fast mode identity and lifecycle", () => {
	test("active principal wins; undefined falls back to durable principal then owner", async () => {
		const h = harness();
		h.rows.set("root", { ...primary(), runtimeRegistrationJson: registration("bob") });
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		h.active.set("root", "alice");
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		h.active.delete("root");
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		h.rows.set("root", primary());
		h.events.emit({ type: "narrator:execution_principal_changed", narratorId: "root" });
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
	});

	test("active and persistent anonymous identities never fall back to owner", async () => {
		const h = harness();
		h.active.set("root", null);
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		expect(h.userReads.size).toBe(0);
		h.active.delete("root");
		h.rows.set("root", { ...primary(), runtimeRegistrationJson: registration(null) });
		h.events.emit({ type: "narrator:execution_principal_changed", narratorId: "root" });
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		h.changeNarrator("root", { ...primary("on"), runtimeRegistrationJson: registration(null) });
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
	});

	test("root missing, deleted, subagent or absent is unavailable only for inherited children", async () => {
		for (const root of [undefined, child("on")]) {
			const h = harness();
			if (root) h.rows.set("root", root);
			else h.rows.delete("root");
			expect(await h.resolveNarratorFastMode("child")).toEqual({
				effectiveFastMode: false,
				fastModeSource: "unavailable",
				fastModeSourceNarratorId: null,
			});
			h.changeNarrator("child", child("on"));
			expect((await h.resolveNarratorFastMode("child")).effectiveFastMode).toBe(true);
		}
		const h = harness();
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		h.rows.delete("root");
		h.events.emit({ type: "narrator:deleted", narratorId: "root", title: null });
		expect((await h.resolveNarratorFastMode("child")).fastModeSource).toBe("unavailable");
		h.changeNarrator("child", child("on", null));
		expect((await h.resolveNarratorFastMode("child")).effectiveFastMode).toBe(true);
		h.changeNarrator("child", child("inherit", null));
		expect((await h.resolveNarratorFastMode("child")).fastModeSource).toBe("unavailable");
	});

	test("root deletion refreshes cached ACL roots changed by ON DELETE SET NULL", async () => {
		const h = harness();
		await h.resolveNarratorFastMode("child");
		h.rows.delete("root");
		h.rows.set("child", child("inherit", null));
		h.events.emit({ type: "narrator:deleted", narratorId: "root", title: null });
		h.rows.set("root", primary("on"));
		expect((await h.resolveNarratorFastMode("child")).fastModeSource).toBe("unavailable");
		expect(h.narratorReads.get("child")).toBe(2);
	});

	test("missing records are not negative-cached across creation or restoration", async () => {
		const h = harness();
		h.rows.delete("root");
		expect((await h.resolveNarratorFastMode("child")).fastModeSource).toBe("unavailable");
		h.rows.set("root", primary("on"));
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		expect(h.narratorReads.get("root")).toBe(2);
		expect((await h.resolveNarratorFastMode("new")).fastModeSource).toBe("unavailable");
		h.rows.set("new", primary("on"));
		expect((await h.resolveNarratorFastMode("new")).effectiveFastMode).toBe(true);
	});

	test("owner change and targeted auth invalidation refresh related facts", async () => {
		const h = harness();
		h.rows.set("other", primary("inherit", "bob"));
		await h.resolveNarratorFastMode("other");
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		h.rows.set("root", primary("inherit", "bob"));
		h.events.emit({ type: "narrator:access_changed", narratorId: "root", reason: "owner_changed" });
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		h.preferences.set("bob", true);
		h.events.emit({ type: "auth:changed", userId: "bob" });
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		expect(h.narratorReads.get("child")).toBe(1);
		h.events.emit({ type: "auth:changed" });
		expect(h.getCacheSizes()).toEqual({ narrators: 0, users: 0 });
	});
});

describe("fast mode cache efficiency", () => {
	test("1000 warm primary and child requests perform no additional reads", async () => {
		let principalParses = 0;
		const h = harness({
			getPersistedPrincipal: (row) => {
				principalParses++;
				return executionPrincipalOf(row)?.userId;
			},
		});
		await h.resolveNarratorFastMode("child");
		for (let i = 0; i < 1000; i++) {
			expect((await h.resolveNarratorFastMode(i % 2 ? "child" : "root")).effectiveFastMode).toBe(
				true,
			);
		}
		expect([...h.narratorReads]).toEqual([
			["child", 1],
			["root", 1],
		]);
		expect([...h.userReads]).toEqual([["alice", 1]]);
		expect(principalParses).toBe(1);
	});

	test("cold concurrent siblings share the same root and user single-flight", async () => {
		const rootLoaded = deferred<void>();
		const releaseRoot = deferred<void>();
		let rootReads = 0;
		let userReads = 0;
		const h = harness({
			loadNarrator: async (id) => {
				if (id !== "root") return child();
				rootReads++;
				rootLoaded.resolve();
				await releaseRoot.promise;
				return primary();
			},
			loadUserDefault: async () => {
				userReads++;
				return true;
			},
		});
		const results = Array.from({ length: 40 }, (_, index) =>
			h.resolveNarratorFastMode(`child-${index % 10}`),
		);
		await rootLoaded.promise;
		releaseRoot.resolve();
		expect((await Promise.all(results)).every((value) => value.effectiveFastMode)).toBe(true);
		expect(rootReads).toBe(1);
		expect(userReads).toBe(1);
	});

	test("targeted narrator and user events preserve unrelated warm facts", async () => {
		const h = harness();
		h.rows.set("other", primary("inherit", "bob"));
		h.rows.set("sibling", child("on"));
		await Promise.all([
			h.resolveNarratorFastMode("child"),
			h.resolveNarratorFastMode("other"),
			h.resolveNarratorFastMode("sibling"),
		]);
		h.changeUser("alice", false);
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		await h.resolveNarratorFastMode("other");
		await h.resolveNarratorFastMode("sibling");
		expect(h.narratorReads.get("root")).toBe(1);
		expect(h.narratorReads.get("child")).toBe(1);
		expect(h.narratorReads.get("other")).toBe(1);
		expect(h.narratorReads.get("sibling")).toBe(1);
		expect(h.userReads.get("bob")).toBe(1);
		h.changeNarrator("root", primary("on"));
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		expect(h.narratorReads.get("root")).toBe(2);
		expect(h.narratorReads.get("child")).toBe(1);
		expect(h.userReads.get("alice")).toBe(2);
	});

	test("default LRU limits are 1024 narrator facts and 256 user facts", async () => {
		const h = harness({
			loadNarrator: async (id) => primary("inherit", id),
			loadUserDefault: async () => false,
		});
		for (let index = 0; index < 1050; index++) await h.resolveNarratorFastMode(`n-${index}`);
		expect(h.getCacheSizes()).toEqual({ narrators: 1024, users: 256 });
	});

	test("LRU touches warm facts and reloads only evicted layers", async () => {
		const h = harness({ narratorCapacity: 3, userCapacity: 2 });
		h.rows.set("other", primary("inherit", "bob"));
		h.rows.set("third", primary("inherit", "charlie"));
		h.rows.set("fourth", primary("on"));
		await h.resolveNarratorFastMode("root");
		await h.resolveNarratorFastMode("other");
		await h.resolveNarratorFastMode("root");
		await h.resolveNarratorFastMode("third");
		await h.resolveNarratorFastMode("fourth");
		expect(h.getCacheSizes()).toEqual({ narrators: 3, users: 2 });
		await h.resolveNarratorFastMode("root");
		expect(h.narratorReads.get("root")).toBe(1);
		expect(h.userReads.get("alice")).toBe(1);
		await h.resolveNarratorFastMode("other");
		expect(h.narratorReads.get("other")).toBe(2);
		expect(h.userReads.get("bob")).toBe(2);
	});
});

describe("fast mode invalidation races", () => {
	test("an invalidated old read cannot refill cache or return as a new snapshot", async () => {
		const started = deferred<void>();
		const releaseOld = deferred<void>();
		let readCount = 0;
		const h = harness({
			loadNarrator: async () => {
				if (++readCount === 1) {
					started.resolve();
					await releaseOld.promise;
					return primary("off");
				}
				return primary("on");
			},
		});
		const oldRequest = h.resolveNarratorFastMode("root");
		await started.promise;
		h.events.emit({ type: "narrator:fast_mode_changed", narratorId: "root" });
		expect((await h.resolveNarratorFastMode("root")).effectiveFastMode).toBe(true);
		expect((await oldRequest).effectiveFastMode).toBe(true);
		releaseOld.resolve();
		await Promise.resolve();
		expect((await h.resolveNarratorFastMode("root")).effectiveFastMode).toBe(true);
		expect(readCount).toBe(2);
	});

	test("a child switched to independent on does not wait for its old root read", async () => {
		const started = deferred<void>();
		const releaseRoot = deferred<void>();
		let own: BooleanOverride = "inherit";
		const h = harness({
			loadNarrator: async (id) => {
				if (id === "child") return child(own);
				started.resolve();
				await releaseRoot.promise;
				return primary("off");
			},
		});
		const resolving = h.resolveNarratorFastMode("child");
		await started.promise;
		own = "on";
		h.events.emit({ type: "narrator:fast_mode_changed", narratorId: "child" });
		expect(await resolving).toEqual({
			effectiveFastMode: true,
			fastModeSource: "override",
			fastModeSourceNarratorId: null,
		});
		releaseRoot.resolve();
	});

	test("user invalidation during an old preference read forces a fresh snapshot", async () => {
		const started = deferred<void>();
		const releaseOld = deferred<void>();
		let reads = 0;
		const h = harness({
			loadUserDefault: async () => {
				if (++reads === 1) {
					started.resolve();
					await releaseOld.promise;
					return true;
				}
				return false;
			},
		});
		const resolving = h.resolveNarratorFastMode("child");
		await started.promise;
		h.events.emit({ type: "user:fast_mode_default_changed", userId: "alice" });
		expect(await resolving).toEqual(disabled);
		releaseOld.resolve();
		expect(await h.resolveNarratorFastMode("child")).toEqual(disabled);
		expect(reads).toBe(2);
	});

	test("active principal is rechecked after asynchronous user loading without an event", async () => {
		const started = deferred<void>();
		const releaseAlice = deferred<void>();
		const h = harness({
			loadUserDefault: async (id) => {
				if (id === "alice") {
					started.resolve();
					await releaseAlice.promise;
					return true;
				}
				return false;
			},
		});
		const resolving = h.resolveNarratorFastMode("child");
		await started.promise;
		h.active.set("root", "bob");
		releaseAlice.resolve();
		expect(await resolving).toEqual(disabled);
	});

	test("rapid consecutive invalidations always load the last committed facts", async () => {
		const h = harness();
		await h.resolveNarratorFastMode("child");
		for (const value of ["off", "on", "off", "on"] as const)
			h.changeNarrator("root", primary(value));
		expect(await h.resolveNarratorFastMode("child")).toEqual(enabled);
		expect(h.narratorReads.get("root")).toBe(2);
	});
});

describe("fast mode cancellation and cleanup", () => {
	test("a pre-aborted request starts no reads", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(h.resolveNarratorFastMode("root", { signal: controller.signal })).rejects.toThrow(
			"cancelled",
		);
		expect(h.narratorReads.size).toBe(0);
	});

	test("one cancelled waiter does not cancel a shared cold read", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		let sharedSignal: AbortSignal | undefined;
		let reads = 0;
		const h = harness({
			loadNarrator: async (_id, signal) => {
				reads++;
				sharedSignal = signal;
				started.resolve();
				await release.promise;
				return primary("on");
			},
		});
		const controller = new AbortController();
		const cancelled = h.resolveNarratorFastMode("root", { signal: controller.signal });
		const surviving = h.resolveNarratorFastMode("root");
		await started.promise;
		controller.abort(new Error("caller cancelled"));
		await expect(cancelled).rejects.toThrow("caller cancelled");
		expect(sharedSignal?.aborted).toBe(false);
		release.resolve();
		expect((await surviving).effectiveFastMode).toBe(true);
		expect(reads).toBe(1);
	});

	test("failed narrator or preference reads reject and retry instead of caching disabled", async () => {
		for (const failureLayer of ["narrator", "user"] as const) {
			let attempts = 0;
			const h = harness({
				loadNarrator: async () => {
					if (failureLayer === "narrator" && ++attempts === 1) throw new Error("read failed");
					return primary();
				},
				loadUserDefault: async () => {
					if (failureLayer === "user" && ++attempts === 1) throw new Error("read failed");
					return true;
				},
			});
			await expect(h.resolveNarratorFastMode("root")).rejects.toThrow("read failed");
			expect((await h.resolveNarratorFastMode("root")).effectiveFastMode).toBe(true);
			expect(attempts).toBe(2);
		}
	});

	test("timed-out loading cannot publish later and the next request retries", async () => {
		const release = deferred<void>();
		const sharedAborted = deferred<void>();
		let reads = 0;
		const h = harness({
			readTimeoutMs: 15,
			loadNarrator: async (_id, signal) => {
				if (++reads === 1) {
					signal.addEventListener("abort", () => sharedAborted.resolve(), { once: true });
					await release.promise;
					return primary("off");
				}
				return primary("on");
			},
		});
		await expect(h.resolveNarratorFastMode("root")).rejects.toThrow("timed out");
		await sharedAborted.promise;
		release.resolve();
		expect((await h.resolveNarratorFastMode("root")).effectiveFastMode).toBe(true);
		expect(reads).toBe(2);
	});

	test("reset clears facts; request count never adds event listeners; dispose is idempotent", async () => {
		const h = harness();
		expect(h.events.listenerCount).toBe(7);
		for (let index = 0; index < 100; index++) await h.resolveNarratorFastMode("child");
		expect(h.events.listenerCount).toBe(7);
		h.reset();
		expect(h.getCacheSizes()).toEqual({ narrators: 0, users: 0 });
		await h.resolveNarratorFastMode("child");
		expect(h.narratorReads.get("root")).toBe(2);
		h.dispose();
		h.dispose();
		expect(h.events.listenerCount).toBe(0);
		await expect(h.resolveNarratorFastMode("child")).rejects.toThrow("disposed");
	});
});
