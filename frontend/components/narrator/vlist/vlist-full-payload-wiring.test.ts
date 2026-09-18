/**
 * vlist-full-payload-wiring.test.ts — Guards the wiring that lets a truncated
 * body reach its un-truncated payload.
 *
 * The regression this pins: the shell passed `getLoadFullPayload` — a per-key
 * THUNK FACTORY built for a (since removed) row prop that invoked the returned
 * handler — into `useVListContentView`, whose `requestFullPayload` contract is
 * fire-and-forget. The factory was called and its thunk discarded, so
 * `markVListFullPayloadRequested` never ran: scrolling past the halfway mark and
 * opening fullscreen were both silent no-ops, the fetch never started, and the
 * fullscreen modal kept showing the static "[preview truncated]" notice because
 * the request mark never existed (`loadingFullPayload` stayed false).
 *
 * Why source scanning: the mismatch is type-compatible both ways (a thunk
 * factory is assignable to a `=> void` slot), so the type checker cannot see it,
 * and hook-level tests pass whatever spy shape they like — the existing
 * `useVListContentView` tests use a direct marker spy and never exercised the
 * factory shape the real shell supplied. The invariant with no runtime
 * representation here is "the shell's callback marks SYNCHRONOUSLY", which is
 * exactly the checklist case source scanning exists for (see
 * vlist-live-wiring.test.ts's header note).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");
const SHELL = shellSource();

describe("full-payload request wiring (inline auto-load + fullscreen)", () => {
	it("keeps communication input.message viewer and payload fetching explicit", () => {
		const selection = sliceBracketedRegion(
			SHELL,
			"const truncatedExpandedToolUseIds = useMemo(() => {",
		);
		if (!selection) throw new Error("payload selection missing");
		const communication = sliceBracketedRegion(
			selection,
			'if (item.spec.kind === "communication-bubble") {',
		);
		expect(communication).toContain("source.messageBody?.textTruncated");
		expect(communication).toContain("isFullPayloadRequestedRow(activeInteraction, item.spec.key)");
		expect(communication).toContain("toolDetailRequestFromData(source.toolUseId, source)");
		expect(SHELL).toContain('key: "input.message", label: "message", body: data.messageBody');
		expect(SHELL).toContain("extra.onViewFull = () => viewControls.openFullscreen(target)");
		expect(SHELL).toContain("const open = injectionNavigation?.onOpenNarrator");
		expect(/openCommunicationRecipient\(\s*\{ id, deliveryMessageId \}/.test(SHELL)).toBe(true);
		expect(SHELL).toContain("locate: narratorsApi.getMessageLocation");
		expect(SHELL).toContain('kind !== "communication-bubble" && !cardHostsOwnBars');
	});
	it("wires inspector refs from card/trace data independently of selection aliases", () => {
		expect(SHELL).toContain("toolDetailRef={interaction.toolDetailRef}");
		expect(SHELL).toContain("? toolDetailRequestFromData(toolUseId, item.spec.data)");
		expect(SHELL).toContain("toolDetailRef={row.identity?.toolDetailRef}");
		for (const field of ["toolUseId", "toolCallId", "messageId", "executionAttempt"]) {
			expect(SHELL).toContain(`a.toolDetailRef?.${field} === b.toolDetailRef?.${field}`);
		}
	});
	it("hands useVListContentView a synchronous marker, not a thunk factory", () => {
		// The broken wiring, verbatim: a factory whose returned thunk was discarded.
		expect(SHELL).not.toContain("getLoadFullPayload");
		// The fixed wiring: a direct, stable marker callback.
		expect(SHELL).toContain("useVListContentView({ requestFullPayload: requestRowFullPayload })");
		const marker = sliceBracketedRegion(
			SHELL,
			"const requestRowFullPayload = useCallback((owner: VListViewOwner) => {",
		);
		if (!marker) throw new Error("owner-based request callback not found");
		// Location stays separate from body identity; marking still happens immediately.
		expect(marker).toContain(
			"setInteraction((prev) => markVListFullPayloadRequested(prev, ownerRequestKey(owner)))",
		);
		expect(marker).not.toContain("return () =>");
		expect(marker).not.toContain("await ");
	});

	it("preserves the trace owner when forwarding a body request", () => {
		expect(read("useVListContentView.ts")).toContain(
			"requestFullPayloadRef.current?.(target.owner)",
		);
		const key = sliceBracketedRegion(
			SHELL,
			"function ownerRequestKey(owner: VListViewOwner): string {",
		);
		if (!key) throw new Error("owner request-key mapping not found");
		expect(key).toContain("owner.traceItemIndex == null");
		expect(key).toMatch(/\$\{owner\.specKey\}#row\$\{owner\.traceItemIndex\}/);
	});

	it("loads a standalone subagent result only after an explicit body request", () => {
		const selection = sliceBracketedRegion(
			SHELL,
			"const truncatedExpandedToolUseIds = useMemo(() => {",
		);
		if (!selection) throw new Error("full-payload selection not found");
		const subagent = sliceBracketedRegion(selection, 'if (item.spec.kind === "subagent-card") {');
		if (!subagent) throw new Error("standalone subagent payload gate not found");
		expect(subagent).toContain(
			"const requested = isFullPayloadRequestedRow(activeInteraction, item.spec.key)",
		);
		expect(subagent).toMatch(
			/!measured\.promptTruncated\s*&&\s*!\(requested\s*&&\s*\(source\.promptBody\?\.textTruncated\s*\|\|\s*source\.resultBody\?\.textTruncated\)\)/,
		);
		expect(subagent).toContain(
			"ids.push(toolDetailRequestFromData(measured.toolUseId, item.spec.data))",
		);
	});

	it("gates a drilled-in subagent result on its own trace-row request", () => {
		const selection = sliceBracketedRegion(
			SHELL,
			"const truncatedExpandedToolUseIds = useMemo(() => {",
		);
		if (!selection) throw new Error("full-payload selection not found");
		const subagent = sliceBracketedRegion(selection, 'if (row.cardKind === "subagent-card") {');
		if (!subagent) throw new Error("trace subagent payload gate not found");
		expect(subagent).toContain("const requested = isFullPayloadRequestedRow(");
		expect(subagent).toContain(
			"ownerRequestKey({ specKey: item.spec.key, traceItemIndex: row.itemIndex })",
		);
		expect(subagent).toMatch(
			/!subCard\.promptTruncated\s*&&\s*!\(\s*requested\s*&&\s*\(source\.promptBody\?\.textTruncated\s*\|\|\s*source\.resultBody\?\.textTruncated\)/,
		);
		expect(subagent).toContain("ids.push(toolDetailRequestFromData(subCard.toolUseId, source))");
	});
});
