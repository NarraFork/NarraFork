import {
	ActionIcon,
	Alert,
	Button,
	Code,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Switch,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconArrowUp,
	IconFolder,
	IconFolderSymlink,
	IconRefresh,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteDirectoryListing } from "../../lib/api/devices";
import { DIRECTORY_BROWSER_ROOT_STYLE } from "../common/directory-browser-modal";
import { useDirectoryTypeahead } from "../common/useDirectoryTypeahead";

/** Fetches one level of a remote directory; see RemotePathInput for rationale. */
export type RemoteDirectoryLister = (
	path: string | undefined,
	opts: { showHidden: boolean },
) => Promise<RemoteDirectoryListing>;

/**
 * Directory picker for a remote executor device.
 *
 * A separate component from the local `DirectoryBrowser` because remote devices
 * have no favorites, shortcuts or drive enumeration to offer, and directory
 * creation is out of scope for permission rules. Navigation starts at the
 * device's default working directory when no initial path is given.
 */
export function RemoteDirectoryBrowser({
	deviceLabel,
	initialPath,
	listDirectory,
	queryKey,
	onSelect,
	onCancel,
}: {
	deviceLabel: string;
	initialPath?: string;
	listDirectory: RemoteDirectoryLister;
	/** Stable cache key identifying the device being browsed. */
	queryKey: readonly unknown[];
	onSelect: (path: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const queryClient = useQueryClient();
	const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
	const [showHidden, setShowHidden] = useState(false);

	const { data, isLoading, error } = useQuery({
		queryKey: [...queryKey, "browser", currentPath, showHidden],
		queryFn: () => listDirectory(currentPath, { showHidden }),
		gcTime: 30_000,
		retry: false,
	});

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: [...queryKey, "browser"] });
	}, [queryClient, queryKey]);

	const goUp = useCallback(() => {
		if (data?.parent) setCurrentPath(data.parent);
	}, [data?.parent]);

	const entries = useMemo(() => data?.entries ?? [], [data?.entries]);
	const names = useMemo(() => entries.map((entry) => entry.name), [entries]);
	// Rows are plain buttons, so the enclosing element is the keyboard surface:
	// arrows move the highlight and typing jumps it to a matching directory.
	const typeahead = useDirectoryTypeahead({
		names,
		onActivate: (index) => {
			const entry = entries[index];
			if (entry) setCurrentPath(entry.path);
		},
		resetKey: data?.path,
	});

	return (
		<Stack
			gap="xs"
			p="md"
			style={DIRECTORY_BROWSER_ROOT_STYLE}
			ref={typeahead.containerRef}
			onKeyDown={typeahead.onKeyDown}
			role="group"
			aria-label={tc("directoryList")}
			tabIndex={0}
		>
			<Group gap="xs" justify="space-between" wrap="nowrap">
				<Text size="xs" c="dimmed" truncate>
					{t("permissionBrowseDeviceTitle", { device: deviceLabel })}
				</Text>
				<Group gap={4} wrap="nowrap">
					<Switch
						size="xs"
						label={showHidden ? tc("hideHiddenDirs") : tc("showHiddenDirs")}
						checked={showHidden}
						onChange={(event) => setShowHidden(event.currentTarget.checked)}
					/>
					<Tooltip label={tc("refresh")}>
						<ActionIcon variant="subtle" size="sm" onClick={refresh} aria-label={tc("refresh")}>
							<IconRefresh size={15} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			<Group gap="xs" wrap="nowrap">
				<Tooltip label={tc("goUp")}>
					<ActionIcon
						variant="default"
						size="sm"
						onClick={goUp}
						disabled={!data?.parent}
						aria-label={tc("goUp")}
					>
						<IconArrowUp size={15} />
					</ActionIcon>
				</Tooltip>
				<Code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
					{data?.path ?? currentPath ?? "…"}
				</Code>
			</Group>

			{error && (
				<Alert color="red" variant="light" icon={<IconAlertTriangle size={15} />} p="xs">
					<Text size="xs">{error instanceof Error ? error.message : String(error)}</Text>
				</Alert>
			)}

			{/*
			 * Fills the space the header/path/footer rows leave, rather than autosizing to a
			 * fixed cap: the modal already bounds this browser, and a cap shorter than the
			 * available room leaves dead space below the last entry on a tall portrait screen.
			 */}
			<ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
				{isLoading ? (
					<Group justify="center" p="md">
						<Loader size="sm" />
					</Group>
				) : (
					<Stack gap={2}>
						{(data?.entries.length ?? 0) === 0 && !error && (
							<Text size="xs" c="dimmed" p="xs">
								{t("permissionBrowseNoSubdirectories")}
							</Text>
						)}
						{data?.entries.map((entry, index) => {
							const EntryIcon = entry.isSymlink ? IconFolderSymlink : IconFolder;
							const active = index === typeahead.cursorIndex;
							return (
								<UnstyledButton
									key={entry.path}
									onClick={() => setCurrentPath(entry.path)}
									p={6}
									data-dir-index={index}
									data-cursor={active ? "true" : undefined}
									style={{
										borderRadius: 4,
										background: active ? "var(--mantine-color-default-hover)" : undefined,
									}}
									title={entry.isSymlink ? tc("symlinkDirectory") : undefined}
								>
									<Group gap={8} wrap="nowrap">
										<EntryIcon size={15} style={{ flexShrink: 0, opacity: 0.6 }} />
										<Text size="xs" truncate>
											{entry.name}
										</Text>
									</Group>
								</UnstyledButton>
							);
						})}
						{data?.truncated && (
							<Text size="xs" c="dimmed" p="xs">
								{t("permissionBrowseTruncated")}
							</Text>
						)}
					</Stack>
				)}
			</ScrollArea>

			<Group justify="flex-end" gap="xs">
				<Button size="xs" variant="default" onClick={onCancel}>
					{tc("cancel")}
				</Button>
				<Button size="xs" disabled={!data?.path} onClick={() => data?.path && onSelect(data.path)}>
					{tc("selectThisDirectory")}
				</Button>
			</Group>
		</Stack>
	);
}
