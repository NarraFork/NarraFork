/**
 * `lib/fs-download-ticket.ts` — the credential that lets the browser download a file itself.
 *
 * These tests exist because the ticket is a capability in a URL: anyone holding it can
 * download the file, with no session at all. So the properties that make that acceptable are
 * pinned here rather than left to the route tests:
 *
 *   - a token that was not minted by this server is refused (`forged`, `unknown`);
 *   - the expiry cannot be extended by editing the token;
 *   - a token is spent the first time it is claimed, and a replay says so as a DISTINCT
 *     reason — "already used" is the signature of a leaked URL, "unknown" of a guess, and an
 *     operator investigating one has to be able to tell them apart;
 *   - the path never travels in the token, so a leaked URL does not disclose the workspace.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	claimDownloadTicket,
	countLiveDownloadTickets,
	DOWNLOAD_TICKET_TTL_MS,
	issueDownloadTicket,
	resetDownloadTickets,
} from "../fs-download-ticket";

beforeEach(() => {
	resetDownloadTickets();
});

/** Mint a ticket and return its three parts, so tests can tamper with one at a time. */
function mint(path = "/work/project/src/app.ts", now = 1_000_000) {
	const issued = issueDownloadTicket(path, now);
	const [expiry, nonce, signature] = issued.ticket.split(".");
	return {
		issued,
		path,
		now,
		expiry: expiry ?? "",
		nonce: nonce ?? "",
		signature: signature ?? "",
	};
}

describe("issueDownloadTicket", () => {
	test("reports a TTL the client can act on", () => {
		const { issued } = mint();
		expect(issued.expiresInMs).toBe(DOWNLOAD_TICKET_TTL_MS);
		expect(issued.expiresAt).toBe(1_000_000 + DOWNLOAD_TICKET_TTL_MS);
	});

	/**
	 * The URL ends up in browser history, `Referer` and proxy access logs. An absolute path
	 * there discloses the workspace layout, and a session already proved the right to see it —
	 * so the token carries a random nonce and the path stays server-side.
	 */
	test("does not put the path in the token", () => {
		const { issued, path } = mint("/work/secret-project/internal/keys.ts");
		expect(issued.ticket).not.toContain(path);
		expect(issued.ticket).not.toContain("secret-project");
		// Even a bare segment, however the separator is encoded, would leak the layout.
		expect(issued.ticket).not.toContain(encodeURIComponent(path));
	});

	test("mints a distinct token each time, so two tabs cannot collide", () => {
		const first = issueDownloadTicket("/work/a.ts", 1_000);
		const second = issueDownloadTicket("/work/a.ts", 1_000);
		expect(first.ticket).not.toBe(second.ticket);
		expect(countLiveDownloadTickets(1_000)).toBe(2);
	});
});

describe("claimDownloadTicket", () => {
	test("redeems a fresh ticket for the path it was minted for", () => {
		const { issued, path, now } = mint();
		const claim = claimDownloadTicket(issued.ticket, now + 1);
		expect(claim).toEqual({ ok: true, path });
	});

	/**
	 * The single-use property. A leaked URL that was already redeemed by someone else must fail
	 * HERE — silently serving the file twice is the failure mode a capability URL invites.
	 */
	test("refuses a replay with a distinct reason", () => {
		const { issued, now } = mint();
		expect(claimDownloadTicket(issued.ticket, now + 1).ok).toBe(true);

		const replay = claimDownloadTicket(issued.ticket, now + 2);
		expect(replay).toEqual({ ok: false, reason: "already_used" });
	});

	describe("expiry", () => {
		test("accepts one millisecond before the deadline", () => {
			const { issued, path, now, expiry } = mint();
			const expiresAt = Number.parseInt(expiry, 36);
			expect(expiresAt).toBe(now + DOWNLOAD_TICKET_TTL_MS);

			// TTL boundary, -1ms: still inside the window.
			expect(claimDownloadTicket(issued.ticket, expiresAt - 1)).toEqual({ ok: true, path });
		});

		/**
		 * TTL boundary, +0ms. `<=` rather than `<`: the deadline itself is already too late.
		 *
		 * Each boundary gets a FRESH ticket on purpose. Reporting `expired` deletes the record, so a
		 * second attempt with the same token reads as `unknown` — a consequence of pruning, not a
		 * separate rule, and asserting both in one test would pin the wrong thing.
		 */
		test("refuses at the deadline, exactly", () => {
			const { issued, expiry } = mint();
			const expiresAt = Number.parseInt(expiry, 36);
			expect(claimDownloadTicket(issued.ticket, expiresAt)).toEqual({
				ok: false,
				reason: "expired",
			});
		});

		test("refuses past the deadline", () => {
			const { issued, expiry } = mint();
			const expiresAt = Number.parseInt(expiry, 36);
			expect(claimDownloadTicket(issued.ticket, expiresAt + 1)).toEqual({
				ok: false,
				reason: "expired",
			});
		});

		/** Once an expired ticket has been reported and pruned, a retry is indistinguishable from a guess. */
		test("a retry after the expired report reads as unknown", () => {
			const { issued, expiry } = mint();
			const expiresAt = Number.parseInt(expiry, 36);
			expect(claimDownloadTicket(issued.ticket, expiresAt).ok).toBe(false);
			expect(claimDownloadTicket(issued.ticket, expiresAt)).toEqual({
				ok: false,
				reason: "unknown",
			});
		});

		/**
		 * Extending the expiry in the token must not work: the HMAC covers it, and the token has
		 * to agree with the record it indexes. Without this, every ticket would be immortal.
		 */
		test("refuses a hand-edited expiry as forged", () => {
			const { issued, now, nonce, signature } = mint();
			const extended = (now + 10 * DOWNLOAD_TICKET_TTL_MS).toString(36);
			const tampered = `${extended}.${nonce}.${signature}`;

			expect(claimDownloadTicket(tampered, now + 1)).toEqual({ ok: false, reason: "forged" });
			// The original is untouched by the attempt.
			expect(claimDownloadTicket(issued.ticket, now + 1).ok).toBe(true);
		});
	});

	describe("rejects tokens this server did not mint", () => {
		test("an empty or missing ticket is unknown", () => {
			expect(claimDownloadTicket("")).toEqual({ ok: false, reason: "unknown" });
			expect(claimDownloadTicket(null)).toEqual({ ok: false, reason: "unknown" });
			expect(claimDownloadTicket(undefined)).toEqual({ ok: false, reason: "unknown" });
			expect(claimDownloadTicket("   ")).toEqual({ ok: false, reason: "unknown" });
		});

		test("a malformed token is unknown rather than a crash", () => {
			for (const value of ["a", "a.b", "a.b.c.d", "...", "....", "x.y.z"]) {
				expect(claimDownloadTicket(value)).toEqual({ ok: false, reason: "unknown" });
			}
		});

		/**
		 * A signature minted for another path must not authorize this one. The nonce and expiry
		 * are kept intact, so only the HMAC stands between a caller and a different file.
		 */
		test("a signature from another path does not transfer", () => {
			const victim = mint("/work/victim.ts", 1_000_000);
			const attacker = mint("/work/.ssh/id_rsa", 1_000_000);
			// Attacker's nonce, victim's signature: every field parses, the HMAC must not match.
			const crossed = `${attacker.expiry}.${attacker.nonce}.${victim.signature}`;
			expect(claimDownloadTicket(crossed, 1_000_001)).toEqual({
				ok: false,
				reason: "forged",
			});
		});

		test("a flipped signature byte is forged", () => {
			const { issued, now, expiry, nonce, signature } = mint();
			const flipped = `${expiry}.${nonce}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
			expect(claimDownloadTicket(flipped, now + 1)).toEqual({ ok: false, reason: "forged" });
			// The real token still works: a failed forgery does not consume it.
			expect(claimDownloadTicket(issued.ticket, now + 1).ok).toBe(true);
		});

		test("a truncated signature is forged, not a length-mismatch crash", () => {
			const { now, expiry, nonce, signature } = mint();
			const truncated = `${expiry}.${nonce}.${signature.slice(0, 10)}`;
			expect(claimDownloadTicket(truncated, now + 1)).toEqual({ ok: false, reason: "forged" });
		});
	});

	/**
	 * One path must never be reachable through a token minted for another: this is the whole
	 * authorization content of a ticket, since the route trusts the stored path.
	 */
	test("returns exactly the path it was minted for", () => {
		const { issued, now } = mint("/work/one.ts");
		const other = issueDownloadTicket("/work/two.ts", now);
		expect(claimDownloadTicket(issued.ticket, now)).toEqual({ ok: true, path: "/work/one.ts" });
		expect(claimDownloadTicket(other.ticket, now)).toEqual({ ok: true, path: "/work/two.ts" });
	});
});

describe("bookkeeping", () => {
	test("prunes expired tickets so repeated clicks cannot grow memory", () => {
		const now = 5_000_000;
		for (let i = 0; i < 10; i += 1) issueDownloadTicket(`/work/${i}.ts`, now);
		expect(countLiveDownloadTickets(now)).toBe(10);

		const later = now + DOWNLOAD_TICKET_TTL_MS;
		expect(countLiveDownloadTickets(later)).toBe(0);
	});

	/**
	 * The live set is bounded independently of expiry: a loop minting tickets inside one TTL
	 * window must not be able to allocate without limit.
	 */
	test("stays bounded under a burst of minting inside one TTL window", () => {
		const now = 7_000_000;
		for (let i = 0; i < 500; i += 1) issueDownloadTicket(`/work/${i}.ts`, now);
		expect(countLiveDownloadTickets(now)).toBeLessThanOrEqual(200);
	});

	test("an evicted ticket is refused instead of silently working", () => {
		const now = 9_000_000;
		const first = issueDownloadTicket("/work/first.ts", now);
		for (let i = 0; i < 200; i += 1) issueDownloadTicket(`/work/filler-${i}.ts`, now);

		// The oldest was dropped, so it reads as unknown rather than granting access.
		expect(claimDownloadTicket(first.ticket, now + 1)).toEqual({ ok: false, reason: "unknown" });
	});
});
