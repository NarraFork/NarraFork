/**
 * Model aggregations (`__agg__:<id>`) give way to `auto:<model>` values
 * (docs/PROVIDER-SOURCING-DESIGN.md §11). Pure rules; the host applies them.
 *
 * - `__agg__:<id>:<prefix>:<model>` (a member pinned inside an aggregation) becomes that
 *   member, `<prefix>:<model>`.
 * - `__agg__:<id>` whose members all strongly match one catalog model becomes
 *   `auto:<model>`.
 * - Any other aggregation (members of different models, or a member outside the catalog)
 *   becomes its first enabled member, or its first member when none is enabled.
 * - An aggregation that no longer exists, or has no members, has nothing to become: the
 *   value is left as it is and reported, so the caller can decide (it still resolves to the
 *   default model, as it does today).
 */

import { autoModelValue } from "./auto-model";

export const AGGREGATION_VALUE_PREFIX = "__agg__:";

export interface AggregationForMigration {
	id: string;
	models: readonly string[];
}

export interface MemberIdentity {
	/** Catalog model id, when the member is an exact or alias match. */
	strongModelId?: string;
	/** The member's provider is disabled now. */
	disabled?: boolean;
}

export type AggregationMigration =
	| { kind: "unchanged" }
	| { kind: "pinned" | "auto" | "first-member"; value: string }
	| { kind: "missing"; aggregationId: string };

export function migrateAggregationValue(
	value: string,
	aggregations: ReadonlyMap<string, AggregationForMigration>,
	identify: (member: string) => MemberIdentity,
): AggregationMigration {
	if (!value.startsWith(AGGREGATION_VALUE_PREFIX)) return { kind: "unchanged" };
	const rest = value.slice(AGGREGATION_VALUE_PREFIX.length);
	const colon = rest.indexOf(":");
	if (colon > 0) {
		const pinned = rest.slice(colon + 1);
		if (pinned.includes(":")) return { kind: "pinned", value: pinned };
	}
	const id = colon > 0 ? rest.slice(0, colon) : rest;
	const aggregation = aggregations.get(id);
	const members = aggregation?.models.filter((member) => member.trim()) ?? [];
	if (members.length === 0) return { kind: "missing", aggregationId: id };

	const identities = members.map(identify);
	const modelIds = new Set(identities.map((identity) => identity.strongModelId));
	const [only] = modelIds;
	if (modelIds.size === 1 && only) return { kind: "auto", value: autoModelValue(only) };

	const firstEnabled = members.find((_, index) => !identities[index]?.disabled);
	return { kind: "first-member", value: firstEnabled ?? (members[0] as string) };
}
