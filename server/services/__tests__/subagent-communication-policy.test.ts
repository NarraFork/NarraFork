import { describe, expect, test } from "bun:test";
import { awaitTool } from "../../lib/agent/tools/await";
import { sendTool } from "../../lib/agent/tools/send";
import { compileDelegationPolicy, resolveRuntimePolicy } from "../agent-runtime/policy";
import {
	assertRuntimeCanAwaitAgent,
	SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
} from "../subagent-communication-policy";

const delegated = resolveRuntimePolicy([compileDelegationPolicy({ template: "general" })]);
const undeclared = resolveRuntimePolicy([]);

describe("communication capability policy", () => {
	test("rejects agent Await without the awaitAgent capability", () => {
		expect(() => assertRuntimeCanAwaitAgent(delegated)).toThrow(
			SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
		);
	});

	test("keeps agent Await available when the capability is present", () => {
		expect(() => assertRuntimeCanAwaitAgent(undeclared)).not.toThrow();
	});

	test("static communication schemas do not encode the current capability ceiling", () => {
		const sendProperties = sendTool.rawJsonSchema?.properties as Record<string, unknown>;
		expect(sendProperties.await).toBeUndefined();
		expect(sendProperties.timeout).toBeUndefined();
		expect(sendProperties.replyTo).toBeUndefined();
		expect(sendProperties.resume).toBeDefined();
		expect(sendProperties.model).toBeDefined();
		const awaitProperties = awaitTool.rawJsonSchema?.properties as {
			type: { enum: string[] };
		};
		expect(awaitProperties.type.enum).toEqual(["agent", "bash", "transfer", "question"]);
	});

	test("the static agent variant still rejects delegated execution", async () => {
		const result = await awaitTool.execute(
			{ type: "agent", id: "some-agent" },
			{
				narratorId: "child",
				cwd: "/worktree",
				locale: "en",
				signal: new AbortController().signal,
				requestPermission: async () => ({ behavior: "allow" }),
				runtimePolicy: delegated,
			},
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
	});
});
