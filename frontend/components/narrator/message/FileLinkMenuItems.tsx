/**
 * FileLinkMenuItems.tsx — "show in file manager" / "copy file" / "download file" for a file link
 * in message content.
 *
 * Right-clicking a rendered file link opens the row's ordinary message menu; these items sit
 * directly under its "copy" entry and act on the file the gesture pointed at, rather than on the
 * message text. The target is resolved from the link's own marker (see
 * `lib/file-link-target.ts`), so a row containing several links answers for whichever one was hit.
 *
 * Why the items differ in availability:
 *  - download  — the bytes are served by the server to this browser, so it works whether NarraFork
 *                is reached on the server machine or across the network. The click opens a tab
 *                immediately, then that tab navigates to a short-lived ticket URL so the browser
 *                streams the file to disk (`lib/file-download.ts`). A mint failure closes the tab
 *                and shows a notification. A claim failure stays in the tab as HTML.
 *  - show in file manager / copy file — both act on the desktop of the machine running NarraFork
 *                (a file-manager window there, or its clipboard), which is why they are offered
 *                only when the browser is on that machine (`isLocalBrowserSession`). A page cannot
 *                copy a file itself: the clipboard API accepts only text/HTML/PNG. The file
 *                manager also needs an absolute path on a supported desktop, the same rule the
 *                file panels apply (`fileRevealDirectory`).
 *
 * All are hidden for a target on another device: that file is not on the server host, so none
 * of these actions could reach it. The file panels gate their own download the same way.
 */

import { usePlatform } from "@frontend/hooks/usePlatform";
import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { ApiError, api } from "@frontend/lib/api";
import {
	closeDownloadTab,
	navigateDownloadTab,
	openDownloadTab,
} from "@frontend/lib/file-download";
import { isLocalBrowserSession } from "@frontend/lib/local-origin";
import { fileRevealDirectory } from "@frontend/lib/reveal-directory";
import { Menu } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { FileTarget } from "@shared/file-reference";
import { IconClipboardCopy, IconDownload, IconFolder } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/** Basename without a path module: the server sends a name, this is only the fallback. */
function fileLinkBaseName(path: string): string {
	const name = path.split(/[\\/]/u).pop();
	return name && name.length > 0 ? name : "download";
}

export function FileLinkMenuItems({
	target,
	onClose,
}: {
	/** The file behind the right-click, or null when the gesture was not on a file link. */
	target: FileTarget | null;
	/** Closes the host menu once an action starts, like every other item it renders. */
	onClose: () => void;
}) {
	const { t: tNarrator } = useTranslation("narrator");
	const { data: userPrefs } = useUserPreferences();
	const platform = usePlatform();

	if (!target || target.deviceId !== "local") return null;

	const localBrowser = isLocalBrowserSession(userPrefs?.treatAsLocalAccess);
	// Same gate as the file panels; the server then selects the file itself, not just its folder.
	const canReveal =
		fileRevealDirectory(target.path, target.deviceId, platform, localBrowser) !== null;

	const revealFile = async () => {
		try {
			await api.fsReveal(target.path);
		} catch (error) {
			notifications.show({
				color: "red",
				title: tNarrator("contextMenu_revealFileFailed"),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const copyFile = async () => {
		try {
			await api.fsCopyFileToClipboard(target.path);
			notifications.show({
				color: "teal",
				message: tNarrator("contextMenu_copyFileDone", { name: fileLinkBaseName(target.path) }),
			});
		} catch (error) {
			notifications.show({
				color: "red",
				title: tNarrator("contextMenu_copyFileFailed"),
				message:
					error instanceof ApiError && error.status === 403
						? tNarrator("contextMenu_copyFileRemote")
						: error instanceof Error
							? error.message
							: String(error),
			});
		}
	};

	const downloadFile = async (tab: Window | null) => {
		if (!tab) {
			notifications.show({
				color: "red",
				title: tNarrator("fileViewer.downloadFailed"),
				message: tNarrator("contextMenu_downloadPopupBlocked"),
			});
			return;
		}
		try {
			// Validation (path refused, file gone, too large) happens while the session is
			// present, so those failures close the blank tab and show a notification. The tab
			// was opened in the click handler, before this await.
			const { ticket } = await api.fsDownloadTicket(target.path);
			navigateDownloadTab(tab, ticket);
		} catch (error) {
			closeDownloadTab(tab);
			notifications.show({
				color: "red",
				title: tNarrator("fileViewer.downloadFailed"),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return (
		<>
			{canReveal && (
				<Menu.Item
					leftSection={<IconFolder size={14} />}
					onClick={() => {
						onClose();
						void revealFile();
					}}
				>
					{tNarrator("contextMenu_revealFile")}
				</Menu.Item>
			)}
			{localBrowser && (
				<Menu.Item
					leftSection={<IconClipboardCopy size={14} />}
					onClick={() => {
						onClose();
						void copyFile();
					}}
				>
					{tNarrator("contextMenu_copyFile")}
				</Menu.Item>
			)}
			<Menu.Item
				leftSection={<IconDownload size={14} />}
				onClick={() => {
					// Open before any await. `onClose` may unmount this item; the tab handle
					// is already in the closure that continues the download.
					const tab = openDownloadTab();
					onClose();
					void downloadFile(tab);
				}}
			>
				{tNarrator("contextMenu_downloadFile")}
			</Menu.Item>
		</>
	);
}
