import { describe, expect, test } from "bun:test";
import { getNarratorStatusBarDisplay } from "./narrator-status-bar";

describe("getNarratorStatusBarDisplay", () => {
	test("ignores status/substatus from a different narrator cache entry", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: {
					id: "other-narrator",
					status: "idle",
					substatus: ["interrupted"],
				},
				liveSubstatus: [],
			}),
		).toEqual({ color: "gray", labelKey: "status_idle" });
	});

	test("shows interrupted only for the current narrator live substatus", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: { id: "current-narrator", status: "idle", substatus: [] },
				liveSubstatus: ["interrupted"],
			}),
		).toEqual({ color: "orange", labelKey: "status_interrupted" });
	});

	test("falls back to persisted substatus for a current non-active narrator", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: {
					id: "current-narrator",
					status: "idle",
					substatus: ["interrupted"],
				},
				liveSubstatus: [],
			}),
		).toEqual({ color: "orange", labelKey: "status_interrupted" });
	});

	test("normalizes legacy terminal status into substatus display", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: { id: "current-narrator", status: "interrupted", substatus: [] },
				liveSubstatus: [],
			}),
		).toEqual({ color: "orange", labelKey: "status_interrupted" });
	});
});
