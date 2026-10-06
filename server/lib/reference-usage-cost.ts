/**
 * Non-token reference cost dimensions (images, audio/video seconds, characters,
 * native search queries), estimated from the complete v2 card's own price rows.
 *
 * This is additive to `usage-tracking.ts`, which owns the token amounts actually
 * recorded against a request. It never rewrites those amounts and never reads a
 * gateway billing rule: a reference rate is not what a channel charges.
 */
import type { ModelCard, PriceRow } from "@shared/model-catalog/card";
import type { CostStatus } from "./cost-estimate";

/** Only quantities a protocol actually reported. Absent stays absent, never 0. */
export interface ReferenceUsageDimensions {
	images?: number;
	audioSeconds?: number;
	videoSeconds?: number;
	outputSeconds?: number;
	characters?: number;
	/** Native search queries, keyed by the context size the provider reported. */
	searchQueries?: Partial<Record<"low" | "medium" | "high", number>>;
}

export interface ReferenceUsageLine {
	/** The card price row this line was computed from, for auditability. */
	key: string;
	component: string;
	modality: string;
	unit: string;
	quantity: number;
	/** Exact decimal rate per source unit; null means the card declared unknown. */
	rate: string | null;
	cost: number | null;
}

export interface ReferenceUsageEstimate {
	/** Bump when the allocation rules below change, so old rows stay interpretable. */
	algorithmVersion: 1;
	status: CostStatus;
	/** Sum of the lines with a known rate. Unknown lines are not treated as zero. */
	knownCost: number;
	lines: ReferenceUsageLine[];
	missingFields: string[];
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Decimal multiply without floating point, then convert once at the boundary. */
function lineCost(rate: string, quantity: number): number {
	const [whole, fraction = ""] = rate.split(".");
	const scaled = Number(`${whole}${fraction}`) * quantity;
	return scaled / 10 ** fraction.length;
}

/**
 * Pick the standard-tier row for one dimension. Service tiers and context
 * thresholds are deliberately not guessed here: a request whose tier we cannot
 * confirm reports the dimension as missing instead of borrowing another tier's rate.
 */
function standardRow(card: ModelCard, match: (row: PriceRow) => boolean): PriceRow | undefined {
	const standard = card.view.prices.find((group) => group.tier === "standard");
	return standard?.rows.find((row) => row.thresholdTokens === null && match(row));
}

export function estimateReferenceUsageDimensions(
	card: ModelCard,
	usage: ReferenceUsageDimensions,
): ReferenceUsageEstimate {
	const lines: ReferenceUsageLine[] = [];
	const missingFields: string[] = [];
	const add = (
		label: string,
		quantity: number | undefined,
		row: PriceRow | undefined,
		unit: string,
	) => {
		if (quantity === undefined) return;
		if (!row) {
			missingFields.push(label);
			return;
		}
		lines.push({
			key: row.key,
			component: row.component,
			modality: row.modality,
			unit,
			quantity,
			rate: row.rate,
			cost: row.rate === null ? null : lineCost(row.rate, quantity),
		});
		if (row.rate === null) missingFields.push(label);
	};

	add(
		"images",
		positive(usage.images),
		standardRow(card, (row) => row.unit === "image" && row.component === "input"),
		"image",
	);
	add(
		"audioSeconds",
		positive(usage.audioSeconds),
		standardRow(card, (row) => row.unit === "second" && row.modality === "audio"),
		"second",
	);
	add(
		"videoSeconds",
		positive(usage.videoSeconds),
		standardRow(card, (row) => row.unit === "second" && row.modality === "video"),
		"second",
	);
	add(
		"outputSeconds",
		positive(usage.outputSeconds),
		standardRow(card, (row) => row.unit === "second" && row.component === "output"),
		"second",
	);
	add(
		"characters",
		positive(usage.characters),
		standardRow(card, (row) => row.unit === "character"),
		"character",
	);
	for (const [size, count] of Object.entries(usage.searchQueries ?? {})) {
		add(
			`searchQueries.${size}`,
			positive(count),
			standardRow(
				card,
				(row) => row.component === "search" && row.modality === `search_context_size_${size}`,
			),
			"request",
		);
	}

	const known = lines.filter((line) => line.cost !== null);
	return {
		algorithmVersion: 1,
		// No reported dimension at all is complete-by-vacuity: the token estimate
		// owns that verdict, and an empty extra-dimension set adds no uncertainty.
		status: missingFields.length ? (known.length ? "partial" : "unknown") : "complete",
		knownCost: known.reduce((sum, line) => sum + (line.cost ?? 0), 0),
		lines,
		missingFields: [...new Set(missingFields)],
	};
}

/**
 * Combine the token verdict with the extra dimensions. A zero token rate must not
 * make a request with unpriced image or audio usage look free, so any partial or
 * unknown dimension downgrades the combined status.
 */
export function combineReferenceCostStatus(
	tokenStatus: CostStatus,
	dimensions: ReferenceUsageEstimate,
): CostStatus {
	if (tokenStatus === "complete" && dimensions.status === "complete") return "complete";
	if (tokenStatus === "unknown" && dimensions.status === "unknown") return "unknown";
	return "partial";
}
