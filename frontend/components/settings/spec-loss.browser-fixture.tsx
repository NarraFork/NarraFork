/**
 * Browser fixture of the swallowed-content findings (outline P2 PR 12c;
 * `spec-loss.browser.test.ts`): the admin section and the Spec panel's notice, the real
 * components, confirm dialog and Mantine styles under a memory router. The API is an in-memory
 * stand-in the test reads and drives through the exports below. Nothing reaches a server.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { Box, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import type {
	OutlineSpecLossFinding,
	OutlineSpecLossScanStatus,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
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
import { SpecLossAdminSection } from "./SpecLossAdminSection";

const NARRATOR = "s001";
const NOW = "2026-11-13T08:00:00.000Z";
export const TABLE =
	"| name | value | a column with a long heading that is wider than a phone |\n| --- | --- | --- |\n| alpha | 1 | x |";

let findings = new Map<string, OutlineSpecLossFinding>();
let scan: OutlineSpecLossScanStatus = { running: false, lastPass: null };
let canAct = true;
/** What the page asked the server to do. */
export const calls: string[] = [];
let root: Root | null = null;

/** Findings of the imported session that are not on the page, and why. */
const LEFT_OUT: Record<number, "page_cap" | "no_page"> = { 27: "page_cap", 30: "no_page" };
/** The attached finding whose block someone wrote in: a dismissal keeps it. */
export const KEPT = "f003";

function finding(n: number, extra: Partial<OutlineSpecLossFinding> = {}): OutlineSpecLossFinding {
	const narratorId = `s${String((n % 3) + 1).padStart(3, "0")}`;
	// The first session was imported: its findings are on their pages, but for two. The others
	// still keep Dynamic Spec, so theirs wait.
	const imported = narratorId === NARRATOR;
	const leftOut = LEFT_OUT[n] ?? null;
	const attached = imported && leftOut === null;
	return {
		id: `f${String(n).padStart(3, "0")}`,
		narratorId,
		title: `Session ${narratorId} with a title long enough to wrap on a narrow phone screen`,
		path: `notes/a-rather-long-directory-name/design-document-number-${n}.md`,
		savedAt: "2026-10-20T09:30:00.000Z",
		kinds: n % 2 ? { table: 2, image: 1 } : { table: 1 },
		truncated: n === 2,
		status: attached ? "attached" : "open",
		blockId: attached ? `block-${n}` : null,
		attachNote: imported ? leftOut : null,
		spaceId: "space-1",
		resolvedAt: null,
		createdAt: new Date(Date.parse(NOW) - n * 60_000).toISOString(),
		attachable: imported && !attached,
		...extra,
	};
}

function seed(): void {
	findings = new Map();
	for (let n = 0; n < 32; n++) findings.set(finding(n).id, finding(n));
	findings.set(
		"f900",
		finding(900, { id: "f900", status: "dismissed", blockId: null, attachable: false }),
	);
	scan = {
		running: false,
		lastPass: { at: NOW, sessions: 40, scanned: 12, found: 3, attached: 2, left: 0 },
	};
	calls.length = 0;
}

api.getSpecLossPage = async (narratorId, { status, cursor, limit }) => {
	const mine = [...findings.values()].filter((f) => !narratorId || f.narratorId === narratorId);
	const all = mine
		.filter((f) => f.status === status)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const start = cursor ? Number(cursor) : 0;
	const size = limit ?? 20;
	const count = (s: OutlineSpecLossStatus) => mine.filter((f) => f.status === s).length;
	return {
		items: all.slice(start, start + size),
		next: start + size < all.length ? String(start + size) : null,
		counts: { open: count("open"), attached: count("attached"), dismissed: count("dismissed") },
		countCap: 1000,
		canAct,
		...(narratorId ? {} : { scan }),
	};
};

api.getSpecLossDetail = async (_narratorId, findingId) => {
	calls.push(`detail:${findingId}`);
	const entry = findings.get(findingId);
	if (!entry) throw new Error("no such finding");
	return {
		...entry,
		parts: [
			{ kind: "table", text: TABLE },
			...(entry.kinds.image ? [{ kind: "image" as const, text: "![diagram](img/flow.png)" }] : []),
		],
	};
};

api.decideSpecLoss = async (_narratorId, findingId, action) => {
	calls.push(`${action}:${findingId}`);
	const entry = findings.get(findingId);
	if (!entry) throw new Error("no such finding");
	const imported = entry.narratorId === NARRATOR;
	// Dismissed: the block goes, unless someone wrote in it. Reopened: attached again when the
	// session was imported.
	const onPage = action === "attach" || (action === "reopen" && imported);
	const next: OutlineSpecLossFinding = {
		...entry,
		status: onPage ? "attached" : action === "dismiss" ? "dismissed" : "open",
		blockId: onPage
			? (entry.blockId ?? "block-new")
			: action === "dismiss" && findingId === KEPT
				? entry.blockId
				: null,
		attachNote: null,
		resolvedAt: action === "dismiss" ? NOW : null,
		attachable: false,
	};
	findings.set(findingId, next);
	return next;
};

api.startSpecLossScan = async () => {
	calls.push("scan");
	scan = { ...scan, running: true };
	return scan;
};

// The Spec panel of a session that still keeps Dynamic Spec (`s002`: nothing attachable) or of
// an imported one (`s001`).
let panelNarrator = NARRATOR;
api.getSpecImportStatus = async () => ({
	mode: "manual",
	importable: panelNarrator !== NARRATOR,
	canImport: false,
	state: panelNarrator === NARRATOR ? "imported" : "idle",
	error: null,
	reason: null,
	at: NOW,
	attempts: 0,
	switchedAt: panelNarrator === NARRATOR ? NOW : null,
	spaceId: panelNarrator === NARRATOR ? "space-1" : null,
	taskPageId: panelNarrator === NARRATOR ? "page-1" : null,
	revertedAt: null,
});
api.getNarratorCurrentTask = async () => ({
	backend: panelNarrator === NARRATOR ? "outline" : "spec",
	current: null,
	awaitingConfirmation: 0,
	awaitingYourConfirmation: 0,
	awaitingFrom: [],
});
api.getSessionTaskBoard = async () =>
	({
		scope: { kind: "session", narratorId: panelNarrator },
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
		content: "# Design\n\nThe notes as they are now.\n",
		revisionId: "r1",
		readonly: false,
		uiEditable: true,
	}) as never;
api.readSpecTasks = async () =>
	({
		content: '{"tasks":[{"text":"A spec task","status":"todo"}]}',
		revisionId: "t1",
		document: { tasks: [{ text: "A spec task", status: "todo" }] },
		compiled: null,
	}) as never;
api.getUserPreferences = async () => ({}) as never;
api.getSettings = async () => ({ agent: {}, outline: { enabled: true } }) as never;
api.getNarrator = async () => ({ id: panelNarrator }) as never;

export function ready(): boolean {
	return true;
}

/** Mount the admin section or a session's Spec panel, in a language and a color scheme. */
export async function mount(options: {
	view: "admin" | "panel";
	lang: "en" | "zh-CN";
	scheme: "light" | "dark";
	/** The panel's session: `s001` was imported, `s002` still keeps Dynamic Spec. */
	narratorId?: string;
	/** The reader may decide (default) or only read. */
	canAct?: boolean;
	/** No findings at all. */
	empty?: boolean;
}): Promise<void> {
	root?.unmount();
	seed();
	if (options.empty) findings = new Map();
	canAct = options.canAct ?? true;
	panelNarrator = options.narratorId ?? NARRATOR;
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
					<SpecLossAdminSection />
				</Box>
			) : (
				<Box h="100vh" data-testid="host">
					<SpecPanel narratorId={panelNarrator} onClose={() => {}} />
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

/** Elements past the viewport's right edge, if any (horizontal overflow of the page). */
export function overflow(): { scroll: number; client: number; offenders: string[] } {
	const doc = document.documentElement;
	const offenders: string[] = [];
	for (const element of document.querySelectorAll<HTMLElement>("[data-testid] *, [data-testid]")) {
		// What scrolls inside its own box (the lost text) does not widen the page.
		if (element.closest("pre")) continue;
		const rect = element.getBoundingClientRect();
		if (rect.width > 0 && rect.right > doc.clientWidth + 0.5)
			offenders.push(
				`${element.tagName.toLowerCase()}.${element.getAttribute("data-testid") ?? ""}:${Math.round(rect.right)}`,
			);
	}
	return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders: offenders.slice(0, 5) };
}
