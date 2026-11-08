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

	test("an auto: session follows the source its last turn actually used", () => {
		const served = { provider: "relay", model: "relay:gpt-5.5" };
		expect(capabilityModelReference("auto:gpt-5.5", undefined, served)).toBe("relay:gpt-5.5");
		// Before the first turn (or when the server has nothing), the auto value stays.
		expect(capabilityModelReference("auto:gpt-5.5", undefined, null)).toBe("auto:gpt-5.5");
		expect(capabilityModelReference("auto:gpt-5.5", undefined, { model: "" })).toBe("auto:gpt-5.5");
		// A named service never takes the runtime value: it is already the source.
		expect(capabilityModelReference("codex:gpt-5.5", undefined, served)).toBe("codex:gpt-5.5");
		// A follow-parent child whose parent uses auto: follows the parent's served source too.
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, "auto:gpt-5.5", served)).toBe(
			"relay:gpt-5.5",
		);
	});
});
