import { beforeEach, describe, expect, test } from "bun:test";
import {
	approveKitRequest,
	consumeKitApproval,
	dismissKitRequest,
	getKitRequest,
	hasKitApproval,
	requestKitBuild,
	resetKitRequestsForTest,
	suggestKitBuild,
} from "./kit-requests";

beforeEach(() => resetKitRequestsForTest());

describe("component kit confirmation gate", () => {
	test("a build is approved only by an explicit confirmation of this narrator's request", () => {
		expect(hasKitApproval("n", "w")).toBe(false);
		const request = requestKitBuild("n", "w", "build", "no kit yet");
		expect(request?.state).toBe("pending");
		// Asking is not approving.
		expect(hasKitApproval("n", "w")).toBe(false);
		// Another narrator cannot approve with a known id.
		expect(approveKitRequest("other", request?.id ?? "")).toBeNull();
		expect(approveKitRequest("n", "wrong-id")).toBeNull();
		expect(hasKitApproval("n", "w")).toBe(false);
		expect(approveKitRequest("n", request?.id ?? "")).toMatchObject({
			newlyApproved: true,
			request: { state: "approved" },
		});
		expect(hasKitApproval("n", "w")).toBe(true);
		// The approval is scoped to the workspace it was requested for.
		expect(hasKitApproval("n", "other-workspace")).toBe(false);
	});

	test("repeated asks reuse the open request; a second confirmation does not re-notify", () => {
		const first = requestKitBuild("n", "w", "update", "stale");
		const again = requestKitBuild("n", "w", "build", "different reason");
		expect(again?.id).toBe(first?.id);
		expect(again?.kind).toBe("update");
		approveKitRequest("n", first?.id ?? "");
		expect(approveKitRequest("n", first?.id ?? "")?.newlyApproved).toBe(false);
		expect(getKitRequest("n", "w")?.state).toBe("approved");
	});

	test("a successful build spends the approval", () => {
		const request = requestKitBuild("n", "w", "build", "r");
		approveKitRequest("n", request?.id ?? "");
		consumeKitApproval("n", "w");
		expect(hasKitApproval("n", "w")).toBe(false);
		expect(getKitRequest("n", "w")).toBeNull();
		// The next build needs a new request with a new id.
		expect(requestKitBuild("n", "w", "update", "r")?.id).not.toBe(request?.id);
	});

	test("a declined prompt is not shown again unless the agent asks explicitly", () => {
		const request = requestKitBuild("n", "w", "build", "r");
		expect(dismissKitRequest("n", request?.id ?? "")).toBe(true);
		expect(getKitRequest("n", "w")).toBeNull();
		// Passive suggestion (a render noticed there is no kit): stay quiet.
		expect(requestKitBuild("n", "w", "build", "r")).toBeNull();
		expect(approveKitRequest("n", request?.id ?? "")).toBeNull();
		// The agent called kit_build itself: ask again, with a fresh request.
		const explicit = requestKitBuild("n", "w", "build", "r", true);
		expect(explicit?.state).toBe("pending");
		expect(explicit?.id).not.toBe(request?.id);
	});

	test("a passive suggestion is returned only by the call that creates it", () => {
		const first = suggestKitBuild("n", "w", "build", "no kit");
		expect(first?.state).toBe("pending");
		// Already asked: later results carry no prompt, but the request stays answerable.
		expect(suggestKitBuild("n", "w", "build", "no kit")).toBeNull();
		expect(getKitRequest("n", "w")?.id).toBe(first?.id as string);
		approveKitRequest("n", first?.id ?? "");
		expect(suggestKitBuild("n", "w", "update", "stale")).toBeNull();
		expect(hasKitApproval("n", "w")).toBe(true);
		// Declined in another workspace: that one is never suggested again either.
		const other = suggestKitBuild("n", "w2", "build", "no kit");
		dismissKitRequest("n", other?.id ?? "");
		expect(suggestKitBuild("n", "w2", "build", "no kit")).toBeNull();
		expect(getKitRequest("n", "w2")).toBeNull();
	});

	test("an approved request cannot be dismissed out from under the agent", () => {
		const request = requestKitBuild("n", "w", "build", "r");
		approveKitRequest("n", request?.id ?? "");
		expect(dismissKitRequest("n", request?.id ?? "")).toBe(false);
		expect(hasKitApproval("n", "w")).toBe(true);
	});
});
