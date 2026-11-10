export const MODEL_JSON_CONTAINER_BYTES = 256;
export const MODEL_JSON_SLOT_BYTES = 32;

/** Only allocation failures may be translated into a history-size recovery error. */
export class ModelJsonBudgetError extends Error {}

/** One estimate for the complete preparation, including reused rows. This is not an RSS cap. */
export class ModelHistoryBudget {
	preparedBytes = 0;

	constructor(
		readonly maxBytes: number,
		private readonly signal?: AbortSignal,
	) {}

	check = (): void => {
		this.signal?.throwIfAborted();
	};

	/** Reserve wire/UTF-16/projection overhead before fetching a body, or known reused costs. */
	reserve(rawBytes = 0, rows = 0, jsonContainerBytes = 0): void {
		this.check();
		const next = this.preparedBytes + rawBytes * 4 + rows * 1024 + jsonContainerBytes;
		if (next > this.maxBytes)
			throw new ModelJsonBudgetError(
				`Model history preparation exceeded estimated ${this.maxBytes} byte budget`,
			);
		this.preparedBytes = next;
	}

	/** Each value pays its graph cost before JSON.parse, not after a row or batch is assembled. */
	parse(raw: unknown): { value: unknown; jsonContainerBytes: number } {
		const jsonContainerBytes = modelJsonContainerBytes(
			raw,
			this.maxBytes - this.preparedBytes,
			this.check,
		);
		this.reserve(0, 0, jsonContainerBytes);
		return { value: typeof raw === "string" ? JSON.parse(raw) : raw, jsonContainerBytes };
	}
}

export interface ModelJsonShapeOptions {
	/** The caller owns cancellation/deadlines; this scanner only enforces allocation limits. */
	check?: () => void;
	maxBytes?: number;
	maxContainerSlots?: number;
}
export interface ModelJsonShape {
	bytes: number;
	containers: number;
	slots: number;
	maxContainerSlots: number;
}

/**
 * Pure lexical preflight, BEFORE JSON.parse. Reserve objects/arrays AND primitive/property slots
 * across the worker, cloned source and provider views. Braces/commas/colons in strings are data.
 * This is an allocation guard, not a JSON validator; JSON.parse still validates accepted input.
 */
export function measureModelJsonShape(
	raw: unknown,
	options: ModelJsonShapeOptions = {},
): ModelJsonShape {
	options.check?.();
	const shape: ModelJsonShape = { bytes: 0, containers: 0, slots: 0, maxContainerSlots: 0 };
	if (typeof raw !== "string") return shape;
	const maxBytes = Math.min(options.maxBytes ?? 128 * 1024 * 1024, 128 * 1024 * 1024);
	const maxContainerSlots = options.maxContainerSlots ?? Number.POSITIVE_INFINITY;
	const stack: Array<{ array: boolean; expectingSlot: boolean; slots: number }> = [];
	let quoted = false;
	let nextCheck = 16_384;
	const reserve = (bytes: number) => {
		shape.bytes += bytes;
		if (shape.bytes > maxBytes)
			throw new ModelJsonBudgetError(
				`Model history JSON allocation estimate exceeded remaining ${maxBytes} byte budget`,
			);
	};
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		if (quoted) {
			if (code === 92) index++;
			else if (code === 34) quoted = false;
		} else {
			const parent = stack.at(-1);
			// An array element starts with any value token; an object property starts with its key.
			if (
				parent?.expectingSlot &&
				(parent.array
					? code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 93 && code !== 44
					: code === 34)
			) {
				parent.expectingSlot = false;
				parent.slots++;
				shape.slots++;
				shape.maxContainerSlots = Math.max(shape.maxContainerSlots, parent.slots);
				reserve(MODEL_JSON_SLOT_BYTES);
				if (parent.slots > maxContainerSlots)
					throw new ModelJsonBudgetError(
						"Model history JSON container width exceeded allocation budget",
					);
			}
			if (code === 34) quoted = true;
			else if (code === 123 || code === 91) {
				shape.containers++;
				reserve(MODEL_JSON_CONTAINER_BYTES);
				stack.push({ array: code === 91, expectingSlot: true, slots: 0 });
			} else if (code === 125 || code === 93) stack.pop();
			else if (code === 44 && parent) parent.expectingSlot = true;
		}
		if (index >= nextCheck) {
			nextCheck = index + 16_384;
			options.check?.();
		}
	}
	options.check?.();
	return shape;
}

/** Compatibility name: now reserves all graph slots, not only containers. */
export function modelJsonContainerBytes(
	raw: unknown,
	maxBytes?: number,
	check?: () => void,
): number {
	return measureModelJsonShape(raw, { maxBytes, check }).bytes;
}
