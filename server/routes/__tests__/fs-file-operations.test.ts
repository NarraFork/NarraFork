/**
 * `POST /api/fs/rename`, `/api/fs/transfer`, `/api/fs/delete` — the entry operations the
 * file tree's context menu performs.
 *
 * These three routes can destroy a person's work, so what they pin is not the happy path
 * but the gates around it:
 *
 *  - the WRITE allow-list, not the read deny-list: a path outside the narrator's workspace
 *    and every declared writable directory is refused even though it can be read;
 *  - the credential and git checks, which sit inside that allow-list, survive;
 *  - a rename cannot become a move (the parent comes from the source path, never the body);
 *  - paste keeps the source NAME, so a paste cannot write at a client-chosen file name;
 *  - delete and transfer refuse directories, so "delete this file" cannot become
 *    "delete this subtree";
 *  - nothing is touched when the destination already exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const { fsRoutes } = await import("../fs");
const { db } = await import("../../db");
const { fileAttributions, narrators, users } = await import("../../db/schema");
const { eq } = await import("drizzle-orm");
const { generateId } = await import("../../lib/id");

const USER_ID = "fs-entry-ops-user";
const OTHER_USER_ID = "fs-entry-ops-other";

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

async function post(
	route: "rename" | "transfer" | "delete",
	body: Record<string, unknown>,
	userId = USER_ID,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await appAs(userId).request(`http://localhost/fs/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
	const root = mkdtempSync(join(tmpdir(), "nf-fs-entries-"));
	workspace = join(root, "workspace");
	outside = join(root, "outside");
	mkdirSync(join(workspace, "src"), { recursive: true });
	mkdirSync(join(workspace, "docs"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "keep.txt"), "outside\n");

	const now = new Date().toISOString();
	for (const id of [USER_ID, OTHER_USER_ID]) {
		await db
			.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: now })
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

describe("rename", () => {
	test("renames a file in place", async () => {
		const source = join(workspace, "src", "before.ts");
		writeFileSync(source, "content\n");
		const { status, json } = await post("rename", { narratorId, path: source, name: "after.ts" });

		expect(status).toBe(200);
		expect(json.path).toBe(join(workspace, "src", "after.ts"));
		expect(existsSync(source)).toBe(false);
		expect(readFileSync(join(workspace, "src", "after.ts"), "utf-8")).toBe("content\n");
	});

	test("keeps the entry in its own directory, so a name cannot move it", async () => {
		const source = join(workspace, "src", "stays.ts");
		writeFileSync(source, "x\n");
		// A separator is a validation error, not a path to somewhere else.
		const { status } = await post("rename", {
			narratorId,
			path: source,
			name: "../escaped.ts",
		});
		expect(status).toBe(400);
		expect(existsSync(source)).toBe(true);
		expect(existsSync(join(workspace, "escaped.ts"))).toBe(false);
	});

	test("refuses to overwrite an existing entry", async () => {
		const source = join(workspace, "docs", "a.md");
		writeFileSync(source, "a\n");
		writeFileSync(join(workspace, "docs", "b.md"), "b\n");
		const { status, json } = await post("rename", { narratorId, path: source, name: "b.md" });

		expect(status).toBe(409);
		expect(json.code).toBe("ALREADY_EXISTS");
		expect(readFileSync(join(workspace, "docs", "b.md"), "utf-8")).toBe("b\n");
		expect(readFileSync(source, "utf-8")).toBe("a\n");
	});

	test("refuses a directory, which another session may be working in", async () => {
		const dir = join(workspace, "docs", "a-folder");
		mkdirSync(dir);
		const { status, json } = await post("rename", { narratorId, path: dir, name: "renamed" });

		expect(status).toBe(422);
		expect(json.code).toBe("UNSUPPORTED_ENTRY");
		expect(existsSync(dir)).toBe(true);
	});

	test("a change of case only still renames", async () => {
		const source = join(workspace, "docs", "Case.md");
		writeFileSync(source, "case\n");
		const { status, json } = await post("rename", { narratorId, path: source, name: "case.md" });

		expect(status).toBe(200);
		expect(json.path).toBe(join(workspace, "docs", "case.md"));
		expect(readFileSync(join(workspace, "docs", "case.md"), "utf-8")).toBe("case\n");
	});

	test("a hard link under another name is a conflict, not the source itself", async () => {
		const source = join(workspace, "docs", "linked-a.md");
		writeFileSync(source, "same inode\n");
		linkSync(source, join(workspace, "docs", "linked-b.md"));
		const { status, json } = await post("rename", {
			narratorId,
			path: source,
			name: "linked-b.md",
		});

		expect(status).toBe(409);
		expect(json.code).toBe("ALREADY_EXISTS");
		expect(existsSync(source)).toBe(true);
	});

	test("refuses a missing entry", async () => {
		const { status } = await post("rename", {
			narratorId,
			path: join(workspace, "src", "nope.ts"),
			name: "still-nope.ts",
		});
		expect(status).toBe(400);
	});
});

describe("transfer", () => {
	test("copies a file into the target directory under its own name", async () => {
		const source = join(workspace, "src", "copy-me.ts");
		writeFileSync(source, "copy\n");
		const targetDir = join(workspace, "docs");
		const { status, json } = await post("transfer", {
			narratorId,
			path: source,
			targetDir,
			mode: "copy",
		});

		expect(status).toBe(200);
		expect(json.path).toBe(join(targetDir, "copy-me.ts"));
		expect(readFileSync(join(targetDir, "copy-me.ts"), "utf-8")).toBe("copy\n");
		// A copy leaves the original in place, which is what makes a second paste possible.
		expect(existsSync(source)).toBe(true);
	});

	test("moves a file and removes the original", async () => {
		const source = join(workspace, "src", "move-me.ts");
		writeFileSync(source, "move\n");
		const { status } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "docs"),
			mode: "move",
		});

		expect(status).toBe(200);
		expect(existsSync(source)).toBe(false);
		expect(readFileSync(join(workspace, "docs", "move-me.ts"), "utf-8")).toBe("move\n");
	});

	test("refuses a paste whose destination name is taken", async () => {
		const source = join(workspace, "docs", "clash.ts");
		const target = join(workspace, "src", "clash.ts");
		writeFileSync(source, "new\n");
		writeFileSync(target, "old\n");
		const { status, json } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "copy",
		});

		expect(status).toBe(409);
		expect(json.code).toBe("ALREADY_EXISTS");
		expect(readFileSync(target, "utf-8")).toBe("old\n");
	});

	test("replaces a taken destination only when the caller asks to overwrite", async () => {
		const source = join(workspace, "docs", "replace.ts");
		const target = join(workspace, "src", "replace.ts");
		writeFileSync(source, "new\n");
		writeFileSync(target, "old\n");

		const { status, json } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "copy",
			overwrite: true,
		});

		expect(status).toBe(200);
		expect(json.path).toBe(target);
		expect(readFileSync(target, "utf-8")).toBe("new\n");
		// The source of a copy survives the overwrite.
		expect(readFileSync(source, "utf-8")).toBe("new\n");
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a failed copy leaves the file it was going to replace untouched",
		async () => {
			const source = join(workspace, "docs", "unreadable.ts");
			const target = join(workspace, "src", "unreadable.ts");
			writeFileSync(source, "new\n");
			writeFileSync(target, "old\n");
			chmodSync(source, 0o000);
			try {
				const { status, json } = await post("transfer", {
					narratorId,
					path: source,
					targetDir: join(workspace, "src"),
					mode: "copy",
					overwrite: true,
				});
				expect(status).toBe(422);
				expect(json.code).toBe("TRANSFER_FAILED");
			} finally {
				chmodSync(source, 0o644);
			}
			expect(readFileSync(target, "utf-8")).toBe("old\n");
			// No staging file is left behind next to it.
			expect(readdirSync(join(workspace, "src")).filter((name) => name.includes(".nf-"))).toEqual(
				[],
			);
		},
	);

	test("overwrite never follows a symlink to replace the file behind it", async () => {
		const source = join(workspace, "docs", "via-link.ts");
		const referent = join(workspace, "src", "referent.ts");
		const link = join(workspace, "src", "via-link.ts");
		writeFileSync(source, "new\n");
		writeFileSync(referent, "referent\n");
		symlinkSync(referent, link);

		const { status, json } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "copy",
			overwrite: true,
		});

		expect(status).toBe(422);
		expect(json.code).toBe("UNSUPPORTED_ENTRY");
		expect(readFileSync(referent, "utf-8")).toBe("referent\n");
	});

	test("pastes a file whose name is near the filesystem limit", async () => {
		const name = `${"n".repeat(240)}.ts`;
		const source = join(workspace, "docs", name);
		writeFileSync(source, "long\n");

		const { status } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "copy",
		});

		expect(status).toBe(200);
		expect(readFileSync(join(workspace, "src", name), "utf-8")).toBe("long\n");
	});

	test("a move may overwrite too, and then removes the original", async () => {
		const source = join(workspace, "docs", "moved-over.ts");
		const target = join(workspace, "src", "moved-over.ts");
		writeFileSync(source, "new\n");
		writeFileSync(target, "old\n");

		const { status } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "move",
			overwrite: true,
		});

		expect(status).toBe(200);
		expect(readFileSync(target, "utf-8")).toBe("new\n");
		expect(existsSync(source)).toBe(false);
	});

	test("overwrite never replaces a directory", async () => {
		const source = join(workspace, "docs", "keep-dir.ts");
		writeFileSync(source, "x\n");
		// A same-named directory would make "replace this file" a subtree deletion.
		const targetDir = join(workspace, "src", "keep-dir.ts");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "inside.ts"), "inside\n");

		const { status, json } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "copy",
			overwrite: true,
		});

		expect(status).toBe(422);
		expect(json.code).toBe("UNSUPPORTED_ENTRY");
		expect(readFileSync(join(targetDir, "inside.ts"), "utf-8")).toBe("inside\n");
	});

	test("a file pasted onto itself asks first, then succeeds without touching the bytes", async () => {
		const source = join(workspace, "src", "self-cut.ts");
		writeFileSync(source, "self\n");

		// Unconfirmed: the destination name is taken, exactly like any other collision, so
		// the client gets the same 409 it turns into an overwrite question.
		const conflicted = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "move",
		});
		expect(conflicted.status).toBe(409);
		expect(conflicted.json.code).toBe("ALREADY_EXISTS");
		expect(readFileSync(source, "utf-8")).toBe("self\n");

		// Confirmed: replacing a file with itself is a no-op, and it must not unlink the
		// bytes the transfer would read.
		const confirmed = await post("transfer", {
			narratorId,
			path: source,
			targetDir: join(workspace, "src"),
			mode: "move",
			overwrite: true,
		});
		expect(confirmed.status).toBe(200);
		expect(readFileSync(source, "utf-8")).toBe("self\n");
	});

	test("refuses a directory source", async () => {
		const { status, json } = await post("transfer", {
			narratorId,
			path: join(workspace, "src"),
			targetDir: join(workspace, "docs"),
			mode: "copy",
		});
		expect(status).toBe(422);
		expect(json.code).toBe("UNSUPPORTED_ENTRY");
	});

	test("refuses a target that is not a directory", async () => {
		const source = join(workspace, "src", "target-not-dir.ts");
		writeFileSync(source, "x\n");
		const { status } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: source,
			mode: "copy",
		});
		expect(status).toBe(400);
	});
});

describe("delete", () => {
	test("removes one file", async () => {
		const target = join(workspace, "src", "delete-me.ts");
		writeFileSync(target, "gone\n");
		const { status } = await post("delete", { narratorId, path: target });

		expect(status).toBe(200);
		expect(existsSync(target)).toBe(false);
	});

	test("is recorded as the person's change, so no concurrent Bash call owns it", async () => {
		const target = join(workspace, "src", "attributed.ts");
		writeFileSync(target, "mine\n");
		const { status } = await post("delete", { narratorId, path: target });

		expect(status).toBe(200);
		const rows = await db
			.select()
			.from(fileAttributions)
			.where(eq(fileAttributions.filePath, "src/attributed.ts"));
		expect(rows.map((row) => [row.action, row.userId])).toEqual([["human", USER_ID]]);
	});

	test("refuses a directory instead of removing it recursively", async () => {
		const target = join(workspace, "src", "sub");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "keep.ts"), "keep\n");

		const { status, json } = await post("delete", { narratorId, path: target });
		expect(status).toBe(422);
		expect(json.code).toBe("UNSUPPORTED_ENTRY");
		expect(existsSync(join(target, "keep.ts"))).toBe(true);
	});

	test("refuses a symlink rather than deleting the file it points at", async () => {
		const pointedAt = join(workspace, "docs", "real.ts");
		writeFileSync(pointedAt, "real\n");
		const link = join(workspace, "src", "link.ts");
		symlinkSync(pointedAt, link);

		const { status, json } = await post("delete", { narratorId, path: link });
		expect(status).toBe(422);
		expect(json.code).toBe("UNSUPPORTED_ENTRY");
		expect(existsSync(pointedAt)).toBe(true);
	});
});

describe("the write allow-list bounds all three", () => {
	test("a path outside the workspace is refused even though it can be read", async () => {
		const target = join(outside, "keep.txt");
		for (const route of ["delete", "rename"] as const) {
			const { status, json } = await post(route, {
				narratorId,
				path: target,
				...(route === "rename" ? { name: "renamed.txt" } : {}),
			});
			expect(status).toBe(403);
			expect(json.code).toBe("WRITE_REFUSED");
		}
		const copied = await post("transfer", {
			narratorId,
			path: target,
			targetDir: workspace,
			mode: "copy",
		});
		expect(copied.status).toBe(403);
		expect(readFileSync(target, "utf-8")).toBe("outside\n");
	});

	test("a paste into a directory outside the workspace is refused", async () => {
		const source = join(workspace, "src", "inside.ts");
		writeFileSync(source, "inside\n");
		const { status } = await post("transfer", {
			narratorId,
			path: source,
			targetDir: outside,
			mode: "copy",
		});
		expect(status).toBe(403);
		expect(existsSync(join(outside, "inside.ts"))).toBe(false);
	});

	test("a symlink that escapes the workspace is refused", async () => {
		const link = join(workspace, "src", "escape.txt");
		symlinkSync(join(outside, "keep.txt"), link);
		const { status, json } = await post("delete", { narratorId, path: link });
		// Escaping via a link is a hard refusal no confirmation can override.
		expect(status).toBe(403);
		expect(json.code).toBe("WRITE_REFUSED");
		expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("outside\n");
	});

	test("the git directory inside the workspace stays refused", async () => {
		const gitConfig = join(workspace, ".git", "config");
		mkdirSync(join(workspace, ".git"), { recursive: true });
		writeFileSync(gitConfig, "[core]\n");
		const { status } = await post("delete", { narratorId, path: gitConfig });
		expect(status).toBe(403);
		expect(existsSync(gitConfig)).toBe(true);
	});

	test("another user's private narrator cannot be written through", async () => {
		const target = join(workspace, "src", "foreign.ts");
		writeFileSync(target, "x\n");
		const { status } = await post("delete", { narratorId: foreignNarratorId, path: target });
		expect([403, 404]).toContain(status);
		expect(existsSync(target)).toBe(true);
	});

	test("a request without a narratorId is a validation error", async () => {
		const { status } = await post("delete", { path: join(workspace, "src", "x.ts") });
		expect(status).toBe(400);
	});
});
