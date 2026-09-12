import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ToolContext } from "../../types";
import { evalReadSchema, evalTool, readEvalConfiguration } from "../eval";

const image = "a".repeat(64);
const integration = process.env.NF_PROGRAMMATIC_TEST_IMAGE ? test : test.skip;
integration(
	"real Eval transports a bounded text read and rejects mid-run configuration revocation",
	async () => {
		process.env.NF_READONLY_EVAL_IMAGE = process.env.NF_PROGRAMMATIC_TEST_IMAGE;
		process.env.NF_READONLY_EVAL_NARRATORS = "trial";
		let calls = 0;
		const ctx: ToolContext = {
			...context(),
			userId: "operator",
			toolCallBinding: { toolCallId: "outer-trial", attempt: 1 },
			recheckAuthorization: async () => {},
			executeRead: async (input) => {
				calls++;
				return { output: (await readFile(String(input.file_path), "utf8")).slice(0, 100) };
			},
		};
		const path = import.meta.filename;
		const good = await evalTool.execute(
			{ code: `return tools.Read({file_path:${JSON.stringify(path)},limit:1});` },
			ctx,
		);
		expect(good.isError).toBe(false);
		expect(JSON.parse(good.output).value.bounded).toBe(true);
		expect(calls).toBe(1);
		ctx.recheckAuthorization = async () => {
			process.env.NF_READONLY_EVAL_NARRATORS = "revoked";
		};
		const denied = await evalTool.execute({ code: "return 42;" }, ctx);
		expect(denied.isError).toBe(true);
		expect(calls).toBe(1);
	},
	30000,
);
const original = {
	image: process.env.NF_READONLY_EVAL_IMAGE,
	narrators: process.env.NF_READONLY_EVAL_NARRATORS,
};
afterEach(() => {
	for (const [key, value] of [
		["NF_READONLY_EVAL_IMAGE", original.image],
		["NF_READONLY_EVAL_NARRATORS", original.narrators],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
function context(): ToolContext {
	return {
		narratorId: "trial",
		cwd: "/work",
		locale: "en",
		signal: new AbortController().signal,
		requestPermission: async () => ({ behavior: "deny" }),
	};
}
test("disabled without complete operator configuration", () => {
	expect(readEvalConfiguration({})).toBeNull();
	expect(
		readEvalConfiguration({
			NF_READONLY_EVAL_IMAGE: "latest",
			NF_READONLY_EVAL_NARRATORS: "trial",
		}),
	).toBeNull();
	expect(readEvalConfiguration({ NF_READONLY_EVAL_IMAGE: image })).toBeNull();
	expect(
		readEvalConfiguration({
			NF_READONLY_EVAL_IMAGE: image,
			NF_READONLY_EVAL_NARRATORS: "trial, second",
		})?.narrators.has("second"),
	).toBe(true);
});
test("runtime rejects missing configuration and non-allowlisted narrator", async () => {
	delete process.env.NF_READONLY_EVAL_IMAGE;
	delete process.env.NF_READONLY_EVAL_NARRATORS;
	expect((await evalTool.execute({ code: "return 1;" }, context())).isError).toBe(true);
	process.env.NF_READONLY_EVAL_IMAGE = image;
	process.env.NF_READONLY_EVAL_NARRATORS = "other";
	expect((await evalTool.execute({ code: "return 1;" }, context())).output).toContain("disabled");
});
test("configuration alone cannot bypass mandatory identity and audit bridge", async () => {
	process.env.NF_READONLY_EVAL_IMAGE = image;
	process.env.NF_READONLY_EVAL_NARRATORS = "trial";
	expect((await evalTool.execute({ code: "return 1;" }, context())).output).toContain(
		"bound authorization and audit",
	);
});
test("only explicit bounded text Read arguments are accepted", () => {
	expect(evalReadSchema.parse({ file_path: "/work/a.ts", limit: 20 })).toEqual({
		file_path: "/work/a.ts",
		limit: 20,
	});
	for (const input of [
		{ file_path: "/work/a", limit: -1 },
		{ file_path: "/work/a", limit: 201 },
		{ file_path: "/work/a", offset: 0 },
		{ file_path: "/work/a", command: "write" },
		{ file_path: "/work/a", narratorId: "forged" },
		{ file_path: "/work/a.pdf" },
		{ file_path: "/work/a.PNG" },
		{ file_path: "/work/a.ipynb" },
	])
		expect(evalReadSchema.safeParse(input).success).toBe(false);
});
