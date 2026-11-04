/**
 * Browser fixture of the inbox with outline rows (P2 PR 7): the real notification drawer on its
 * "needs you" tab, against the test server's human-attention list and outline API
 * (`outline-inbox.browser.test.ts`). The async-question history below the rows is not under
 * test: its page is empty here.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { humanAttentionQueryKey } from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import narratorEn from "../../locales/en/narrator.json";
import navEn from "../../locales/en/nav.json";
import outlineEn from "../../locales/en/outline.json";
import { NotificationCenterDrawer } from "../notifications/NotificationCenterDrawer";

api.getGlobalQuestionPage = async () => ({ items: [], nextCursor: null });

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: narratorEn, nav: navEn, outline: outlineEn } },
	interpolation: { escapeValue: false },
});

let client: QueryClient | null = null;
/** Where the router is (read by the test). */
let currentHref: (() => string) | null = null;
let closed = 0;

export function ready(): boolean {
	return true;
}

/** Mount the drawer open on the "needs you" tab. */
export function open(): void {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["settings"], { outline: { enabled: true } });
	const queryClient = client;
	const routed = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<NotificationCenterDrawer
					opened
					initialTab="attention"
					onClose={() => {
						closed++;
					}}
				/>
			),
		}),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	currentHref = () => routed.state.location.href;
	createRoot(document.getElementById("root") as HTMLElement).render(
		<QueryClientProvider client={queryClient}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<Notifications />
					<RouterProvider router={routed} />
				</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
}

/** Where the app's router is now, and how often the drawer was asked to close. */
export function location(): { href: string; closed: number } {
	return { href: currentHref?.() ?? "", closed };
}

/** Read the inbox again (what a `human_attention_changed` frame does in the app). */
export function refresh(): void {
	void client?.invalidateQueries({ queryKey: humanAttentionQueryKey });
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

export function exists(selector: string): boolean {
	return document.querySelector(selector) !== null;
}

/** Whether the radio a selector names is checked. */
export function checked(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	const input =
		element instanceof HTMLInputElement
			? element
			: element?.querySelector<HTMLInputElement>("input");
	return input?.checked === true;
}

/** Click the first element matching a selector. */
export function click(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	element.click();
	return true;
}

/** Type into a textarea the way a person does (React sees the change). */
export function type(selector: string, text: string): boolean {
	const element = document.querySelector<HTMLTextAreaElement>(selector);
	if (!element) return false;
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, text);
	element.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}

export function textOf(selector: string): string | null {
	return document.querySelector(selector)?.textContent ?? null;
}
