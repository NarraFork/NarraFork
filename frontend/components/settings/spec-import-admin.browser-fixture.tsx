/**
 * Browser fixture of the Dynamic Spec import's admin view and the Spec panel's read-only line
 * (outline P2 PR 12b2; `spec-import-admin.browser.test.ts`). The real components, the real
 * confirm dialog and Mantine styles, under a memory router; the API is an in-memory stand-in
 * the test reads and drives through the exports below. Nothing reaches a server.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { Box, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import type {
	OutlineSpecImportAdminItem,
	OutlineSpecImportAdminState,
	OutlineSpecImportStatus,
} from "@shared/outline-spec-import";
import { OUTLINE_SPEC_IMPORT_ADMIN_STATES } from "@shared/outline-spec-import";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../lib/api";
import commonEn from "../../locales/en/common.json";
import errorsEn from "../../locales/en/errors.json";
import narratorEn from "../../locales/en/narrator.json";
import outlineEn from "../../locales/en/outline.json";
import settingsEn from "../../locales/en/settings.json";
import commonZh from "../../locales/zh-CN/common.json";
import errorsZh from "../../locales/zh-CN/errors.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import outlineZh from "../../locales/zh-CN/outline.json";
import settingsZh from "../../locales/zh-CN/settings.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { SpecPanel } from "../narrator/spec/SpecPanel";
import { SpecImportAdminSection } from "./SpecImportAdminSection";

const NARRATOR = "moved-session";
const NOW = "2026-11-12T08:00:00.000Z";

/** The admin page's sessions, by id. */
let sessions = new Map<string, OutlineSpecImportAdminItem>();
/** What the next move back answers about the old fence (the page warns when false). */
let revertFenceRestored = true;
export function setRevertFenceRestored(value: boolean): void {
	revertFenceRestored = value;
}
/** What the page asked the server to do. */
export const calls: string[] = [];
let root: Root | null = null;

function item(
	n: number,
	state: OutlineSpecImportAdminState,
	extra: Partial<OutlineSpecImportAdminItem> = {},
): OutlineSpecImportAdminItem {
	const outline = state === "imported";
	return {
		narratorId: `s${String(n).padStart(3, "0")}`,
		title: `Session ${n} with a title long enough to wrap on a narrow phone screen`,
		ownerName: `owner${n}`,
		taskBackend: outline ? "outline" : "spec",
		state,
		trigger: "sweep",
		attempts: state === "failed" || state === "attention" ? 2 : 0,
		reason:
			state === "attention"
				? { code: "kept_blocks", count: 3 }
				: state === "failed"
					? { code: "changed" }
					: null,
		error: null,
		switchedAt: outline ? NOW : null,
		switchCount: outline ? 1 : 0,
		revertedAt: state === "reverted" ? NOW : null,
		revertCount: state === "reverted" ? 1 : 0,
		updatedAt: new Date(Date.parse(NOW) - n * 60_000).toISOString(),
		canRevert: outline,
		canReimport: !outline && state !== "running",
		...extra,
	};
}

function seed(): void {
	sessions = new Map();
	let n = 0;
	for (let i = 0; i < 3; i++)
		sessions.set(`s${String(++n).padStart(3, "0")}`, item(n, "attention"));
	for (let i = 0; i < 25; i++)
		sessions.set(`s${String(++n).padStart(3, "0")}`, item(n, "imported"));
	sessions.set(`s${String(++n).padStart(3, "0")}`, item(n, "reverted"));
	calls.length = 0;
}

api.getSpecImportAdminPage = async ({ state, cursor, limit }) => {
	const all = [...sessions.values()]
		.filter((entry) => entry.state === state)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const start = cursor ? Number(cursor) : 0;
	const size = limit ?? 20;
	const counts = Object.fromEntries(
		OUTLINE_SPEC_IMPORT_ADMIN_STATES.map((s) => [
			s,
			[...sessions.values()].filter((entry) => entry.state === s).length,
		]),
	) as Record<OutlineSpecImportAdminState, number>;
	return {
		mode: "auto",
		counts,
		countCap: 1000,
		items: all.slice(start, start + size),
		next: start + size < all.length ? String(start + size) : null,
	};
};

api.revertSpecImport = async (narratorId) => {
	calls.push(`revert:${narratorId}`);
	const entry = sessions.get(narratorId);
	if (entry)
		sessions.set(narratorId, {
			...entry,
			state: "reverted",
			taskBackend: "spec",
			canRevert: false,
			canReimport: true,
			revertCount: entry.revertCount + 1,
			updatedAt: new Date().toISOString(),
		});
	return { reverted: true, marked: true, fenceRestored: revertFenceRestored, released: 1 };
};

api.reimportSpecSession = async (narratorId) => {
	calls.push(`reimport:${narratorId}`);
	const entry = sessions.get(narratorId);
	if (entry)
		sessions.set(narratorId, {
			...entry,
			state: "imported",
			taskBackend: "outline",
			canRevert: true,
			canReimport: false,
			updatedAt: new Date().toISOString(),
		});
	return panelStatus(true);
};

// The Spec panel of a session the import moved, on its old files.
let moved = true;
function panelStatus(switched: boolean): OutlineSpecImportStatus {
	return {
		mode: "auto",
		importable: false,
		canImport: false,
		state: "imported",
		error: null,
		reason: null,
		at: NOW,
		attempts: 0,
		switchedAt: switched ? NOW : null,
		spaceId: switched ? "space-1" : null,
		taskPageId: switched ? "page-1" : null,
		revertedAt: null,
	};
}
api.getSpecImportStatus = async () => panelStatus(moved);
api.getNarratorCurrentTask = async () => ({
	backend: "outline",
	current: null,
	awaitingConfirmation: 0,
	awaitingYourConfirmation: 0,
	awaitingFrom: [],
});
api.getSessionTaskBoard = async () =>
	({
		scope: { kind: "session", narratorId: NARRATOR },
		sections: [],
		canAdd: false,
		nextCursor: null,
		me: { userId: "u1", name: "u1" },
	}) as never;
api.listSpecFiles = async () =>
	({
		files: ["tasks.json", "design.md"].map((path) => ({
			uri: `spec://${path}`,
			path,
			readonly: false,
			uiEditable: true,
			revisionId: "r1",
			updatedAt: NOW,
		})),
	}) as never;
api.readSpecFile = async (_narrator, uri) =>
	({
		uri,
		path: uri.replace("spec://", ""),
		content: "# Design\n\nThe old notes, now on an outline page.\n",
		revisionId: "r1",
		readonly: false,
		uiEditable: true,
	}) as never;
api.readSpecTasks = async () =>
	({
		content: '{"tasks":[{"text":"Old spec task","status":"todo"}]}',
		revisionId: "t1",
		document: { tasks: [{ text: "Old spec task", status: "todo" }] },
		compiled: null,
	}) as never;
// The session has nothing the old editor may have swallowed (12c has its own fixture).
api.getSpecLossPage = async () => ({
	items: [],
	next: null,
	counts: { open: 0, attached: 0, dismissed: 0 },
	countCap: 1000,
	canAct: false,
});
api.getUserPreferences = async () => ({}) as never;
api.getSettings = async () => ({ agent: {}, outline: { enabled: true } }) as never;
api.getNarrator = async () => ({ id: NARRATOR }) as never;

export function ready(): boolean {
	return true;
}

/** Mount the admin view or the Spec panel, in a language and a color scheme. */
export async function mount(options: {
	view: "admin" | "panel";
	lang: "en" | "zh-CN";
	scheme: "light" | "dark";
	switched?: boolean;
	/** What the move back answers about the old fence. */
	fenceRestored?: boolean;
}): Promise<void> {
	root?.unmount();
	seed();
	revertFenceRestored = options.fenceRestored ?? true;
	moved = options.switched ?? true;
	const i18n = createInstance();
	await i18n.init({
		lng: options.lang,
		fallbackLng: "en",
		resources: {
			en: {
				common: commonEn,
				errors: errorsEn,
				narrator: narratorEn,
				outline: outlineEn,
				settings: settingsEn,
			},
			"zh-CN": {
				common: commonZh,
				errors: errorsZh,
				narrator: narratorZh,
				outline: outlineZh,
				settings: settingsZh,
			},
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	document.documentElement.lang = options.lang;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["settings"], { agent: {}, outline: { enabled: true } });
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const home = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () =>
			options.view === "admin" ? (
				<Box px={16} py="md" data-testid="host">
					<SpecImportAdminSection />
				</Box>
			) : (
				<Box h="100vh" data-testid="host">
					<SpecPanel narratorId={NARRATOR} onClose={() => {}} />
				</Box>
			),
	});
	const narrator = createRoute({
		getParentRoute: () => rootRoute,
		path: "/narrators/$narratorId",
		component: () => <div data-testid="narrator-page" />,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([home, narrator]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const container = document.getElementById("root");
	if (!container) throw new Error("no #root");
	root = createRoot(container);
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider forceColorScheme={options.scheme}>
				<Notifications />
				<QueryClientProvider client={client}>
					<ConfirmDialogProvider>
						<RouterProvider router={router} />
					</ConfirmDialogProvider>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

/** Widest element past the viewport's right edge, if any (horizontal overflow). */
export function overflow(): { scroll: number; client: number; offenders: string[] } {
	const doc = document.documentElement;
	const offenders: string[] = [];
	for (const element of document.querySelectorAll<HTMLElement>("[data-testid] *, [data-testid]")) {
		const rect = element.getBoundingClientRect();
		if (rect.width > 0 && rect.right > doc.clientWidth + 0.5)
			offenders.push(
				`${element.tagName.toLowerCase()}.${element.getAttribute("data-testid") ?? ""}:${Math.round(rect.right)}`,
			);
	}
	return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders: offenders.slice(0, 5) };
}
