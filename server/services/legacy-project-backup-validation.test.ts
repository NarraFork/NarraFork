import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

class Reader extends EventEmitter {
	static instances: Reader[] = [];
	terminating = false;
	private release!: (code: number) => void;
	private stopped = new Promise<number>((resolve) => {
		this.release = resolve;
	});
	constructor() {
		super();
		Reader.instances.push(this);
		queueMicrotask(() => this.emit("message", { valid: true }));
	}
	terminate() {
		this.terminating = true;
		return this.stopped;
	}
	exit() {
		this.emit("exit", 0);
		this.release(0);
	}
}
mock.module("node:worker_threads", () => ({ Worker: Reader }));
const { validateLegacyProjectBackup } = await import("./legacy-project-backup-validation");
afterEach(() => {
	for (const reader of Reader.instances.splice(0)) reader.exit();
});
async function flush() {
	for (let index = 0; index < 4; index++) await Promise.resolve();
}

test("validated backup is not authorized until its reader has actually exited", async () => {
	let returned = false;
	const validation = validateLegacyProjectBackup("fixture.db", "p").then((value) => {
		returned = true;
		return value;
	});
	await flush();
	expect(Reader.instances[0]?.terminating).toBe(true);
	expect(returned).toBe(false);
	Reader.instances[0]?.exit();
	expect(await validation).toBe(true);
});
test("private backup validation never creates an unbounded worker queue", async () => {
	const a = validateLegacyProjectBackup("a.db", "a");
	const b = validateLegacyProjectBackup("b.db", "b");
	expect(await validateLegacyProjectBackup("c.db", "c")).toBe(false);
	expect(Reader.instances.length).toBe(2);
	for (const reader of Reader.instances) reader.exit();
	expect(await a).toBe(true);
	expect(await b).toBe(true);
	const next = validateLegacyProjectBackup("d.db", "d");
	await flush();
	Reader.instances.at(-1)?.exit();
	expect(await next).toBe(true);
});
