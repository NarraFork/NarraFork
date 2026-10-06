import { describe, expect, test } from "bun:test";
import type { BashAnalysis } from "@server/lib/agent/bash-analyze";
import type {
	ExecutionBackend,
	FileMetadataOptions,
	PathIdentity,
} from "@server/lib/agent/execution/backend";
import { targetPathSemantics } from "@server/lib/agent/execution/path-semantics";
import { getSettingsRevision, settings } from "@server/lib/settings";
import { canonicalizeShellAnalysisPaths } from "../../narrator-permission";
import { ExecutionPolicyEngine } from "../engine";
import { normalizeExecutionPolicyRuleSet } from "../normalize";
import type { LoadedExecutionPolicy } from "../repository";
import type { ExecutionTargetContext, LegacyExecutionPolicyRuleSet } from "../types";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const inputs = Array.from({ length: 24 }, (_, index) => `/workspace/file-${index}`);

/** A cancellable metadata backend: unfinished calls consume a slot until settled. */
class PathProbes {
	active = 0;
	peak = 0;
	readonly calls: Array<{
		path: string;
		signal?: AbortSignal;
		succeed: (overrides?: Partial<PathIdentity>) => void;
		fail: (error: unknown) => void;
	}> = [];

	constructor(
		private readonly automatic = false,
		private readonly honorAbort = true,
	) {}

	resolve = (path: string, options?: FileMetadataOptions): Promise<PathIdentity> => {
		this.active++;
		this.peak = Math.max(this.peak, this.active);
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (complete: () => void) => {
				if (settled) return;
				settled = true;
				this.active--;
				options?.signal?.removeEventListener("abort", abort);
				complete();
			};
			const fail = (error: unknown) => finish(() => reject(error));
			const abort = () => fail(options?.signal?.reason);
			const succeed = (overrides?: Partial<PathIdentity>) =>
				finish(() =>
					resolve({
						lexicalPath: path,
						canonicalPath: `/canonical${path}`,
						exists: true,
						runtimeGeneration: 7,
						...overrides,
					}),
				);
			this.calls.push({ path, signal: options?.signal, succeed, fail });
			if (this.honorAbort) options?.signal?.addEventListener("abort", abort, { once: true });
			if (this.honorAbort && options?.signal?.aborted) abort();
			else if (this.automatic) queueMicrotask(() => succeed());
		});
	};

	cleanup() {
		for (const call of this.calls) call.fail(new Error("test cleanup"));
	}
}

function context(
	probes: PathProbes,
	flavor: "windows" | "posix" = "posix",
): ExecutionTargetContext {
	const paths = targetPathSemantics(flavor);
	const backend = {
		deviceId: "path-probe-device",
		kind: "remote",
		paths,
		pathFlavor: flavor,
		runtimeGeneration: 7,
		resolvePathIdentity: probes.resolve,
	} as unknown as ExecutionBackend;
	return {
		backend,
		paths,
		target: {
			deviceId: backend.deviceId,
			backendKind: backend.kind,
			cwd: flavor === "windows" ? "C:\\workspace" : "/workspace",
			pathFlavor: flavor,
			runtimeGeneration: 7,
			selectionSource: "explicit",
		},
		deviceClass: null,
	};
}

function analysis(filePaths = inputs): BashAnalysis {
	return {
		commands: [{ tokens: ["cat", ...filePaths], text: "cat", fullText: "cat" }],
		filePaths,
		allWhitelisted: true,
		nonWhitelisted: [],
		dangerousPatterns: [],
		hasEnvInjection: false,
		commandEnvVars: [],
		isCatastrophic: false,
		gitBranchViolations: [],
		gitBranchWarnings: [],
		hasWriteOperation: false,
		allReadOnly: true,
	};
}

function seededEngine(rules: LegacyExecutionPolicyRuleSet) {
	const engine = new ExecutionPolicyEngine();
	const settingsRevision = getSettingsRevision();
	const policy: LoadedExecutionPolicy = {
		...normalizeExecutionPolicyRuleSet(rules, "narrator"),
		narratorId: "probe-narrator",
		ownerNarratorId: "probe-narrator",
		projectId: null,
		projectGitPath: null,
		settingsRevision,
	};
	// Only repository loading is bypassed; compile/cache/target selection run unchanged.
	const cache = (
		engine as unknown as {
			loadedCache: Map<
				string,
				{ settingsRevision: number; promise: Promise<LoadedExecutionPolicy> }
			>;
		}
	).loadedCache;
	cache.set(policy.narratorId, { settingsRevision, promise: Promise.resolve(policy) });
	return { engine, narratorId: policy.narratorId };
}

function manyRules(): LegacyExecutionPolicyRuleSet {
	return {
		whitelistDirs: inputs.map((path) => ({ path, selector: { kind: "all" } })),
		blacklistDirs: inputs.map((path) => ({
			path,
			selector: { kind: "all" },
			denyLevel: "denyWrite",
		})),
	};
}

describe("permission probes respect the effective device RPC cap", () => {
	for (const cap of [1, 2]) {
		for (const route of ["Bash", "compile"] as const) {
			test(`${route} succeeds with a configured cap of ${cap} without self-exhaustion`, async () => {
				if (!settings.devices) throw new Error("Missing device settings");
				const previousCap = settings.devices.maxConcurrentRpcPerDevice;
				settings.devices.maxConcurrentRpcPerDevice = cap;
				const probes = new PathProbes(true);
				const ctx = context(probes);
				ctx.backend.resolvePathIdentity = (path, options) => {
					if (probes.active >= cap) {
						return Promise.reject(new Error(`Device RPC concurrency limit reached (${cap})`));
					}
					return probes.resolve(path, options);
				};
				try {
					if (route === "Bash") await canonicalizeShellAnalysisPaths(analysis(), ctx);
					else {
						const { engine, narratorId } = seededEngine(manyRules());
						await engine.compile(narratorId, ctx);
					}
					expect(probes.peak).toBe(cap);
					expect(probes.active).toBe(0);
					expect(probes.calls).toHaveLength(inputs.length);
				} finally {
					settings.devices.maxConcurrentRpcPerDevice = previousCap;
					probes.cleanup();
				}
			});
		}
	}
});

describe("Bash permission canonical path probes", () => {
	test("bounds a real analysis batch larger than the device's 16 slots", async () => {
		const probes = new PathProbes(true);
		const original = analysis();
		const result = await canonicalizeShellAnalysisPaths(original, context(probes));
		expect(probes.peak).toBeLessThanOrEqual(4);
		expect(probes.active).toBe(0);
		expect(probes.calls).toHaveLength(inputs.length);
		expect(result.filePaths).toEqual(inputs.map((path) => `/canonical${path}`));
		expect(result.commands).toBe(original.commands);
		expect(original.filePaths).toBe(inputs);
	});

	test("deduplicates probes before dispatch, using target Windows identity", async () => {
		const probes = new PathProbes(true);
		const result = await canonicalizeShellAnalysisPaths(
			analysis(["C:\\workspace\\file", "c:/workspace/./FILE", "C:\\workspace\\file"]),
			context(probes, "windows"),
		);
		expect(probes.calls).toHaveLength(1);
		expect(result.filePaths).toHaveLength(1);
	});

	test("preserves POSIX case and leaves symlink identity to the backend after target normalization", async () => {
		const probes = new PathProbes(true);
		const ctx = context(probes);
		ctx.backend.resolvePathIdentity = async (path, options) => {
			const identity = await probes.resolve(path, options);
			return {
				...identity,
				canonicalPath:
					path === "/workspace/link/file" || path === "/workspace/target/file"
						? "/real/shared-file"
						: identity.canonicalPath,
			};
		};
		const result = await canonicalizeShellAnalysisPaths(
			analysis([
				"/workspace/link/file",
				"/workspace/target/file",
				"/workspace/link/../file",
				"/workspace/file",
				"/workspace/FILE",
			]),
			ctx,
		);
		// resolve() already collapses .. in both the shell analyzer and the backend.
		// Distinct symlink aliases and POSIX case variants must still be probed separately.
		expect(probes.calls.map((call) => call.path)).toEqual([
			"/workspace/link/file",
			"/workspace/target/file",
			"/workspace/file",
			"/workspace/FILE",
		]);
		expect(result.filePaths).toEqual([
			"/real/shared-file",
			"/canonical/workspace/file",
			"/canonical/workspace/FILE",
		]);
	});

	test("owner abort cancels active probes without dispatching queued paths", async () => {
		const probes = new PathProbes();
		const owner = new AbortController();
		const result = canonicalizeShellAnalysisPaths(analysis(), context(probes), owner.signal);
		void result.catch(() => {});
		try {
			await nextTurn();
			owner.abort(new Error("permission interrupted"));
			await expect(result).rejects.toThrow("permission interrupted");
			expect(probes.active).toBe(0);
			expect(probes.calls).toHaveLength(4);
			expect(probes.calls.every((call) => call.signal?.aborted)).toBe(true);
		} finally {
			probes.cleanup();
			await result.catch(() => {});
		}
	});

	test("an already aborted owner starts no probes, even for an empty analysis", async () => {
		const probes = new PathProbes(true);
		const signal = AbortSignal.abort(new Error("permission interrupted"));
		for (const paths of [inputs, []]) {
			await expect(
				canonicalizeShellAnalysisPaths(analysis(paths), context(probes), signal),
			).rejects.toThrow("permission interrupted");
		}
		expect(probes.calls).toHaveLength(0);
	});

	test("waits for a cancellation-delayed backend rather than leaving detached work", async () => {
		const probes = new PathProbes(false, false);
		let settled = false;
		const result = canonicalizeShellAnalysisPaths(analysis(), context(probes));
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			probes.calls[0].fail(new Error("first error"));
			await nextTurn();
			expect(settled).toBe(false);
			expect(probes.calls).toHaveLength(4);
			expect(probes.calls.every((call) => call.signal?.aborted)).toBe(true);
			for (const call of probes.calls) call.succeed();
			await expect(result).rejects.toThrow("first error");
			expect(probes.active).toBe(0);
		} finally {
			probes.cleanup();
			await result.catch(() => {});
		}
	});

	for (const failure of ["rpc", "generation"] as const) {
		test(`${failure} failure cancels/drains siblings and never starts the remaining paths`, async () => {
			const probes = new PathProbes();
			const result = canonicalizeShellAnalysisPaths(analysis(), context(probes));
			void result.catch(() => {});
			try {
				await nextTurn();
				if (failure === "rpc") probes.calls[0].fail(new Error("metadata unavailable"));
				else probes.calls[0].succeed({ runtimeGeneration: 8 });
				await expect(result).rejects.toThrow(
					failure === "rpc" ? "metadata unavailable" : "generation drifted",
				);
				expect(probes.active).toBe(0);
				expect(probes.calls.length).toBeLessThanOrEqual(4);
			} finally {
				probes.cleanup();
				await result.catch(() => {});
			}
		});
	}
});

describe("execution policy compile canonical path probes", () => {
	test("one aborted waiter does not poison the shared compile or its successful cache", async () => {
		const probes = new PathProbes();
		const { engine, narratorId } = seededEngine({
			whitelistDirs: [{ path: inputs[0], selector: { kind: "all" } }],
		});
		const ctx = context(probes);
		const owner = new AbortController();
		const first = engine.compile(narratorId, ctx, [], owner.signal);
		const second = engine.compile(narratorId, ctx);
		void first.catch(() => {});
		void second.catch(() => {});
		try {
			await nextTurn();
			owner.abort(new Error("first waiter left"));
			await expect(first).rejects.toThrow("first waiter left");
			expect(probes.calls).toHaveLength(1);
			expect(probes.active).toBe(1);
			expect(probes.calls[0].signal?.aborted).toBe(false);
			probes.calls[0].succeed();
			const compiled = await second;
			expect(await engine.compile(narratorId, ctx)).toBe(compiled);
			expect(probes.calls).toHaveLength(1);
		} finally {
			probes.cleanup();
			await Promise.allSettled([first, second]);
		}
	});

	test("the last of two aborted waiters cancels the shared batch and stops its queue", async () => {
		const probes = new PathProbes();
		const { engine, narratorId } = seededEngine(manyRules());
		const ctx = context(probes);
		const a = new AbortController();
		const b = new AbortController();
		const first = engine.compile(narratorId, ctx, [], a.signal);
		const second = engine.compile(narratorId, ctx, [], b.signal);
		void first.catch(() => {});
		void second.catch(() => {});
		try {
			await nextTurn();
			a.abort(new Error("first left"));
			await expect(first).rejects.toThrow("first left");
			expect(probes.active).toBe(4);
			b.abort(new Error("last left"));
			await expect(second).rejects.toThrow("last left");
			expect(probes.active).toBe(0);
			expect(probes.calls).toHaveLength(4);
			expect(probes.calls.every((call) => call.signal?.aborted)).toBe(true);
		} finally {
			probes.cleanup();
			await Promise.allSettled([first, second]);
		}
	});

	test("late cleanup of a cancelled cache entry cannot evict its successful replacement", async () => {
		const probes = new PathProbes(false, false);
		const { engine, narratorId } = seededEngine(manyRules());
		const owner = new AbortController();
		const cancelled = engine.compile(narratorId, context(probes), [], owner.signal);
		void cancelled.catch(() => {});
		try {
			await nextTurn();
			owner.abort(new Error("owner left"));
			const recovered = new PathProbes(true);
			const ctx = context(recovered);
			const replacement = await engine.compile(narratorId, ctx);
			// The old backend observes cancellation but does not settle until its RPC finishes.
			expect(probes.calls.every((call) => call.signal?.aborted)).toBe(true);
			probes.cleanup();
			await expect(cancelled).rejects.toThrow("owner left");
			expect(await engine.compile(narratorId, ctx)).toBe(replacement);
			expect(recovered.calls).toHaveLength(inputs.length);
		} finally {
			probes.cleanup();
			await cancelled.catch(() => {});
		}
	});

	test("an already aborted caller does not load or start compilation", async () => {
		const probes = new PathProbes(true);
		const engine = new ExecutionPolicyEngine();
		await expect(
			engine.compile(
				"not-in-repository",
				context(probes),
				[],
				AbortSignal.abort(new Error("owner left")),
			),
		).rejects.toThrow("owner left");
		expect(probes.calls).toHaveLength(0);
	});

	test("shares one bounded deduplicated batch across both rule lists, preserving deny rules", async () => {
		const probes = new PathProbes(true);
		const { engine, narratorId } = seededEngine(manyRules());
		const compiled = await engine.compile(narratorId, context(probes));
		expect(probes.peak).toBeLessThanOrEqual(4);
		expect(probes.active).toBe(0);
		expect(probes.calls).toHaveLength(inputs.length);
		expect(compiled.directoryWhitelist).toHaveLength(inputs.length);
		expect(compiled.directoryBlacklist).toHaveLength(inputs.length);
		expect(compiled.directoryBlacklist[0]).toMatchObject({
			path: `/canonical${inputs[0]}`,
			denyLevel: "denyWrite",
			source: "narrator",
		});
		expect(
			compiled.evaluatePath({ path: `/canonical${inputs[0]}/nested`, operation: "write" }),
		).toMatchObject({ decision: "deny" });
	});

	test("does not dispatch inactive or mismatched directory rules", async () => {
		const probes = new PathProbes(true);
		const { engine, narratorId } = seededEngine({
			whitelistDirs: [
				{ path: inputs[0], selector: { kind: "all" } },
				{ path: inputs[1], selector: { kind: "all" }, enabled: false },
				{ path: inputs[2], selector: { kind: "host" } },
				{ path: "C:\\other", pathFlavor: "windows", selector: { kind: "all" } },
			],
		});
		await engine.compile(narratorId, context(probes));
		expect(probes.calls.map((call) => call.path)).toEqual([inputs[0]]);
	});

	test("fails closed only after siblings drain, then retries rather than caching rejection", async () => {
		const probes = new PathProbes();
		const { engine, narratorId } = seededEngine(manyRules());
		const result = engine.compile(narratorId, context(probes));
		void result.catch(() => {});
		try {
			await nextTurn();
			probes.calls[0].fail(new Error("metadata unavailable"));
			await expect(result).rejects.toThrow("metadata unavailable");
			expect(probes.active).toBe(0);
			expect(probes.calls.length).toBeLessThanOrEqual(4);
			const recovered = new PathProbes(true);
			await engine.compile(narratorId, context(recovered));
			expect(recovered.calls).toHaveLength(inputs.length);
		} finally {
			probes.cleanup();
			await result.catch(() => {});
		}
	});
});
