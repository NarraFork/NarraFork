import { beforeEach, describe, expect, test } from "bun:test";
import {
	type PostShutdownHook,
	registerPostShutdownHook,
	resetPostShutdownHooksForTests,
	runPostShutdownHooks,
} from "../post-shutdown-hooks";

const calls: string[] = [];

function recordingHook(label: string): PostShutdownHook {
	return ({ reason }) => {
		calls.push(`${label}:${reason}`);
	};
}

beforeEach(() => {
	calls.length = 0;
	resetPostShutdownHooksForTests();
});

describe("post-shutdown hooks", () => {
	test("runs every registered hook with the shutdown reason", async () => {
		registerPostShutdownHook("a", recordingHook("a"));
		registerPostShutdownHook("b", recordingHook("b"));
		await runPostShutdownHooks("unattended_idle");
		expect(calls.sort()).toEqual(["a:unattended_idle", "b:unattended_idle"]);
	});

	test("registering the same key twice replaces the hook instead of stacking it", async () => {
		registerPostShutdownHook("unattended-mode", recordingHook("first"));
		registerPostShutdownHook("unattended-mode", recordingHook("second"));
		await runPostShutdownHooks("unattended_idle");
		expect(calls).toEqual(["second:unattended_idle"]);
	});

	test("registering null removes a hook", async () => {
		registerPostShutdownHook("a", recordingHook("a"));
		registerPostShutdownHook("a", null);
		await runPostShutdownHooks("operator_shutdown");
		expect(calls).toEqual([]);
	});

	test("a throwing hook never rejects the shutdown sequence", async () => {
		registerPostShutdownHook("boom", () => {
			throw new Error("hook exploded");
		});
		registerPostShutdownHook("ok", recordingHook("ok"));
		await runPostShutdownHooks("unattended_idle");
		expect(calls).toEqual(["ok:unattended_idle"]);
	});

	test("a hanging hook is bounded by the deadline", async () => {
		registerPostShutdownHook("hang", () => new Promise<void>(() => {}));
		const started = Date.now();
		await runPostShutdownHooks("unattended_idle", 20);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("no hooks is a no-op", async () => {
		await runPostShutdownHooks("signal");
		expect(calls).toEqual([]);
	});
});
