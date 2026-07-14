import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentReplyScope,
	clearPendingAgentReplyWaits,
	getPendingAgentReplyCount,
	hasPendingAgentReply,
	registerAgentReplyWait,
	resolvePendingAgentReply,
} from "../agent-reply-waiter";

const REQUESTER_ID = "requester-narrator";
const RESPONDER_ID = "responder-narrator";
const TEAM_SCOPE: AgentReplyScope = { type: "team", id: "parent-narrator" };
const OTHER_SCOPE: AgentReplyScope = { type: "chat-group", id: "group-1" };

afterEach(() => {
	clearPendingAgentReplyWaits();
});

describe("agent Send reply waiter", () => {
	test("matches an explicit request id and consumes only that waiter", async () => {
		const first = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});
		const second = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});

		expect(getPendingAgentReplyCount(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(2);
		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				replyTo: second.requestId,
				message: "Second answer arrived first.",
			}),
		).toEqual({ matched: true, requestId: second.requestId });
		expect(await second.promise).toMatchObject({
			status: "replied",
			message: "Second answer arrived first.",
		});
		expect(getPendingAgentReplyCount(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(1);

		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				replyTo: first.requestId,
				message: "First answer arrived second.",
			}),
		).toEqual({ matched: true, requestId: first.requestId });
		expect(await first.promise).toMatchObject({
			status: "replied",
			message: "First answer arrived second.",
		});
	});

	test("rejects wrong responder and wrong scope for an explicit request", () => {
		const wait = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});

		expect(
			resolvePendingAgentReply({
				fromNarratorId: "another-narrator",
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				replyTo: wait.requestId,
				message: "Wrong responder",
			}),
		).toMatchObject({ matched: false, error: expect.stringContaining("not the requested") });
		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: OTHER_SCOPE,
				replyTo: wait.requestId,
				message: "Wrong scope",
			}),
		).toMatchObject({ matched: false, error: expect.stringContaining("scope") });
		expect(hasPendingAgentReply(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(true);
	});

	test("legacy fallback works only when pair and scope have one pending request", async () => {
		const wait = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});
		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				message: "Legacy answer",
			}),
		).toEqual({ matched: true, requestId: wait.requestId });
		expect(await wait.promise).toMatchObject({ status: "replied", message: "Legacy answer" });
	});

	test("legacy fallback reports ambiguity without consuming either waiter", () => {
		registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});
		registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});

		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				message: "Ambiguous",
			}),
		).toMatchObject({ matched: false, ambiguous: true });
		expect(getPendingAgentReplyCount(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(2);
	});

	test("an expired request id cannot consume a newer waiter", async () => {
		const expired = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
			timeoutMs: 5,
		});
		expect(await expired.promise).toEqual({ status: "timeout" });
		const fresh = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
		});

		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				replyTo: expired.requestId,
				message: "Too late",
			}),
		).toMatchObject({ matched: false, error: expect.stringContaining("expired") });
		expect(hasPendingAgentReply(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(true);
		fresh.cancel();
	});

	test("cleans up when the caller is interrupted", async () => {
		const controller = new AbortController();
		const wait = registerAgentReplyWait({
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
			signal: controller.signal,
		});

		controller.abort();
		expect(await wait.promise).toEqual({ status: "aborted" });
		expect(hasPendingAgentReply(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(false);
	});
});
