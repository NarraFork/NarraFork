import type {
	ElementNode,
	FileStatistics,
	ImportExportInfo,
	LocatedNode,
	OutlineNode,
	ProviderSupport,
	StructDocument,
	StructPosition,
	StructSelector,
} from "./provider";

export type StructuralOperation =
	| "supports"
	| "outline"
	| "locate"
	| "enclosing"
	| "imports"
	| "statistics"
	| "elementTree"
	| "explainLimitation";

export interface StructuralResultMap {
	supports: ProviderSupport;
	outline: { nodes: OutlineNode[]; truncated: boolean };
	locate: LocatedNode[];
	enclosing: LocatedNode[];
	imports: ImportExportInfo;
	statistics: FileStatistics | null;
	elementTree: ElementNode[] | null;
	explainLimitation: string | null;
}

export interface StructuralTaskArgs {
	selector?: StructSelector;
	position?: StructPosition;
}

export type StructuralTask =
	| {
			operation: StructuralOperation;
			doc: Omit<StructDocument, "signal">;
			args?: StructuralTaskArgs;
	  }
	| { operation: "verifyGrammar"; bytes: Uint8Array };

export interface StructuralWorkerRequest {
	requestId: string;
	generation: number;
	task: StructuralTask;
}

export const STRUCTURAL_INPUT_LIMIT = 2 * 1024 * 1024;
export const STRUCTURAL_METADATA_LIMIT = 64 * 1024;
export const STRUCTURAL_GRAMMAR_LIMIT = 8 * 1024 * 1024;
export const STRUCTURAL_RESULT_LIMIT = 8 * 1024 * 1024;

export const STRUCTURAL_ERROR_MESSAGES = {
	STRUCTURAL_WORKER_DISABLED: "Structural worker is disabled",
	STRUCTURAL_WORKER_CLOSED: "Structural worker is shut down",
	STRUCTURAL_WORKER_STARTUP: "Structural worker could not become ready",
	STRUCTURAL_WORKER_EXITED: "Structural worker exited unexpectedly",
	STRUCTURAL_WORKER_PROTOCOL: "Structural worker returned an invalid response",
	STRUCTURAL_WORKER_TIMEOUT: "Structural worker deadline exceeded",
	STRUCTURAL_WORKER_CANCELLED: "Structural worker task was cancelled",
	STRUCTURAL_WORKER_STALE: "Structural worker generation was invalidated",
	STRUCTURAL_WORKER_QUEUE_FULL: "Structural worker queue budget exceeded",
	STRUCTURAL_INPUT_TOO_LARGE: "Structural worker input exceeds its byte budget",
	STRUCTURAL_RESULT_TOO_LARGE: "Structural worker result exceeds its byte budget",
	STRUCTURAL_TASK_FAILED: "Structural worker computation failed",
} as const;
export type StructuralErrorCode = keyof typeof STRUCTURAL_ERROR_MESSAGES;

export class StructuralWorkerError extends Error {
	constructor(readonly code: StructuralErrorCode) {
		super(STRUCTURAL_ERROR_MESSAGES[code]);
		this.name = "StructuralWorkerError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const kinds = new Set([
	"function",
	"method",
	"class",
	"interface",
	"struct",
	"enum",
	"trait",
	"impl",
	"type",
	"constant",
	"variable",
	"property",
	"field",
	"module",
	"namespace",
	"constructor",
	"getter",
	"setter",
	"test",
	"call",
	"unknown",
]);
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const nonnegative = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown) =>
	Array.isArray(value) && value.every((v) => typeof v === "string");
const optional = (value: unknown, check: (value: unknown) => boolean) =>
	value === undefined || check(value);
const text = (value: unknown) => typeof value === "string";
const kind = (value: unknown) => typeof value === "string" && kinds.has(value);

function located(value: unknown): boolean {
	return (
		isRecord(value) &&
		kind(value.kind) &&
		text(value.name) &&
		text(value.symbolPath) &&
		nonnegative(value.startIndex) &&
		nonnegative(value.endIndex) &&
		(value.endIndex as number) >= (value.startIndex as number) &&
		positive(value.startLine) &&
		positive(value.endLine) &&
		(value.endLine as number) >= (value.startLine as number) &&
		typeof value.exported === "boolean" &&
		optional(value.signature, text) &&
		optional(value.modifiers, strings)
	);
}

/** Iterative validation also bounds adversarial response nesting and node counts. */
function tree(value: unknown, element: boolean): boolean {
	if (!Array.isArray(value)) return false;
	const pending: unknown[] = [...value];
	let count = 0;
	while (pending.length) {
		if (++count > 100_000) return false;
		const node = pending.pop();
		if (!isRecord(node) || !text(node.name)) return false;
		if (element) {
			if (
				!positive(node.line) ||
				!positive(node.endLine) ||
				!optional(node.attributes, strings) ||
				!optional(node.html, (v) => typeof v === "boolean") ||
				!optional(node.condition, (v) =>
					["and", "ternary", "map", "optional"].includes(v as string),
				)
			)
				return false;
		} else if (
			!kind(node.kind) ||
			!positive(node.startLine) ||
			!positive(node.endLine) ||
			!nonnegative(node.depth) ||
			typeof node.exported !== "boolean" ||
			!optional(node.signature, text) ||
			!optional(node.modifiers, strings) ||
			!optional(node.bindings, strings) ||
			!optional(node.initializer, text) ||
			!optional(node.refs, nonnegative)
		)
			return false;
		if (node.children !== undefined) {
			if (!Array.isArray(node.children)) return false;
			for (const child of node.children) pending.push(child);
		}
	}
	return true;
}

export function isStructuralResult(
	operation: StructuralTask["operation"],
	value: unknown,
): boolean {
	switch (operation) {
		case "supports":
			return value === "full" || value === "degraded" || value === "no";
		case "explainLimitation":
		case "verifyGrammar":
			return value === null || typeof value === "string";
		case "outline":
			return isRecord(value) && typeof value.truncated === "boolean" && tree(value.nodes, false);
		case "locate":
		case "enclosing":
			return Array.isArray(value) && value.every(located);
		case "elementTree":
			return value === null || tree(value, true);
		case "imports":
			return (
				isRecord(value) &&
				Array.isArray(value.imports) &&
				Array.isArray(value.exports) &&
				value.imports.every(
					(item) =>
						isRecord(item) &&
						text(item.module) &&
						positive(item.line) &&
						optional(item.form, text) &&
						optional(
							item.names,
							(v) =>
								Array.isArray(v) &&
								v.every((n) => isRecord(n) && text(n.local) && optional(n.original, text)),
						),
				) &&
				value.exports.every(
					(item) =>
						isRecord(item) &&
						text(item.name) &&
						kind(item.kind) &&
						positive(item.line) &&
						optional(item.from, text),
				)
			);
		case "statistics":
			return (
				value === null ||
				(isRecord(value) &&
					typeof value.truncated === "boolean" &&
					["identifiers", "calls", "elements"].every(
						(key) =>
							Array.isArray(value[key]) &&
							(value[key] as unknown[]).every(
								(item) =>
									isRecord(item) &&
									text(item.name) &&
									nonnegative(item.count) &&
									optional(item.lines, (v) => Array.isArray(v) && v.every(positive)),
							),
					))
			);
	}
}
