import { afterEach, describe, expect, test } from "bun:test";
import {
	countLiveExecutorTickets,
	EXECUTOR_TICKET_TTL_MS,
	issueExecutorTicket,
	peekExecutorTicketUse,
	redeemExecutorTicket,
	resetExecutorTickets,
} from "../executor-bootstrap-ticket";

afterEach(() => {
	resetExecutorTickets();
});

const SCRIPT = { body: "#!/bin/sh\necho hi\n", filename: "install.sh", shell: "sh" as const };

describe("issueExecutorTicket", () => {
	test("issues a long random ticket bound to a platform and expiry", () => {
		const now = 1_000_000;
		const issued = issueExecutorTicket("linux-amd64", { deviceId: "dev1", now });
		expect(issued.platform).toBe("linux-amd64");
		expect(issued.expiresAt).toBe(now + EXECUTOR_TICKET_TTL_MS);
		// 32 random bytes as hex.
		expect(issued.ticket).toMatch(/^[0-9a-f]{64}$/);
	});

	test("token delivery is off unless explicitly requested", () => {
		// The safe default matters: a ticket minted by any future caller that forgets
		// this flag must not be able to hand out a device key.
		expect(issueExecutorTicket("linux-amd64").allowTokenDelivery).toBe(false);
		expect(
			issueExecutorTicket("linux-amd64", { allowTokenDelivery: true }).allowTokenDelivery,
		).toBe(true);
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

describe("purpose budgets", () => {
	test("binary downloads tolerate retries, and stop at the limit", () => {
		// A dropped download on a multi-megabyte binary is ordinary, and the human
		// response is to re-run the same command. Refusing the second attempt would
		// turn a network blip into "generate a new install command".
		const issued = issueExecutorTicket("linux-amd64", { deviceId: "d" });
		for (let i = 0; i < 5; i++) {
			expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "binary").ok).toBe(true);
		}
		const exhausted = redeemExecutorTicket(issued.ticket, "linux-amd64", "binary");
		expect(exhausted.ok).toBe(false);
		expect(exhausted.reason).toBe("purpose_exhausted");
	});

	test("script fetches are counted separately from binary downloads", () => {
		const issued = issueExecutorTicket("linux-amd64", { script: SCRIPT });
		// Exhaust the script budget…
		for (let i = 0; i < 5; i++) {
			expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "script").ok).toBe(true);
		}
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "script").reason).toBe(
			"purpose_exhausted",
		);
		// …and the binary budget is untouched, because the script is fetched by the
		// operator's shell and the binary by the script itself.
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "binary").ok).toBe(true);
	});

	test("a script redemption returns the pre-rendered body", () => {
		// Rendered at issue time so the public endpoint never has to touch the DB.
		const issued = issueExecutorTicket("linux-amd64", { script: SCRIPT });
		const result = redeemExecutorTicket(issued.ticket, "linux-amd64", "script");
		expect(result.script).toEqual({ body: SCRIPT.body, filename: "install.sh", shell: "sh" });
	});

	test("a ticket with no script body cannot serve one", () => {
		const issued = issueExecutorTicket("linux-amd64");
		const refused = redeemExecutorTicket(issued.ticket, "linux-amd64", "script");
		expect(refused.ok).toBe(false);
		expect(refused.reason).toBe("purpose_not_allowed");
		expect(refused.script).toBeUndefined();
	});
});

describe("token delivery", () => {
	test("the key can be exchanged exactly once", () => {
		const issued = issueExecutorTicket("linux-amd64", {
			deviceId: "dev-42",
			allowTokenDelivery: true,
		});
		const first = redeemExecutorTicket(issued.ticket, "linux-amd64", "token");
		expect(first.ok).toBe(true);
		expect(first.deviceId).toBe("dev-42");

		const replay = redeemExecutorTicket(issued.ticket, "linux-amd64", "token");
		expect(replay.ok).toBe(false);
		expect(replay.reason).toBe("already_used");
	});

	test("exchanging the key spends the whole ticket, not just that purpose", () => {
		// The caller rotates the device key on exchange, so anything the ticket could
		// still authorize afterwards would refer to a secret that no longer exists.
		// More importantly: a stolen ticket redeemed first must make the legitimate
		// run fail visibly rather than quietly share a credential.
		const issued = issueExecutorTicket("linux-amd64", { allowTokenDelivery: true, script: SCRIPT });
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "token").ok).toBe(true);
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "binary").reason).toBe(
			"already_used",
		);
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "script").reason).toBe(
			"already_used",
		);
	});

	test("a prompt-mode ticket structurally cannot yield a key", () => {
		// The guarantee lives in the ticket, not in the script text: even if a script
		// were somehow rewritten to call the enroll endpoint, its ticket refuses.
		const issued = issueExecutorTicket("linux-amd64", {
			allowTokenDelivery: false,
			script: SCRIPT,
		});
		const refused = redeemExecutorTicket(issued.ticket, "linux-amd64", "token");
		expect(refused.ok).toBe(false);
		expect(refused.reason).toBe("purpose_not_allowed");
		// And refusing does not burn the ticket's legitimate uses.
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "script").ok).toBe(true);
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "binary").ok).toBe(true);
	});
});

describe("redeemExecutorTicket validation", () => {
	test("rejects a ticket issued for another platform without consuming it", () => {
		const issued = issueExecutorTicket("linux-amd64");
		const mismatch = redeemExecutorTicket(issued.ticket, "windows-amd64", "binary");
		expect(mismatch.ok).toBe(false);
		expect(mismatch.reason).toBe("platform_mismatch");
		// Still usable for its real platform: a mismatch is usually the wrong script.
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "binary").ok).toBe(true);
	});

	test("rejects an expired ticket", () => {
		const now = 5_000_000;
		const issued = issueExecutorTicket("darwin-arm64", { now });
		expect(
			redeemExecutorTicket(issued.ticket, "darwin-arm64", "binary", {
				now: now + EXECUTOR_TICKET_TTL_MS + 1,
			}),
		).toEqual({ ok: false, reason: "expired" });
	});

	test("accepts a ticket right up to its expiry boundary", () => {
		const now = 5_000_000;
		const issued = issueExecutorTicket("darwin-arm64", { now });
		expect(
			redeemExecutorTicket(issued.ticket, "darwin-arm64", "binary", {
				now: now + EXECUTOR_TICKET_TTL_MS - 1,
			}).ok,
		).toBe(true);
	});

	test("the TTL stays in minutes, because a ticket is now a credential", () => {
		// Guards the property rather than the number: a ticket can yield a device key,
		// so an hours-long lifetime would quietly turn a leaked install command into a
		// durable one.
		expect(EXECUTOR_TICKET_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
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
			expect(redeemExecutorTicket(candidate, "linux-amd64", "binary").ok).toBe(false);
		}
	});

	test("a ticket for one device does not unlock another platform's binary", () => {
		const linux = issueExecutorTicket("linux-amd64");
		const windows = issueExecutorTicket("windows-amd64");
		expect(redeemExecutorTicket(linux.ticket, "windows-amd64", "binary").ok).toBe(false);
		expect(redeemExecutorTicket(windows.ticket, "windows-amd64", "binary").ok).toBe(true);
		expect(redeemExecutorTicket(linux.ticket, "linux-amd64", "binary").ok).toBe(true);
	});

	test("expired tickets are pruned from memory", () => {
		const now = 9_000_000;
		issueExecutorTicket("linux-amd64", { now });
		issueExecutorTicket("linux-arm64", { now });
		expect(countLiveExecutorTickets(now)).toBe(2);
		expect(countLiveExecutorTickets(now + EXECUTOR_TICKET_TTL_MS + 1)).toBe(0);
	});
});

describe("redemption provenance", () => {
	test("records the first and latest redemption", () => {
		// This is the only evidence available if a ticket leaks, so it must survive
		// past the redemption that spends the ticket.
		const issued = issueExecutorTicket("linux-amd64", { allowTokenDelivery: true });
		redeemExecutorTicket(issued.ticket, "linux-amd64", "binary", {
			ip: "10.0.0.5",
			userAgent: "curl/8",
			now: 100,
		});
		redeemExecutorTicket(issued.ticket, "linux-amd64", "token", {
			ip: "10.0.0.6",
			userAgent: "curl/9",
			now: 200,
		});
		const use = peekExecutorTicketUse(issued.ticket);
		expect(use?.firstUse).toEqual({ ip: "10.0.0.5", at: 100, userAgent: "curl/8" });
		expect(use?.lastUse).toEqual({ ip: "10.0.0.6", at: 200, userAgent: "curl/9" });
	});

	test("bounds a hostile user agent rather than storing it whole", () => {
		const issued = issueExecutorTicket("linux-amd64");
		redeemExecutorTicket(issued.ticket, "linux-amd64", "binary", {
			ip: "1.2.3.4",
			userAgent: "x".repeat(5_000),
		});
		expect(peekExecutorTicketUse(issued.ticket)?.firstUse?.userAgent?.length).toBe(256);
	});

	/**
	 * A rejection is generic to the caller, so the server log is the only record of it
	 * — and the caller being rejected is the party that LOST the race, whose own
	 * address explains nothing. Returning the first redemption is what lets the route
	 * log distinguish "the operator re-ran their command" from "someone else redeemed
	 * it first", which is the entire detection story for a leaked install command.
	 */
	test("a spent ticket reports who redeemed it first", () => {
		const issued = issueExecutorTicket("linux-amd64", {
			deviceId: "dev1",
			deviceSlug: "build-box",
			allowTokenDelivery: true,
		});
		expect(
			redeemExecutorTicket(issued.ticket, "linux-amd64", "token", { ip: "203.0.113.9", now: 50 })
				.ok,
		).toBe(true);

		const replay = redeemExecutorTicket(issued.ticket, "linux-amd64", "token", {
			ip: "198.51.100.4",
			now: 60,
		});
		expect(replay.ok).toBe(false);
		expect(replay.reason).toBe("already_used");
		expect(replay.firstUse?.ip).toBe("203.0.113.9");
	});

	test("an exhausted purpose reports the first redemption too", () => {
		const issued = issueExecutorTicket("linux-amd64", { script: SCRIPT });
		for (let i = 0; i < 5; i++) {
			redeemExecutorTicket(issued.ticket, "linux-amd64", "script", { ip: "10.0.0.1" });
		}
		const exhausted = redeemExecutorTicket(issued.ticket, "linux-amd64", "script", {
			ip: "10.0.0.2",
		});
		expect(exhausted.reason).toBe("purpose_exhausted");
		expect(exhausted.firstUse?.ip).toBe("10.0.0.1");
	});

	test("an unknown or expired ticket attributes nothing", () => {
		// There is no first use to report, and inventing one would imply the ticket
		// existed — which is exactly what a rejection must not reveal.
		expect(redeemExecutorTicket("abcdef", "linux-amd64", "binary").firstUse).toBeUndefined();
		const issued = issueExecutorTicket("linux-amd64", { now: 1_000 });
		expect(
			redeemExecutorTicket(issued.ticket, "linux-amd64", "binary", {
				now: 1_000 + EXECUTOR_TICKET_TTL_MS + 1,
			}).firstUse,
		).toBeUndefined();
	});
});
