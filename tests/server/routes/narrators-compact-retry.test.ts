import { describe, expect, test } from "bun:test";
import { buildRetryFailedCompactResponse } from "@server/routes/narrators";

describe("failed compact retry route response", () => {
	test("returns the COW message ID and replacement aliases", () => {
		expect(
			buildRetryFailedCompactResponse("compact-old", {
				messageId: "compact-new",
				oldMessageId: "compact-old",
				replacedMessageId: "compact-old",
			}),
		).toEqual({
			ok: true,
			messageId: "compact-new",
			oldMessageId: "compact-old",
			replacedMessageId: "compact-old",
		});
	});

	test("keeps the requested ID for an ordinary retry", () => {
		expect(
			buildRetryFailedCompactResponse("compact-same", {
				messageId: "compact-same",
			}),
		).toEqual({ ok: true, messageId: "compact-same" });
	});

	test("falls back to the requested ID for an older service result", () => {
		expect(buildRetryFailedCompactResponse("compact-legacy", {})).toEqual({
			ok: true,
			messageId: "compact-legacy",
		});
	});
});
