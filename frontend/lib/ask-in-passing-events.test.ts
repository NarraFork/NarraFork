import { expect, test } from "bun:test";
import {
	type AskInPassingEvent,
	publishAskInPassingEvent,
	subscribeAskInPassingEvents,
} from "./ask-in-passing-events";

test("canonical acknowledgement subscriptions detach without leaking between documents", () => {
	const events: AskInPassingEvent[] = [];
	const unsubscribe = subscribeAskInPassingEvents((event) => events.push(event));
	const event: AskInPassingEvent = { kind: "deleted", narratorId: "n", messageId: "ask" };
	publishAskInPassingEvent(event);
	unsubscribe();
	unsubscribe();
	publishAskInPassingEvent(event);
	expect(events).toEqual([event]);
});
