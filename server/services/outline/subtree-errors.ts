/**
 * The API error for a read of outline history that cannot be right (pageless outline, H2).
 *
 * The store refuses such a read with `OutlineHistoryUnavailableError` (`store/history-port.ts`)
 * instead of answering with a tree that looks plausible: the space's placements are not built
 * yet, or the seq asked for is below its history floor. Services turn that into
 * {@link OutlineHistoryNotAvailableError}: HTTP 409 with a code per reason
 * (`OUTLINE_HISTORY_NOT_READY`, `OUTLINE_HISTORY_BEFORE_FLOOR`) and the floor in `details`, so
 * a client can say "history starts here" or try again shortly. Reads of the current tree are
 * never refused.
 */
import { AppError } from "@server/lib/errors";
import {
	OUTLINE_HISTORY_ERROR_CODES,
	type OutlineHistoryUnavailableDetails,
} from "@shared/outline-subtree-api";
import { OutlineHistoryUnavailableError } from "./store/history-port";

export class OutlineHistoryNotAvailableError extends AppError {
	declare readonly details: OutlineHistoryUnavailableDetails;

	constructor(details: OutlineHistoryUnavailableDetails) {
		super(
			details.reason === "not-ready"
				? "The history of this outline space is still being prepared; try again shortly"
				: `This outline space keeps no history at or before commit ${details.floorSeq}`,
			409,
			OUTLINE_HISTORY_ERROR_CODES[details.reason],
			undefined,
			details,
		);
		this.name = "OutlineHistoryNotAvailableError";
	}
}

/** Run a read of history, turning the store's refusal into the API error. */
export async function withOutlineHistory<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof OutlineHistoryUnavailableError) {
			throw new OutlineHistoryNotAvailableError({
				reason: error.reason,
				floorSeq: error.floorSeq,
				seq: error.seq,
			});
		}
		throw error;
	}
}
