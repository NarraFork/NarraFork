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
	hasAvailableCredentials: (group: SourceGroupView, now: number) => boolean;
	routingPreview: (group: SourceGroupView, now: number) => RoutingPreview | null;
}

type KeyConfig = { apiKey: string };
type Block = { blocked: boolean; until?: number };

/** Unknown/error/unlimited balances are not zero; different currencies may fund a request. */
function quotaBlock(snapshot: QuotaSnapshot | undefined, now: number): Block {
	if (!snapshot || snapshot.error) return { blocked: false };
	const balances = snapshot.balances;
	if (
		balances.length > 0 &&
		balances.every(
			(balance) =>
				!balance.unlimited &&
				typeof balance.remaining === "number" &&
				Number.isFinite(balance.remaining) &&
				balance.remaining <= 0,
		)
	) {
		return { blocked: true };
	}
	const exhausted = snapshot.windows.filter(
		(window) =>
			typeof window.usedRatio === "number" &&
			window.usedRatio >= 1 &&
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
		streamIdentity?: (config: T) => string;
	} = {},
): CredentialRouting {
	function state(group: SourceGroupView, now: number) {
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
			const block = combine([
				{
					blocked: !!failure && failure.reason !== "rate_limited",
					until: failure?.until,
				},
				quotaBlock(current && quotaStore.peekForIdentity(key.id, identity(current)), now),
				quotaBlock(
					current && options.streamIdentity
						? quotaStore.peekForIdentity(
								key.id,
								options.streamIdentity(current),
								STREAM_QUOTA_SOURCE,
							)
						: undefined,
					now,
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
		hasAvailableCredentials(group, now) {
			const { candidates, cli } = state(group, now);
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
