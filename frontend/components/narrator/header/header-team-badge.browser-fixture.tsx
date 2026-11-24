import "@mantine/core/styles.css";
import { ActionIcon, Group, MantineProvider } from "@mantine/core";
import { IconArrowLeft, IconDots, IconStar, IconX } from "@tabler/icons-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createRoot, type Root } from "react-dom/client";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { HEADER_LEADING_GAP_PX, headerTitleLayoutWidth } from "./header-title-width";
import { NarratorHeaderLayout } from "./NarratorHeaderLayout";
import { NarratorPanelHeaderTitle } from "./NarratorPanelHeaderTitle";
import { NarratorTeamBadge, useNarratorTeamBadge } from "./NarratorTeamBadge";

// The session header's row as NarratorPanel paints it: real layout arithmetic, real title slot,
// real team badge, and a toolbar with HeaderToolbar's structure (Group gap="xs", sm icons,
// overflow trigger, close).
type Strings = Record<string, unknown>;
declare global {
	interface Window {
		fixtureT: (key: string, options?: Record<string, unknown>) => string;
	}
}
const TOOL_COUNT = 9;
let closeClicks = 0;
let overflowClicks = 0;
let root: Root | null = null;

function Header({ title }: { title: string }) {
	const narrator = { traits: ["named", "team"], title };
	const teamBadge = useNarratorTeamBadge({ narratorId: "coord-1", narrator, projectId: "proj-1" });
	return (
		<div style={{ width: "100%" }}>
			<NarratorHeaderLayout
				titleFullWidth={headerTitleLayoutWidth(title)}
				showBack
				showTitleActions
				titleBadgeWidth={teamBadge?.width ?? 0}
				surfacedToolCount={TOOL_COUNT}
				showClose
			>
				{(layout) => (
					<>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: HEADER_LEADING_GAP_PX,
								flexWrap: "nowrap",
								flex: "0 0 auto",
								minWidth: 0,
								maxWidth: "100%",
								overflow: "hidden",
							}}
						>
							<ActionIcon size="sm" variant="subtle" color="gray">
								<IconArrowLeft size={16} />
							</ActionIcon>
							<NarratorPanelHeaderTitle
								narratorId="coord-1"
								narrator={narrator}
								hostOwnsTitle={false}
								isWorkspacePreview={false}
								titleFullWidth={layout.titleWidth}
							/>
							{teamBadge && layout.showTitleBadge && <NarratorTeamBadge target={teamBadge} />}
						</div>
						<Group gap="xs" wrap="nowrap" style={{ flex: "0 0 auto", marginLeft: "auto" }}>
							{Array.from({ length: layout.visibleToolCount }, (_, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder tools
								<ActionIcon key={i} size="sm" variant="subtle" data-fixture-tool>
									<IconStar size={16} />
								</ActionIcon>
							))}
							<ActionIcon
								size="sm"
								variant="subtle"
								data-fixture="overflow"
								onClick={() => overflowClicks++}
							>
								<IconDots size={16} />
							</ActionIcon>
							<ActionIcon
								size="sm"
								variant="subtle"
								color="red"
								data-fixture="close"
								onClick={() => closeClicks++}
							>
								<IconX size={16} />
							</ActionIcon>
						</Group>
					</>
				)}
			</NarratorHeaderLayout>
		</div>
	);
}

export function start(options: { width: number; locale: "en" | "zh-CN"; title: string }) {
	const strings: Strings = options.locale === "en" ? en : zh;
	window.fixtureT = (key, values) => {
		const entry = strings[key];
		let text = typeof entry === "string" ? entry : key;
		for (const [name, value] of Object.entries(values ?? {}))
			text = text.replaceAll(`{{${name}}}`, String(value));
		return text;
	};
	closeClicks = 0;
	overflowClicks = 0;
	root?.unmount();
	const host = document.getElementById("root") as HTMLElement;
	host.style.width = `${options.width}px`;
	const rootRoute = createRootRoute({ component: () => <Header title={options.title} /> });
	const routeTree = rootRoute.addChildren([
		createRoute({ getParentRoute: () => rootRoute, path: "narrators/$narratorId" }),
		createRoute({ getParentRoute: () => rootRoute, path: "projects/$projectId/teams/$teamId" }),
	]);
	const router = createRouter({
		routeTree,
		basepath: "/nf",
		history: createMemoryHistory({ initialEntries: ["/nf/narrators/coord-1"] }),
	});
	root = createRoot(host);
	root.render(
		<MantineProvider>
			<QueryClientProvider client={new QueryClient()}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</MantineProvider>,
	);
}

function rect(element: Element | null) {
	if (!element) return null;
	const r = element.getBoundingClientRect();
	return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
}

/** Whether a real pointer at the element's center lands on it (not clipped or covered). */
function hittable(element: Element | null): boolean {
	if (!element) return false;
	const r = element.getBoundingClientRect();
	const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
	return !!hit && (hit === element || element.contains(hit));
}

export function snapshot() {
	const row = document.querySelector("[data-narrator-header-layout]");
	const close = document.querySelector("[data-fixture='close']");
	const overflow = document.querySelector("[data-fixture='overflow']");
	const badge = document.querySelector<HTMLAnchorElement>("[data-testid='narrator-team-badge']");
	const label = badge?.querySelector("span:last-child") ?? null;
	return {
		ready: !!row && !!close,
		row: rect(row),
		close: rect(close),
		overflow: rect(overflow),
		closeHittable: hittable(close),
		overflowHittable: hittable(overflow),
		badge: rect(badge),
		badgeHref: badge?.getAttribute("href") ?? null,
		badgeText: badge?.textContent ?? null,
		badgeLabelClipped: label ? label.scrollWidth > label.clientWidth : null,
		toolbar: rect(close?.parentElement ?? null),
		tools: document.querySelectorAll("[data-fixture-tool]").length,
		closeClicks,
		overflowClicks,
	};
}
