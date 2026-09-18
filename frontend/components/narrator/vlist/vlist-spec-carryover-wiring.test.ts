/**
 * vlist-spec-carryover-wiring.test.ts — the Dynamic Spec notice cards' buttons must
 * be wired end to end in the exact shell.
 *
 * The bug: in Virtual-list mode "View tasks" / "Clear" / "Reset Spec" on a
 * fork-carryover card did nothing. The card is re-drawn by the render layer
 * (RenderSystemText), which must stay app-free, so it only declares an `actions`
 * slot — and nothing filled it. The chunked path never had this problem because
 * MessageBubble's SpecForkCarryoverCard owns the mutations itself.
 *
 * The click-to-callback half is covered by a real DOM test
 * (render/RenderSystemText.speccard.test.tsx). This file covers the other half,
 * which no unit test can reach: the shell is not unit-mountable (scroll container +
 * document coordinator + WS subscription), so its wiring is asserted against the
 * source, in the same spirit as vlist-editing-wiring / off-path-routing.
 *
 * Both halves matter independently: a handler that is never injected is inert, and
 * an injected handler that the dispatch drops never reaches the button.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellSource } from "./guard-source";
import type { VListItem } from "./vlist-pipeline";
import { isSpecCarryoverItem, resolveSpecCarryoverActions } from "./vlist-spec-carryover-actions";

const DIR = import.meta.dir;
const SHELL = shellSource();
const DISPATCH = readFileSync(join(DIR, "render-registry.tsx"), "utf8");
const CARD = readFileSync(join(DIR, "render", "RenderSystemText.tsx"), "utf8");
const ACTIONS = readFileSync(join(DIR, "vlist-spec-carryover-actions.ts"), "utf8");

/** A minimal item stub — the resolvers only read `spec.kind` / `spec.data.kind`. */
function item(kind: string, dataKind?: string): VListItem {
	return {
		spec: { kind, key: `k-${dataKind ?? kind}`, data: dataKind ? { kind: dataKind } : null },
		measured: { height: 0, blocks: [], frame: { blocks: [], contentHeight: 0, usedWidth: 0 } },
	} as unknown as VListItem;
}

describe("spec carryover actions — row resolution", () => {
	it("recognizes the three Dynamic Spec notice kinds", () => {
		expect(isSpecCarryoverItem(item("system-text", "spec_fork_carryover"))).toBe(true);
		expect(isSpecCarryoverItem(item("system-text", "spec_context_cleared"))).toBe(true);
		expect(isSpecCarryoverItem(item("system-text", "spec_goal_added"))).toBe(true);
	});

	it("ignores other system-text cards and other kinds", () => {
		// A stray match would hand spec buttons to an unrelated card (e.g. error's
		// retry/close row), so this is the guard against over-broad wiring.
		expect(isSpecCarryoverItem(item("system-text", "error"))).toBe(false);
		expect(isSpecCarryoverItem(item("system-text", "bash_command"))).toBe(false);
		expect(isSpecCarryoverItem(item("system-text"))).toBe(false);
		expect(isSpecCarryoverItem(item("markdown"))).toBe(false);
		expect(isSpecCarryoverItem(item("tool-call"))).toBe(false);
	});

	it("resolves actions from the row's owning message id", () => {
		const seen: Array<string | undefined> = [];
		const resolve = (messageId: string | undefined) => {
			seen.push(messageId);
			return messageId ? { onViewTasks: () => {} } : undefined;
		};
		expect(
			resolveSpecCarryoverActions(item("system-text", "spec_fork_carryover"), ["msg-1"], resolve),
		).toBeDefined();
		expect(seen).toEqual(["msg-1"]);
	});

	it("returns undefined for a non-spec row without consulting the resolver", () => {
		let called = false;
		const resolve = () => {
			called = true;
			return { onViewTasks: () => {} };
		};
		expect(resolveSpecCarryoverActions(item("markdown"), ["msg-1"], resolve)).toBeUndefined();
		expect(called).toBe(false);
	});

	it("yields no actions when the row carries no message id (nothing to dismiss)", () => {
		// Clear/reset both end by dismissing the notice message, so without an id the
		// card must not offer them.
		const resolve = (messageId: string | undefined) =>
			messageId ? { onViewTasks: () => {} } : undefined;
		expect(
			resolveSpecCarryoverActions(item("system-text", "spec_fork_carryover"), [], resolve),
		).toBeUndefined();
	});
});

describe("spec carryover actions — shell wiring", () => {
	it("injects the resolved actions into the row's render extra", () => {
		expect(SHELL).toContain("if (specCarryoverActions) extra.specCarryoverActions");
		expect(SHELL).toContain("specCarryoverActions={resolveSpecCarryoverActions(");
		// Row identity must be part of the memo comparison or a busy-state change
		// would not repaint the card's loading button.
		expect(SHELL).toContain("prev.specCarryoverActions === next.specCarryoverActions");
	});

	it("opens the Spec task board through the panel's viewport listener", () => {
		// The chunked card bubbles this DOM event to the NarratorPanel scroll
		// viewport; the shell's scroll node IS that viewport, so it dispatches there.
		expect(SHELL).toContain('new CustomEvent("spec-open-tasks", { bubbles: true })');
		expect(SHELL).toContain("useSpecCarryoverActions(narratorId, openSpecTasks)");
	});

	it("passes the actions through the render dispatch to the card", () => {
		expect(DISPATCH).toContain("actions={extra.specCarryoverActions as never}");
		expect(CARD).toContain("actions?: SpecCarryoverActions");
		// The three buttons must be bound in the adapter's emitted order.
		expect(CARD).toContain(
			"const buttonHandlers = [actions?.onViewTasks, actions?.onClearTasks, actions?.onResetSpec]",
		);
	});

	it("clear and reset dismiss the notice and refresh the spec queries", () => {
		expect(ACTIONS).toContain("api.clearSpecTasks(narratorId)");
		expect(ACTIONS).toContain("api.resetSpec(narratorId)");
		expect(ACTIONS).toContain("api.dismissSpecCarryoverMessage(narratorId, messageId)");
		expect(ACTIONS).toMatch(/queryKey: \["narrators", narratorId, "spec"\]/);
	});

	it("confirms before resetting the whole Dynamic Spec namespace", () => {
		// Reset wipes tasks + index.md + behavior fence + custom notes; it must not be
		// a single unconfirmed click.
		expect(ACTIONS).toMatch(/if \(action === "reset"\)[\s\S]{0,200}await confirm\(\{/);
		expect(ACTIONS).toContain('t("specForkResetConfirmMessage")');
	});

	it("keeps the render layer free of app imports (CONTRACT.md §0)", () => {
		// The mutations live in the integration module; the card must not reach for
		// the REST client / i18n / confirm dialog itself.
		expect(CARD).not.toContain("@frontend/lib/api");
		expect(CARD).not.toContain("react-i18next");
		expect(CARD).not.toContain("ConfirmDialogProvider");
	});
});
