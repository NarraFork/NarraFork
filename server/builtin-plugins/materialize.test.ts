import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializedFileMatches } from "./materialize";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nf-materialize-"));
	dirs.push(dir);
	return dir;
}

describe("materializedFileMatches", () => {
	test("a missing file does not match", async () => {
		const dir = await tempDir();
		expect(await materializedFileMatches(join(dir, "missing.json"), '{"a":1}')).toBe(false);
	});

	test("identical text matches, including multibyte characters", async () => {
		const dir = await tempDir();
		const path = join(dir, "readme.txt");
		await writeFile(path, "插件说明", "utf8");
		expect(await materializedFileMatches(path, "插件说明")).toBe(true);
	});

	test("the same byte length with different bytes does not match", async () => {
		const dir = await tempDir();
		const path = join(dir, "plugin.json");
		await writeFile(path, "aaaa", "utf8");
		expect(Buffer.byteLength("aaaa")).toBe(Buffer.byteLength("bbbb"));
		expect(await materializedFileMatches(path, "bbbb")).toBe(false);
	});
});
