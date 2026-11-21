/**
 * FileContextMenu.tsx — the file tree's right-click menu for one file row.
 *
 * ## What belongs here
 *
 * Only what the tree can actually do, and each entry appears only when its precondition
 * holds. Opening a file is not one of them: the row's own click already opens it.
 *
 *  - **reference** — needs a composer in scope for THIS narrator. The scope comes from
 *    `FileReferenceScope` (`addFileReference` on the dock), so a tree torn into its own
 *    window has no composer to reference into and shows no such entry rather than a dead
 *    one.
 *  - **reveal** — acts on the desktop of the machine running NarraFork, so it appears only
 *    for a browser on that machine (the same `isLocalBrowserSession` +
 *    `fileRevealDirectory` gate `FileLinkMenuItems` uses).
 *  - **copy** — fills the tree's clipboard AND, when the browser is on the server's
 *    machine, the OS clipboard too. They are one entry because they are one intention
 *    ("take this file"); two entries only made the user guess which clipboard a later paste
 *    would read. The OS half is best-effort: a page cannot put a file on a clipboard at all
 *    (the server does it on its own desktop), so a failure there is reported without
 *    undoing the in-app copy.
 *  - **paste** — needs an entry in the tree's own clipboard from the same narrator: the
 *    paste target is bounded by that narrator's writable roots, so a cross-narrator paste
 *    could only fail. A taken destination asks before replacing it — see `paste`.
 *  - **cut** — always, because it only fills that clipboard.
 *
 * ## Why the menu does its own API calls
 *
 * `FileLinkMenuItems` set the precedent: an item that owns its request can report its own
 * failure where the user is looking. The only things the tree supplies are the row, the
 * callback that opens the rename dialog (which must outlive the menu) and the callback
 * that makes it re-read the directories the change touched.
 */

import { useConfirmDialog } from "@frontend/components/common/confirm-dialog-context";
import { usePlatform } from "@frontend/hooks/usePlatform";
import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { api } from "@frontend/lib/api";
import { isLocalBrowserSession } from "@frontend/lib/local-origin";
import { fileRevealDirectory } from "@frontend/lib/reveal-directory";
import { notifications } from "@mantine/notifications";
import {
	IconClipboardCopy,
	IconCopy,
	IconCut,
	IconFolder,
	IconPencil,
	IconTrash,
} from "@tabler/icons-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import { clearFileClipboard, setFileClipboard, useFileClipboard } from "./file-clipboard";
import {
	type FileMenuTarget,
	fileMenuDirectory,
	fileMenuRelativeDirectory,
} from "./file-menu-target";

/**
 * The HTTP status of an API failure, read from the error's own fields instead of with
 * `instanceof`.
 *
 * `ApiError` is a single class in the source, but a bundle can hold two copies of it — the
 * barrel re-export and the client module that throws — and `instanceof` then answers false
 * for a genuine 409. That failure mode is silent and expensive: the paste's "ask before
 * replacing" path would be skipped and the user would only see "Already exists", with no
 * way to confirm. Both fields are part of the error's public shape (`ApiError.status`,
 * `ApiError.data`), so reading them works whichever copy threw.
 */
export function apiFailureStatus(error: unknown): number | null {
	if (!error || typeof error !== "object") return null;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : null;
}

export interface FileContextMenuProps {
	x: number;
	y: number;
	target: FileMenuTarget;
	narratorId: string;
	/** Reference the file in the narrator's composer, when one is in scope. */
	onReference: (() => void) | null;
	/** Open the rename dialog. Owned by the tree so the dialog survives the menu. */
	onRename: (target: FileMenuTarget) => void;
	/** A mutation succeeded and this tree-relative directory must be re-read. */
	onChanged: (relativeDirectory: string) => void;
	onClose: () => void;
}

export function FileContextMenu({
	x,
	y,
	target,
	narratorId,
	onReference,
	onRename,
	onChanged,
	onClose,
}: FileContextMenuProps) {
	const { t } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const platform = usePlatform();
	const { data: userPrefs } = useUserPreferences();
	const localBrowser = isLocalBrowserSession(userPrefs?.treatAsLocalAccess);
	const clipboard = useFileClipboard();

	const directory = fileMenuDirectory(target.absolutePath);
	const relativeDirectory = fileMenuRelativeDirectory(target.relativePath);
	const canReveal =
		localBrowser &&
		fileRevealDirectory(target.absolutePath, "local", platform, localBrowser) !== null;
	// A paste from another narrator's clipboard could only be refused by the server.
	const canPaste = clipboard !== null && clipboard.narratorId === narratorId;

	const report = useCallback(
		(error: unknown, titleKey: string) => {
			notifications.show({
				color: "red",
				title: t(titleKey),
				message: error instanceof Error ? error.message : String(error),
			});
		},
		[t],
	);

	/**
	 * Fill the tree's clipboard, and — for a browser on the server's machine — the OS
	 * clipboard too.
	 *
	 * One entry, two destinations: the OS half is what makes the file pasteable into a file
	 * manager, and the in-app half is what "粘贴到此处" reads. The OS half is best-effort and
	 * never undoes the in-app one, because it can fail for reasons the user cannot fix from
	 * here (no wl-copy/xclip, a remote browser, a helper that refuses the path).
	 */
	const copyToTree = useCallback(
		async (mode: "copy" | "move") => {
			setFileClipboard({
				mode,
				path: target.absolutePath,
				name: target.name,
				narratorId,
				sourceDirectory: fileMenuRelativeDirectory(target.relativePath),
			});
			onClose();
			// A cut is a move inside the tree; putting it on the OS clipboard would invite a
			// file-manager paste that leaves the original in place.
			if (mode !== "copy" || !localBrowser) return;
			try {
				await api.fsCopyFileToClipboard(target.absolutePath);
				notifications.show({
					color: "teal",
					message: t("fileTree.copyToClipboardDone", { name: target.name }),
				});
			} catch (error) {
				report(
					apiFailureStatus(error) === 403 ? new Error(t("fileTree.copyToClipboardRemote")) : error,
					"fileTree.copyToClipboardFailed",
				);
			}
		},
		[
			localBrowser,
			narratorId,
			onClose,
			report,
			t,
			target.absolutePath,
			target.name,
			target.relativePath,
		],
	);

	/** One transfer attempt; `overwrite` is only ever true after the user confirmed. */
	const transfer = useCallback(
		async (
			entry: { path: string; mode: "copy" | "move"; sourceDirectory?: string },
			overwrite: boolean,
		) => {
			await api.fsTransferFile({
				narratorId,
				path: entry.path,
				targetDir: directory,
				mode: entry.mode,
				...(overwrite ? { overwrite: true } : {}),
			});
			// A cut is consumed by its paste; a copy stays so it can be pasted again.
			if (entry.mode === "move") clearFileClipboard();
			notifications.show({
				color: "teal",
				message: t("fileTree.pasteDone", {
					name: entry.path.split(/[\\/]/u).pop() ?? "",
				}),
			});
			onChanged(relativeDirectory);
			if (
				entry.mode === "move" &&
				entry.sourceDirectory !== undefined &&
				entry.sourceDirectory !== relativeDirectory
			) {
				onChanged(entry.sourceDirectory);
			}
		},
		[directory, narratorId, onChanged, relativeDirectory, t],
	);

	/**
	 * Paste, asking before it replaces anything.
	 *
	 * The destination name is always the source's own, so "already exists" is not an edge
	 * case but the normal result of pasting next to a file of the same name — reporting it
	 * as a failure would leave the user with no way forward. The server answers 409 first
	 * precisely so this dialog can name the file being replaced before the bytes are gone.
	 *
	 * Every taken destination reaches this dialog, including the file's own folder: pasting
	 * a file onto itself is a replacement the server performs as a no-op, which is what the
	 * user asked for by confirming, rather than a refusal that looks like a bug.
	 */
	const paste = useCallback(async () => {
		onClose();
		if (!canPaste || !clipboard) return;
		try {
			await transfer(clipboard, false);
			return;
		} catch (error) {
			if (apiFailureStatus(error) !== 409) {
				report(error, "fileTree.pasteFailed");
				return;
			}
		}
		const confirmed = await confirm({
			title: t("fileTree.pasteOverwriteTitle"),
			message: t("fileTree.pasteOverwriteMessage", { name: clipboard.name }),
			confirmLabel: t("fileTree.pasteOverwriteConfirm"),
			confirmColor: "red",
		});
		if (!confirmed) return;
		try {
			await transfer(clipboard, true);
		} catch (error) {
			// A separate title from `pasteFailed` on purpose: this one can only appear after
			// the user agreed to replace, so it says which step broke.
			report(error, "fileTree.pasteOverwriteFailed");
		}
	}, [canPaste, clipboard, confirm, onClose, report, t, transfer]);

	const remove = useCallback(async () => {
		onClose();
		// Nothing in the app can undo a delete, so the confirmation is not optional.
		const confirmed = await confirm({
			title: t("fileTree.deleteConfirmTitle"),
			message: t("fileTree.deleteConfirmMessage", { name: target.name }),
			confirmLabel: t("fileTree.menuDelete"),
			confirmColor: "red",
		});
		if (!confirmed) return;
		try {
			await api.fsDeleteFile({ narratorId, path: target.absolutePath });
			notifications.show({
				color: "teal",
				message: t("fileTree.deleteDone", { name: target.name }),
			});
			onChanged(relativeDirectory);
		} catch (error) {
			report(error, "fileTree.deleteFailed");
		}
	}, [
		confirm,
		narratorId,
		onChanged,
		onClose,
		relativeDirectory,
		report,
		t,
		target.absolutePath,
		target.name,
	]);

	const reveal = useCallback(async () => {
		onClose();
		try {
			await api.fsReveal(target.absolutePath);
		} catch (error) {
			report(error, "fileTree.revealFailed");
		}
	}, [onClose, report, target.absolutePath]);

	const items = useMemo<ContextMenuItem[]>(() => {
		const list: ContextMenuItem[] = [];
		if (onReference) {
			list.push({
				key: "reference",
				label: t("fileTree.menuReference"),
				icon: <IconClipboardCopy size={14} />,
				onSelect: () => {
					onClose();
					onReference();
				},
			});
		}
		list.push(
			{
				key: "copy",
				label: t("fileTree.menuCopy"),
				icon: <IconCopy size={14} />,
				dividerBefore: list.length > 0,
				onSelect: () => void copyToTree("copy"),
			},
			{
				key: "cut",
				label: t("fileTree.menuCut"),
				icon: <IconCut size={14} />,
				onSelect: () => void copyToTree("move"),
			},
			{
				key: "paste",
				label: canPaste
					? t("fileTree.menuPasteNamed", { name: clipboard?.name ?? "" })
					: t("fileTree.menuPaste"),
				icon: <IconFolder size={14} />,
				disabled: !canPaste,
				onSelect: () => void paste(),
			},
			{
				key: "rename",
				label: t("fileTree.menuRename"),
				icon: <IconPencil size={14} />,
				dividerBefore: true,
				onSelect: () => {
					onClose();
					onRename(target);
				},
			},
			{
				key: "delete",
				label: t("fileTree.menuDelete"),
				icon: <IconTrash size={14} />,
				color: "red",
				onSelect: () => void remove(),
			},
		);
		if (canReveal) {
			list.push({
				key: "reveal",
				label: t("fileTree.menuReveal"),
				icon: <IconFolder size={14} />,
				dividerBefore: true,
				onSelect: () => void reveal(),
			});
		}
		return list;
	}, [
		canPaste,
		canReveal,
		clipboard?.name,
		copyToTree,
		onClose,
		onReference,
		onRename,
		paste,
		remove,
		reveal,
		t,
		target,
	]);

	return (
		<ContextMenu
			x={x}
			y={y}
			items={items}
			onClose={onClose}
			ariaLabel={t("fileTree.menuLabel", { name: target.name })}
		/>
	);
}
