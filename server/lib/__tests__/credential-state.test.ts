import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStateStore } from "../credential-state";

const dirs: string[] = [];
function statePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-credential-state-"));
	dirs.push(dir);
	return join(dir, "credential-state.json");
}
const readState = (path: string) => JSON.parse(readFileSync(path, "utf8"));

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CredentialStateStore", () => {
	test("merges several changes into one write", () => {
		const path = statePath();
		const store = new CredentialStateStore(path);
		store.set("a", { stats: { successCount: 1, failureCount: 0 } });
		store.set("b", { blocked: { reason: "quota_exhausted", resetsAt: 123 } });
		store.set("a", { stats: { successCount: 2, failureCount: 0 } });
		expect(existsSync(path)).toBe(false);

		store.flush();
		expect(readState(path)).toEqual({
			a: { stats: { successCount: 2, failureCount: 0 } },
			b: { blocked: { reason: "quota_exhausted", resetsAt: 123 } },
		});
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

		// Nothing pending: flush and dispose do not write again.
		rmSync(path);
		store.flush();
		store.dispose();
		expect(existsSync(path)).toBe(false);
	});

	test("writes on its own after the debounce delay", async () => {
		const path = statePath();
		const store = new CredentialStateStore(path, 5);
		store.set("a", { stats: { successCount: 1, failureCount: 0 } });
		await Bun.sleep(40);
		expect(readState(path)).toEqual({ a: { stats: { successCount: 1, failureCount: 0 } } });
	});

	test("an empty state removes the credential and reloads from disk", () => {
		const path = statePath();
		const store = new CredentialStateStore(path);
		store.set("a", { stats: { successCount: 1, failureCount: 0 } });
		store.set("b", { stats: { successCount: 3, failureCount: 1 } });
		store.set("a", { usage: undefined, blocked: undefined });
		store.dispose();
		expect(Object.keys(readState(path))).toEqual(["b"]);

		const reloaded = new CredentialStateStore(path);
		expect(reloaded.get("b")).toEqual({ stats: { successCount: 3, failureCount: 1 } });
		expect(reloaded.get("a")).toBeUndefined();
	});

	test("an unreadable file starts empty", () => {
		const path = statePath();
		writeFileSync(path, "{not json");
		const store = new CredentialStateStore(path);
		expect(store.get("a")).toBeUndefined();
		store.set("a", { stats: { successCount: 1, failureCount: 0 } });
		store.flush();
		expect(readState(path)).toEqual({ a: { stats: { successCount: 1, failureCount: 0 } } });
	});
});
