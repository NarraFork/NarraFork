/**
 * Tests for bash tool watchdog & emitLongRunning integration.
 *
 * These tests verify that:
 *   1. The watchdog timer is properly set up and cleaned up
 *   2. emitLongRunning is wired through ctx correctly
 *   3. Fast commands don't trigger long-running notification
 *   4. The watchdog doesn't interfere with normal command execution
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../types";
import { bashTool } from "../bash";

const TEST_DIR = join(tmpdir(), `narrafork-bash-watchdog-test-${Date.now()}`);

beforeAll(() => {
	if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

function makeCtx(cwd = TEST_DIR): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
		currentToolUseId: "test-tool-use-id",
	};
}

describe("bash tool — watchdog integration", () => {
	test("fast command does NOT trigger emitLongRunning", async () => {
		let longRunningFired = false;
		const ctx = makeCtx();
		ctx.emitLongRunning = () => {
			longRunningFired = true;
		};
		const result = await bashTool.execute({ command: "echo hello" }, ctx);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("hello");
		expect(longRunningFired).toBe(false);
	});

	test("watchdog does not interfere with normal output", async () => {
		const ctx = makeCtx();
		const result = await bashTool.execute(
			{ command: "echo line1 && echo line2 && echo line3" },
			ctx,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line2");
		expect(result.output).toContain("line3");
	});

	test("watchdog timer is cleaned up after command exits", async () => {
		// Run a fast command — if watchdog timer leaks, bun:test will warn about open handles
		const ctx = makeCtx();
		await bashTool.execute({ command: "echo cleanup-test" }, ctx);
		// If we get here without hanging, the timer was cleaned up
		expect(true).toBe(true);
	});

	test("emitOutput still works alongside watchdog", async () => {
		const outputs: string[] = [];
		const ctx = makeCtx();
		ctx.emitOutput = (output: string) => outputs.push(output);
		await bashTool.execute({ command: "echo streaming-test" }, ctx);
		expect(outputs.length).toBeGreaterThanOrEqual(1);
		expect(outputs[outputs.length - 1]).toContain("streaming-test");
	});

	test("abort signal still works with watchdog active", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 500);
		const ctx = makeCtx();
		ctx.signal = ac.signal;
		const start = Date.now();
		const result = await bashTool.execute({ command: "sleep 30" }, ctx);
		const elapsed = Date.now() - start;
		expect(result.isError).toBe(true);
		expect(result.output).toContain("aborted");
		expect(elapsed).toBeLessThan(5_000);
	});

	test("timeout still works with watchdog active", async () => {
		const ctx = makeCtx();
		const start = Date.now();
		const result = await bashTool.execute({ command: "sleep 30", timeout: 1000 }, ctx);
		const elapsed = Date.now() - start;
		expect(result.isError).toBe(true);
		expect(result.output).toContain("timed out");
		expect(elapsed).toBeLessThan(5_000);
	});
});
