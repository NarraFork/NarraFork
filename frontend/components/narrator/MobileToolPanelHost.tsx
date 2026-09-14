/**
 * MobileToolPanelHost — the off-dock (mobile) host for narrator tool panels.
 *
 * Why this exists: the mobile narrator page renders `NarratorPanel` directly,
 * with NO `NarratorDockProvider` above it, so `useNarratorDockContext()` returns
 * null. The header used to gate five tool buttons behind `{dock && …}`, which
 * meant Git, search, browser, discussion and the plugin picker had no entry point
 * at all on a phone — not a collapsed one, an absent one. Nothing reported this;
 * the buttons simply were not rendered.
 *
 * The panel CONTENT components were already independent of dockview: each takes
 * a `narratorId` (or `chapterId`) and most accept `chromeless`. Only the dock's
 * `ToolPanelShell` needed `props.api`. So the fix is a second host for the same
 * content, not a second implementation of it — this Drawer is that host.
 *
 * Deliberately NOT a dockview instance at phone width: a 360px viewport cannot
 * show chat and a tool side by side, and a draggable/splittable surface there is
 * cost without benefit. A full-screen Drawer over the conversation is the honest
 * mobile shape, and it matches what the terminal and spec panels already do.
 */

import { Box, Center, Drawer, Loader, Text } from "@mantine/core";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import {
	SAFE_AREA_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
	safeAreaDrawerHeaderHeight,
	safeAreaDrawerHeaderPaddingTop,
} from "../../lib/safe-area";

const GitPanel = lazy(() => import("../chapter/GitPanel").then((m) => ({ default: m.GitPanel })));
const NarratorSearchPanel = lazy(() =>
	import("./NarratorSearchPanel").then((m) => ({ default: m.NarratorSearchPanel })),
);
const BrowserPanel = lazy(() =>
	import("./browser/BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);
const NarratorUserChatPanel = lazy(() =>
	import("../chat/NarratorUserChatPanel").then((m) => ({ default: m.NarratorUserChatPanel })),
);

/**
 * Tool panels this host can present. A subset of the dock's panel kinds on
 * purpose — `details` and `filemod` already have their own drawers in
 * `NarratorPanel`, and `terminal` / `spec` are hosted by the route.
 */
export type MobileToolPanelKind = "git" | "search" | "browser" | "userchat";

const MOBILE_DRAWER_HEADER_HEIGHT = 45;

/**
 * Matches the route's own mobile drawers (terminal / spec) so all of them share
 * one visual contract: safe-area aware header, zero body padding, body height
 * that accounts for the header.
 */
const MOBILE_DRAWER_STYLES = {
	header: {
		minHeight: safeAreaDrawerHeaderHeight(MOBILE_DRAWER_HEADER_HEIGHT),
		paddingTop: safeAreaDrawerHeaderPaddingTop(8),
		paddingBottom: 8,
		paddingLeft: 16,
		paddingRight: 16,
		borderBottom: "1px solid var(--mantine-color-default-border)",
	},
	body: {
		height: safeAreaDrawerBodyHeight(MOBILE_DRAWER_HEADER_HEIGHT),
		padding: 0,
		...SAFE_AREA_DRAWER_BODY_STYLE,
	},
} as const;

function PanelBoundary({ children }: { children: React.ReactNode }) {
	return (
		<Suspense
			fallback={
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			}
		>
			{children}
		</Suspense>
	);
}

export interface MobileToolPanelHostProps {
	/** Which panel to show; null closes the drawer. */
	kind: MobileToolPanelKind | null;
	onClose: () => void;
	narratorId: string;
	/** Required by the git panel; when absent the git entry reports "no chapter". */
	chapterId?: string | null;
	/** Live browser session count, forwarded so the panel matches the dock's props. */
	browserSessionCount?: number;
	browserVisualChange?: { sessionId: string; seq: number } | null;
	/**
	 * Scroll the conversation to a message. Supplied instead of the dock's
	 * `scrollToMessage` bridge, which does not exist off-dock. Closing the drawer
	 * is the caller's job: the target is behind it.
	 */
	onJumpToMessage?: (messageId: string) => void;
	/** Submit text to the narrator's composer, replacing the dock's submit bridge. */
	onForwardToNarrator?: (text: string) => void;
}

export function MobileToolPanelHost({
	kind,
	onClose,
	narratorId,
	chapterId,
	browserSessionCount,
	browserVisualChange,
	onJumpToMessage,
	onForwardToNarrator,
}: MobileToolPanelHostProps) {
	const { t } = useTranslation("narrator");
	const { t: tGit } = useTranslation("git");
	const { t: tChat } = useTranslation("chat");

	const title =
		kind === "git"
			? tGit("panel.title")
			: kind === "search"
				? t("search.title")
				: kind === "browser"
					? t("browser.title")
					: kind === "userchat"
						? tChat("panelTitle")
						: "";

	return (
		<Drawer
			opened={kind !== null}
			onClose={onClose}
			position="right"
			size="100%"
			title={
				<Text size="sm" fw={600} truncate>
					{title}
				</Text>
			}
			closeButtonProps={{ size: "sm" }}
			styles={MOBILE_DRAWER_STYLES}
		>
			{/* Mount only the active panel: these are live surfaces (a browser session,
			    a chat room subscription), so keeping the inactive ones mounted would hold
			    subscriptions open for panels the reader closed. */}
			{kind === "git" ? (
				chapterId ? (
					<Box style={{ height: "100%" }}>
						<PanelBoundary>
							<GitPanel chapterId={chapterId} />
						</PanelBoundary>
					</Box>
				) : (
					<Center h="100%">
						<Text size="sm" c="dimmed">
							{tGit("panel.noChapter")}
						</Text>
					</Center>
				)
			) : null}
			{kind === "search" ? (
				<PanelBoundary>
					<NarratorSearchPanel
						narratorId={narratorId}
						// Jumping must also dismiss this drawer — the message it scrolls to is
						// underneath it, so leaving it open would look like nothing happened.
						onJumpToMessage={
							onJumpToMessage
								? (messageId) => {
										onClose();
										onJumpToMessage(messageId);
									}
								: undefined
						}
					/>
				</PanelBoundary>
			) : null}
			{kind === "browser" ? (
				<PanelBoundary>
					<BrowserPanel
						narratorId={narratorId}
						sessionCount={browserSessionCount}
						visualChange={browserVisualChange}
						chromeless
					/>
				</PanelBoundary>
			) : null}
			{kind === "userchat" ? (
				<PanelBoundary>
					<NarratorUserChatPanel
						narratorId={narratorId}
						onForwardToNarrator={onForwardToNarrator}
					/>
				</PanelBoundary>
			) : null}
		</Drawer>
	);
}
