/**
 * The spec notice cards' actions by the session's task backend (outline P2 PR 12a): a spec session
 * gets "View tasks", "Clear" and "Reset Spec" wired; an outline session only "View tasks", with
 * the hint the card shows on the two it leaves without a handler (painted disabled in place). The
 * hook itself, rendered with the providers the shell gives it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enNarrator from "../../../locales/en/narrator.json";
import { ConfirmDialogContext } from "../../common/confirm-dialog-context";
import type { SpecCarryoverActions } from "./render/RenderSystemText";
import {
	type SpecCarryoverActionsResolver,
	useSpecCarryoverActions,
} from "./vlist-spec-carryover-actions";

const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "en",
	defaultNS: "narrator",
	ns: ["narrator"],
	resources: { en: { narrator: enNarrator } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

function resolverFor(backend: "spec" | "outline" | undefined): SpecCarryoverActionsResolver {
	let resolver: SpecCarryoverActionsResolver | null = null;
	function Harness() {
		resolver = useSpecCarryoverActions("narrator-1", () => {}, backend);
		return null;
	}
	const container = document.createElement("div");
	const root = createRoot(container);
	act(() => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={new QueryClient()}>
					<ConfirmDialogContext.Provider value={{ confirm: async () => false }}>
						<Harness />
					</ConfirmDialogContext.Provider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
	act(() => root.unmount());
	if (!resolver) throw new Error("hook did not run");
	return resolver;
}

describe("useSpecCarryoverActions by task backend", () => {
	test("a spec session (or one not known yet) gets all three handlers and no hint", () => {
		for (const backend of ["spec", undefined] as const) {
			const actions = resolverFor(backend)("msg-1") as SpecCarryoverActions;
			expect(typeof actions.onViewTasks).toBe("function");
			expect(typeof actions.onClearTasks).toBe("function");
			expect(typeof actions.onResetSpec).toBe("function");
			expect(actions.readOnlyHint).toBeUndefined();
		}
	});

	test("an outline session gets View tasks only, with the hint for the other two", () => {
		const resolve = resolverFor("outline");
		const actions = resolve("msg-1") as SpecCarryoverActions;
		expect(typeof actions.onViewTasks).toBe("function");
		expect(actions.onClearTasks).toBeUndefined();
		expect(actions.onResetSpec).toBeUndefined();
		expect(actions.readOnlyHint).toBe(enNarrator.specCarryoverOutlineReadonly);
		// One object per message, kept: the row memo keeps skipping unchanged rows.
		expect(resolve("msg-1")).toBe(actions);
		expect(resolve(undefined)).toBeUndefined();
	});
});
