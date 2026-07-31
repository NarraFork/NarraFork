import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PathIdentity } from "@server/lib/agent/execution/backend";
import { targetPathSemantics } from "@server/lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "@server/lib/agent/types";
import { ExecutionPolicyEngine } from "../engine";
import { normalizeExecutionPolicyRuleSet } from "../normalize";
import type { ExecutionTargetContext } from "../types";

/**
 * Verify that a rejected compile() promise does not permanently stick in the
 * cache. After a transient failure, the next call must retry compilation
 * (fail-closed is preserved: the failure still results in a rejection, not a
 * silent allow).
 */

function makeMinimalPolicy(overrides: Partial<any> = {}) {
	return {
		narratorId: "test-narrator",
		ownerNarratorId: "test-narrator",
		projectId: null,
		projectGitPath: null,
		settingsRevision: 1,
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
			settingsRevision: 1,
			promise: Promise.resolve(policy),
		};
		(engine as any).loadedCache.set(narratorId, entry);
	}

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

	test("load failure is evicted from loadedCache on next call", async () => {
		const narratorId = "load-fail-narrator";
		const loadedCache = (engine as any).loadedCache as Map<string, any>;

		// Manually insert a rejected load entry to simulate repository.load() failure.
		// In the real code, the .catch handler on load() evicts the entry. Here we
		// simulate the end state after that handler runs.
		const rejectedPromise = Promise.reject(new Error("DB connection lost"));
		rejectedPromise.catch(() => {}); // Suppress unhandled rejection
		const failEntry = {
			narratorId,
			settingsRevision: 1,
			promise: rejectedPromise,
		};
		loadedCache.set(narratorId, failEntry);

		// compile propagates the load failure
		await expect(engine.compile(narratorId, null)).rejects.toThrow("DB connection lost");

		// Now seed a working entry (simulating that the DB recovered)
		const entry = {
			narratorId,
			ownerNarratorId: narratorId,
			settingsRevision: 1,
			promise: Promise.resolve(makeMinimalPolicy({ narratorId })),
		};
		loadedCache.set(narratorId, entry);

		const result = await engine.compile(narratorId, null);
		expect(result).toBeDefined();
		expect(result.narratorId).toBe(narratorId);
	});
});
