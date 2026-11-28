/** In-memory API-key routing shared by templates; no adapter construction or quota restore. */
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { keyCooldown } from "../agent/pooled-provider";
import { peekProviderKeyStore, withProviderKey } from "../provider-keys";
import { quotaStore, STREAM_QUOTA_SOURCE } from "./quota-store";
import type { SourceGroupView } from "./source-groups";

export interface RoutingPreview {
	label?: string;
	resetsAt?: number;
	rotating?: boolean;
}

export interface CredentialRouting {
	hasAvailableCredentials: (group: SourceGroupView, now: number, model?: string) => boolean;
	routingPreview: (group: SourceGroupView, now: number) => RoutingPreview | null;
}

type KeyConfig = { apiKey: string };
type Block = { blocked: boolean; until?: number };

/** Stream-only balances have no refill probe of their own; periodically allow a fresh attempt. */
export const STREAM_BALANCE_MAX_AGE_MS = 60_000;

/** Unknown/error/unlimited balances are not zero; different currencies may fund a request. */
function quotaBlock(snapshot: QuotaSnapshot | undefined, now: number, checkBalances = true): Block {
	if (!snapshot || snapshot.error) return { blocked: false };
	if (
		snapshot.available === false ||
		(snapshot.expiresAt !== undefined && snapshot.expiresAt <= now)
	)
		return { blocked: true };
	const balances = snapshot.balances.filter(
		(balance) => balance.quota !== "none" && (!balance.window || balance.quota === "alternative"),
	);
	const balanceExhausted = (balance: (typeof balances)[number]) =>
		!balance.unlimited &&
		typeof balance.remaining === "number" &&
		Number.isFinite(balance.remaining) &&
		balance.remaining <= 0;
	const alternatives = balances.filter((balance) => balance.quota !== "required");
	if (
		checkBalances &&
		(balances.some((balance) => balance.quota === "required" && balanceExhausted(balance)) ||
			(alternatives.length > 0 && alternatives.every(balanceExhausted)))
	)
		return { blocked: true };
	const exhausted = snapshot.windows.filter(
		(window) =>
			(window.status === "rate-limited" ||
				window.remaining === 0 ||
				(typeof window.usedRatio === "number" &&
					window.usedRatio >= 1 &&
					!(typeof window.remaining === "number" && window.remaining > 0))) &&
			(window.resetsAt === null || window.resetsAt > now),
	);
	if (!exhausted.length) return { blocked: false };
	return {
		blocked: true,
		...(exhausted.every((window) => window.resetsAt !== null) && {
			until: Math.max(...exhausted.map((window) => window.resetsAt as number)),
		}),
	};
}

function combine(blocks: Block[]): Block {
	const blocked = blocks.filter((block) => block.blocked);
	return {
		blocked: blocked.length > 0,
		...(blocked.length > 0 &&
			blocked.every((block) => block.until !== undefined) && {
				until: Math.max(...blocked.map((block) => block.until as number)),
			}),
	};
}

/** Group/owner spelling is resolved by the key facade, including legacy NUG and builtins. */
export function keyRouting<T extends KeyConfig>(
	configOf: (group: SourceGroupView) => T | undefined,
	identity: (config: T) => string,
	options: {
		/** Command Code can use CLI auth; do not read auth.json to prove readiness here. */
		allowUnconfigured?: boolean;
		/** OpenCode's optional wallet is a fallback, not a prerequisite for its plan. */
		probeBalanceIsFallback?: boolean;
		streamIdentity?: (config: T) => string;
		/** Pure identity-checked projection from an external canonical quota owner. */
		probeSnapshot?: (credentialId: string) => QuotaSnapshot | undefined;
		streamCurrent?: (credentialId: string, snapshot: QuotaSnapshot) => boolean;
		/** Model-specific transport constraints are checked on the same credential as quota. */
		isEligible?: (config: T, model?: string) => boolean;
		/** Source owner decides comparable balance authority; generic windows/errors stay separate. */
		balanceSources?: (
			probe: QuotaSnapshot | undefined,
			stream: QuotaSnapshot | undefined,
			now: number,
			streamMaxAgeMs: number,
		) => { probe: boolean; stream: boolean };
	} = {},
): CredentialRouting {
	function state(group: SourceGroupView, now: number, model?: string) {
		const config = configOf(group);
		const stored = peekProviderKeyStore()?.listGroup(group.id) ?? [];
		const keys = stored.length
			? stored.filter((key) => !key.disabled && !!key.apiKey)
			: config?.apiKey
				? [{ id: group.id, apiKey: config.apiKey, label: "", priority: 0 }]
				: [];
		const candidates = keys.map((key) => {
			const current = config && withProviderKey(config, key);
			const failure = keyCooldown(key.id, now, false);
			const cachedStream =
				current && options.streamIdentity
					? quotaStore.peekForIdentity(key.id, options.streamIdentity(current), STREAM_QUOTA_SOURCE)
					: undefined;
			const stream =
				cachedStream && options.streamCurrent?.(key.id, cachedStream) !== false
					? cachedStream
					: undefined;
			const probe =
				current &&
				(options.probeSnapshot
					? options.probeSnapshot(key.id)
					: quotaStore.peekForIdentity(key.id, identity(current)));
			const balances = options.balanceSources?.(probe, stream, now, STREAM_BALANCE_MAX_AGE_MS);
			const block = combine([
				{ blocked: !!current && options.isEligible?.(current, model) === false },
				{
					blocked: !!failure && failure.reason !== "rate_limited",
					until: failure?.until,
				},
				quotaBlock(probe, now, !options.probeBalanceIsFallback && (balances?.probe ?? true)),
				// Only the owner's comparable NUG balance choice changes; windows remain independent.
				quotaBlock(
					stream,
					now,
					balances?.stream ?? (!!stream && now - stream.fetchedAt < STREAM_BALANCE_MAX_AGE_MS),
				),
			]);
			return { key, block, rateLimited: failure?.reason === "rate_limited" };
		});
		return {
			candidates,
			cli: stored.length === 0 && !config?.apiKey && !!options.allowUnconfigured,
		};
	}
	return {
		hasAvailableCredentials(group, now, model) {
			const { candidates, cli } = state(group, now, model);
			return cli || candidates.some(({ block }) => !block.blocked);
		},
		routingPreview(group, now) {
			const { candidates } = state(group, now);
			const ready = candidates.filter(({ block }) => !block.blocked);
			const reset = candidates.reduce<number | undefined>((earliest, { block }) => {
				if (block.until === undefined) return earliest;
				return earliest === undefined ? block.until : Math.min(earliest, block.until);
			}, undefined);
			// Cooling pools still fall back to a key; its label is independent of availability.
			const chosen =
				ready.find(({ rateLimited }) => !rateLimited) ??
				ready[0] ??
				candidates.find(({ block }) => block.until === reset) ??
				candidates[0];
			return {
				...(chosen?.key.label ? { label: chosen.key.label } : {}),
				...(!ready.length && reset !== undefined ? { resetsAt: reset } : {}),
			};
		},
	};
}
