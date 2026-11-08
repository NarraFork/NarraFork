import {
	MODEL_JSON_CONTAINER_BYTES,
	MODEL_JSON_SLOT_BYTES,
	ModelJsonBudgetError,
	measureModelJsonShape,
} from "../../services/agent-runtime/model-history-json";
import { DISPLAY_PAGE_LIMITS, DisplayPageReadError } from "./display-page-protocol";

/** The imported module is a pure lexical allocation scanner, NOT model-history runtime. */
export class DisplayJsonAllocationBudget {
	private used: number;
	constructor(
		private ceiling: number,
		private deadline: number,
		initialBytes = 0,
	) {
		this.used = initialBytes;
		this.check();
	}
	private check(): void {
		if (Date.now() >= this.deadline)
			throw new DisplayPageReadError(
				"DISPLAY_PAGE_DEADLINE",
				"Display page read exceeded its deadline",
			);
		if (this.used > this.ceiling)
			throw new DisplayPageReadError(
				"DISPLAY_PAGE_BUDGET_EXCEEDED",
				"Display page exceeded the prepared allocation budget; request a smaller history window",
			);
	}
	/** Stored SQL text and its parsed/copied strings conservatively reserve four UTF-8 copies. */
	reserveJson(raw: string, textBytes = 0): void {
		this.used += textBytes * 4;
		this.check();
		try {
			this.used += measureModelJsonShape(raw, {
				check: () => this.check(),
				maxBytes: Math.max(0, this.ceiling - this.used),
				maxContainerSlots: DISPLAY_PAGE_LIMITS.maxContainerSlots,
			}).bytes;
		} catch (error) {
			// Caller deadlines and programming/worker failures are not oversized history.
			if (!(error instanceof ModelJsonBudgetError)) throw error;
			throw new DisplayPageReadError(
				"DISPLAY_PAGE_BUDGET_EXCEEDED",
				"Display page JSON shape exceeded the allocation/width budget; request a smaller history window",
			);
		}
		this.check();
	}
}

/** DTO scalar slots/row containers are outside the stored JSON strings and count too. */
export function storedDisplayAllocationBudget(
	rawBytes: number,
	messageRows: number,
	toolRows: number,
	messageFields: number,
	toolFields: number,
	deadline: number,
	ceiling: number,
): DisplayJsonAllocationBudget {
	return new DisplayJsonAllocationBudget(
		ceiling,
		deadline,
		rawBytes * 4 +
			messageRows * (MODEL_JSON_CONTAINER_BYTES * 3 + (messageFields + 7) * MODEL_JSON_SLOT_BYTES) +
			toolRows * (MODEL_JSON_CONTAINER_BYTES + (toolFields + 3) * MODEL_JSON_SLOT_BYTES),
	);
}
