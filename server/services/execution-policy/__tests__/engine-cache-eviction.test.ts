import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ReadQueryOptions } from "@server/db/worker-read";
import type { PathIdentity } from "@server/lib/agent/execution/backend";
import { targetPathSemantics } from "@server/lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "@server/lib/agent/types";
import { getSettingsRevision } from "@server/lib/settings";
import { ExecutionPolicyEngine } from "../engine";
import { normalizeExecutionPolicyRuleSet } from "../normalize";
import { executionPolicyRepository, type LoadedExecutionPolicy } from "../repository";
import type { ExecutionTargetContext } from "../types";

/**
 * Verify that a rejected compile() promise does not permanently stick in the
 * cache. After a transient failure, the next call must retry compilation
 * (fail-closed is preserved: the failure still results in a rejection, not a
 * silent allow).
 *
 * Every seeded cache entry must carry the LIVE settings revision: `load()`
 * discards an entry whose revision has moved on and falls through to the real
 * repository, which fails with "Narrator not found" for these synthetic ids.
 * The revision is a process-wide counter bumped by any saveSettings() /
 * reloadSettings() call, so hardcoding a number only works while this file runs
 * first — it must be read at seed time instead.
 */
function currentSettingsRevision(): number {
	return getSettingsRevision();
}

function makeMinimalPolicy(overrides: Partial<LoadedExecutionPolicy> = {}): LoadedExecutionPolicy {
	return {
		narratorId: "test-narrator",
		ownerNarratorId: "test-narrator",
		projectId: null,
		projectGitPath: null,
		settingsRevision: currentSettingsRevision(),
		directoryWhitelist: [],
		directoryBlacklist: [],
		commandWhitelist: [],
		commandBlacklist: [],
		...overrides,
	};
}

/**
 * Build a policy with a properly-normalized directory whitelist rule that
 * will pass compiler filtering (enabled=true, selector matches host, pathFlavor=posix).
 */
function makePolicyWithDirRule() {
	const rules = normalizeExecutionPolicyRuleSet(
		{ whitelistDirs: [{ path: "/workspace/src" }] },
		"narrator",
	);
	return makeMinimalPolicy({
		directoryWhitelist: rules.directoryWhitelist,
	});
}

/**
 * Build an ExecutionTargetContext with a controllable resolvePathIdentity.
 */
function contextWithPathIdentity(opts: {
	resolvePathIdentity: (path: string) => Promise<PathIdentity>;
	runtimeGeneration?: number;
}): ExecutionTargetContext {
	const pathFlavor = "posix";
	const paths = targetPathSemantics(pathFlavor);
	const cwd = "/workspace";
	const runtimeGeneration = opts.runtimeGeneration ?? 0;
	const backend = {
		deviceId: "local",
		kind: "local",
		paths,
		pathFlavor,
		runtimeGeneration,
		resolvePathIdentity: opts.resolvePathIdentity,
	} as any;
	const target = Object.freeze({
		deviceId: "local",
		backendKind: "local",
		cwd,
		pathFlavor,
		runtimeGeneration,
		selectionSource: "local_default",
	} satisfies ToolExecutionTarget);
	return Object.freeze({ backend, target, paths, deviceClass: null });
}

describe("execution policy engine cache eviction on failure", () => {
	let engine: ExecutionPolicyEngine;

	beforeEach(() => {
		engine = new ExecutionPolicyEngine();
	});

	afterEach(() => {
		engine.clear();
	});

	/** Seed the private loadedCache to bypass the repository (no DB needed). */
	function seedLoadedCache(narratorId: string, policy: any): void {
		const entry = {
			narratorId,
			ownerNarratorId: policy.ownerNarratorId ?? narratorId,
			settingsRevision: currentSettingsRevision(),
			promise: Promise.resolve(policy),
			controller: new AbortController(),
			waiters: 0,
			settled: true,
		};
		(engine as any).loadedCache.set(narratorId, entry);
	}

	test("budgeted facts isolate callers and leave the in-flight shared load intact", async () => {
		const shared = Promise.withResolvers<LoadedExecutionPolicy>();
		const surviving = Promise.withResolvers<LoadedExecutionPolicy>();
		const a = new AbortController();
		const b = new AbortController();
		const seen: (ReadQueryOptions | AbortSignal | undefined)[] = [];
		const load = spyOn(executionPolicyRepository, "load").mockImplementation((_id, options) => {
			seen.push(options);
			if (!options || options instanceof AbortSignal) return shared.promise;
			if (options.signal === b.signal) return surviving.promise;
			return new Promise((_, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
					once: true,
				});
			});
		});
		const deadlineAt = Date.now() + 1000;
		const ordinary = engine.compile("test-narrator", null);
		const first = engine.compile("test-narrator", null, [], a.signal, {
			signal: a.signal,
			deadlineAt,
		});
		const second = engine.compile("test-narrator", null, [], b.signal, {
			signal: b.signal,
			deadlineAt,
		});
		void first.catch(() => {});
		try {
			expect(seen).toHaveLength(3);
			expect(seen[0]).toBeInstanceOf(AbortSignal);
			expect(seen[1]).toMatchObject({ signal: a.signal, deadlineAt });
			a.abort(new Error("first facts consumer left"));
			await expect(first).rejects.toThrow("first facts consumer left");
			expect(b.signal.aborted).toBe(false);
			surviving.resolve(makeMinimalPolicy());
			const policy = await second;
			const otherOrdinary = engine.compile("test-narrator", null);
			expect(load).toHaveBeenCalledTimes(3);
			shared.resolve(makeMinimalPolicy());
			expect(await ordinary).toBe(policy);
			expect(await otherOrdinary).toBe(policy);
		} finally {
			a.abort();
			shared.resolve(makeMinimalPolicy());
			surviving.resolve(makeMinimalPolicy());
			await Promise.allSettled([ordinary, first, second]);
			load.mockRestore();
		}
	});

	test("compile failure does not permanently cache the rejected promise", async () => {
		const narratorId = "test-narrator";

		// Seed a policy with a properly-formed directory rule
		seedLoadedCache(narratorId, makePolicyWithDirRule());

		// Context whose resolvePathIdentity returns a mismatched runtimeGeneration
		const failingCtx = contextWithPathIdentity({
			runtimeGeneration: 5,
			resolvePathIdentity: async (path) => ({
				lexicalPath: path,
				canonicalPath: path,
				exists: true,
				runtimeGeneration: 999, // Mismatch with context's 5 → throws
			}),
		});

		// First compile should reject due to generation drift
		await expect(engine.compile(narratorId, failingCtx)).rejects.toThrow(/generation drifted/);

		// After rejection, replace with a good policy (no directory rules)
		seedLoadedCache(narratorId, makeMinimalPolicy());

		// Second compile with same context should succeed (entry was evicted)
		const result = await engine.compile(narratorId, failingCtx);
		expect(result).toBeDefined();
		expect(result.narratorId).toBe(narratorId);
	});

	test("compile failure still results in deny (fail-closed preserved)", async () => {
		const narratorId = "test-narrator";
		seedLoadedCache(narratorId, makePolicyWithDirRule());

		const failingCtx = contextWithPathIdentity({
			runtimeGeneration: 1,
			resolvePathIdentity: async () => {
				throw new Error("transient FS failure");
			},
		});

		// The rejection means the caller gets an error → the permission system
		// treats this as deny (no valid compiled policy = no allow).
		await expect(engine.compile(narratorId, failingCtx)).rejects.toThrow("transient FS failure");

		// Calling again with the same failing backend also rejects (fail-closed),
		// but it retries rather than returning the stale cached rejection
		await expect(engine.compile(narratorId, failingCtx)).rejects.toThrow("transient FS failure");
	});

	test("retry after transient failure succeeds once the fault clears", async () => {
		const narratorId = "test-narrator";
		let callCount = 0;

		seedLoadedCache(narratorId, makePolicyWithDirRule());

		const ctx = contextWithPathIdentity({
			runtimeGeneration: 1,
			resolvePathIdentity: async (path) => {
				callCount++;
				if (callCount === 1) {
					throw new Error("transient network timeout");
				}
				return { lexicalPath: path, canonicalPath: path, exists: true, runtimeGeneration: 1 };
			},
		});

		// First call fails
		await expect(engine.compile(narratorId, ctx)).rejects.toThrow("transient network timeout");

		// Second call succeeds because the fault cleared
		const result = await engine.compile(narratorId, ctx);
		expect(result).toBeDefined();
		expect(result.narratorId).toBe(narratorId);
		expect(callCount).toBe(2); // Proves it actually retried
	});

	test("concurrent compile calls share the same promise during inflight", async () => {
		const narratorId = "test-narrator";
		seedLoadedCache(narratorId, makeMinimalPolicy());

		// null context skips canonicalization entirely
		const p1 = engine.compile(narratorId, null);
		const p2 = engine.compile(narratorId, null);

		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toBe(r2); // Same object reference = same cached promise
	});

	test("eviction does not clobber a newer entry for a different cache key", async () => {
		const narratorId = "test-narrator";
		let resolveCount = 0;

		seedLoadedCache(narratorId, makePolicyWithDirRule());

		const failingCtx = contextWithPathIdentity({
			runtimeGeneration: 1,
			resolvePathIdentity: async (path) => {
				resolveCount++;
				if (resolveCount <= 1) {
					throw new Error("first call fails");
				}
				return { lexicalPath: path, canonicalPath: path, exists: true, runtimeGeneration: 1 };
			},
		});

		// First compile rejects
		await expect(engine.compile(narratorId, failingCtx)).rejects.toThrow("first call fails");

		// Second compile with same context and same policy should succeed now
		// because the eviction removed the failing entry
		const result = await engine.compile(narratorId, failingCtx);
		expect(result).toBeDefined();
		expect(result.narratorId).toBe(narratorId);
	});

	test("a project edit retries affected snapshots for existing and new tool checks", async () => {
		const unrelated = Promise.withResolvers<LoadedExecutionPolicy>();
		const inherited = Promise.withResolvers<LoadedExecutionPolicy>();
		const load = spyOn(executionPolicyRepository, "load")
			.mockReturnValueOnce(unrelated.promise)
			.mockReturnValueOnce(inherited.promise)
			.mockResolvedValueOnce(
				makeMinimalPolicy({
					narratorId: "child",
					projectId: "unrelated",
					projectIds: ["unrelated", "edited"],
					projectGitPath: "/new",
				}),
			);
		try {
			const unaffected = engine.compile("other", null);
			const affected = engine.compile("child", null);
			engine.invalidateProject("edited");
			const afterEdit = engine.compile("child", null);
			const result = Promise.all([unaffected, affected, afterEdit]);
			unrelated.resolve(makeMinimalPolicy({ narratorId: "other", projectIds: ["unrelated"] }));
			inherited.resolve(
				makeMinimalPolicy({
					narratorId: "child",
					projectId: "unrelated",
					projectIds: ["unrelated", "edited"],
					projectGitPath: "/old",
				}),
			);
			expect(await result).toEqual([
				expect.objectContaining({ narratorId: "other" }),
				expect.objectContaining({ narratorId: "child", projectGitPath: "/new" }),
				expect.objectContaining({ narratorId: "child", projectGitPath: "/new" }),
			]);
			await expect(engine.compile("child", null)).resolves.toMatchObject({ narratorId: "child" });
			await expect(engine.compile("other", null)).resolves.toMatchObject({ narratorId: "other" });
			expect(load).toHaveBeenCalledTimes(3);
		} finally {
			load.mockRestore();
		}
	});

	test("load failure is evicted from loadedCache on next call", async () => {
		const narratorId = "load-fail-narrator";
		const load = spyOn(executionPolicyRepository, "load")
			.mockRejectedValueOnce(new Error("DB connection lost"))
			.mockResolvedValueOnce(makeMinimalPolicy({ narratorId }));
		try {
			await expect(engine.compile(narratorId, null)).rejects.toThrow("DB connection lost");
			expect((await engine.compile(narratorId, null)).narratorId).toBe(narratorId);
			expect(load).toHaveBeenCalledTimes(2);
		} finally {
			load.mockRestore();
		}
	});

	test("a policy invalidated while the Worker is reading cannot repopulate the cache", async () => {
		const narratorId = "pending-narrator";
		const pending = Promise.withResolvers<LoadedExecutionPolicy>();
		const load = spyOn(executionPolicyRepository, "load")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(makeMinimalPolicy({ narratorId, ownerNarratorId: "parent" }));
		try {
			const first = engine.compile(narratorId, null);
			engine.invalidate("parent");
			pending.resolve(makeMinimalPolicy({ narratorId, ownerNarratorId: "old-parent" }));
			await expect(first).rejects.toThrow("changed while loading");
			expect((await engine.compile(narratorId, null)).ownerNarratorId).toBe("parent");
			expect(load).toHaveBeenCalledTimes(2);
		} finally {
			load.mockRestore();
		}
	});
});
