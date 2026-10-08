import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const directory = join(root, "docs/task-call-challenges/results");
const binary = join(root, "node_modules/.bin/biome");

function format(source: string, path: string) {
	return spawnSync(
		binary,
		["format", `--config-path=${join(root, "biome.json")}`, `--stdin-file-path=${path}`],
		{
			cwd: root,
			input: source,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 24 * 1024 * 1024,
		},
	);
}

describe("frozen experiment artifact formatting", () => {
	test("keeps strict formatting enabled rather than excluding the evidence", () => {
		const config = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
		expect(config.formatter.enabled).toBe(true);
		expect(config.linter.enabled).toBe(true);
		const override = config.overrides.find((entry: { includes: string[] }) =>
			entry.includes.includes("docs/task-call-challenges/results/**/*.json"),
		);
		expect(override.json.formatter).toEqual({
			indentStyle: "space",
			indentWidth: 2,
			expand: "always",
		});
		expect(override.formatter?.enabled).not.toBe(false);
		expect(override.linter?.enabled).not.toBe(false);
		expect(config.files.includes.some((path: string) => path.includes("!**/docs"))).toBe(false);
	});

	test("corrects invalid artifact formatting but does not change its data", () => {
		const result = format('{"x":1,"items":[2,3]}', "docs/task-call-challenges/results/probe.json");
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('{\n  "x": 1,\n  "items": [\n    2,\n    3\n  ]\n}\n');
		expect(JSON.parse(result.stdout)).toEqual({ x: 1, items: [2, 3] });
	});

	test("retains the original tab rule for ordinary JSON", () => {
		const result = format('{\n "x":1\n}', "frontend/locales/en/probe.json");
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('{\n\t"x": 1\n}\n');
	});

	test("formats every frozen JSON to identical bytes without rewriting a file", () => {
		const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const path = join(directory, file);
			if (statSync(path).size > 20_000_000)
				throw new Error(`${file}: artifact exceeds existing input budget`);
			const source = readFileSync(path, "utf8");
			const result = format(source, `docs/task-call-challenges/results/${file}`);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(source);
		}
	}, 30_000);
});
