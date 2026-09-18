/**
 * vlist-injection-guard-actions.test.ts — the interrupt task-guard reminder card
 * must be wired end to end in the exact shell.
 *
 * The reminder (server source `interrupt_task_guard`) renders as an
 * origin_notice system-text card whose close button is an `InjectionGuardActions`
 * slot on `RenderSystemText`. This file covers the resolver logic and the shell
 * wiring (same source-assertion style as vlist-error-actions.test.ts, because
 * the shell is not unit-mountable); the click-to-callback half is covered by the
 * real DOM test (render/RenderSystemText.guardcard.test.tsx).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellSource } from "./guard-source";
import {
	INTERRUPT_TASK_GUARD_SOURCE,
	isInterruptGuardItem,
	resolveInterruptGuardActions,
} from "./vlist-injection-guard-actions";
import type { VListItem } from "./vlist-pipeline";

const DIR = import.meta.dir;
const SHELL = shellSource();
const DISPATCH = readFileSync(join(DIR, "render-registry.tsx"), "utf8");
const CARD = readFileSync(join(DIR, "render", "RenderSystemText.tsx"), "utf8");
const ACTIONS = readFileSync(join(DIR, "vlist-injection-guard-actions.ts"), "utf8");
const LABELS = readFileSync(join(DIR, "useVListLabels.ts"), "utf8");
const ADAPTER = readFileSync(
	join(DIR, "..", "..", "..", "..", "shared", "pretext-layout", "segment-adapter.ts"),
	"utf8",
);
const API = readFileSync(join(DIR, "..", "..", "..", "lib", "api", "narrators.ts"), "utf8");
const ROUTES = readFileSync(
	join(DIR, "..", "..", "..", "..", "server", "routes", "narrators.ts"),
	"utf8",
);

/** A minimal item stub — the resolvers only read `spec.kind` / `spec.data`. */
function item(kind: string, data?: Record<string, unknown>): VListItem {
	return {
		spec: { kind, key: `k-${String(data?.kind ?? kind)}`, data: data ?? null },
		measured: { height: 0, blocks: [], frame: { blocks: [], contentHeight: 0, usedWidth: 0 } },
	} as unknown as VListItem;
}

describe("interrupt guard actions — row resolution", () => {
	it("recognizes the guard origin_notice card by its raw injection source", () => {
		expect(
			isInterruptGuardItem(
				item("system-text", {
					kind: "origin_notice",
					originLabel: INTERRUPT_TASK_GUARD_SOURCE,
				}),
			),
		).toBe(true);
	});

	it("ignores other origin notices and other cards", () => {
		// A stray match would put a dismiss button on unrelated injection cards
		// (progress reminders, knowledge hints…), each deletable only through its own
		// flow.
		expect(
			isInterruptGuardItem(item("system-text", { kind: "origin_notice", originLabel: "" })),
		).toBe(false);
		expect(
			isInterruptGuardItem(
				item("system-text", { kind: "origin_notice", originLabel: "silent_progress" }),
			),
		).toBe(false);
		expect(isInterruptGuardItem(item("system-text", { kind: "error" }))).toBe(false);
		expect(isInterruptGuardItem(item("markdown"))).toBe(false);
	});

	it("resolves actions from the row's owning message id", () => {
		const seen: Array<string | undefined> = [];
		const resolve = (messageId: string | undefined) => {
			seen.push(messageId);
			return messageId ? { onDismiss: () => {} } : undefined;
		};
		expect(
			resolveInterruptGuardActions(
				item("system-text", { kind: "origin_notice", originLabel: INTERRUPT_TASK_GUARD_SOURCE }),
				["msg-1"],
				resolve,
			),
		).toBeDefined();
		expect(seen).toEqual(["msg-1"]);
	});

	it("returns undefined for a non-guard row without consulting the resolver", () => {
		let called = false;
		const resolve = () => {
			called = true;
			return { onDismiss: () => {} };
		};
		expect(resolveInterruptGuardActions(item("markdown"), ["msg-1"], resolve)).toBeUndefined();
		expect(called).toBe(false);
	});

	it("yields no actions when the row carries no message id (nothing to delete)", () => {
		const resolve = (messageId: string | undefined) =>
			messageId ? { onDismiss: () => {} } : undefined;
		expect(
			resolveInterruptGuardActions(
				item("system-text", { kind: "origin_notice", originLabel: INTERRUPT_TASK_GUARD_SOURCE }),
				[],
				resolve,
			),
		).toBeUndefined();
	});
});

describe("interrupt guard actions — shell wiring", () => {
	it("injects the resolved actions into the row's render extra", () => {
		expect(SHELL).toContain("if (injectionGuardActions) extra.injectionGuardActions");
		expect(SHELL).toContain("injectionGuardActions={resolveInterruptGuardActions(");
		// Row identity must be part of the memo comparison or an in-flight dismissal
		// would not repaint the disabled close button.
		expect(SHELL).toContain("prev.injectionGuardActions === next.injectionGuardActions");
		expect(SHELL).toContain("useInterruptGuardActions(narratorId)");
	});

	it("passes the actions through the render dispatch to the card", () => {
		expect(DISPATCH).toContain("injectionGuardActions={extra.injectionGuardActions as never}");
		expect(CARD).toContain("injectionGuardActions?: InjectionGuardActions");
		expect(CARD).toContain("onClick={guardActions.onDismiss}");
	});

	it("keeps the render layer free of app imports (CONTRACT.md §0)", () => {
		expect(CARD).not.toContain("@frontend/lib/api");
		expect(CARD).not.toContain("react-i18next");
	});

	it("dismissal deletes the message and prunes the messages cache", () => {
		expect(ACTIONS).toContain("api.dismissInterruptTaskGuardMessage(narratorId, messageId)");
		expect(ACTIONS).toContain("removeMessagesFromCache(qc, narratorId,");
	});

	it("the API client targets the dedicated DELETE route", () => {
		expect(API).toContain("interrupt-task-guard-messages/");
		expect(ROUTES).toContain(
			'narratorRoutes.delete("/:id/interrupt-task-guard-messages/:messageId"',
		);
		expect(ROUTES).toContain("dismissInterruptTaskGuardMessage(narratorId, messageId)");
	});

	it("labels the card heading through the adapter (measured chrome, not render i18n)", () => {
		// The origin_notice heading text is measured, so the label must travel
		// through the adapter's label table — the render layer holds no i18n.
		expect(ADAPTER).toContain('interrupt_task_guard: "sidecarSourceInterruptTaskGuard"');
		expect(LABELS).toContain(
			'sidecarSourceInterruptTaskGuard: t("sidecar.sources.interrupt_task_guard")',
		);
	});
});
