import { describe, expect, test } from "bun:test";
import { zodToJsonSchema } from "../../lib/agent/tool-registry";
import { awaitTool } from "../../lib/agent/tools/await";
import { sendTool } from "../../lib/agent/tools/send";
import { watchTool } from "../../lib/agent/tools/watch";
import { compileDelegationPolicy, resolveRuntimePolicy } from "../agent-runtime/policy";
import {
	assertRuntimeCanAwaitAgent,
	SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
} from "../subagent-communication-policy";

const delegated = resolveRuntimePolicy([compileDelegationPolicy({ template: "general" })]);
const undeclared = resolveRuntimePolicy([]);

describe("communication capability policy", () => {
	test("rejects agent observation without the watchAgent capability", () => {
		expect(() => assertRuntimeCanAwaitAgent(delegated)).toThrow(
			SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
		);
	});

	test("keeps agent observation available when the capability is present", () => {
		expect(() => assertRuntimeCanAwaitAgent(undeclared)).not.toThrow();
	});

	test("static communication schemas do not encode the current capability ceiling", () => {
		const sendProperties = sendTool.rawJsonSchema?.properties as Record<string, unknown>;
		expect(sendProperties.await).toBeUndefined();
		expect(sendProperties.timeout).toBeUndefined();
		expect(sendProperties.replyTo).toBeUndefined();
		expect(sendProperties.resume).toBeDefined();
		expect(sendProperties.model).toBeDefined();
		const watchProperties = zodToJsonSchema(watchTool.parameters).properties as {
			type: { enum: string[] };
		};
		expect(watchProperties.type.enum).toEqual(["terminal", "bash", "agent"]);
	});

	test("the static agent variant still rejects delegated execution and Await is inert", async () => {
		const context = {
			narratorId: "child",
			cwd: "/worktree",
			locale: "en",
			signal: new AbortController().signal,
			requestPermission: async () => ({ behavior: "allow" as const }),
			runtimePolicy: delegated,
		};
		const result = await watchTool.execute({ type: "agent", id: "some-agent" }, context);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("does not permit agent");
		const retired = await awaitTool.execute({ type: "agent", id: "some-agent" }, context);
		expect(retired.isError).toBe(true);
		expect(retired.output).toContain("Await is retired");
	});
});
