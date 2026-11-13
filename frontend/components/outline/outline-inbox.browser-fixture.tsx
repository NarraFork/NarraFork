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
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { humanAttentionQueryKey } from "../../hooks/useHumanAttention";
import { useOutlineBlock } from "../../hooks/useOutline";
import { api } from "../../lib/api";
import narratorEn from "../../locales/en/narrator.json";
import navEn from "../../locales/en/nav.json";
import outlineEn from "../../locales/en/outline.json";
import { useOutlineAskSlots } from "../narrator/vlist/vlist-outline-ask-bridge";
import type { VListItem } from "../narrator/vlist/vlist-pipeline";
import type { VListToolMeta } from "../narrator/vlist/vlist-tool-meta";
import { NotificationCenterDrawer } from "../notifications/NotificationCenterDrawer";
import { OutlineQuestionsForm, OutlineQuestionsSection } from "./OutlineQuestions";

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

export type Pane = {
	id: string;
	entry: "form" | "outline" | "narrator";
	spaceId: string;
	blockId: string;
	questionRootIds?: string[];
	questionIds?: string[];
	readOnly?: boolean;
};

let setHidden: ((ids: string[]) => void) | undefined;

function OutlinePane({ pane }: { pane: Pane }) {
	const query = useOutlineBlock(pane.spaceId, pane.blockId, { view: "all" });
	return query.data ? <OutlineQuestionsSection view={query.data} /> : null;
}

function NarratorPane({ pane }: { pane: Pane }) {
	const slots = useOutlineAskSlots({
		enabled: true,
		renderItems: [
			{
				spec: { key: `tool-${pane.id}`, kind: "tool-call" },
				measured: { effectiveOpened: true },
			} as unknown as VListItem,
		],
		tools: new Map<string, VListToolMeta>([
			[
				pane.id,
				{
					outlineAsk: {
						questionRootIds: pane.questionRootIds ?? [pane.blockId],
						questionIds: pane.questionIds ?? [pane.blockId],
					},
				},
			],
		]),
	});
	return slots.get(`tool-${pane.id}`);
}

function Contents({ inbox, panes }: { inbox: boolean; panes: Pane[] }) {
	const [hidden, updateHidden] = useState<string[]>([]);
	setHidden = updateHidden;
	return (
		<>
			{inbox && (
				<NotificationCenterDrawer
					opened
					initialTab="attention"
					onClose={() => {
						closed++;
					}}
				/>
			)}
			{panes
				.filter((pane) => !hidden.includes(pane.id))
				.map((pane) => (
					<section key={pane.id} data-pane={pane.id} style={{ maxWidth: 560, padding: 16 }}>
						{pane.entry === "outline" ? (
							<OutlinePane pane={pane} />
						) : pane.entry === "narrator" ? (
							<NarratorPane pane={pane} />
						) : (
							<OutlineQuestionsForm {...pane} showOpenLink={false} />
						)}
					</section>
				))}
		</>
	);
}

/** Mount real inbox, outline section and narrator Ask slots using one query client. */
export function open(options: { inbox?: boolean; panes?: Pane[] } = {}): void {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["settings"], { outline: { enabled: true } });
	const queryClient = client;
	const routed = createRouter({
		routeTree: createRootRoute({
			component: () => <Contents inbox={options.inbox ?? true} panes={options.panes ?? []} />,
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

/** Simulate question invalidation delivered by the live outline subscription. */
export function refreshQuestions(): void {
	void client?.invalidateQueries();
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

export function value(selector: string): string | null {
	return document.querySelector<HTMLTextAreaElement>(selector)?.value ?? null;
}

export function disabled(selector: string): boolean {
	const element = document.querySelector(selector);
	return (
		(element instanceof HTMLInputElement ||
			element instanceof HTMLTextAreaElement ||
			element instanceof HTMLButtonElement) &&
		element.disabled
	);
}

/** Unmounting all panes must not discard drafts in the page's shared store. */
export function hidePanes(ids: string[]): void {
	setHidden?.(ids);
}
