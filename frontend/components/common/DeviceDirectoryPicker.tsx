import { Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { lazy, type ReactNode, Suspense } from "react";
import { Z } from "../../lib/z-index";
import type { RemoteDirectoryLister } from "../permissions/RemoteDirectoryBrowser";
import { LOCAL_DEVICE } from "./device-directory-options";
import { DIRECTORY_BROWSER_MODAL_STYLES } from "./directory-browser-modal";

/**
 * Device-aware directory selection, shared by every picker that can target more than
 * this server.
 *
 * The two browsers stay separate components on purpose: the local one browses this
 * server's filesystem (shortcuts, favorites, drives, mkdir) through `api.fs*`, while a
 * remote device's own filesystem is reached through a caller-supplied listing function
 * and has none of those capabilities. What WAS duplicated across five hosts is the layer
 * above them — the local/remote branch, the modal shell and the lazy loading — so that is
 * what lives here. The device option list lives in `device-directory-options`.
 */

// Lazy on purpose: the local browser pulls in favorites/dnd/drive listing, and a host
// only ever shows one of the two.
const DirectoryBrowser = lazy(() =>
	import("./DirectoryPicker").then((module) => ({ default: module.DirectoryBrowser })),
);
const RemoteDirectoryBrowser = lazy(() =>
	import("../permissions/RemoteDirectoryBrowser").then((module) => ({
		default: module.RemoteDirectoryBrowser,
	})),
);

export interface DeviceDirectoryBrowserProps {
	/** `LOCAL_DEVICE`, or the id of an execution device. */
	deviceId: string;
	/** Shown in the remote browser's own header; falls back to the id. */
	deviceLabel?: string;
	initialPath?: string;
	/** Local browser only: select a parent plus an uncreated leaf. */
	mode?: "existing" | "newTarget";
	/**
	 * Remote devices only; the local browser reads this server's filesystem itself.
	 * A remote id without a lister renders nothing — every caller gates on having one.
	 */
	listDirectory?: RemoteDirectoryLister;
	/** Cache-key prefix identifying the device being browsed (remote only). */
	queryKey?: readonly unknown[];
	onSelect: (path: string) => void;
	onCancel: () => void;
	isWide?: boolean;
}

/**
 * The browser content for one device, without the modal around it.
 *
 * For hosts that are already a dialog (the device directory dialog) or whose modal holds
 * more than the browser.
 */
export function DeviceDirectoryBrowser({
	deviceId,
	deviceLabel,
	initialPath,
	mode,
	listDirectory,
	queryKey,
	onSelect,
	onCancel,
	isWide,
}: DeviceDirectoryBrowserProps) {
	if (deviceId === LOCAL_DEVICE) {
		return (
			<Suspense fallback={null}>
				<DirectoryBrowser
					mode={mode}
					initialPath={initialPath}
					onSelect={onSelect}
					onCancel={onCancel}
					isWide={isWide}
				/>
			</Suspense>
		);
	}
	if (!listDirectory) return null;
	return (
		<Suspense fallback={null}>
			{/* Keyed: the browser keeps its own current path, which is meaningless on the
			    device the user just switched away from. */}
			<RemoteDirectoryBrowser
				key={deviceId}
				deviceLabel={deviceLabel ?? deviceId}
				initialPath={initialPath}
				listDirectory={listDirectory}
				queryKey={queryKey ?? ["deviceDirectoryBrowse", deviceId]}
				onSelect={onSelect}
				onCancel={onCancel}
			/>
		</Suspense>
	);
}

/**
 * The device browser in the shared modal shell.
 *
 * Same sizing source as every other directory-browser host (see
 * `directory-browser-modal`): the height and the flex chain are what keep the listing
 * pane reaching the modal's bottom edge on a narrow viewport.
 */
export function DeviceDirectoryModal({
	opened,
	onClose,
	title,
	zIndex,
	...browser
}: DeviceDirectoryBrowserProps & {
	opened: boolean;
	onClose: () => void;
	title?: ReactNode;
	zIndex?: number;
}) {
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={title}
			size={isWide ? 880 : "md"}
			zIndex={zIndex ?? Z.modal}
			styles={DIRECTORY_BROWSER_MODAL_STYLES}
		>
			{opened ? <DeviceDirectoryBrowser {...browser} isWide={isWide} /> : null}
		</Modal>
	);
}
