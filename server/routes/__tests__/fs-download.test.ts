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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { narraforkDir } from "../../lib/settings";
import { fsRoutes } from "../fs";

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
	 * `auth.jwtSecret` (forge any user's session) and the database carries every
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
