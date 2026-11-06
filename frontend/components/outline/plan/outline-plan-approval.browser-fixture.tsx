/**
 * Browser fixture of an outline plan's approval (outline P2 PR 8): the real `InlinePermission`
 * form for a waiting ExitPlanMode of an outline session, which renders `OutlinePlanApproval`,
 * against the test server's outline API, its decision route and the page's change hints over the
 * app's own narrator socket (`outline-plan-approval.browser.test.ts`). With `keyboard`, the panel's
 * keyboard navigation (`usePermissionFocusNav`) hosts it, as in a session's panel.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { type ReactNode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import commonEn from "../../../locales/en/common.json";
import narratorEn from "../../../locales/en/narrator.json";
import outlineEn from "../../../locales/en/outline.json";
import type { PendingPermission } from "../../../types/narrator";
import type { NarratorComposerHandle } from "../../narrator/composer/NarratorComposer";
import { usePermissionFocusNav } from "../../narrator/interaction/use-permission-focus-nav";
import { InlinePermission } from "../../narrator/permission/InlinePermission";
import { PermEnterHintCtx } from "../../narrator/tool-call/tool-call-contexts";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { narrator: narratorEn, common: commonEn, outline: outlineEn } },
	react: { useSuspense: false },
});

export function ready(): boolean {
	return true;
}

/** The panel's keyboard navigation of the waiting request (no composer text). */
function KeyboardHost({
	permission,
	children,
}: {
	permission: PendingPermission;
	children: ReactNode;
}) {
	const composerRef = useRef<NarratorComposerHandle | null>(null);
	const { permEnterHintCtxValue } = usePermissionFocusNav({
		pendingPermissionId: permission.id,
		pendingPermissionToolName: permission.toolName,
		composerSendable: false,
		composerRef,
	});
	return (
		<PermEnterHintCtx.Provider value={permEnterHintCtxValue}>{children}</PermEnterHintCtx.Provider>
	);
}

/** Mount the approval form of one waiting plan (under the panel's keyboard navigation). */
export function open(permission: PendingPermission, options: { keyboard?: boolean } = {}): void {
	// The diff's page subscription rides the narrator socket, as in the app.
	narratorWSManager.connect();
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { outline: { enabled: true } });
	const root = document.getElementById("root") as HTMLElement;
	createRoot(root).render(
		<I18nextProvider i18n={instance}>
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<div style={{ maxWidth: 720, padding: 16, boxSizing: "border-box" }}>
						{options.keyboard ? (
							<KeyboardHost permission={permission}>
								<InlinePermission permission={permission} />
							</KeyboardHost>
						) : (
							<InlinePermission permission={permission} />
						)}
					</div>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

export function socketConnected(): boolean {
	return narratorWSManager.connected;
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;

export function text(selector: string): string | null {
	return q(selector)?.textContent ?? null;
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

/** Click the first button whose text is `label` (inside `within` when given). */
export function clickButton(label: string, within?: string): boolean {
	const scope = within ? q(within) : document.body;
	const button = [...(scope?.querySelectorAll("button") ?? [])].find(
		(b) => b.textContent?.trim() === label,
	);
	button?.click();
	return !!button;
}

export function click(selector: string): boolean {
	const el = q(selector);
	el?.click();
	return !!el;
}

/** Type into a textarea or input the React way. */
export function type(selector: string, value: string): void {
	const el = q(selector) as HTMLTextAreaElement | HTMLInputElement | null;
	if (!el) throw new Error(`no ${selector}`);
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
	Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The label of the button Enter would press (the one carrying the "⏎" hint). */
export function enterTarget(): string | null {
	const button = [...document.querySelectorAll("button")].find((b) =>
		b.textContent?.trim().endsWith("⏎"),
	);
	return button?.textContent?.replace("⏎", "").trim() ?? null;
}

/** Take the focus out of any field (Enter then reaches the panel's keyboard navigation). */
export function blur(): void {
	(document.activeElement as HTMLElement | null)?.blur();
}

/** How many lines the element paints (its height over its line height). */
export function lines(selector: string): number {
	const el = q(selector);
	if (!el) return 0;
	return Math.round(
		el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
	);
}

/** The texts of every element `selector` matches, in order. */
export function texts(selector: string): string[] {
	return [...document.querySelectorAll(selector)].map((e) => e.textContent ?? "");
}

/** The texts of the diff's entries, in order. */
export function entries(): string[] {
	return [...document.querySelectorAll("[data-testid=outline-plan-diff-entry]")].map(
		(e) => e.textContent ?? "",
	);
}

/** The option labels of the open combobox. */
export function options(): string[] {
	return [...document.querySelectorAll("[role=option]")].map((o) => o.textContent ?? "");
}

export function chooseOption(label: string): boolean {
	const option = [...document.querySelectorAll("[role=option]")].find(
		(o) => o.textContent === label,
	) as HTMLElement | undefined;
	option?.click();
	return !!option;
}

/** Whether the page scrolls sideways (it must not, at any width). */
export function overflowsX(): boolean {
	return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
}
