import "@mantine/core/styles.css";
import type { HumanAttentionDetail } from "@frontend/types/narrator";
import { MantineProvider } from "@mantine/core";
import type { HumanAttentionItem } from "@shared/human-attention";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { humanAttentionQueryKey } from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import narratorEn from "../../locales/en/narrator.json";
import navEn from "../../locales/en/nav.json";
import { NotificationCenterDrawer } from "./NotificationCenterDrawer";

const item: HumanAttentionItem = {
	id: "question:browser-question",
	kind: "async_question",
	source: "question",
	requestId: "browser-question",
	toolCallId: "browser-call",
	toolName: "AskUserQuestion",
	narratorId: "browser-owner",
	narratorTitle: "Browser owner",
	parentNarratorId: null,
	rootNarratorId: null,
	chapterId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	blocking: false,
	canAct: true,
	summary: "Browser question",
};
const detail: HumanAttentionDetail = {
	item,
	question: {
		id: item.requestId,
		narratorId: item.narratorId,
		toolCallId: item.toolCallId,
		toolUseId: "browser-use",
		questions: [{ id: "choice", header: "Choose", options: [{ header: "A" }, { header: "B" }] }],
		answers: null,
		status: "open",
		origin: "user_deferred",
		answerMessageId: null,
		decidedBy: null,
		decidedAt: null,
		createdAt: item.createdAt,
	},
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
client.setQueryData(["settings"], { agent: {} });
let refreshing = false;
let finishRefresh: (() => void) | undefined;
api.getHumanAttention = async () => ({ items: [item], nextCursor: null });
api.getHumanAttentionDetail = async () => {
	if (!refreshing) return detail;
	return new Promise((resolve) => {
		finishRefresh = () => {
			refreshing = false;
			resolve(detail);
		};
	});
};
api.getGlobalQuestionPage = async () => ({ items: [], nextCursor: null });

declare global {
	interface Window {
		__notificationFixture: { refresh: () => void; finish: () => void; fetching: () => boolean };
	}
}
window.__notificationFixture = {
	refresh: () => {
		refreshing = true;
		void client.invalidateQueries({ queryKey: humanAttentionQueryKey });
	},
	finish: () => finishRefresh?.(),
	fetching: () => client.isFetching({ queryKey: [...humanAttentionQueryKey, "detail"] }) > 0,
};
const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: narratorEn, nav: navEn } },
	interpolation: { escapeValue: false },
});
const router = createRouter({
	routeTree: createRootRoute(),
	history: createMemoryHistory(),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing notification fixture root");
createRoot(root).render(
	<QueryClientProvider client={client}>
		<I18nextProvider i18n={i18n}>
			<RouterContextProvider router={router}>
				<MantineProvider>
					<NotificationCenterDrawer opened initialTab="attention" onClose={() => {}} />
				</MantineProvider>
			</RouterContextProvider>
		</I18nextProvider>
	</QueryClientProvider>,
);
