/** Pure, fixed-cardinality observations. Never retains SQL, binds or result payloads. */
export const READ_BUDGET_KINDS = [
	"sqlBytes",
	"parameterCount",
	"parameterBytes",
	"rows",
	"queryRows",
	"resultBytes",
	"taskBytes",
	"digestEntries",
	"digestExpectedRows",
	"digestExpectedBytes",
	"domainInputBytes",
	"domainInputItems",
	"domainResultBytes",
	"domainResultItems",
] as const;
export type ReadBudgetKind = (typeof READ_BUDGET_KINDS)[number];
export type ReadBudgetPhase = "input" | "result" | "postprocess";
export interface ReadBudgetObservation {
	kind: ReadBudgetKind;
	actual: number;
	threshold: number;
	phase: ReadBudgetPhase;
}
export type ReadBudgetSnapshot = ReadBudgetObservation[];
export class ReadBudgetMeter {
	private readonly observations = new Map<ReadBudgetKind, ReadBudgetObservation>();
	observe(kind: ReadBudgetKind, actual: number, threshold: number, phase: ReadBudgetPhase): void {
		if (!Number.isFinite(actual) || actual < 0 || !Number.isFinite(threshold) || threshold < 0)
			return;
		const previous = this.observations.get(kind);
		if (previous) {
			// A per-query excess must retain one observed actual/threshold pair, not combine pages.
			if (kind === "queryRows") {
				if (actual - threshold > previous.actual - previous.threshold) {
					previous.actual = actual;
					previous.threshold = threshold;
					previous.phase = phase;
				}
				return;
			}
			previous.actual = Math.max(previous.actual, actual);
			previous.threshold = Math.min(previous.threshold, threshold);
			previous.phase = phase;
		} else this.observations.set(kind, { kind, actual, threshold, phase });
	}
	merge(snapshot: ReadBudgetSnapshot | undefined): void {
		if (!Array.isArray(snapshot)) return;
		for (const item of snapshot.slice(0, READ_BUDGET_KINDS.length)) {
			if (
				item &&
				READ_BUDGET_KINDS.includes(item.kind) &&
				(item.phase === "input" || item.phase === "result" || item.phase === "postprocess")
			)
				this.observe(item.kind, item.actual, item.threshold, item.phase);
		}
	}
	snapshot(): ReadBudgetSnapshot {
		return [...this.observations.values()].map((item) => ({ ...item }));
	}
}
/** Exact string JSON size, without allocating an escaped copy of a large string. */
export function jsonStringBytes(value: string): number {
	let bytes = Buffer.byteLength(value) + 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code === 34 ||
			code === 92 ||
			code === 8 ||
			code === 9 ||
			code === 10 ||
			code === 12 ||
			code === 13
		)
			bytes++;
		else if (code < 32) bytes += 5;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) index++;
			else bytes += 3;
		} else if (code >= 0xdc00 && code <= 0xdfff) bytes += 3;
	}
	return bytes;
}
export function readValueBytes(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof Uint8Array) return value.byteLength;
	return 8;
}
export function readRowBytes(row: readonly unknown[]): number {
	let bytes = 8;
	for (const value of row) bytes += readValueBytes(value);
	return bytes;
}
/** Best-effort DTO estimate for postprocessing, with neither serialization nor retained payloads. */
export function estimateReadValueBytes(input: unknown): number {
	const visiting = new Set<object>();
	const walk = (value: unknown, depth: number): number => {
		if (depth > 32) return 16;
		if (!value || typeof value !== "object" || value instanceof Uint8Array)
			return readValueBytes(value) + 16;
		if (visiting.has(value)) return 16;
		visiting.add(value);
		let bytes = 16;
		for (const key in value) {
			if (Object.hasOwn(value, key))
				bytes += Buffer.byteLength(key) + walk((value as Record<string, unknown>)[key], depth + 1);
		}
		visiting.delete(value);
		return bytes;
	};
	return walk(input, 0);
}
