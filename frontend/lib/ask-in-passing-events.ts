import type { TreeMessage } from "./api/types";

export type AskInPassingEvent =
	| { kind: "start"; narratorId: string; message: TreeMessage; focus: true }
	| { kind: "resolved"; narratorId: string; message: TreeMessage }
	| { kind: "deleted"; narratorId: string; messageId: string };

const listeners = new Set<(event: AskInPassingEvent) => void>();

/** HTTP acknowledgements share the document's canonical WS mutation paths. */
export function publishAskInPassingEvent(event: AskInPassingEvent): void {
	for (const listener of listeners) listener(event);
}

export function subscribeAskInPassingEvents(
	listener: (event: AskInPassingEvent) => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
