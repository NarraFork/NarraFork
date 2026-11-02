/**
 * `GET/PUT /api/fs/project-prompt` — the project instruction file the "new session"
 * dialog edits before any narrator exists.
 *
 * Three properties are worth pinning, because each fails silently:
 *
 *  - the READ resolves the same file the system prompt injects
 *    (`PROJECT_PROMPT_FILENAMES` order), so the dialog can never show one file while
 *    the session reads another;
 *  - the WRITE is an optimistic lock. An agent rewriting AGENTS.md while the dialog is
 *    open must produce a 409 carrying the current text, never a silent overwrite;
 *  - the write is bounded to the known filenames inside the given directory, so this
 *    route cannot become a general-purpose file write that skips `/api/fs/write`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { MAX_PROJECT_INSTRUCTIONS_BYTES } from "../../lib/read-file-capped";

const { fsRoutes } = await import("../fs");

const USER_ID = "project-prompt-user";

let root: string;
let workspace: string;

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: USER_ID, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/fs", fsRoutes);
	instance.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	return instance;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function readPrompt(cwd: string) {
	const response = await app().request(
		`http://localhost/fs/project-prompt?cwd=${encodeURIComponent(cwd)}`,
	);
	expect(response.status).toBe(200);
	return (await response.json()) as {
		cwd: string;
		filename: string;
		path: string;
		exists: boolean;
		content: string;
		truncated: boolean;
		hash: string | null;
		candidates: string[];
	};
}

function putPrompt(body: Record<string, unknown>) {
	return app().request("http://localhost/fs/project-prompt", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "narrafork-project-prompt-"));
});

afterAll(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* Windows keeps handles; leaking a temp dir is harmless. */
	}
});

beforeEach(() => {
	workspace = mkdtempSync(join(root, "ws-"));
});

describe("reading", () => {
	test("an empty directory reports the file a save would create", async () => {
		const result = await readPrompt(workspace);
		expect(result.exists).toBe(false);
		expect(result.filename).toBe("AGENTS.md");
		expect(result.content).toBe("");
		expect(result.hash).toBeNull();
		expect(result.path).toBe(join(workspace, "AGENTS.md"));
		expect(result.candidates[0]).toBe("AGENTS.override.md");
	});

	test("an existing file is returned with the hash the save must present", async () => {
		writeFileSync(join(workspace, "CLAUDE.md"), "# 项目约定\n");
		const result = await readPrompt(workspace);
		expect(result.exists).toBe(true);
		expect(result.filename).toBe("CLAUDE.md");
		expect(result.content).toBe("# 项目约定\n");
		expect(result.truncated).toBe(false);
		expect(result.hash).toBe(sha256("# 项目约定\n"));
	});

	test("the highest-priority candidate wins, matching prompt injection", async () => {
		writeFileSync(join(workspace, "CLAUDE.md"), "claude");
		writeFileSync(join(workspace, "AGENTS.md"), "agents");
		const result = await readPrompt(workspace);
		expect(result.filename).toBe("AGENTS.md");
		expect(result.content).toBe("agents");
	});

	test("a directory is not a prompt file", async () => {
		mkdirSync(join(workspace, "AGENTS.md"));
		writeFileSync(join(workspace, "AGENT.md"), "legacy");
		const result = await readPrompt(workspace);
		expect(result.filename).toBe("AGENT.md");
		expect(result.content).toBe("legacy");
	});

	test("a missing working directory is a validation error, not a 500", async () => {
		const response = await app().request(
			`http://localhost/fs/project-prompt?cwd=${encodeURIComponent(join(workspace, "nope"))}`,
		);
		expect(response.status).toBe(400);
	});

	test("a file is not a working directory", async () => {
		const file = join(workspace, "plain.txt");
		writeFileSync(file, "x");
		const response = await app().request(
			`http://localhost/fs/project-prompt?cwd=${encodeURIComponent(file)}`,
		);
		expect(response.status).toBe(400);
	});
});

describe("writing", () => {
	test("creates the default file when none exists", async () => {
		const response = await putPrompt({ cwd: workspace, filename: "AGENTS.md", content: "# hi\n" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { path: string; hash: string };
		expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("# hi\n");
		expect(body.hash).toBe(sha256("# hi\n"));

		// The next read sees the created file rather than "would create".
		const reread = await readPrompt(workspace);
		expect(reread.exists).toBe(true);
		expect(reread.content).toBe("# hi\n");
	});

	test("updates an existing file when the hash matches", async () => {
		writeFileSync(join(workspace, "CLAUDE.md"), "old");
		const before = await readPrompt(workspace);
		const response = await putPrompt({
			cwd: workspace,
			filename: before.filename,
			content: "new",
			baseHash: before.hash,
		});
		expect(response.status).toBe(200);
		expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toBe("new");
	});

	test("refuses a stale hash and hands back the current text", async () => {
		writeFileSync(join(workspace, "AGENTS.md"), "1");
		const before = await readPrompt(workspace);
		// An agent rewrites the file between the dialog opening and the save.
		writeFileSync(join(workspace, "AGENTS.md"), "agent edit");
		const response = await putPrompt({
			cwd: workspace,
			filename: before.filename,
			content: "my edit",
			baseHash: before.hash,
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as { code: string; currentContent: string };
		expect(body.code).toBe("STALE_WRITE");
		expect(body.currentContent).toBe("agent edit");
		expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("agent edit");
	});

	test("refuses to overwrite a file the client never read", async () => {
		writeFileSync(join(workspace, "AGENTS.md"), "existing");
		const response = await putPrompt({ cwd: workspace, filename: "AGENTS.md", content: "blind" });
		expect(response.status).toBe(409);
		expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("existing");
	});

	test("refuses a create when the file appeared meanwhile", async () => {
		const absent = await readPrompt(workspace);
		expect(absent.hash).toBeNull();
		writeFileSync(join(workspace, "AGENTS.md"), "raced");
		const response = await putPrompt({
			cwd: workspace,
			filename: "AGENTS.md",
			content: "mine",
		});
		expect(response.status).toBe(409);
	});

	test("preserves CRLF line endings", async () => {
		writeFileSync(join(workspace, "AGENTS.md"), "one\r\ntwo\r\n");
		const before = await readPrompt(workspace);
		const response = await putPrompt({
			cwd: workspace,
			filename: before.filename,
			content: "one\ntwo\nthree\n",
			baseHash: before.hash,
		});
		expect(response.status).toBe(200);
		expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("one\r\ntwo\r\nthree\r\n");
	});

	test("a file that exactly fills the read cap is still editable", async () => {
		writeFileSync(join(workspace, "AGENTS.md"), "a".repeat(MAX_PROJECT_INSTRUCTIONS_BYTES));
		const loaded = await readPrompt(workspace);
		expect(loaded.truncated).toBe(false);
		expect(loaded.content.length).toBe(MAX_PROJECT_INSTRUCTIONS_BYTES);
		const response = await putPrompt({
			cwd: workspace,
			filename: loaded.filename,
			content: "short",
			baseHash: loaded.hash,
		});
		expect(response.status).toBe(200);
		expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("short");
	});

	test("a file past the read cap is reported truncated and refused on write", async () => {
		writeFileSync(join(workspace, "AGENTS.md"), "b".repeat(MAX_PROJECT_INSTRUCTIONS_BYTES + 1));
		const loaded = await readPrompt(workspace);
		expect(loaded.truncated).toBe(true);
		const response = await putPrompt({
			cwd: workspace,
			filename: loaded.filename,
			content: "short",
			baseHash: loaded.hash,
		});
		expect(response.status).toBe(400);
		expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe(
			"b".repeat(MAX_PROJECT_INSTRUCTIONS_BYTES + 1),
		);
	});

	test("rejects a filename that is not a known instruction file", async () => {
		const response = await putPrompt({
			cwd: workspace,
			filename: "../../etc/passwd",
			content: "x",
		});
		expect(response.status).toBe(400);
		expect(existsSync(join(workspace, "..", "etc", "passwd"))).toBe(false);
	});

	test("rejects missing fields by name", async () => {
		const response = await putPrompt({ filename: "AGENTS.md", content: "x" });
		expect(response.status).toBe(400);
	});
});
