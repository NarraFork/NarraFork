import { describe, expect, test } from "bun:test";
import { acquireFileHistoryCapture, withFileHistoryWrite } from "./file-history-locks";

const t = (p: string, d = "d1") => ({
	deviceId: d,
	pathFlavor: "posix" as const,
	canonicalPath: p,
});
const win = (p: string, d = "d1") => ({
	deviceId: d,
	pathFlavor: "windows" as const,
	canonicalPath: p,
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const backslash = String.fromCharCode(92);

describe("file history locks", () => {
	test("serializes same file and parallelizes different files", async () => {
		const a: string[] = [];
		let go!: () => void;
		const gate = new Promise<void>((r) => (go = r));
		const first = withFileHistoryWrite(t("/a"), async () => {
			a.push("1");
			await gate;
			a.push("2");
		});
		const second = withFileHistoryWrite(t("/a"), () => a.push("3"));
		await tick();
		expect(a).toEqual(["1"]);
		go();
		await Promise.all([first, second]);
		expect(a).toEqual(["1", "2", "3"]);
	});

	test("capture root blocks child but not outside", async () => {
		const release = await acquireFileHistoryCapture(t("/root"));
		let child = false;
		const p = withFileHistoryWrite(t("/root/x"), () => {
			child = true;
		});
		const outside = withFileHistoryWrite(t("/other"), () => "ok");
		await outside;
		expect(child).toBe(false);
		release();
		await p;
		expect(child).toBe(true);
	});

	test("Windows drive roots block descendant paths", async () => {
		const release = await acquireFileHistoryCapture(win(`C:${backslash}`));
		let ran = false;
		const pending = withFileHistoryWrite(win(["C:", "repo", "file.txt"].join(backslash)), () => {
			ran = true;
		});
		await tick();
		expect(ran).toBe(false);
		release();
		await pending;
		expect(ran).toBe(true);
	});

	test("devices do not interfere and abort does not release holder", async () => {
		const release = await acquireFileHistoryCapture(t("/x"));
		const c = new AbortController();
		const p = withFileHistoryWrite(t("/x"), () => {}, c.signal);
		c.abort();
		await expect(p).rejects.toBeDefined();
		let ran = false;
		await withFileHistoryWrite(t("/x", "d2"), () => {
			ran = true;
		});
		expect(ran).toBe(true);
		release();
	});

	test("capture waiters remain fair", async () => {
		const release = await acquireFileHistoryCapture(t("/r"));
		const order: number[] = [];
		const p1 = withFileHistoryWrite(t("/r/a"), () => order.push(1));
		const p2 = withFileHistoryWrite(t("/r/b"), () => order.push(2));
		release();
		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});
});
