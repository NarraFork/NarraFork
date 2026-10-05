import { afterEach, expect, test } from "bun:test";
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
import { acquireSqliteGenerationLock } from "../sqlite-generation-lock";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "nf-sqlite-lock-fixture-"));
	roots.push(root);
	mkdirSync(join(root, "meta"));
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("exclusive live owner rejects a second claimant and releases idempotently", () => {
	const root = fixture();
	const meta = join(root, "meta");
	const release = acquireSqliteGenerationLock(meta);
	const ownerPath = join(meta, "_generation.lock/owner.json");
	const owner = readFileSync(ownerPath, "utf8");
	expect(() => acquireSqliteGenerationLock(meta)).toThrow("lock exists");
	expect(readFileSync(ownerPath, "utf8")).toBe(owner);
	release();
	release();
	expect(existsSync(join(meta, "_generation.lock"))).toBe(false);
	acquireSqliteGenerationLock(meta)();
});
test("directory aliases have the same lock identity, including symlink/junction aliases", () => {
	const root = fixture();
	const meta = join(root, "meta");
	const alias = join(root, "alias");
	symlinkSync(meta, alias, process.platform === "win32" ? "junction" : "dir");
	const release = acquireSqliteGenerationLock(meta);
	expect(() => acquireSqliteGenerationLock(alias)).toThrow("lock exists");
	release();
	acquireSqliteGenerationLock(alias)();
});
test("missing or dead self-reported owner never authorizes automatic stale-lock takeover", () => {
	const root = fixture();
	const meta = join(root, "meta");
	mkdirSync(join(meta, "_generation.lock"));
	for (const owner of [null, { pid: -1, token: "stale", host: "same", unshipped: true }]) {
		if (owner) writeFileSync(join(meta, "_generation.lock/owner.json"), JSON.stringify(owner));
		expect(() => acquireSqliteGenerationLock(meta)).toThrow("explicit repair");
		expect(existsSync(join(meta, "_generation.lock"))).toBe(true);
	}
});
test("constructor failure removes only its own newly-created lock and preserves history", () => {
	const root = fixture();
	const meta = join(root, "meta");
	writeFileSync(join(meta, "history"), "immutable");
	for (const afterWrite of [false, true]) {
		expect(() =>
			acquireSqliteGenerationLock(meta, {
				writeOwner: (...args) => {
					if (afterWrite) writeFileSync(...args);
					throw new Error("owner creation fixture failed");
				},
			}),
		).toThrow("owner creation fixture failed");
		expect(existsSync(join(meta, "_generation.lock"))).toBe(false);
		expect(readFileSync(join(meta, "history"), "utf8")).toBe("immutable");
	}
});
test("owner changes are never released; release failure remains fail-closed", () => {
	const root = fixture();
	const meta = join(root, "meta");
	const release = acquireSqliteGenerationLock(meta);
	const owner = join(meta, "_generation.lock/owner.json");
	writeFileSync(owner, '{"token":"another-owner"}');
	expect(release).toThrow("owner changed");
	expect(readFileSync(owner, "utf8")).toContain("another-owner");
	expect(() => acquireSqliteGenerationLock(meta)).toThrow("lock exists");
	const second = fixture();
	const failRelease = acquireSqliteGenerationLock(join(second, "meta"), {
		removeDirectory: () => {
			throw new Error("release fixture failure");
		},
	});
	expect(failRelease).toThrow("release fixture failure");
	expect(() => acquireSqliteGenerationLock(join(second, "meta"))).toThrow("lock exists");
});
