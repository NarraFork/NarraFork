/**
 * agent-message-origin.test.ts — attribution for a message one agent sent another.
 *
 * A `Send` to a subagent is delivered through the recipient's USER-message pipeline,
 * so by the time it is persisted it is indistinguishable from something a human
 * typed: same text, and a `created_by` naming whoever's session triggered the send.
 * That is why the subagent's page used to sign a machine's words with a real
 * person's avatar. These tests pin the registry that carries the sender's identity
 * from send time to write time, and the safety rules that keep an unclaimed
 * attribution from landing on an unrelated message.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessageSender } from "../agent-message-origin";
import {
	buildAgentMessageOrigin,
	claimAgentMessageOrigin,
	clearAgentMessageOrigins,
	pendingAgentMessageOriginCount,
	registerAgentMessageOrigin,
} from "../agent-message-origin";

const PARENT: AgentMessageSender = {
	id: "narr-parent-0001",
	title: "Refactor the lease path",
	label: "refactor-the-lease-path",
	type: null,
	isParent: true,
};

const SIBLING: AgentMessageSender = {
	id: "narr-sibling-0002",
	title: null,
	label: "explore-1",
	type: "explore",
	isParent: false,
};

beforeEach(() => {
	clearAgentMessageOrigins();
});

describe("buildAgentMessageOrigin", () => {
	test("attributes the turn to an AI, never to the triggering human", () => {
		// `role` must stay "user" (it is the recipient's next turn), so `origin` is the
		// only field that can say a machine wrote this.
		expect(buildAgentMessageOrigin(PARENT).origin).toBe("assistant");
	});

	test("carries the sender's title as the label detail", () => {
		expect(buildAgentMessageOrigin(PARENT).originLabel).toBe(
			"agentMessage:Refactor the lease path",
		);
	});

	test("falls back to the alias for an untitled sender rather than a nanoid", () => {
		// A bare id is not a name, and it is what the header would otherwise show.
		expect(buildAgentMessageOrigin(SIBLING).originLabel).toBe("agentMessage:explore-1");
	});

	test("falls back to the id only when there is neither title nor alias", () => {
		const nameless: AgentMessageSender = { id: "narr-x", label: "  ", isParent: false };
		expect(buildAgentMessageOrigin(nameless).originLabel).toBe("agentMessage:narr-x");
	});

	test("uses the alias when the title is only whitespace", () => {
		const padded: AgentMessageSender = { ...SIBLING, title: "   " };
		expect(buildAgentMessageOrigin(padded).originLabel).toBe("agentMessage:explore-1");
	});
});

describe("register / claim", () => {
	test("the recipient's write claims what the sender registered", () => {
		registerAgentMessageOrigin("sub-1", "[Message from the parent narrator]\nrebase it", PARENT);
		const claimed = claimAgentMessageOrigin(
			"sub-1",
			"[Message from the parent narrator]\nrebase it",
		);
		expect(claimed).toEqual({
			origin: "assistant",
			originLabel: "agentMessage:Refactor the lease path",
		});
	});

	test("an ordinary human message finds nothing, so the persistence layer can always ask", () => {
		expect(claimAgentMessageOrigin("sub-1", "please fix the test")).toBeNull();
	});

	test("consume-once: a second write with the same text is not attributed to the sender", () => {
		// Otherwise a human typing the same words later would be labelled as the agent.
		registerAgentMessageOrigin("sub-1", "same words", PARENT);
		expect(claimAgentMessageOrigin("sub-1", "same words")).not.toBeNull();
		expect(claimAgentMessageOrigin("sub-1", "same words")).toBeNull();
	});

	test("two sends of identical text yield two attributions, in order", () => {
		// A relayed decision legitimately repeats text; collapsing them would leave the
		// second row unattributed.
		registerAgentMessageOrigin("sub-1", "go", PARENT);
		registerAgentMessageOrigin("sub-1", "go", SIBLING);
		expect(claimAgentMessageOrigin("sub-1", "go")?.originLabel).toBe(
			"agentMessage:Refactor the lease path",
		);
		expect(claimAgentMessageOrigin("sub-1", "go")?.originLabel).toBe("agentMessage:explore-1");
		expect(claimAgentMessageOrigin("sub-1", "go")).toBeNull();
	});

	test("keyed per recipient: one subagent cannot claim another's attribution", () => {
		registerAgentMessageOrigin("sub-1", "shared text", PARENT);
		expect(claimAgentMessageOrigin("sub-2", "shared text")).toBeNull();
		expect(claimAgentMessageOrigin("sub-1", "shared text")).not.toBeNull();
	});

	test("keyed on the exact delivered text, prefix included", () => {
		// The registry is keyed on what persistence actually receives; the un-prefixed
		// body is a different string and must not match.
		registerAgentMessageOrigin("sub-1", "[Message from the parent narrator]\nbody", PARENT);
		expect(claimAgentMessageOrigin("sub-1", "body")).toBeNull();
	});

	test("clear drops everything, so a teardown cannot leak into the next session", () => {
		registerAgentMessageOrigin("sub-1", "a", PARENT);
		registerAgentMessageOrigin("sub-2", "b", SIBLING);
		expect(pendingAgentMessageOriginCount()).toBe(2);
		clearAgentMessageOrigins();
		expect(pendingAgentMessageOriginCount()).toBe(0);
	});
});

describe("bounded retention", () => {
	test("keeps the pending set capped so dropped deliveries cannot grow it forever", () => {
		// A send whose message never reaches a turn (target archived, queue cleared on
		// finalize) leaves its attribution unclaimed. That is expected; unbounded growth
		// is not.
		for (let i = 0; i < 900; i++) {
			registerAgentMessageOrigin(`sub-${i}`, `message ${i}`, PARENT);
		}
		expect(pendingAgentMessageOriginCount()).toBeLessThanOrEqual(500);
	});

	test("eviction is oldest-first, so the newest sends stay claimable", () => {
		for (let i = 0; i < 700; i++) {
			registerAgentMessageOrigin(`sub-${i}`, `message ${i}`, PARENT);
		}
		// The most recent registration is the one whose write is still pending.
		expect(claimAgentMessageOrigin("sub-699", "message 699")).not.toBeNull();
		// The oldest were evicted to honour the cap.
		expect(claimAgentMessageOrigin("sub-0", "message 0")).toBeNull();
	});
});
