import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../types";
import { groupControlTool } from "../group-control";

function makeCtx(): ToolContext {
	return {
		narratorId: "named-1",
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

describe("groupControlTool validation", () => {
	test("approve without request_id returns an error before any DB access", async () => {
		const res = await groupControlTool.execute({ action: "approve" }, makeCtx());
		expect(res.isError).toBe(true);
		expect(res.output).toContain("request_id is required");
	});

	test("deny without request_id returns an error", async () => {
		const res = await groupControlTool.execute({ action: "deny" }, makeCtx());
		expect(res.isError).toBe(true);
		expect(res.output).toContain("request_id is required");
	});

	test("interrupt without target_id returns an error", async () => {
		const res = await groupControlTool.execute({ action: "interrupt" }, makeCtx());
		expect(res.isError).toBe(true);
		expect(res.output).toContain("target_id is required");
	});

	test("rawJsonSchema only requires action", () => {
		const schema = groupControlTool.rawJsonSchema as {
			required: string[];
			properties: Record<string, unknown>;
		};
		expect(schema.required).toEqual(["action"]);
		expect(Object.keys(schema.properties).sort()).toEqual([
			"action",
			"message",
			"request_id",
			"target_id",
		]);
	});

	test("tool is named GroupControl", () => {
		expect(groupControlTool.name).toBe("GroupControl");
	});
});
