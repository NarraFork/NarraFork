/**
 * vlist-error-actions.test.ts — the error notice card's controls must be wired end
 * to end in the exact shell.
 *
 * The bug: in Virtual-list mode "Mark as retryable" and the dismiss button on an
 * error card did nothing. The card is re-drawn by the render layer
 * (RenderSystemText), which must stay app-free, so it only declares an
 * `errorActions` slot — and nothing filled it. The chunked path never had this
 * problem because MessageBubble's ErrorNotice owns both flows itself.
 *
 * The click-to-callback half is covered by a real DOM test
 * (render/RenderSystemText.errorcard.test.tsx). This file covers the other half,
 * which no unit test can reach: the shell is not unit-mountable (scroll container +
 * document coordinator + WS subscription), so its wiring is asserted against the
 * source, in the same spirit as vlist-spec-carryover-wiring / vlist-editing-wiring.
 *
 * Both halves matter independently: a handler that is never injected is inert, and
 * an injected handler that the dispatch drops never reaches the control.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	errorNoticeText,
	isErrorNoticeItem,
	resolveErrorNoticeActions,
} from "./vlist-error-actions";
import type { VListItem } from "./vlist-pipeline";

const DIR = import.meta.dir;
const SHELL = readFileSync(join(DIR, "PretextExactMessageList.tsx"), "utf8");
const DISPATCH = readFileSync(join(DIR, "render-registry.tsx"), "utf8");
const CARD = readFileSync(join(DIR, "render", "RenderSystemText.tsx"), "utf8");
const ACTIONS = readFileSync(join(DIR, "vlist-error-actions.tsx"), "utf8");
const MODAL = readFileSync(join(DIR, "..", "permission", "RetryRuleModal.tsx"), "utf8");
const LABELS = readFileSync(join(DIR, "useVListLabels.ts"), "utf8");
const MEASURE = readFileSync(join(DIR, "measure", "measure-system-text.ts"), "utf8");
const ADAPTER = readFileSync(
	join(DIR, "..", "..", "..", "..", "shared", "pretext-layout", "segment-adapter.ts"),
	"utf8",
);

/** A minimal item stub — the resolvers only read `spec.kind` / `spec.data`. */
function item(kind: string, data?: Record<string, unknown>): VListItem {
	return {
		spec: { kind, key: `k-${String(data?.kind ?? kind)}`, data: data ?? null },
		measured: { height: 0, blocks: [], frame: { blocks: [], contentHeight: 0, usedWidth: 0 } },
	} as unknown as VListItem;
}

describe("error notice actions — row resolution", () => {
	it("recognizes the error system-text card", () => {
		expect(isErrorNoticeItem(item("system-text", { kind: "error" }))).toBe(true);
	});

	it("ignores other system-text cards and other kinds", () => {
		// A stray match would hand dismiss/retry controls to an unrelated card (e.g.
		// a spec notice's button row), so this is the guard against over-broad wiring.
		expect(isErrorNoticeItem(item("system-text", { kind: "spec_fork_carryover" }))).toBe(false);
		expect(isErrorNoticeItem(item("system-text", { kind: "bash_command" }))).toBe(false);
		expect(isErrorNoticeItem(item("system-text"))).toBe(false);
		expect(isErrorNoticeItem(item("markdown"))).toBe(false);
		expect(isErrorNoticeItem(item("tool-call"))).toBe(false);
	});

	it("reads the card body text (prefills the retry-rule keyword)", () => {
		expect(errorNoticeText(item("system-text", { kind: "error", text: "boom" }))).toBe("boom");
		expect(errorNoticeText(item("system-text", { kind: "error" }))).toBe("");
	});

	it("resolves actions from the row's owning message id and error text", () => {
		const seen: Array<[string | undefined, string]> = [];
		const resolve = (messageId: string | undefined, errorText: string) => {
			seen.push([messageId, errorText]);
			return messageId ? { onDismiss: () => {} } : undefined;
		};
		expect(
			resolveErrorNoticeActions(
				item("system-text", { kind: "error", text: "ECONNRESET" }),
				["msg-1"],
				resolve,
			),
		).toBeDefined();
		expect(seen).toEqual([["msg-1", "ECONNRESET"]]);
	});

	it("returns undefined for a non-error row without consulting the resolver", () => {
		let called = false;
		const resolve = () => {
			called = true;
			return { onDismiss: () => {} };
		};
		expect(resolveErrorNoticeActions(item("markdown"), ["msg-1"], resolve)).toBeUndefined();
		expect(called).toBe(false);
	});

	it("yields no actions when the row carries no message id (nothing to delete)", () => {
		// Dismissal targets a specific message, so without an id the card must not
		// offer the control.
		const resolve = (messageId: string | undefined) =>
			messageId ? { onDismiss: () => {} } : undefined;
		expect(
			resolveErrorNoticeActions(item("system-text", { kind: "error" }), [], resolve),
		).toBeUndefined();
	});
});

describe("error notice actions — shell wiring", () => {
	it("injects the resolved actions into the row's render extra", () => {
		expect(SHELL).toContain("if (errorNoticeActions) extra.errorNoticeActions");
		expect(SHELL).toContain("errorNoticeActions={resolveErrorNoticeActions(");
		// Row identity must be part of the memo comparison or an in-flight dismissal
		// would not repaint the disabled close button.
		expect(SHELL).toContain("prev.errorNoticeActions === next.errorNoticeActions");
	});

	it("hosts exactly one retry-rule dialog for the whole list", () => {
		// Rows are zero-DOM copies and cannot own a modal, so the shell mounts it
		// once — the same pattern as the compact cancel dialog.
		expect(SHELL).toContain("useVListErrorNoticeActions(narratorId)");
		expect(SHELL).toContain("{errorNotice.ruleModal}");
	});

	it("passes the actions through the render dispatch to the card", () => {
		expect(DISPATCH).toContain("errorActions={extra.errorNoticeActions as never}");
		expect(CARD).toContain("errorActions?: ErrorNoticeActions");
		// Both controls must be real, bound controls — the original bug was a bare
		// icon with no click target at all.
		expect(CARD).toContain("onClick={actions?.onMarkRetryable}");
		expect(CARD).toContain("onClick={actions?.onDismiss}");
		// The provider fix is bound the same way; its click behaviour and its visible
		// label are covered by the real-DOM errorcard test.
		expect(CARD).toContain("onClick={actions?.onDisableImageGen}");
	});

	it("reads the fix button's label from the adapter, never from the render layer", () => {
		// The fix must be a LABELLED button: an icon-only control explains itself only
		// through a hover tooltip, which touch users never see. The wording therefore
		// has to travel through the adapter (where it is measured) — the render layer
		// holds no i18n at all.
		expect(CARD).toContain("data.buttons?.[0]");
		expect(LABELS).toContain('disableImageGen: t("disableImageGen")');
		expect(ADAPTER).toContain('sysLabel(ctx, "disableImageGen")');
	});

	it("decides the fix button during ADAPTATION so its row is measured", () => {
		// The button sits below the message and makes the card taller. Deciding it at
		// paint time would draw it outside the row's reserved box.
		expect(ADAPTER).toContain("ctx.canOfferProviderFix?.(errorText) === true");
		expect(MEASURE).toContain('kind !== "error" || !data.buttons?.length');
		expect(SHELL).toContain("canOfferProviderFix: errorNotice.canOfferProviderFix");
	});

	it("offers the fix only for the rows whose own error matches", () => {
		// The fix action is per-narrator (one provider, one retry), but eligibility is
		// per-row: attaching it unconditionally would put a "turn off image generation"
		// button on unrelated failures.
		expect(ACTIONS).toContain("useCodexImageGenerationFix(narratorId)");
		expect(ACTIONS).toContain("imageGenFix.canFix(errorText)");
		expect(ACTIONS).toContain("onDisableImageGen: imageGenFix.run");
		// The resolver caches one object per message id, so the in-flight flag must be
		// a dependency or a row would keep painting a stale loading spinner.
		expect(ACTIONS).toContain("imageGenFix.busy");
	});

	it("dismissal deletes the message and prunes the messages cache", () => {
		expect(ACTIONS).toContain("api.dismissErrorMessage(narratorId, messageId)");
		expect(ACTIONS).toContain("removeMessagesFromCache(qc, narratorId,");
	});

	it("the retry rule dialog posts the rule and refreshes the settings query", () => {
		expect(MODAL).toContain("api.addRetryRule(");
		expect(MODAL).toMatch(/queryKey: \["settings"\]/);
		// At least one matcher is required, otherwise the rule would match every error.
		expect(MODAL).toContain('ts("retryRuleAtLeastOne")');
	});

	it("resets the rule form for the row that opened it", () => {
		// One shared modal serving many rows must not keep the first error's text.
		expect(MODAL).toContain("setKeyword(stripErrorDisplayPrefix(errorMessage))");
		expect(MODAL).toMatch(/\[opened, errorMessage\]/);
	});

	it("prefills the keyword without the card's error display prefix", () => {
		// The card text reads `Error: <provider message>`, but the server matches
		// custom retry rules against the RAW provider message — prefilling the
		// decorated text produced rules that could never fire.
		expect(MODAL).toContain('from "@shared/retry-rule-keyword"');
		expect(MODAL).toContain("stripErrorDisplayPrefix(keyword)");
	});

	it("keeps the render layer free of app imports (CONTRACT.md §0)", () => {
		// The mutations live in the integration module; the card must not reach for
		// the REST client / i18n itself.
		expect(CARD).not.toContain("@frontend/lib/api");
		expect(CARD).not.toContain("react-i18next");
	});
});
