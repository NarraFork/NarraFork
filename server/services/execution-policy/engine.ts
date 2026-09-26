import { createHash } from "node:crypto";
import { hotSafe } from "@server/lib/hot-safe";
import { robotDiagnosticRuleSet } from "@server/lib/robot-diagnostic-policy";
import { getSettingsRevision } from "@server/lib/settings";
import { type CompiledExecutionPolicy, compileExecutionPolicy } from "./compiler";
import { mergeExecutionPolicyRuleSets } from "./normalize";
import { resolveCanonicalPaths } from "./path-probes";
import { executionPolicyRepository, type LoadedExecutionPolicy } from "./repository";
import { executionTargetContextKey } from "./target-context";
import type {
	DirectoryBlacklistRule,
	DirectoryWhitelistRule,
	ExecutionPolicyRuleSet,
	ExecutionTargetContext,
} from "./types";

export interface ResolvedExecutionPolicy extends CompiledExecutionPolicy {
	readonly narratorId: string;
	readonly ownerNarratorId: string;
	readonly projectId: string | null;
	readonly projectGitPath: string | null;
	readonly revision: string;
}

interface LoadedCacheEntry {
	narratorId: string;
	ownerNarratorId?: string;
	settingsRevision: number;
	promise: Promise<LoadedExecutionPolicy>;
}

interface CompiledCacheEntry {
	narratorId: string;
	ownerNarratorId?: string;
	settingsRevision: number;
	promise: Promise<ResolvedExecutionPolicy>;
	controller: AbortController;
	waiters: number;
	settled: boolean;
}

/** One waiter may leave without cancelling another caller's shared compilation. */
function waitForCompilation(
	entry: CompiledCacheEntry,
	signal?: AbortSignal,
): Promise<ResolvedExecutionPolicy> {
	entry.waiters++;
	return new Promise((resolve, reject) => {
		let finished = false;
		const finish = (complete: () => void) => {
			if (finished) return;
			finished = true;
			entry.waiters--;
			signal?.removeEventListener("abort", abort);
			complete();
		};
		const abort = () =>
			finish(() => {
				const reason = signal?.reason;
				if (entry.waiters === 0 && !entry.settled) {
					entry.controller.abort(reason);
					// The last caller owns cleanup: do not report cancellation until probes drain.
					void entry.promise.then(
						() => reject(reason),
						() => reject(reason),
					);
				} else {
					reject(reason);
				}
			});
		signal?.addEventListener("abort", abort, { once: true });
		void entry.promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (signal?.aborted) abort();
	});
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function executionPolicyRevision(policy: LoadedExecutionPolicy): string {
	return createHash("sha256")
		.update(
			stableJson({
				directoryWhitelist: policy.directoryWhitelist,
				directoryBlacklist: policy.directoryBlacklist,
				commandWhitelist: policy.commandWhitelist,
				commandBlacklist: policy.commandBlacklist,
				ownerNarratorId: policy.ownerNarratorId,
				projectId: policy.projectId,
				projectGitPath: policy.projectGitPath,
				settingsRevision: policy.settingsRevision,
			}),
		)
		.digest("hex");
}

/**
 * Trusted instance-level rule layers merged on top of global/project/narrator rules.
 *
 * These come from server code rather than user input (currently only the robot diagnostic
 * read-only preset), so a caller opts in by name and cannot inject arbitrary patterns.
 */
export type ExecutionPolicyPreset = "robotDiagnostic";

function presetRuleSet(preset: ExecutionPolicyPreset): ExecutionPolicyRuleSet {
	switch (preset) {
		case "robotDiagnostic":
			return robotDiagnosticRuleSet();
	}
}

/** Stable, order-independent key so presets participate in the revision and cache key. */
function presetsKey(presets: readonly ExecutionPolicyPreset[]): string {
	return presets.length === 0 ? "none" : [...new Set(presets)].sort().join(",");
}

async function canonicalizeCompiledRules(
	compiled: CompiledExecutionPolicy,
	context: ExecutionTargetContext | null,
	signal: AbortSignal,
): Promise<ExecutionPolicyRuleSet> {
	signal.throwIfAborted();
	if (!context || context.paths.flavor === "spec") return compiled;
	// Share the deduplication and concurrency budget across both lists, but keep every
	// rule's order and metadata: identical roots may have different access/deny levels.
	const canonicalPaths = await resolveCanonicalPaths(
		[...compiled.directoryWhitelist, ...compiled.directoryBlacklist].map((rule) => rule.path),
		context,
		"Execution policy path",
		signal,
	);
	let next = 0;
	const paths = context.paths;
	function canonicalRule<T extends DirectoryWhitelistRule | DirectoryBlacklistRule>(rule: T): T {
		const path = canonicalPaths[next++];
		return { ...rule, path, pathKey: paths.identityKey(path) };
	}
	return {
		directoryWhitelist: compiled.directoryWhitelist.map(canonicalRule),
		directoryBlacklist: compiled.directoryBlacklist.map(canonicalRule),
		commandWhitelist: compiled.commandWhitelist,
		commandBlacklist: compiled.commandBlacklist,
	};
}

export class ExecutionPolicyEngine {
	private readonly loadedCache = new Map<string, LoadedCacheEntry>();
	private readonly compiledCache = new Map<string, CompiledCacheEntry>();

	private load(narratorId: string): Promise<LoadedExecutionPolicy> {
		const settingsRevision = getSettingsRevision();
		const cached = this.loadedCache.get(narratorId);
		if (cached && cached.settingsRevision === settingsRevision) return cached.promise;
		if (cached) this.invalidate(narratorId);

		const entry: LoadedCacheEntry = {
			narratorId,
			settingsRevision,
			promise: Promise.resolve(undefined as never),
		};
		entry.promise = executionPolicyRepository.load(narratorId).then(
			(policy) => {
				entry.ownerNarratorId = policy.ownerNarratorId;
				return policy;
			},
			(error) => {
				if (this.loadedCache.get(narratorId) === entry) {
					this.loadedCache.delete(narratorId);
				}
				throw error;
			},
		);
		this.loadedCache.set(narratorId, entry);
		return entry.promise;
	}

	async compile(
		narratorId: string,
		context: ExecutionTargetContext | null,
		presets: readonly ExecutionPolicyPreset[] = [],
		signal?: AbortSignal,
	): Promise<ResolvedExecutionPolicy> {
		signal?.throwIfAborted();
		const loaded = await this.load(narratorId);
		signal?.throwIfAborted();
		const appliedPresets = presetsKey(presets);
		// Presets join the revision, not just the cache key: enabling or disabling one changes
		// the effective rule set, and a stale entry would otherwise be reused across the switch.
		const revision = createHash("sha256")
			.update(`${executionPolicyRevision(loaded)}:${appliedPresets}`)
			.digest("hex");
		const contextKey = context ? executionTargetContextKey(context) : "unrouted";
		const cacheKey = `${narratorId}:${revision}:${contextKey}`;
		const settingsRevision = getSettingsRevision();
		const cached = this.compiledCache.get(cacheKey);
		if (cached?.settingsRevision === settingsRevision && !cached.controller.signal.aborted) {
			return waitForCompilation(cached, signal);
		}
		if (cached) this.compiledCache.delete(cacheKey);

		const entry: CompiledCacheEntry = {
			narratorId,
			ownerNarratorId: loaded.ownerNarratorId,
			settingsRevision,
			promise: Promise.resolve(undefined as never),
			controller: new AbortController(),
			waiters: 0,
			settled: false,
		};
		entry.promise = (async () => {
			const effectiveRules =
				presets.length === 0
					? loaded
					: mergeExecutionPolicyRuleSets(
							loaded,
							...[...new Set(presets)].map((preset) => presetRuleSet(preset)),
						);
			const selected = compileExecutionPolicy(effectiveRules, context);
			const canonicalRules = await canonicalizeCompiledRules(
				selected,
				context,
				entry.controller.signal,
			);
			const compiled = compileExecutionPolicy(canonicalRules, context);
			return Object.freeze({
				...compiled,
				narratorId: loaded.narratorId,
				ownerNarratorId: loaded.ownerNarratorId,
				projectId: loaded.projectId,
				projectGitPath: loaded.projectGitPath,
				revision,
			});
		})().then(
			(policy) => {
				entry.settled = true;
				return policy;
			},
			(error) => {
				entry.settled = true;
				// A cancelled batch may already have been replaced. Never evict its successor.
				if (this.compiledCache.get(cacheKey) === entry) {
					this.compiledCache.delete(cacheKey);
				}
				throw error;
			},
		);
		this.compiledCache.set(cacheKey, entry);
		return waitForCompilation(entry, signal);
	}

	/** Invalidate a narrator and every cached subagent whose rules are owned by it. */
	invalidate(narratorId: string): void {
		for (const [key, entry] of this.loadedCache) {
			if (entry.narratorId === narratorId || entry.ownerNarratorId === narratorId) {
				this.loadedCache.delete(key);
			}
		}
		for (const [key, entry] of this.compiledCache) {
			if (entry.narratorId === narratorId || entry.ownerNarratorId === narratorId) {
				this.compiledCache.delete(key);
			}
		}
	}

	clear(): void {
		this.loadedCache.clear();
		this.compiledCache.clear();
	}
}

export const executionPolicyEngine = hotSafe<ExecutionPolicyEngine>(
	"narrafork.executionPolicy.engine",
	() => new ExecutionPolicyEngine(),
);
