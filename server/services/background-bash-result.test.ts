import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { basename, dirname } from "node:path";
import { OUTPUT_DIR } from "../lib/agent/truncate";
import { logger } from "../lib/logger";
import { discardBackgroundBashResult, prepareBackgroundBashResult } from "./background-bash-result";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await discardBackgroundBashResult(path);
});

async function prepare(output: string, taskId = "task") {
	const result = await prepareBackgroundBashResult(taskId, output);
	if (result.outputPath) paths.push(result.outputPath);
	return result;
}

function requirePath(result: { outputPath?: string }): string {
	if (!result.outputPath) throw new Error("Expected spilled output path");
	return result.outputPath;
}

function preview(content: string): string {
	return content.split("UTF-8 bytes):\n")[1];
}

describe("background Bash captured output", () => {
	test("preserves empty and sub-threshold UTF-8 output exactly", async () => {
		for (const output of ["", "a".repeat(5119), "中".repeat(1706)]) {
			expect(await prepare(output)).toEqual({ content: output });
		}
	});

	test("spills at exactly 5120 bytes and directs reads to local device", async () => {
		const output = "a".repeat(5120);
		const result = await prepare(output);
		expect(result.outputPath).toBeDefined();
		expect(dirname(requirePath(result))).toBe(OUTPUT_DIR);
		expect(basename(requirePath(result))).toStartWith("toolcall_");
		expect(await fs.readFile(requirePath(result), "utf8")).toBe(output);
		expect(result.content).toContain("captured output");
		expect(result.content).toContain('device: "local"');
		expect(result.content).toContain("Read or Grep");
		expect(result.content).toContain("No Await is needed");
		expect(result.content).toContain("If Read reports that the file was cleaned up");
		expect(result.content).toContain("may retain only a preview");
		expect(result.content).toContain("does not guarantee complete output");
		expect(Buffer.byteLength(preview(result.content))).toBe(1024);
	});

	test("uses UTF-8 byte threshold and complete Unicode tail boundaries", async () => {
		const output = "中😀".repeat(800);
		const result = await prepare(output);
		expect(await fs.readFile(requirePath(result), "utf8")).toBe(output);
		const tail = preview(result.content);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024);
		expect(tail).not.toContain("�");
		expect(output.endsWith(tail)).toBe(true);
	});

	test("same task gets unique files and task IDs cannot escape the directory", async () => {
		const [a, b] = await Promise.all([
			prepare("x".repeat(5120), "../../bad"),
			prepare("y".repeat(5120), "../../bad"),
		]);
		expect(a.outputPath).not.toBe(b.outputPath);
		expect(dirname(requirePath(a))).toBe(OUTPUT_DIR);
		expect(await fs.readFile(requirePath(a), "utf8")).toBe("x".repeat(5120));
	});

	test("clips oversized capture at the Bash 10 MiB limit without broken UTF-8", async () => {
		const output = `${"中".repeat(Math.ceil((10 * 1024 * 1024) / 3))}END`;
		const result = await prepare(output);
		const saved = await fs.readFile(requirePath(result));
		expect(saved.length).toBeLessThanOrEqual(10 * 1024 * 1024);
		expect(saved.length).toBeGreaterThan(10 * 1024 * 1024 - 4);
		expect(saved.toString("utf8")).not.toContain("�");
		expect(result.content).toContain("clipped");
		expect(result.content).toContain("not the complete output");
		expect(preview(result.content)).toEndWith("END");
	});

	test("write failure returns bounded preview, Await fallback, and task-only warning", async () => {
		const mock = spyOn(fs, "writeFile").mockRejectedValue(new Error("disk full"));
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const secret = "SECRET_OUTPUT_BODY";
			const result = await prepare(`${secret}${"😀".repeat(2000)}`);
			expect(result.outputPath).toBeUndefined();
			expect(result.content).toContain("Failed to save captured output");
			expect(result.content).toContain('Await with type: "bash", id: "task"');
			expect(Buffer.byteLength(preview(result.content))).toBeLessThanOrEqual(1024);
			expect(warn).toHaveBeenCalledWith("Background Bash captured output could not be saved", {
				taskId: "task",
				reason: "write_failed",
			});
			for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
		} finally {
			mock.mockRestore();
			warn.mockRestore();
		}
	});

	test("timeout returns without waiting for writer and removes late file", async () => {
		const original = fs.writeFile;
		let release!: () => void;
		let latePath = "";
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let settled!: () => void;
		const done = new Promise<void>((resolve) => {
			settled = resolve;
		});
		const mock = spyOn(fs, "writeFile").mockImplementation(async (path, data) => {
			latePath = String(path);
			await gate;
			await original(path, data);
			settled();
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await prepare("x".repeat(5120));
			expect(result.outputPath).toBeUndefined();
			expect(result.content).toContain("timed out");
			expect(warn).toHaveBeenCalledWith("Background Bash captured output could not be saved", {
				taskId: "task",
				reason: "write_timeout",
			});
			release();
			await done;
			// Wait for the module's asynchronous late-write cleanup, not the timer.
			for (let i = 0; i < 50 && (await Bun.file(latePath).exists()); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(await Bun.file(latePath).exists()).toBe(false);
		} finally {
			release();
			mock.mockRestore();
			warn.mockRestore();
			await discardBackgroundBashResult(latePath);
		}
	});

	test("discard is idempotent and ignores paths outside its ownership", async () => {
		const result = await prepare("x".repeat(5120));
		await discardBackgroundBashResult(result.outputPath);
		await discardBackgroundBashResult(result.outputPath);
		await discardBackgroundBashResult();
		expect(await Bun.file(requirePath(result)).exists()).toBe(false);
		const mock = spyOn(fs, "unlink");
		try {
			await discardBackgroundBashResult("/somewhere/toolcall_123_abcd");
			await discardBackgroundBashResult(`${OUTPUT_DIR}/tool_123_abcd`);
			expect(mock).not.toHaveBeenCalled();
		} finally {
			mock.mockRestore();
		}
	});
});
