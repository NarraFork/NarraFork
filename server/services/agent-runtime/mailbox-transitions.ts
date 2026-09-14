import { and, eq } from "drizzle-orm";
import { narratorMessageRefs } from "../../db/schema";
import type { DeliveryState, RuntimeTx } from "./mailbox-types";

/** Update the history ref's delivery projection inside the mailbox transaction. */
export function setDeliveryProjectionStateTx(
	tx: RuntimeTx,
	narratorId: string,
	deliveryId: string,
	state: DeliveryState,
): number {
	return tx
		.update(narratorMessageRefs)
		.set({ deliveryState: state })
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.deliveryId, deliveryId),
			),
		)
		.returning({ id: narratorMessageRefs.id })
		.all().length;
}

/** Mirror a mailbox transition when a legacy row has no delivery identity yet. */
export function mirrorDeliveryStateTx(
	tx: RuntimeTx,
	narratorId: string,
	deliveryId: string | null | undefined,
	state: DeliveryState,
): void {
	if (deliveryId) setDeliveryProjectionStateTx(tx, narratorId, deliveryId, state);
}
