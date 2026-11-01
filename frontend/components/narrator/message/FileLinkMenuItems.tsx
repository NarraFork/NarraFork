/**
 * FileLinkMenuItems.tsx — "copy file" / "download file" for a file link in message content.
 *
 * Right-clicking a rendered file link opens the row's ordinary message menu; these two items sit
 * directly under its "copy" entry and act on the file the gesture pointed at, rather than on the
 * message text. The target is resolved from the link's own marker (see
 * `lib/file-link-target.ts`), so a row containing several links answers for whichever one was hit.
 *
 * Why the two items differ in availability:
 *  - download  — the bytes are served by the server to this browser, so it works whether NarraFork
 *                is reached on the server machine or across the network. It downloads through a
 *                single-use ticket so the browser can stream the file to disk itself, rather than
 *                the page buffering the whole file first (`lib/file-download.ts`).
 *  - copy file — the file is placed on the clipboard of the machine running NarraFork, which is
 *                why it is offered only when the browser is on that machine
 *                (`isLocalBrowserSession`). A page cannot do this itself: the clipboard API accepts
 *                only text/HTML/PNG, never an arbitrary file.
 *
 * Both are hidden for a target on another device: that file is not on the server host, so neither
 * action could reach it. The file panels gate their own download the same way.
 */

import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { api } from "@frontend/lib/api";
import { fsDownloadUrl } from "@frontend/lib/file-download";
import { isLocalBrowserSession } from "@frontend/lib/local-origin";
import { Menu } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { FileTarget } from "@shared/file-reference";
import { IconClipboardCopy, IconDownload } from "@tabler/icons-react";
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

	if (!target || target.deviceId !== "local") return null;

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
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const downloadFile = async () => {
		try {
			// Ask for a single-use ticket first: the validation (path refused, file gone, too
			// large) happens while the session is present, so the failures a user can actually
			// act on arrive as notifications instead of a browser error page.
			const { ticket } = await api.fsDownloadTicket(target.path);
			// The navigation IS the download: the browser streams it to disk, so this page
			// never holds the bytes and stays put while the file saves.
			fsDownloadUrl(ticket, fileLinkBaseName(target.path));
		} catch (error) {
			notifications.show({
				color: "red",
				title: tNarrator("fileViewer.downloadFailed"),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return (
		<>
			{isLocalBrowserSession(userPrefs?.treatAsLocalAccess) && (
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
					onClose();
					void downloadFile();
				}}
			>
				{tNarrator("contextMenu_downloadFile")}
			</Menu.Item>
		</>
	);
}
