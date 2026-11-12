/**
 * `GET /api/fs/download` — the file viewer's "save this file" endpoint.
 *
 * It exists separately from `/preview` rather than as a flag on it, and the three
 * differences are exactly what these tests pin:
 *
 *   - `attachment` disposition, so the browser saves instead of navigating;
 *   - `application/octet-stream` + `nosniff`, because a same-origin URL that
 *     serves an honest `text/html` from the workspace is a stored-XSS vector;
 *   - `no-store`, since the response is fetched under a session credential and
 *     must not land in a shared or disk cache.
 *
 * The size ceiling is asserted through the response rather than the constant so a
 * refactor that moves the check cannot pass while dropping it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { DOWNLOAD_TICKET_MAX_CLAIMS, resetDownloadTickets } from "../../lib/fs-download-ticket";
import { narraforkDir } from "../../lib/settings";
import { fsPublicDownloadRoutes, fsRoutes } from "../fs";

// The real app mounts these behind `requireSessionAuth`; authorization is covered
// elsewhere, so this harness only adds the app's own error serialization, which the
// route's ValidationError paths depend on for their 400s.
const app = new Hono().route("/fs", fsRoutes).onError((err, c) => {
	return buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500);
});

let dir: string;

function url(path: string): string {
	return `http://localhost/fs/download?path=${encodeURIComponent(path)}`;
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "nf-fs-download-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/fs/download", () => {
	test("serves the exact bytes as an attachment named after the file", async () => {
		const file = join(dir, "api-request-2026-08-17T14-00-52-612Z-ic7g26.json");
		writeFileSync(file, '{"id":"ic7g26"}');

		const res = await app.request(url(file));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"id":"ic7g26"}');
		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toStartWith("attachment;");
		expect(disposition).toContain('filename="api-request-2026-08-17T14-00-52-612Z-ic7g26.json"');
	});

	// A `Content-Length` is what lets the browser show download progress; Bun only
	// derives it when the body is a BunFile, so a refactor to `file.stream()` would
	// silently switch to chunked encoding and drop it.
	test("reports a length so the browser can show progress", async () => {
		const file = join(dir, "sized.txt");
		writeFileSync(file, "0123456789");

		const res = await app.request(url(file));

		expect(res.headers.get("content-length")).toBe("10");
	});

	// An .html file in a worktree served as text/html from the app's own origin
	// would execute with the session's cookies and localStorage in scope.
	test("never serves a renderable content type, even for html", async () => {
		const file = join(dir, "page.html");
		writeFileSync(file, "<script>alert(1)</script>");

		const res = await app.request(url(file));

		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-disposition")).toStartWith("attachment;");
	});

	test("is never cached, because it is fetched under a session credential", async () => {
		const file = join(dir, "secret.txt");
		writeFileSync(file, "token");

		const res = await app.request(url(file));

		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	// Unlike /preview, this route must serve files above the 1 MB text preview cap:
	// being able to READ a truncated head of a file is not the same as being able to
	// save it, and the panel's download button is the only way to get the rest.
	test("serves a file far above the preview text cap", async () => {
		const file = join(dir, "big.log");
		const size = 3 * 1024 * 1024;
		writeFileSync(file, "x".repeat(size));

		const res = await app.request(url(file));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-length")).toBe(String(size));
	});

	test("rejects a directory instead of streaming something unusable", async () => {
		const res = await app.request(url(dir));

		expect(res.status).toBe(400);
	});

	test("rejects a missing file and a missing path parameter", async () => {
		expect((await app.request(url(join(dir, "absent.txt")))).status).toBe(400);
		expect((await app.request("http://localhost/fs/download")).status).toBe(400);
	});

	// The CJK name is unrepresentable in the quoted `filename`, so the download
	// would arrive with a mangled name unless `filename*` carries it.
	test("carries a non-ASCII name through RFC 5987", async () => {
		const file = join(dir, "报告.json");
		writeFileSync(file, "{}");

		const res = await app.request(url(file));

		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.json");
	});

	/**
	 * The route takes an absolute path from the client on purpose, so the one thing it
	 * must not do is hand over the platform's own credentials: `settings.json` carries
	 * `auth.jwtSecret` (forge MFA challenges) and the database carries every
	 * password hash. Asserted through the RESPONSE rather than the predicate, so a
	 * refactor that keeps `fs-secret-paths.ts` but stops calling it still fails here.
	 */
	test("refuses the platform's credential files", async () => {
		// `narraforkDir` rather than `~/.narrafork`: the home is overridable (the test
		// runner does exactly that), and the file worth protecting is the ACTIVE one.
		// Written with a recognizable payload so a pass cannot come from an empty read.
		const secret = join(narraforkDir, "settings.json");
		mkdirSync(narraforkDir, { recursive: true });
		writeFileSync(secret, '{"auth":{"jwtSecret":"leaked-secret-marker"}}');

		const res = await app.request(url(secret));

		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("leaked-secret-marker");
	});

	test("refuses the database, whose WAL carries every password hash", async () => {
		const db = join(narraforkDir, "narrafork.db-wal");
		mkdirSync(narraforkDir, { recursive: true });
		writeFileSync(db, "hashes");

		expect((await app.request(url(db))).status).toBe(403);
	});

	test.each([
		"request-recordings",
		"saved-request-recordings",
		"editor-transfers",
		"editor-native",
		"editor-native-operations",
		"token-repair-jobs",
	])("generic file routes cannot serve %s, directly or via symlink", async (directory) => {
		const root = join(narraforkDir, directory, "owner-recording");
		mkdirSync(root, { recursive: true });
		const recording = join(root, "stream.jsonl");
		writeFileSync(recording, "private-recording-marker");
		const link = join(dir, `${directory}-alias.jsonl`);
		symlinkSync(recording, link, "file");
		for (const endpoint of ["preview", "download", "edit-source"]) {
			for (const path of [recording, link, join(root, "missing.jsonl")]) {
				const res = await app.request(
					`http://localhost/fs/${endpoint}?path=${encodeURIComponent(path)}`,
				);
				expect(res.status).toBe(403);
				expect(await res.text()).not.toContain("private-recording-marker");
			}
		}
	});

	test("still serves a request dump under the same home", async () => {
		// The guard must not over-block: the file viewer's whole reason for reaching
		// outside a project is opening these.
		const dumpDir = join(narraforkDir, "malformed-request-dumps");
		mkdirSync(dumpDir, { recursive: true });
		const dump = join(dumpDir, "dump.json");
		writeFileSync(dump, '{"request":{}}');

		const res = await app.request(url(dump));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"request":{}}');
	});

	test("refuses a third-party credential store in the user's home", async () => {
		const res = await app.request(url(join(homedir(), ".ssh", "id_rsa")));
		// 403 even when the file does not exist on this machine: the refusal is about
		// the path, and answering 400 ("does not exist") would leak whether it does.
		expect(res.status).toBe(403);
	});
});

/**
 * `POST /api/fs/download-ticket` — mint the credential that lets the BROWSER download.
 *
 * The route exists so the client never has to buffer a file into page memory. What these
 * tests pin is that minting validates exactly what `GET /download` validates: the same
 * secret-path refusal, the same "is a regular file", and the same size ceiling. A ticket is
 * a capability to fetch bytes, so minting one for a path the route would refuse is the same
 * disclosure as serving it.
 */
describe("POST /fs/download-ticket", () => {
	function ticketUrl(): string {
		return "http://localhost/fs/download-ticket";
	}

	async function mintFor(path: string): Promise<Response> {
		return app.request(ticketUrl(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		});
	}

	beforeEach(() => {
		resetDownloadTickets();
	});

	test("mints a ticket for a real file without returning any of its bytes", async () => {
		const file = join(dir, "payload.json");
		writeFileSync(file, '{"secret":"do-not-leak-in-the-ticket-response"}');

		const res = await mintFor(file);
		const body = (await res.json()) as { ticket?: string; expiresInMs?: number };

		expect(res.status).toBe(200);
		expect(typeof body.ticket).toBe("string");
		expect(body.ticket?.length).toBeGreaterThan(0);
		expect(body.expiresInMs).toBeGreaterThan(0);
		// The path must not ride along: it would land in history and proxy logs.
		expect(body.ticket).not.toContain(file);
		expect(JSON.stringify(body)).not.toContain("do-not-leak-in-the-ticket-response");
	});

	test("refuses the platform's credential files, like the download route does", async () => {
		const secret = join(narraforkDir, "settings.json");
		mkdirSync(narraforkDir, { recursive: true });
		writeFileSync(secret, '{"auth":{"jwtSecret":"leaked-secret-marker"}}');

		const res = await mintFor(secret);

		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("leaked-secret-marker");
	});

	test("refuses a directory and a missing file", async () => {
		expect((await mintFor(dir)).status).toBe(400);
		expect((await mintFor(join(dir, "absent.txt"))).status).toBe(400);
	});

	test("refuses a missing path and a malformed body", async () => {
		expect((await mintFor("")).status).toBe(400);

		const malformed = await app.request(ticketUrl(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(malformed.status).toBe(400);
	});

	/**
	 * The ceiling is enforced at MINT time, not only at claim time: a ticket for a file that
	 * can never be served would otherwise send the browser to an error page, which is strictly
	 * worse than an error the client can turn into a notification.
	 */
	test("refuses a file above the download ceiling before minting", async () => {
		const huge = join(dir, "huge.bin");
		// Sparse: reports 2 GB + 1 byte without writing 2 GB to disk.
		writeFileSync(huge, "");
		const { truncateSync } = await import("node:fs");
		truncateSync(huge, 2 * 1024 * 1024 * 1024 + 1);

		const res = await mintFor(huge);

		expect(res.status).toBe(413);
		expect(await res.text()).toContain("too large");
	});

	/** The boundary itself is allowed: `>` rather than `>=`, matching the download route. */
	test("allows a file of exactly the ceiling size", async () => {
		const exact = join(dir, "exact.bin");
		writeFileSync(exact, "");
		const { truncateSync } = await import("node:fs");
		truncateSync(exact, 2 * 1024 * 1024 * 1024);

		const res = await mintFor(exact);

		expect(res.status).toBe(200);
	});
});

/**
 * `GET /api/fs/download?ticket=…` — the browser's own download.
 *
 * ## Why this harness exists
 *
 * The security of the whole feature rests on ONE ordering property in `app.ts`: the public
 * ticket route is mounted BEFORE `requireSessionAuth`, and the rest of `/api/fs` stays after
 * it. A behavioural test on the router alone cannot see that, so this harness reproduces the
 * arrangement — public router, then the gate, then the session router — and asserts both
 * halves: the ticket route works with no session, and everything else still 401s.
 *
 * `gate` stands in for `requireSessionAuth`, which needs a live session store. What matters
 * here is WHERE it sits, not what it does in detail: it rejects any request without a bearer
 * token, and its position is what the assertions probe.
 */
describe("public ticket route and the session gate", () => {
	const gate = async (c: Parameters<Parameters<Hono["use"]>[1]>[0], next: () => Promise<void>) => {
		if (!c.req.header("authorization")) {
			return c.json({ error: "Authentication required" }, 401);
		}
		await next();
	};

	/** Mirrors app.ts: public mount first, then the global gate, then the session router. */
	const layered = new Hono();
	layered.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));
	layered.route("/api/fs", fsPublicDownloadRoutes);
	layered.use("/api/*", gate);
	layered.route("/api/fs", fsRoutes);

	function downloadUrl(query: string): string {
		return `http://localhost/api/fs/download?${query}`;
	}

	async function mint(path: string): Promise<string> {
		const res = await layered.request("http://localhost/api/fs/download-ticket", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-session" },
			body: JSON.stringify({ path }),
		});
		const body = (await res.json()) as { ticket: string };
		return body.ticket;
	}

	beforeEach(() => {
		resetDownloadTickets();
	});

	test("serves a file with NO session when a valid ticket is presented", async () => {
		const file = join(dir, "ticket-served.txt");
		writeFileSync(file, "bytes-from-a-ticket");
		const ticket = await mint(file);

		// No Authorization header at all: this is what the browser's navigation looks like.
		const res = await layered.request(downloadUrl(`ticket=${encodeURIComponent(ticket)}`));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("bytes-from-a-ticket");
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("content-disposition")).toStartWith("attachment;");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		// Progress needs a length; Bun derives it from the BunFile body.
		expect(res.headers.get("content-length")).toBe(String("bytes-from-a-ticket".length));
	});

	test("still reports a length for a large ticket download", async () => {
		const file = join(dir, "ticket-big.log");
		const size = 3 * 1024 * 1024;
		writeFileSync(file, "x".repeat(size));
		const ticket = await mint(file);

		const res = await layered.request(downloadUrl(`ticket=${encodeURIComponent(ticket)}`));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-length")).toBe(String(size));
	});

	/**
	 * The cardinal rule of this change: `/api/fs/download?path=…` must NOT become public.
	 * Without a ticket the public handler falls through with `next()`, and the gate then has
	 * to stop it — that fall-through is exactly the seam that could publish the whole route.
	 */
	test("does not publish the path form: no session is still 401", async () => {
		const file = join(dir, "private.txt");
		writeFileSync(file, "must-not-be-public");
		const ticketless = await layered.request(downloadUrl(`path=${encodeURIComponent(file)}`));

		expect(ticketless.status).toBe(401);
		expect(await ticketless.text()).not.toContain("must-not-be-public");
	});

	/** With a session, the fall-through must reach the authenticated route unchanged. */
	test("the fall-through still serves the path form to a session", async () => {
		const file = join(dir, "session-form.txt");
		writeFileSync(file, "session-bytes");

		const res = await layered.request(downloadUrl(`path=${encodeURIComponent(file)}`), {
			headers: { Authorization: "Bearer test-session" },
		});

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("session-bytes");
	});

	/** Minting is a session-only action: it is the step that validates the path. */
	test("minting a ticket requires a session", async () => {
		const file = join(dir, "needs-session.txt");
		writeFileSync(file, "x");

		const res = await layered.request("http://localhost/api/fs/download-ticket", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: file }),
		});

		expect(res.status).toBe(401);
	});

	/** Other /api/fs endpoints must stay closed: only `/download` was mounted early. */
	test.each(["browse", "preview", "edit-source"])("%s stays behind the gate", async (endpoint) => {
		const res = await layered.request(
			`http://localhost/api/fs/${endpoint}?path=${encodeURIComponent(dir)}`,
		);
		expect(res.status).toBe(401);
	});

	test("serves the claim budget, then refuses another replay with no session", async () => {
		const file = join(dir, "replay.txt");
		writeFileSync(file, "once");
		const ticket = await mint(file);

		for (let i = 0; i < DOWNLOAD_TICKET_MAX_CLAIMS; i += 1) {
			const res = await layered.request(downloadUrl(`ticket=${encodeURIComponent(ticket)}`));
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("once");
		}

		const replay = await layered.request(downloadUrl(`ticket=${encodeURIComponent(ticket)}`));
		expect(replay.status).toBe(403);
		expect(replay.headers.get("content-type")).toContain("text/html");
		const body = await replay.text();
		expect(body).toContain("DOWNLOAD_TICKET_ALREADY_USED");
		expect(body).toContain("already used");
		expect(body).not.toContain(file);
	});

	test("refuses a forged ticket without leaking the path", async () => {
		const file = join(dir, "forged.txt");
		writeFileSync(file, "target-bytes");
		const ticket = await mint(file);
		const [expiry, , signature] = ticket.split(".");
		const forged = `${expiry}.${"0".repeat(32)}.${signature}`;

		const res = await layered.request(downloadUrl(`ticket=${encodeURIComponent(forged)}`));

		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("target-bytes");
	});

	test("refuses an empty ticket parameter", async () => {
		const res = await layered.request(downloadUrl("ticket="));
		// An empty ticket is not a ticket: the request falls through to the gate.
		expect(res.status).toBe(401);
	});

	/**
	 * A file deleted between click and navigation is the ordinary failure of a 60-second
	 * ticket. It has to be a readable sentence, not the route's JSON validation body — a human
	 * is looking at the resulting browser tab.
	 */
	test("explains a file that vanished between minting and claiming", async () => {
		const file = join(dir, "vanishing.txt");
		writeFileSync(file, "here-for-now");
		const ticket = await mint(file);
		rmSync(file, { force: true });

		const res = await layered.request(downloadUrl(`ticket=${encodeURIComponent(ticket)}`));

		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("DOWNLOAD_UNAVAILABLE");
		expect(body).toContain("no longer available");
		expect(body).not.toContain(file);
	});

	test("carries a non-ASCII name through RFC 5987 on the ticket route too", async () => {
		const file = join(dir, "票据报告.json");
		writeFileSync(file, "{}");
		const ticket = await mint(file);

		const res = await layered.request(downloadUrl(`ticket=${encodeURIComponent(ticket)}`));

		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toContain("filename*=UTF-8''%E7%A5%A8%E6%8D%AE%E6%8A%A5%E5%91%8A.json");
	});

	/**
	 * The ticket's only authorization content is the path stored server-side, so the URL must
	 * not be a way to reach a DIFFERENT file: two tickets minted at the same instant must each
	 * serve their own file. (Tampering with the token itself is covered in
	 * `lib/__tests__/fs-download-ticket.test.ts`; this pins the route end.)
	 */
	test("each ticket serves only the file it was minted for", async () => {
		const first = join(dir, "first.txt");
		const second = join(dir, "second.txt");
		writeFileSync(first, "first-bytes");
		writeFileSync(second, "second-bytes");

		const firstTicket = await mint(first);
		const secondTicket = await mint(second);

		expect(
			await (
				await layered.request(downloadUrl(`ticket=${encodeURIComponent(firstTicket)}`))
			).text(),
		).toBe("first-bytes");
		expect(
			await (
				await layered.request(downloadUrl(`ticket=${encodeURIComponent(secondTicket)}`))
			).text(),
		).toBe("second-bytes");
	});

	/** The secret-path refusal must survive onto the ticket route, not just the path form. */
	test("the session form still refuses credential files", async () => {
		const secret = join(narraforkDir, "settings.json");
		mkdirSync(narraforkDir, { recursive: true });
		writeFileSync(secret, '{"auth":{"jwtSecret":"leaked-secret-marker"}}');

		const res = await layered.request(downloadUrl(`path=${encodeURIComponent(secret)}`), {
			headers: { Authorization: "Bearer test-session" },
		});

		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("leaked-secret-marker");
	});
});
