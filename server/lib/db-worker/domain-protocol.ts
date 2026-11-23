import { DbReadError } from "./errors";
import type { ReadBudgetMeter } from "./read-budget";

export interface DomainReadTaskMap {
	readerProbe: { params: null; result: { ready: true } };
}
export type DomainReadTaskKind = keyof DomainReadTaskMap;
export type DomainReadParams = {
	[K in DomainReadTaskKind]: { kind: "domainRead"; task: K; input: DomainReadTaskMap[K]["params"] };
}[DomainReadTaskKind];
interface DomainDefinition {
	maxInputBytes: number;
	maxResultBytes: number;
	maxInputArrayItems?: number;
	maxArrayItems: number;
	validate(input: unknown): boolean;
	validateResult?(result: unknown): boolean;
}
const SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const DOMAIN_READ_DEFINITIONS: { [K in DomainReadTaskKind]: DomainDefinition } = {
	readerProbe: {
		maxInputBytes: 128 * 1024,
		maxResultBytes: SNAPSHOT_BYTES,
		maxArrayItems: 10_000,
		validate: (input) => input === null,
	},
};
/** Validate structure before clone; numeric DTO budgets are observations, without serialization. */
export function checkDomainBudget(
	value: unknown,
	maxBytes: number,
	maxArrayItems: number,
	meter?: ReadBudgetMeter,
	phase: "input" | "result" = "result",
): number {
	let bytes = 0;
	const visiting = new Set<object>();
	const walk = (item: unknown, depth: number): void => {
		if (depth > 32)
			throw new DbReadError("DB_READ_BUDGET", "Domain read exceeded its nesting budget");
		bytes += 16;
		if (typeof item === "string") bytes += Buffer.byteLength(item);
		else if (item instanceof Uint8Array) bytes += item.byteLength;
		else if (item && typeof item === "object") {
			if (visiting.has(item)) throw new DbReadError("DB_READ_INVALID", "Invalid domain read value");
			if (Array.isArray(item))
				meter?.observe(
					phase === "input" ? "domainInputItems" : "domainResultItems",
					item.length,
					maxArrayItems,
					phase,
				);
			visiting.add(item);
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				bytes += Buffer.byteLength(key);
				walk((item as Record<string, unknown>)[key], depth + 1);
			}
			visiting.delete(item);
		} else if (typeof item === "function" || typeof item === "symbol")
			throw new DbReadError("DB_READ_INVALID", "Invalid domain read value");
		meter?.observe(
			phase === "input" ? "domainInputBytes" : "domainResultBytes",
			bytes,
			maxBytes,
			phase,
		);
	};
	walk(value, 0);
	return bytes;
}
export function validateDomainRead(
	params: DomainReadParams,
	meter?: ReadBudgetMeter,
): DomainDefinition {
	if (!Object.hasOwn(DOMAIN_READ_DEFINITIONS, params.task))
		throw new DbReadError("DB_READ_UNSUPPORTED", "Unregistered database read task");
	const definition = DOMAIN_READ_DEFINITIONS[params.task];
	checkDomainBudget(
		params.input,
		definition.maxInputBytes,
		definition.maxInputArrayItems ?? definition.maxArrayItems,
		meter,
		"input",
	);
	if (!definition.validate(params.input))
		throw new DbReadError("DB_READ_INVALID", "Invalid domain read parameters");
	return definition;
}
/** Keep generic task/input pairing checked before erasing it into the discriminated wire union. */
export function createDomainReadParams<K extends DomainReadTaskKind>(
	task: K,
	input: DomainReadTaskMap[K]["params"],
): DomainReadParams {
	const request = { kind: "domainRead", task, input } as DomainReadParams;
	validateDomainRead(request);
	return request;
}
