import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import i18next from "i18next";
import { useReducer } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { chatKeys } from "../../hooks/useChat";
import type { ChatMessagePage } from "../../lib/api/chat";
import { setToken } from "../../lib/api/client";
import enChat from "../../locales/en/chat.json";
import enCommon from "../../locales/en/common.json";
import enNarrator from "../../locales/en/narrator.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { ImageViewerProvider } from "../common/ImageViewerProvider";
import { NarratorPanelVisibilityProvider } from "../narrator/narrator-panel-visibility";
import { acknowledge, emit, reportWS } from "./chat-visibility.browser-ws-fixture";
import { NarratorUserChatPanel } from "./NarratorUserChatPanel";

export { acknowledge, emit, reportWS };

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById("root") as HTMLElement);
let visible = false;
let width = 840;
let savedViewport: Element | null = null;
let repaint = () => {};
function App() {
	const [, update] = useReducer((revision: number) => revision + 1, 0);
	repaint = update;
	return (
		<MantineProvider defaultColorScheme="dark">
			<QueryClientProvider client={queryClient}>
				<ConfirmDialogProvider>
					<ImageViewerProvider>
						<NarratorPanelVisibilityProvider value={visible}>
							<div
								data-fixture-surface
								style={{ width, height: 650, display: visible ? "block" : "none" }}
							>
								<NarratorUserChatPanel narratorId="fixture" />
							</div>
						</NarratorPanelVisibilityProvider>
					</ImageViewerProvider>
				</ConfirmDialogProvider>
			</QueryClientProvider>
		</MantineProvider>
	);
}
const route = createRootRoute({ component: App });
const router = createRouter({ routeTree: route });
export async function start() {
	setToken("chat-browser-fixture-principal");
	await i18next.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		resources: { en: { narrator: enNarrator, chat: enChat, common: enCommon } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	root.render(<RouterProvider router={router} />);
	await settle();
}
export async function setVisible(value: boolean) {
	visible = value;
	repaint();
	await settle();
}
/** DOM visibility-event simulation, explicitly not an OS/tab-background claim. */
export async function setDocumentVisible(value: boolean, immediateFrame?: Record<string, unknown>) {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: value ? "visible" : "hidden",
	});
	Object.defineProperty(document, "hidden", { configurable: true, value: !value });
	document.dispatchEvent(new Event("visibilitychange"));
	if (immediateFrame) emit(immediateFrame);
	await settle();
}
export async function setWidth(value: number) {
	width = value;
	repaint();
	await settle();
}
export async function settle() {
	await new Promise<void>((resolve) => setTimeout(resolve, 160));
	await new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
}
function viewport() {
	return document.querySelector<HTMLElement>("[data-pretext-exact-message-list]");
}
export function rememberViewport() {
	savedViewport = viewport();
}
export function scrollHistory() {
	const node = viewport();
	if (!node) throw new Error("Production vlist viewport missing");
	node.scrollTop = Math.max(80, node.scrollHeight / 3);
	node.dispatchEvent(new Event("scroll"));
}
export function report() {
	const node = viewport();
	const rect = node?.getBoundingClientRect();
	const rows = [...document.querySelectorAll<HTMLElement>("[data-nf-row-key]")];
	const visibleRows = rows.filter((row) => {
		const r = row.getBoundingClientRect();
		return rect && r.bottom > rect.top && r.top < rect.bottom;
	});
	const first = visibleRows[0];
	const data = queryClient
		.getQueriesData<{ pages: ChatMessagePage[] }>({ queryKey: chatKeys.messages("room-fixture") })
		.map(([, value]) => value)
		.filter((value): value is { pages: ChatMessagePage[] } => !!value)
		.sort(
			(a, b) =>
				b.pages.flatMap((page) => page.messages).length -
				a.pages.flatMap((page) => page.messages).length,
		)[0];
	return {
		visible,
		documentVisibility: document.visibilityState,
		ws: reportWS(),
		ids: data?.pages.flatMap((page) => page.messages.map((message) => message.id)) ?? [],
		texts: data?.pages.flatMap((page) => page.messages.map((message) => message.contentText)) ?? [],
		deletedIds:
			data?.pages.flatMap((page) =>
				page.messages.filter((message) => !!message.deletedAt).map((message) => message.id),
			) ?? [],
		viewport: node
			? {
					scrollTop: node.scrollTop,
					scrollHeight: node.scrollHeight,
					clientHeight: node.clientHeight,
					sameNode: savedViewport === node,
				}
			: null,
		anchor: first
			? {
					id: first.dataset.messageId,
					offset: first.getBoundingClientRect().top - (rect?.top ?? 0),
				}
			: null,
		rows: visibleRows.map((row) => ({ id: row.dataset.messageId, text: row.textContent })),
		draft: document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? null,
		body: document.body.textContent ?? "",
	};
}
