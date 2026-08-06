import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentReplyScope,
	beginAgentReplyWaitRun,
	clearPendingAgentReplyWaits,
	getPendingAgentReplyCount,
	getRunningAgentReplyWaitRunSnapshot,
	hasPendingAgentReply,
	registerAgentReplyWait,
	registerAgentReplyWaitFromSnapshot,
	resolvePendingAgentReply,
	waitForAgentReplyWaitRunStability,
} from "../agent-reply-waiter";

const REQUESTER_ID = "requester-narrator";
const RESPONDER_ID = "responder-narrator";
const TEAM_SCOPE: AgentReplyScope = { type: "team", id: "parent-narrator" };
const OTHER_SCOPE: AgentReplyScope = { type: "parent-child", id: "other-pair" };

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

	test("snapshots all reconstruction fields and waits for setup stability", async () => {
		const run = beginAgentReplyWaitRun({
			toolUseId: "send-tool-use",
			requesterId: REQUESTER_ID,
			doInterrupt: true,
		});
		const deadlineAt = new Date(Date.now() + 60_000).toISOString();
		const wait = registerAgentReplyWait({
			requestId: "original-request",
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
			deadlineAt,
			run,
			label: "worker",
			title: "Worker title",
			deliveryNote: "Delivered once.",
			interrupted: true,
		});
		let stabilized = false;
		const stability = waitForAgentReplyWaitRunStability(run.toolUseId).then((snapshot) => {
			stabilized = true;
			return snapshot;
		});
		await Bun.sleep(0);
		expect(stabilized).toBe(false);

		run.markStable();
		const snapshot = await stability;
		expect(snapshot).toEqual({
			toolUseId: "send-tool-use",
			requesterId: REQUESTER_ID,
			doInterrupt: true,
			prefixSections: [],
			prefixTargets: [],
			waiters: [
				{
					toolUseId: "send-tool-use",
					requestId: "original-request",
					requesterId: REQUESTER_ID,
					responderId: RESPONDER_ID,
					scope: TEAM_SCOPE,
					deadlineAt,
					label: "worker",
					title: "Worker title",
					deliveryNote: "Delivered once.",
					interrupted: true,
				},
			],
		});
		expect(getRunningAgentReplyWaitRunSnapshot(run.toolUseId)).toEqual(snapshot);
		wait.cancel();
		run.complete();
	});

	test("restores an explicit request id and absolute deadline without stale cleanup races", async () => {
		const requestId = "stable-request-id";
		const old = registerAgentReplyWait({
			requestId,
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const run = beginAgentReplyWaitRun({
			toolUseId: "restored-send",
			requesterId: REQUESTER_ID,
		});
		const restored = registerAgentReplyWaitFromSnapshot(run, {
			toolUseId: run.toolUseId,
			requestId,
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			deliveryNote: "Already delivered.",
		}) as NonNullable<ReturnType<typeof registerAgentReplyWaitFromSnapshot>>;
		run.markStable();

		expect(await old.promise).toEqual({ status: "cancelled" });
		old.cancel();
		expect(hasPendingAgentReply(REQUESTER_ID, RESPONDER_ID, TEAM_SCOPE)).toBe(true);
		expect(
			resolvePendingAgentReply({
				fromNarratorId: RESPONDER_ID,
				toNarratorId: REQUESTER_ID,
				scope: TEAM_SCOPE,
				replyTo: requestId,
				message: "Restored reply",
			}),
		).toEqual({ matched: true, requestId });
		expect(await restored.promise).toMatchObject({ status: "replied", message: "Restored reply" });
		run.complete();
	});

	test("uses only the remaining time of an absolute restored deadline", async () => {
		const run = beginAgentReplyWaitRun({
			toolUseId: "expired-restored-send",
			requesterId: REQUESTER_ID,
		});
		const restored = registerAgentReplyWaitFromSnapshot(run, {
			toolUseId: run.toolUseId,
			requestId: "expired-restored-request",
			requesterId: REQUESTER_ID,
			responderId: RESPONDER_ID,
			scope: TEAM_SCOPE,
			deadlineAt: new Date(Date.now() - 1).toISOString(),
			deliveryNote: "Already delivered.",
		}) as NonNullable<ReturnType<typeof registerAgentReplyWaitFromSnapshot>>;
		run.markStable();
		expect(await restored.promise).toEqual({ status: "timeout" });
		run.complete();
	});
});
