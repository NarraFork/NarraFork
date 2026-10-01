/**
 * Capability-model selection for `useResolvedModel`.
 *
 * A follow-parent subagent stores `__parent__`, which no provider-prefix parse
 * can read — before this substitution the status bar could not tell the child
 * was running a Codex model, so the fast-mode control (and context-threshold /
 * quota lookups) silently never appeared for following subagents.
 */

import { describe, expect, test } from "bun:test";
import { FOLLOW_PARENT_MODEL } from "../../../lib/constants";
import { capabilityModelReference } from "./use-resolved-model";

describe("capabilityModelReference", () => {
	test("follow-parent resolves through the reported inheritance model", () => {
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, "codex:gpt-5")).toBe("codex:gpt-5");
	});

	test("follow-parent without an inheritance report keeps the sentinel", () => {
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, undefined)).toBe(FOLLOW_PARENT_MODEL);
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, null)).toBe(FOLLOW_PARENT_MODEL);
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, "")).toBe(FOLLOW_PARENT_MODEL);
	});

	test("pinned models ignore inheritance even when one is reported", () => {
		expect(capabilityModelReference("openai:gpt-4o", "codex:gpt-5")).toBe("openai:gpt-4o");
		expect(capabilityModelReference(undefined, "codex:gpt-5")).toBeUndefined();
	});
});
