/**
 * ask-in-passing-open-target.test.ts — an aside must be read WITHOUT leaving the
 * conversation it was asked about.
 *
 * The behaviour this locks down: both ways of reaching an ask-in-passing answer
 * (the pending card once its question is sent, and the resolved card's arrow) used
 * to `navigate()` to `/narrators/$id`. On the desktop dock that discards the page
 * the aside was asked from — scroll position, composer draft, and the message the
 * question was about — even though the surface already knows how to hold a second
 * session beside the chat.
 *
 * Two halves are asserted:
 *   1. the PURE decision (`resolveAskInPassingOpenPlan`);
 *   2. the WIRING at all three call sites, asserted against source text. The cards
 *      are not unit-mountable here (they own mutations, a router and a dock
 *      context), and this is the same approach `file-panel-offdock-fallback.test.ts`
 *      takes for the sibling "prefer the dock" rule.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAskInPassingOpenPlan } from "./ask-in-passing-open-target";

const CARD = readFileSync(join(import.meta.dir, "AskInPassingCard.tsx"), "utf8");
const BRIDGE = readFileSync(
	join(import.meta.dir, "..", "vlist", "vlist-ask-in-passing-bridge.tsx"),
	"utf8",
);

describe("resolveAskInPassingOpenPlan", () => {
	it("prefers a panel beside the conversation when the surface has a dock", () => {
		expect(resolveAskInPassingOpenPlan({ targetNarratorId: "nar-1", canOpenInDock: true })).toEqual(
			{ mode: "dock", targetNarratorId: "nar-1" },
		);
	});

	it("falls back to navigation off-dock (mobile page, workspace preview)", () => {
		// There is no secondary area at phone width, so a route is the only host.
		expect(
			resolveAskInPassingOpenPlan({ targetNarratorId: "nar-1", canOpenInDock: false }),
		).toEqual({ mode: "route", targetNarratorId: "nar-1" });
	});

	it("reports no destination when the target is missing", () => {
		// Legacy resolved cards predate `targetNarratorId`. Routing to an empty id
		// would land the reader on a broken page; an inert card is the honest shape.
		for (const targetNarratorId of [null, undefined, "", "   "]) {
			expect(resolveAskInPassingOpenPlan({ targetNarratorId, canOpenInDock: true })).toEqual({
				mode: "none",
			});
			expect(resolveAskInPassingOpenPlan({ targetNarratorId, canOpenInDock: false })).toEqual({
				mode: "none",
			});
		}
	});

	it("trims the id it hands back, so a padded value cannot become a bad route", () => {
		expect(
			resolveAskInPassingOpenPlan({ targetNarratorId: "  nar-1  ", canOpenInDock: false }),
		).toEqual({ mode: "route", targetNarratorId: "nar-1" });
	});
});

describe("wiring — every path to the answer goes through the shared opener", () => {
	it("the opener reads the dock's session-panel action", () => {
		expect(CARD).toContain("const openInDock = dock?.openSubagentPanel;");
		expect(CARD).toContain("openInDock?.(plan.targetNarratorId)");
	});

	it("the pending card opens the answer instead of navigating itself", () => {
		// The submit handler must not carry its own navigate(): that was the branch
		// that took the reader off the page on success.
		expect(CARD).toContain("const openAnswer = useOpenAskInPassingNarrator();");
		expect(CARD).toContain("openAnswer(newNarrator.id)");
		const submitBlock = CARD.slice(
			CARD.indexOf("const handleSubmit"),
			CARD.indexOf("handleCancel"),
		);
		expect(submitBlock).not.toContain("navigate(");
	});

	it("the resolved card binds the pre-bound opener and stays inert without a target", () => {
		expect(CARD).toContain("const open = useOpenAskInPassingTarget(targetNarratorId);");
		expect(CARD).toContain("onClick={open ?? undefined}");
		// Not merely non-navigating: the pointer must not advertise a click either.
		expect(CARD).toContain('cursor: open ? "pointer" : undefined,');
	});

	it("the vlist bridge shares the opener rather than routing on its own", () => {
		// The virtual list is the default renderer, so a divergence here means most
		// readers get the old leave-the-page behaviour while the chunked path is fixed.
		expect(BRIDGE).toContain("useOpenAskInPassingNarrator");
		expect(BRIDGE).toContain("map.set(key, () => openAnswer(targetNarratorId));");
		expect(BRIDGE).not.toContain("useNavigate");
	});
});
