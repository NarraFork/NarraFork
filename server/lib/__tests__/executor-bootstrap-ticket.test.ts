import { afterEach, describe, expect, test } from "bun:test";
import {
	countLiveExecutorTickets,
	EXECUTOR_TICKET_TTL_MS,
	issueExecutorTicket,
	redeemExecutorTicket,
	resetExecutorTickets,
} from "../executor-bootstrap-ticket";

afterEach(() => {
	resetExecutorTickets();
});

describe("issueExecutorTicket", () => {
	test("issues a long random ticket bound to a platform and expiry", () => {
		const now = 1_000_000;
		const issued = issueExecutorTicket("linux-amd64", { deviceId: "dev1", now });
		expect(issued.platform).toBe("linux-amd64");
		expect(issued.expiresAt).toBe(now + EXECUTOR_TICKET_TTL_MS);
		// 32 random bytes as hex.
		expect(issued.ticket).toMatch(/^[0-9a-f]{64}$/);
	});

	test("never repeats a ticket value", () => {
		const values = new Set<string>();
		for (let i = 0; i < 50; i++) {
			values.add(issueExecutorTicket("linux-amd64").ticket);
		}
		expect(values.size).toBe(50);
	});

	test("bounds live tickets so repeated generation cannot grow unbounded", () => {
		for (let i = 0; i < 260; i++) {
			issueExecutorTicket("linux-amd64");
		}
		expect(countLiveExecutorTickets()).toBeLessThanOrEqual(200);
	});
});

describe("redeemExecutorTicket", () => {
	test("accepts a ticket exactly once", () => {
		const issued = issueExecutorTicket("linux-amd64", { deviceId: "dev-42" });
		const first = redeemExecutorTicket(issued.ticket, "linux-amd64");
		expect(first.ok).toBe(true);
		expect(first.deviceId).toBe("dev-42");

		const replay = redeemExecutorTicket(issued.ticket, "linux-amd64");
		expect(replay).toEqual({ ok: false, reason: "already_used" });
	});

	test("rejects a ticket issued for another platform without consuming it", () => {
		const issued = issueExecutorTicket("linux-amd64");
		expect(redeemExecutorTicket(issued.ticket, "windows-amd64")).toEqual({
			ok: false,
			reason: "platform_mismatch",
		});
		// Still usable for its real platform: a mismatch is usually the wrong script.
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64").ok).toBe(true);
	});

	test("rejects an expired ticket", () => {
		const now = 5_000_000;
		const issued = issueExecutorTicket("darwin-arm64", { now });
		expect(
			redeemExecutorTicket(issued.ticket, "darwin-arm64", {
				now: now + EXECUTOR_TICKET_TTL_MS + 1,
			}),
		).toEqual({ ok: false, reason: "expired" });
	});

	test("accepts a ticket right up to its expiry boundary", () => {
		const now = 5_000_000;
		const issued = issueExecutorTicket("darwin-arm64", { now });
		expect(
			redeemExecutorTicket(issued.ticket, "darwin-arm64", {
				now: now + EXECUTOR_TICKET_TTL_MS - 1,
			}).ok,
		).toBe(true);
	});

	test("rejects unknown, empty and malformed tickets", () => {
		issueExecutorTicket("linux-amd64");
		for (const candidate of [
			undefined,
			null,
			"",
			"   ",
			"not-hex",
			"ABCDEF",
			"a".repeat(64),
			"../../etc/passwd",
		]) {
			expect(redeemExecutorTicket(candidate, "linux-amd64").ok).toBe(false);
		}
	});

	test("a ticket for one device does not unlock another platform's binary", () => {
		const linux = issueExecutorTicket("linux-amd64");
		const windows = issueExecutorTicket("windows-amd64");
		expect(redeemExecutorTicket(linux.ticket, "windows-amd64").ok).toBe(false);
		expect(redeemExecutorTicket(windows.ticket, "windows-amd64").ok).toBe(true);
		expect(redeemExecutorTicket(linux.ticket, "linux-amd64").ok).toBe(true);
	});

	test("expired tickets are pruned from memory", () => {
		const now = 9_000_000;
		issueExecutorTicket("linux-amd64", { now });
		issueExecutorTicket("linux-arm64", { now });
		expect(countLiveExecutorTickets(now)).toBe(2);
		expect(countLiveExecutorTickets(now + EXECUTOR_TICKET_TTL_MS + 1)).toBe(0);
	});
});
