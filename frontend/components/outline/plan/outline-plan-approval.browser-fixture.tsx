/**
 * Browser fixture of an outline plan's approval (outline P2 PR 8): the real `InlinePermission`
 * form for a waiting ExitPlanMode of an outline session, which renders `OutlinePlanApproval`,
 * against the test server's outline API, its decision route and the page's change hints over the
 * app's own narrator socket (`outline-plan-approval.browser.test.ts`).
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import commonEn from "../../../locales/en/common.json";
import narratorEn from "../../../locales/en/narrator.json";
import outlineEn from "../../../locales/en/outline.json";
import type { PendingPermission } from "../../../types/narrator";
import { InlinePermission } from "../../narrator/permission/InlinePermission";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { narrator: narratorEn, common: commonEn, outline: outlineEn } },
	react: { useSuspense: false },
});

export function ready(): boolean {
	return true;
}

/** Mount the approval form of one waiting plan. */
export function open(permission: PendingPermission): void {
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
						<InlinePermission permission={permission} />
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
