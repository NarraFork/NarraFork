import { createHash } from "node:crypto";
import {
	type CredentialRef,
	credentialRefKey,
	principalRefKey,
} from "@shared/integrations/principals";
import { resourceRefKey, resourceScopeKey } from "@shared/integrations/resources";
import { digestAuthorizationConstraints } from "./limits";
import {
	type AuthorizationDecision,
	type ExecutionContext,
	executionContextSchema,
	type OperationRequirement,
	operationRequirementSchema,
	type RuntimeRef,
} from "./types";

export const AUTHORIZATION_CACHE_MAX_ENTRIES = 4_096;
export const AUTHORIZATION_CACHE_MAX_TTL_MS = 5 * 60_000;

export interface AuthorizationCacheKeyInput {
	context: ExecutionContext;
	requirement: OperationRequirement;
}

export interface AuthorizationCacheKeyParts {
	authority: string;
	revision: number;
	subject: string;
	credential: string;
	runtime: string;
	runtimeGeneration: number;
	operation: string;
	capability: string;
	resource: string;
	scope: string;
	boundScopes: string[];
	constraintsDigest: string;
	deadlineAt: number;
}

export function buildAuthorizationCacheKeyParts(
	input: AuthorizationCacheKeyInput,
): AuthorizationCacheKeyParts {
	const context = executionContextSchema.parse(input.context);
	const requirement = operationRequirementSchema.parse(input.requirement);
	return {
		authority: context.authority.id,
		revision: context.authority.revision,
		subject: principalRefKey(context.subject),
		credential: credentialRefKey(context.credential),
		runtime: `${context.runtime.type}:${context.runtime.id}`,
		runtimeGeneration: context.runtime.generation,
		operation: requirement.operation,
		capability: requirement.capability,
		resource: resourceRefKey(requirement.resource),
		scope: resourceScopeKey(requirement.scope),
		boundScopes: context.boundScopes.map(resourceScopeKey).sort(),
		constraintsDigest: digestAuthorizationConstraints(requirement.constraints),
		deadlineAt: requirement.deadlineAt,
	};
}

export function buildAuthorizationCacheKey(input: AuthorizationCacheKeyInput): string {
	const { deadlineAt: _deadlineAt, ...identity } = buildAuthorizationCacheKeyParts(input);
	const serialized = JSON.stringify(identity);
	return `ik1:${createHash("sha256").update(serialized).digest("hex")}`;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
	authorityId: string;
	credentialKey: string;
	runtimeKey: string;
}

export interface AuthorizationDecisionCacheOptions {
	maxEntries?: number;
	ttlMs?: number;
	now?: () => number;
}

export class AuthorizationDecisionCache<T = AuthorizationDecision> {
	readonly #entries = new Map<string, CacheEntry<T>>();
	readonly #authorityIndex = new Map<string, Set<string>>();
	readonly #credentialIndex = new Map<string, Set<string>>();
	readonly #runtimeIndex = new Map<string, Set<string>>();
	readonly #maxEntries: number;
	readonly #ttlMs: number;
	readonly #now: () => number;

	constructor(options: AuthorizationDecisionCacheOptions = {}) {
		this.#maxEntries = Math.min(
			AUTHORIZATION_CACHE_MAX_ENTRIES,
			Math.max(1, Math.trunc(options.maxEntries ?? AUTHORIZATION_CACHE_MAX_ENTRIES)),
		);
		this.#ttlMs = Math.min(
			AUTHORIZATION_CACHE_MAX_TTL_MS,
			Math.max(1, Math.trunc(options.ttlMs ?? 30_000)),
		);
		this.#now = options.now ?? Date.now;
	}

	get size(): number {
		return this.#entries.size;
	}

	get(input: AuthorizationCacheKeyInput): T | undefined {
		const now = this.#now();
		if (input.requirement.deadlineAt < now) return undefined;
		const key = buildAuthorizationCacheKey(input);
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= now) {
			this.#delete(key, entry);
			return undefined;
		}
		return entry.value;
	}

	set(input: AuthorizationCacheKeyInput, value: T): string {
		const key = buildAuthorizationCacheKey(input);
		const parts = buildAuthorizationCacheKeyParts(input);
		const existing = this.#entries.get(key);
		if (existing) this.#delete(key, existing);
		while (this.#entries.size >= this.#maxEntries) {
			const oldest = this.#entries.entries().next().value as [string, CacheEntry<T>] | undefined;
			if (!oldest) break;
			this.#delete(oldest[0], oldest[1]);
		}
		const entry: CacheEntry<T> = {
			value,
			expiresAt: Math.min(this.#now() + this.#ttlMs, parts.deadlineAt),
			authorityId: parts.authority,
			credentialKey: parts.credential,
			runtimeKey: parts.runtime,
		};
		this.#entries.set(key, entry);
		this.#addIndex(this.#authorityIndex, entry.authorityId, key);
		this.#addIndex(this.#credentialIndex, entry.credentialKey, key);
		this.#addIndex(this.#runtimeIndex, entry.runtimeKey, key);
		return key;
	}

	invalidateAuthority(authorityId: string): number {
		return this.#invalidateIndex(this.#authorityIndex, authorityId);
	}

	invalidateCredential(credential: CredentialRef): number {
		return this.#invalidateIndex(this.#credentialIndex, credentialRefKey(credential));
	}

	invalidateRuntime(runtime: Pick<RuntimeRef, "type" | "id">): number {
		return this.#invalidateIndex(this.#runtimeIndex, `${runtime.type}:${runtime.id}`);
	}

	clear(): void {
		this.#entries.clear();
		this.#authorityIndex.clear();
		this.#credentialIndex.clear();
		this.#runtimeIndex.clear();
	}

	#addIndex(index: Map<string, Set<string>>, partition: string, key: string): void {
		const keys = index.get(partition) ?? new Set<string>();
		keys.add(key);
		index.set(partition, keys);
	}

	#invalidateIndex(index: Map<string, Set<string>>, partition: string): number {
		const keys = index.get(partition);
		if (!keys) return 0;
		let deleted = 0;
		for (const key of [...keys]) {
			const entry = this.#entries.get(key);
			if (!entry) continue;
			this.#delete(key, entry);
			deleted += 1;
		}
		return deleted;
	}

	#delete(key: string, entry: CacheEntry<T>): void {
		this.#entries.delete(key);
		this.#removeIndex(this.#authorityIndex, entry.authorityId, key);
		this.#removeIndex(this.#credentialIndex, entry.credentialKey, key);
		this.#removeIndex(this.#runtimeIndex, entry.runtimeKey, key);
	}

	#removeIndex(index: Map<string, Set<string>>, partition: string, key: string): void {
		const keys = index.get(partition);
		if (!keys) return;
		keys.delete(key);
		if (keys.size === 0) index.delete(partition);
	}
}
