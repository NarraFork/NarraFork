/**
 * ArchiveViewerContent.tsx — read-only browser for zip-family archives (.zip, .jar, …).
 *
 * Lists the central directory (`fileReferenceApi.archive`) and opens one entry at a
 * time (`fileReferenceApi.archiveEntry`). Both go through the editor's legacy panel
 * authorization on the server, so this view exists only for LOCAL, non-reference
 * files; FilePanelContent never routes anything else here.
 *
 * Entry names are labels, not paths: they are split on "/" for the tree and sent
 * back verbatim, never joined onto a filesystem path. Text arrives decoded and capped
 * by the server (1 MiB); binary entries arrive as a size only.
 */

import { useClipboard } from "@frontend/hooks/useClipboard";
import {
	ActionIcon,
	Box,
	Center,
	Group,
	Loader,
	type RenderTreeNodePayload,
	Stack,
	Text,
	Tooltip,
	Tree,
	type TreeNodeData,
	useTree,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconDownload,
	IconEyeOff,
	IconLock,
	IconRefresh,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMobileViewport } from "../../../hooks/useMobileViewport";
import { ApiError, api } from "../../../lib/api";
import {
	type ArchiveEntryInfo,
	type ArchiveEntryRead,
	type ArchiveListing,
	fileReferenceApi,
} from "../../../lib/api/file-references";
import { saveBlobAsFile } from "../../../lib/file-download";
import { TruncatedText } from "../../common/TruncatedText";
import { MonacoEditor } from "../file-editor/MonacoEditor";
import { filePanelSizeLabel } from "../file-panel/LargeFileGate";
import { FileTreeIcon } from "../file-tree/file-icons";
import { archiveExtension } from "./archive-viewable";
import { fileBaseName, HEADER_FIXED_STYLE, HEADER_FLEXIBLE_STYLE } from "./FileViewerContent";

/** Java packages open on their manifest: the usual first question about a jar. */
const MANIFEST_ENTRY = "META-INF/MANIFEST.MF";
const MANIFEST_FIRST = new Set(["jar", "war", "ear", "aar"]);

/** Same per-level cap as the workspace file tree, for the same reason: render cost. */
const MAX_NODES_PER_LEVEL = 1_000;
const TRUNCATED_PREFIX = "\u0000truncated:";

interface ArchiveNodeProps {
	entry?: ArchiveEntryInfo;
	/** Synthetic folder for a path prefix that has no entry of its own. */
	folder?: boolean;
	truncatedCount?: number;
}

/** Turn flat raw names into tree levels; folders implied by a prefix are synthesized. */
export function buildArchiveTree(entries: readonly ArchiveEntryInfo[]): TreeNodeData[] {
	interface Level {
		children: Map<string, { node: TreeNodeData; level?: Level }>;
	}
	const root: Level = { children: new Map() };
	for (const entry of entries) {
		const parts = entry.name.split("/").filter((part) => part.length > 0);
		if (parts.length === 0) continue;
		let level = root;
		let prefix = "";
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			prefix = prefix ? `${prefix}/${part}` : part;
			const leaf = index === parts.length - 1 && !entry.isDirectory;
			let slot = level.children.get(part);
			if (!slot) {
				slot = {
					node: {
						value: leaf ? entry.name : `${prefix}/`,
						label: part,
						nodeProps: (leaf ? { entry } : { folder: true }) satisfies ArchiveNodeProps,
					},
				};
				if (!leaf) slot.level = { children: new Map() };
				level.children.set(part, slot);
			} else if (!leaf && !slot.level) {
				// A file and a folder share a name: keep both, the folder second.
				const key = `${part}/`;
				slot = level.children.get(key) ?? {
					node: { value: `${prefix}/`, label: part, nodeProps: { folder: true } },
					level: { children: new Map() },
				};
				level.children.set(key, slot);
			}
			if (!leaf && slot.level) level = slot.level;
		}
	}
	const toNodes = (level: Level, parentKey: string): TreeNodeData[] => {
		const slots = [...level.children.values()].sort((a, b) => {
			const folderA = a.level ? 0 : 1;
			const folderB = b.level ? 0 : 1;
			return folderA - folderB || String(a.node.label).localeCompare(String(b.node.label));
		});
		const shown = slots
			.slice(0, MAX_NODES_PER_LEVEL)
			.map((slot) =>
				slot.level ? { ...slot.node, children: toNodes(slot.level, slot.node.value) } : slot.node,
			);
		const hidden = slots.length - shown.length;
		if (hidden > 0)
			shown.push({
				value: `${TRUNCATED_PREFIX}${parentKey}`,
				label: String(hidden),
				nodeProps: { truncatedCount: hidden } satisfies ArchiveNodeProps,
			});
		return shown;
	};
	return toNodes(root, "");
}

function errorMessage(error: unknown, t: (key: string) => string): string {
	if (error instanceof ApiError) {
		const code = error.data?.code;
		if (code === "ARCHIVE_UNREADABLE") return t("archiveViewer.unreadable");
		if (code === "ARCHIVE_TOO_MANY_ENTRIES") return t("archiveViewer.tooManyEntries");
		if (code === "ARCHIVE_ENTRY_TOO_LARGE") return t("archiveViewer.entryTooLarge");
		if (code === "ARCHIVE_ENTRY_UNREADABLE") return t("archiveViewer.entryUnsupported");
	}
	return error instanceof Error ? error.message : String(error);
}

type EntryState =
	| { status: "idle" }
	| { status: "loading"; name: string }
	| { status: "error"; name: string; message: string }
	| { status: "loaded"; read: ArchiveEntryRead };

export function ArchiveViewerContent({
	filePath,
	narratorId,
	referenceOrigin = false,
}: {
	filePath: string;
	narratorId: string;
	/** A file a chat message linked to: the server applies the reference read policy. */
	referenceOrigin?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const tRef = useRef(t);
	tRef.current = t;
	const isMobile = useMobileViewport();
	const clipboard = useClipboard({ timeout: 1500 });
	const [reloadToken, setReloadToken] = useState(0);
	const [listing, setListing] = useState<ArchiveListing | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [entry, setEntry] = useState<EntryState>({ status: "idle" });
	const [downloading, setDownloading] = useState(false);
	const tree = useTree({ multiple: false });

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the intentional re-fetch trigger
	useEffect(() => {
		const controller = new AbortController();
		setListing(null);
		setListError(null);
		setSelected(null);
		setEntry({ status: "idle" });
		fileReferenceApi
			.archive(narratorId, filePath, referenceOrigin, controller.signal)
			.then((value) => {
				if (controller.signal.aborted) return;
				setListing(value);
				if (MANIFEST_FIRST.has(archiveExtension(filePath))) {
					const manifest = value.entries.find((item) => item.name === MANIFEST_ENTRY);
					if (manifest?.readable) setSelected(manifest.name);
				}
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setListError(errorMessage(error, tRef.current));
			});
		return () => controller.abort();
	}, [narratorId, filePath, reloadToken, referenceOrigin]);

	useEffect(() => {
		if (!selected) return;
		const controller = new AbortController();
		setEntry({ status: "loading", name: selected });
		fileReferenceApi
			.archiveEntry(narratorId, filePath, selected, referenceOrigin, controller.signal)
			.then((read) => {
				if (!controller.signal.aborted) setEntry({ status: "loaded", read });
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted)
					setEntry({ status: "error", name: selected, message: errorMessage(error, tRef.current) });
			});
		return () => controller.abort();
	}, [narratorId, filePath, selected, referenceOrigin]);

	const data = useMemo(() => (listing ? buildArchiveTree(listing.entries) : []), [listing]);
	const fileCount = useMemo(
		() => listing?.entries.filter((item) => !item.isDirectory).length ?? 0,
		[listing],
	);

	// Reveal the manifest's folder once per listing, when it was auto-selected. `tree` changes
	// identity with its expanded state, so it must not be a trigger: the user may collapse it.
	const revealedRef = useRef<ArchiveListing | null>(null);
	const expand = tree.expand;
	useEffect(() => {
		if (selected !== MANIFEST_ENTRY || !listing || revealedRef.current === listing) return;
		revealedRef.current = listing;
		expand("META-INF/");
	}, [selected, listing, expand]);

	const download = useCallback(async () => {
		setDownloading(true);
		try {
			const { blob, fileName: served } = await api.fsDownload(filePath);
			saveBlobAsFile(blob, served ?? fileBaseName(filePath));
		} catch (error) {
			notifications.show({
				color: "red",
				title: tRef.current("fileViewer.downloadFailed"),
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setDownloading(false);
		}
	}, [filePath]);

	const renderNode = useCallback(
		({ node, expanded, elementProps, tree: payloadTree }: RenderTreeNodePayload) => {
			const props = node.nodeProps as ArchiveNodeProps | undefined;
			if (props?.truncatedCount != null)
				return (
					<Group {...elementProps} gap={6} wrap="nowrap" style={{ cursor: "default" }}>
						<IconEyeOff size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
						<Text size="xs" c="dimmed" fs="italic">
							{t("fileTree.truncated", { count: props.truncatedCount })}
						</Text>
					</Group>
				);
			const item = props?.entry;
			const isFolder = !item;
			const name = String(node.label);
			return (
				<Group
					{...elementProps}
					gap={6}
					wrap="nowrap"
					onClick={() =>
						isFolder ? payloadTree.toggleExpanded(node.value) : setSelected(item.name)
					}
					style={{
						...elementProps.style,
						cursor: "pointer",
						background:
							item && item.name === selected ? "var(--mantine-color-default-hover)" : undefined,
					}}
				>
					{isFolder ? (
						<>
							{expanded ? (
								<IconChevronDown size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
							) : (
								<IconChevronRight size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
							)}
							<FileTreeIcon name={name} isDirectory expanded={expanded} />
						</>
					) : (
						<>
							<Box style={{ width: 14, flexShrink: 0 }} />
							<FileTreeIcon name={name} isDirectory={false} />
						</>
					)}
					<Text
						size="sm"
						truncate
						c={item && !item.readable ? "dimmed" : undefined}
						style={{ flex: 1, minWidth: 0 }}
					>
						{name}
					</Text>
					{item?.encrypted && <IconLock size={12} style={{ flexShrink: 0, opacity: 0.6 }} />}
					{item && (
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{filePanelSizeLabel(item.uncompressedSize)}
						</Text>
					)}
				</Group>
			);
		},
		[selected, t],
	);

	const header = (
		<Group gap={6} px="xs" py={4} wrap="nowrap" style={{ flexShrink: 0 }}>
			<TruncatedText
				text={filePath}
				tooltipLabel={filePath}
				size="xs"
				fw={600}
				style={HEADER_FLEXIBLE_STYLE}
			/>
			{listing && (
				<Text size="xs" c="dimmed" style={HEADER_FIXED_STYLE}>
					{t("archiveViewer.summary", {
						count: fileCount,
						size: filePanelSizeLabel(listing.size),
					})}
				</Text>
			)}
			<Group gap={2} wrap="nowrap" style={HEADER_FIXED_STYLE}>
				<Tooltip label={t("contextMenu_copyFilePath")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("contextMenu_copyFilePath")}
						onClick={() => clipboard.copy(filePath)}
					>
						{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("fileViewer.download")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("fileViewer.download")}
						loading={downloading}
						onClick={download}
					>
						<IconDownload size={14} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("fileViewer.reload")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("fileViewer.reload")}
						onClick={() => setReloadToken((value) => value + 1)}
					>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
		</Group>
	);

	const selectedInfo = selected ? listing?.entries.find((item) => item.name === selected) : null;
	const entryPane = !selected ? (
		<Center h="100%" p="md">
			<Text size="sm" c="dimmed" ta="center">
				{t("archiveViewer.selectEntry")}
			</Text>
		</Center>
	) : selectedInfo && !selectedInfo.readable ? (
		<Center h="100%" p="md">
			<Text size="sm" c="dimmed" ta="center">
				{t(
					selectedInfo.encrypted
						? "archiveViewer.entryEncrypted"
						: "archiveViewer.entryUnsupported",
				)}
			</Text>
		</Center>
	) : entry.status === "loading" || entry.status === "idle" ? (
		<Center h="100%">
			<Loader size="sm" />
		</Center>
	) : entry.status === "error" ? (
		<Center h="100%" p="md">
			<Text size="sm" c="red" ta="center">
				{entry.message}
			</Text>
		</Center>
	) : entry.read.kind === "binary" ? (
		<Center h="100%" p="md">
			<Stack align="center" gap={4}>
				<Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
					{entry.read.name}
				</Text>
				<Text size="sm" c="dimmed" ta="center">
					{t("archiveViewer.binaryEntry", { size: filePanelSizeLabel(entry.read.size) })}
				</Text>
			</Stack>
		</Center>
	) : (
		<MonacoEditor
			key={entry.read.name}
			initialValue={entry.read.content}
			documentKey={JSON.stringify(["archive-entry", narratorId, filePath, entry.read.name])}
			filePath={entry.read.name}
			readOnly
		/>
	);

	const body = listError ? (
		<Center h="100%" p="md">
			<Stack align="center" gap="xs">
				<Text size="sm" c="red" ta="center">
					{listError}
				</Text>
				<ActionIcon
					variant="subtle"
					size="sm"
					aria-label={t("fileTree.retry")}
					onClick={() => setReloadToken((value) => value + 1)}
				>
					<IconRefresh size={14} />
				</ActionIcon>
			</Stack>
		</Center>
	) : !listing ? (
		<Center h="100%">
			<Loader size="sm" />
		</Center>
	) : (
		<Box
			style={{
				flex: 1,
				minHeight: 0,
				display: "flex",
				flexDirection: isMobile ? "column" : "row",
			}}
		>
			<Box
				p="xs"
				style={{
					overflow: "auto",
					flexShrink: 0,
					...(isMobile
						? { maxHeight: "40%", borderBottom: "1px solid var(--mantine-color-default-border)" }
						: {
								width: "clamp(200px, 35%, 420px)",
								borderRight: "1px solid var(--mantine-color-default-border)",
							}),
				}}
			>
				{data.length === 0 ? (
					<Text size="sm" c="dimmed" ta="center" py="lg">
						{t("archiveViewer.empty")}
					</Text>
				) : (
					<Tree
						data={data}
						tree={tree}
						levelOffset="md"
						expandOnClick={false}
						selectOnClick={false}
						withLines
						renderNode={renderNode}
					/>
				)}
			</Box>
			<Box style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{entryPane}</Box>
		</Box>
	);

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			{header}
			{body}
		</Box>
	);
}
