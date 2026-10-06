import { formatLocaleNumber } from "./intl-format";

export interface CompactNumberOptions {
	prefix?: string;
	unit?: string;
	standardFractionDigits?: number;
	compactFractionDigits?: number;
	exactFractionDigits?: number;
	locale?: string;
}

export interface CompactNumberValue {
	compact: string;
	exact: string;
	isCompact: boolean;
}

function formatNumber(value: number, maximumFractionDigits: number, locale?: string): string {
	return formatLocaleNumber(value, { maximumFractionDigits }, locale);
}

function withAffixes(value: string, options: CompactNumberOptions): string {
	const prefixed = `${options.prefix ?? ""}${value}`;
	return options.unit ? `${prefixed} ${options.unit}` : prefixed;
}

export function formatCompactNumber(
	value: number,
	options: CompactNumberOptions = {},
): CompactNumberValue {
	const safeValue = Number.isFinite(value) ? value : 0;
	const absoluteValue = Math.abs(safeValue);
	const compactFractionDigits = options.compactFractionDigits ?? 1;
	const standardFractionDigits = options.standardFractionDigits ?? 0;
	const exactFractionDigits = options.exactFractionDigits ?? standardFractionDigits;

	let scaledValue = safeValue;
	let suffix = "";
	if (absoluteValue >= 1_000_000_000) {
		scaledValue = safeValue / 1_000_000_000;
		suffix = "B";
	} else if (absoluteValue >= 1_000_000) {
		scaledValue = safeValue / 1_000_000;
		suffix = "M";
	} else if (absoluteValue >= 1_000) {
		scaledValue = safeValue / 1_000;
		suffix = "K";
	}

	const compactDigits = suffix ? compactFractionDigits : standardFractionDigits;
	const compact = withAffixes(
		`${formatNumber(scaledValue, compactDigits, options.locale)}${suffix}`,
		options,
	);
	const exact = withAffixes(formatNumber(safeValue, exactFractionDigits, options.locale), options);

	return {
		compact,
		exact,
		isCompact: suffix !== "",
	};
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "-";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

export function formatExactDuration(ms: number | null | undefined, locale?: string | null): string {
	if (ms == null || !Number.isFinite(ms)) return "-";
	return `${formatLocaleNumber(Math.round(ms), {}, locale)} ms`;
}
