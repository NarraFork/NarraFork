import { describe, expect, test } from "bun:test";
import { openCommunicationRecipient } from "./communication-navigation";

describe("Send receipt navigation", () => {
	test("deleted recipient tombstone cannot navigate to a retained fork's shared message", async () => {
		const notices: string[] = [];
		await openCommunicationRecipient(
			{ id: "child", deliveryMessageId: "old", receiptDisposition: "recipient_deleted" },
			{
				locate: async () => {
					throw new Error("Must not resolve a tombstone");
				},
				open: () => {
					throw new Error("Must not navigate a tombstone");
				},
				notify: (reason) => {
					notices.push(reason);
				},
			},
		);
		expect(notices).toEqual(["unavailable"]);
	});
	test("opens the received message, not the sender's message or session tail", async () => {
		const opened: unknown[] = [];
		const located: unknown[] = [];
		await openCommunicationRecipient(
			{ id: "child", deliveryMessageId: "receipt" },
			{
				locate: async (...args) => {
					located.push(args);
					return { messageId: "receipt" };
				},
				open: (...args) => {
					opened.push(args);
				},
				notify: () => {
					throw new Error("Unexpected notification");
				},
			},
		);
		expect(located).toEqual([["child", "receipt"]]);
		expect(opened).toEqual([["child", "receipt"]]);
	});
	test("sent-but-not-received opens the session without message tracking", async () => {
		// A reserved receipt that has not materialized yet is 404. The target id is
		// already known, so the dock must still open — just without a messageId.
		const opened: unknown[] = [];
		const notices: string[] = [];
		await openCommunicationRecipient(
			{ id: "child", deliveryMessageId: "reserved" },
			{
				locate: async () => {
					throw Object.assign(new Error("Not found"), { status: 404 });
				},
				open: (...args) => {
					opened.push(args);
				},
				notify: (reason) => {
					notices.push(reason);
				},
			},
		);
		expect(opened).toEqual([["child"]]);
		expect(notices).toEqual(["unavailable"]);
	});
	test("inaccessible receipts do not jump to unrelated content", async () => {
		for (const status of [403, 500]) {
			const notices: string[] = [];
			await openCommunicationRecipient(
				{ id: "child", deliveryMessageId: "reserved" },
				{
					locate: async () => {
						throw Object.assign(new Error("Unavailable"), { status });
					},
					open: () => {
						throw new Error("Must not navigate");
					},
					notify: (reason) => {
						notices.push(reason);
					},
				},
			);
			expect(notices).toEqual(["error"]);
		}
	});
	test("legacy Send opens the session with an honest missing-receipt notice", async () => {
		const calls: unknown[] = [];
		await openCommunicationRecipient(
			{ id: "child" },
			{
				locate: async () => {
					throw new Error("No receipt to locate");
				},
				open: (...args) => {
					calls.push(args);
				},
				notify: (reason) => {
					calls.push(reason);
				},
			},
		);
		expect(calls).toEqual([["child"], "legacy"]);
	});
});
