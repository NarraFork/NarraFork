/**
 * await-navigation-identity.test.ts — the label is for reading, the id is for routing.
 *
 * Await results now name the agent by ALIAS, including inside the `<subagent_id>`
 * tag. That tag is also the last-resort source the three navigation helpers fall
 * back to when metadata is missing — and an alias handed to "open this narrator's
 * session" routes to a narrator id that does not exist.
 *
 * The invariant that keeps the two apart: whenever the tag holds a label, the same
 * write also sets `metadata.subagentId` to the REAL id, and metadata is probed
 * first. So these tests assert the priority order rather than the tag's content —
 * the tag may legitimately hold either form depending on when the row was written.
 */

import { describe, expect, test } from "bun:test";
import { traceRowAwaitAgentNarratorId } from "./trace-row-identity";

// The vlist implementation lives in vlist/, which non-vlist files may not import
// statically (vlist-isolation.guard.test.ts keeps the flag-OFF path from loading
// it). A dynamic import is allowed and still cross-checks the REAL function
// rather than a hand-copied expectation.
const { deriveAwaitAgentNarratorId } = await import("./vlist/vlist-tool-meta");

const REAL_ID = "UscgG1vLFnxzyKyaUOIfR";
const LABEL = "map-the-providers";

/** A row as the current code writes it: aliased tag + real id in metadata. */
function currentRow() {
	return {
		toolName: "Await",
		inputJson: { type: "agent", id: LABEL },
		outputJson: {
			_text: `<subagent_id>${LABEL}</subagent_id>\n\nAgent ${LABEL} status: completed`,
			_metadata: {
				kind: "await",
				awaitType: "agent",
				targetId: LABEL,
				targetLabel: LABEL,
				resolvedId: REAL_ID,
				subagentId: REAL_ID,
				status: "completed",
			},
		},
	};
}

/** A row written before metadata carried ids: the tag held the real id. */
function legacyRow() {
	return {
		toolName: "Await",
		inputJson: { type: "agent", id: REAL_ID },
		outputJson: { _text: `<subagent_id>${REAL_ID}</subagent_id>\n\ndone` },
	};
}

describe("trace-row navigation resolves a real narrator id", () => {
	test("prefers metadata.subagentId over the aliased tag", () => {
		// If this ever returned the label, "open full session" would 404.
		expect(traceRowAwaitAgentNarratorId(currentRow())).toBe(REAL_ID);
	});

	test("legacy rows still resolve through the tag fallback", () => {
		expect(traceRowAwaitAgentNarratorId(legacyRow())).toBe(REAL_ID);
	});

	test("a bash Await offers no session to open", () => {
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "bash", id: "run-tests" },
				outputJson: { _text: "Background task run-tests completed." },
			}),
		).toBeUndefined();
	});
});

describe("vlist navigation resolves the same id", () => {
	// Two independent implementations read this; divergence would mean the chunked
	// and virtualized lists navigate differently from the same row.
	test("prefers metadata.subagentId over the aliased tag", () => {
		const row = currentRow();
		const metadata = row.outputJson._metadata as Record<string, unknown>;
		expect(
			deriveAwaitAgentNarratorId(
				{ type: "tool_use", ...row } as unknown as Parameters<typeof deriveAwaitAgentNarratorId>[0],
				metadata,
			),
		).toBe(REAL_ID);
	});

	test("legacy rows still resolve through the tag fallback", () => {
		const row = legacyRow();
		expect(
			deriveAwaitAgentNarratorId(
				{ type: "tool_use", ...row } as unknown as Parameters<typeof deriveAwaitAgentNarratorId>[0],
				{},
			),
		).toBe(REAL_ID);
	});
});
