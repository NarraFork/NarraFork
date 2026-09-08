import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../local-backend";

const roots: string[] = [];
function tempRoot() {
	const root = mkdtempSync(join(tmpdir(), "nf-bounded-glob-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local glob worker budgets", () => {
	test("literal path query, Unicode, spaces and directory candidates are supported", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "中文 dir"));
		writeFileSync(join(root, "中文 dir", "name.ts"), "ignored content");
		writeFileSync(join(root, "other.ts"), "");
		const result = await new LocalBackend().glob("**/*", {
			cwd: root,
			query: "中文",
			includeDirectories: true,
			maxBytes: 4096,
			maxResults: 50,
			timeoutMs: 2000,
		});
		expect([...result].sort()).toEqual(["中文 dir", "中文 dir/name.ts"]);
		expect(result.truncated).toBe(false);
	});
	test("count and byte budgets stop collection and carry truncation", async () => {
		const root = tempRoot();
		for (let i = 0; i < 30; i++) writeFileSync(join(root, `file-${i}.ts`), "");
		const backend = new LocalBackend();
		const byCount = await backend.glob("**/*", {
			cwd: root,
			maxResults: 3,
			maxBytes: 1000,
			timeoutMs: 2000,
		});
		expect(byCount).toHaveLength(3);
		expect(byCount.truncated).toBe(true);
		const byBytes = await backend.glob("**/*", {
			cwd: root,
			maxResults: 30,
			maxBytes: 5,
			timeoutMs: 2000,
		});
		expect(byBytes).toHaveLength(0);
		expect(byBytes.truncated).toBe(true);
	});
	test("a scan with no matches is terminated on deadline, not just abandoned", async () => {
		const root = tempRoot();
		for (let dir = 0; dir < 20; dir++) {
			const path = join(root, `dir-${dir}`);
			mkdirSync(path);
			for (let file = 0; file < 50; file++) writeFileSync(join(path, `file-${file}.ts`), "");
		}
		const terminate = spyOn(Worker.prototype, "terminate");
		try {
			await expect(
				new LocalBackend().glob("**/never-present-*.xyz", {
					cwd: root,
					maxResults: 50,
					maxBytes: 1024,
					timeoutMs: 1,
				}),
			).rejects.toThrow(/timed out/i);
			expect(terminate).toHaveBeenCalled();
		} finally {
			terminate.mockRestore();
		}
	});
	test("abort terminates its worker and a later request works normally", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "file.ts"), "");
		const abort = new AbortController();
		const terminate = spyOn(Worker.prototype, "terminate");
		const pending = new LocalBackend().glob("**/*", {
			cwd: root,
			signal: abort.signal,
			timeoutMs: 2000,
		});
		abort.abort(new Error("superseded query"));
		try {
			await expect(pending).rejects.toThrow("superseded query");
			expect(terminate).toHaveBeenCalled();
		} finally {
			terminate.mockRestore();
		}
		expect([...(await new LocalBackend().glob("**/*", { cwd: root, timeoutMs: 2000 }))]).toEqual([
			"file.ts",
		]);
	});
	test("pre-aborted or invalid-budget calls cannot start scanning", async () => {
		const abort = new AbortController();
		abort.abort(new Error("cancelled"));
		await expect(
			new LocalBackend().glob("**/*", { cwd: "/not-a-user-directory", signal: abort.signal }),
		).rejects.toThrow("cancelled");
		await expect(
			new LocalBackend().glob("**/*", { cwd: "/not-a-user-directory", timeoutMs: 0 }),
		).rejects.toThrow(/limits/);
	});
});
