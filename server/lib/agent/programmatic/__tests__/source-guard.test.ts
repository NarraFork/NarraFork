import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { parse } from "@babel/parser";
import { createSandboxBootstrap } from "../bootstrap";
import { PROGRAMMATIC_LIMITS } from "../protocol";
import { guardSource } from "../source-guard";

describe("isolated source syntax boundary", () => {
	for (const source of [
		'return "async await Promise import";',
		"// async await Promise import\n/* import('x') */ return 1;",
		"const value: number = 42; return value;",
		"return `async await Promise import`;",
		"return (() => catalog.read())();",
	]) {
		test(`accepts synchronous body: ${source}`, () => {
			expect(() => guardSource(source, parse)).not.toThrow();
		});
	}
	for (const source of [
		"async function run() {}",
		"const run = async () => 1;",
		"const obj = {async run() {}};",
		"await catalog.read();",
		"return Promise.resolve(1);",
		"return Pr\\u006fmise.resolve(1);",
		"return import('node:fs');",
		"type Module = typeof import('node:fs');",
		"import fs from 'node:fs';",
		"return (;",
		"}; catalog.read(); function replacement(){",
		"}; (() => catalog.read())(); function replacement(){",
		"}; globalThis.__nfCompiledEntry = (() => {catalog.read();return function(){",
	]) {
		test(`rejects invalid contract before preparation: ${source}`, () => {
			let calls = 0;
			const context = vm.createContext({ catalog: { read: () => calls++ } });
			expect(() => {
				const guarded = guardSource(source, parse);
				vm.runInContext(guarded, context, { timeout: 100 });
			}).toThrow();
			expect(calls).toBe(0);
		});
	}
	test("return IIFE executes only when the prepared entry is invoked", () => {
		let calls = 0;
		const context = vm.createContext({ catalog: { read: () => ++calls } });
		const guarded = guardSource("return (() => catalog.read())();", parse);
		const compiled = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
			`globalThis.__nfCompiledEntry = ${guarded};`,
		);
		const fn = vm.runInContext(compiled, context, { timeout: 100 });
		expect(calls).toBe(0);
		expect(fn()).toBe(1);
		expect(calls).toBe(1);
	});
	test("self-contained bootstrap fits the driver budget after all escaping", () => {
		const bootstrap = createSandboxBootstrap();
		expect(Buffer.byteLength(bootstrap)).toBeLessThan(PROGRAMMATIC_LIMITS.wireFrameBytes);
		const ast = parse(bootstrap);
		const statement = ast.program.body[0];
		expect(statement?.type).toBe("ExpressionStatement");
		if (statement?.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression")
			throw new Error("Unexpected bootstrap shape");
		const worker = statement.expression.arguments[1];
		if (worker?.type !== "StringLiteral") throw new Error("Missing inline worker");
		expect(() => parse(worker.value, { sourceType: "module" })).not.toThrow();
	});
});
