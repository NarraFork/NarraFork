import {
	ActionIcon,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	NavLink,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArrowUp,
	IconDeviceDesktop,
	IconEye,
	IconEyeOff,
	IconFolder,
	IconFolderOpen,
	IconFolderPlus,
	IconHome,
	IconPencil,
	IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { PathInput } from "./PathInput";

interface DirectoryPickerProps {
	value: string;
	onChange: (path: string) => void;
	label?: string;
	placeholder?: string;
	description?: string;
	required?: boolean;
	disabled?: boolean;
	/** Extra element rendered before the browse button in rightSection */
	rightSectionExtra?: React.ReactNode;
	leftSection?: React.ReactNode;
}

export function DirectoryPicker({
	value,
	onChange,
	label,
	placeholder,
	description,
	required,
	disabled,
	rightSectionExtra,
	leftSection,
}: DirectoryPickerProps) {
	const { t } = useTranslation("common");
	const [opened, { open, close }] = useDisclosure(false);
	const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);

	const handleOpen = () => {
		setBrowsePath(value || undefined);
		open();
	};

	const handleSelect = (path: string) => {
		onChange(path);
		close();
	};

	const rightContent = rightSectionExtra ? (
		<Group gap={2} wrap="nowrap">
			{rightSectionExtra}
			<ActionIcon
				variant="subtle"
				onClick={handleOpen}
				aria-label={t("browse")}
				disabled={disabled}
			>
				<IconFolderOpen size={18} />
			</ActionIcon>
		</Group>
	) : (
		<ActionIcon variant="subtle" onClick={handleOpen} aria-label={t("browse")} disabled={disabled}>
			<IconFolderOpen size={18} />
		</ActionIcon>
	);

	return (
		<>
			<PathInput
				label={label}
				placeholder={placeholder}
				description={description}
				required={required}
				disabled={disabled}
				value={value}
				onChange={onChange}
				leftSection={leftSection}
				rightSection={rightContent}
				rightSectionWidth={rightSectionExtra ? 64 : undefined}
			/>
			<Modal
				opened={opened}
				onClose={close}
				title={t("selectDirectory")}
				size="lg"
				styles={{ body: { padding: 0 } }}
			>
				<DirectoryBrowser initialPath={browsePath} onSelect={handleSelect} onCancel={close} />
			</Modal>
		</>
	);
}

// ── Directory Browser (modal content) ────────────────────────────────────────

interface DirectoryBrowserProps {
	initialPath?: string;
	onSelect: (path: string) => void;
	onCancel: () => void;
}

export function DirectoryBrowser({ initialPath, onSelect, onCancel }: DirectoryBrowserProps) {
	const { t } = useTranslation("common");
	const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const newFolderInputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	// Editable path bar state
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	// Shortcuts
	const { data: shortcutsData } = useQuery({
		queryKey: ["fs-shortcuts"],
		queryFn: () => api.fsShortcuts(),
		staleTime: 60_000,
	});

	const { data, isLoading, error } = useQuery({
		queryKey: ["fs-browse", currentPath, showHidden],
		queryFn: () => api.fsBrowse(currentPath, { showHidden }),
	});

	const mkdirMutation = useMutation({
		mutationFn: ({ parent, name }: { parent: string; name: string }) => api.fsMkdir(parent, name),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: ["fs-browse", currentPath, showHidden] });
			setCreatingFolder(false);
			setNewFolderName("");
			setCurrentPath(result.path);
		},
	});

	const hasDrives = (data?.drives?.length ?? 0) > 0;
	const isAtDriveRoot = !data?.path && hasDrives;

	const navigateTo = useCallback((path: string) => {
		setCurrentPath(path);
		setCreatingFolder(false);
		setEditing(false);
	}, []);

	const goUp = useCallback(() => {
		setCreatingFolder(false);
		setEditing(false);
		if (data?.parent) {
			setCurrentPath(data.parent);
		} else if (hasDrives) {
			setCurrentPath(undefined);
		}
	}, [data, hasDrives]);

	const goHome = useCallback(() => {
		setCurrentPath(undefined);
		setCreatingFolder(false);
		setEditing(false);
	}, []);

	const refreshCurrent = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["fs-browse", currentPath, showHidden] });
	}, [queryClient, currentPath, showHidden]);

	const startCreatingFolder = useCallback(() => {
		setNewFolderName("");
		mkdirMutation.reset();
		setCreatingFolder(true);
		setTimeout(() => newFolderInputRef.current?.focus(), 0);
	}, [mkdirMutation]);

	const submitNewFolder = useCallback(() => {
		const name = newFolderName.trim();
		if (!name || !data?.path) return;
		mkdirMutation.mutate({ parent: data.path, name });
	}, [newFolderName, data?.path, mkdirMutation]);

	// Start editing the path bar
	const startEditing = useCallback(() => {
		setEditValue(data?.path ?? "");
		setEditing(true);
		setTimeout(() => {
			editInputRef.current?.focus();
			editInputRef.current?.select();
		}, 0);
	}, [data?.path]);

	// Commit the edited path
	const commitEdit = useCallback(() => {
		const v = editValue.trim();
		if (v) {
			setCurrentPath(v);
		}
		setEditing(false);
	}, [editValue]);

	const cancelEdit = useCallback(() => {
		setEditing(false);
	}, []);

	// Shortcut label mapping
	const shortcutLabel = useCallback(
		(key: string) => {
			const map: Record<string, string> = {
				home: t("homeDirectory"),
				desktop: t("desktop"),
				documents: t("documents"),
				downloads: t("downloads"),
				root: t("rootDirectory"),
			};
			return map[key] || key;
		},
		[t],
	);

	const shortcutIcon = useCallback((key: string) => {
		switch (key) {
			case "home":
				return <IconHome size={16} />;
			case "desktop":
				return <IconDeviceDesktop size={16} />;
			default:
				return <IconFolder size={16} />;
		}
	}, []);

	// Double-click on entry to select it directly
	const handleEntryDoubleClick = useCallback(
		(entryPath: string) => {
			onSelect(entryPath);
		},
		[onSelect],
	);

	return (
		<Stack gap={0}>
			{/* ── Toolbar ── */}
			<Group gap={4} px="sm" py={6} wrap="nowrap">
				<Tooltip label={t("homeDirectory")} openDelay={400}>
					<ActionIcon variant="subtle" size="sm" onClick={goHome}>
						<IconHome size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("goUp")} openDelay={400}>
					<ActionIcon variant="subtle" size="sm" onClick={goUp} disabled={isAtDriveRoot}>
						<IconArrowUp size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("refresh")} openDelay={400}>
					<ActionIcon variant="subtle" size="sm" onClick={refreshCurrent}>
						<IconRefresh size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("newFolder")} openDelay={400}>
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={startCreatingFolder}
						disabled={!data?.path}
					>
						<IconFolderPlus size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={showHidden ? t("hideHiddenDirs") : t("showHiddenDirs")} openDelay={400}>
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={() => setShowHidden((v) => !v)}
						color={showHidden ? "indigo" : undefined}
					>
						{showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
					</ActionIcon>
				</Tooltip>
			</Group>

			<Divider />

			{/* ── Path bar ── */}
			<Group gap={4} px="sm" py={6} wrap="nowrap">
				{editing ? (
					<TextInput
						ref={editInputRef}
						size="xs"
						value={editValue}
						onChange={(e) => setEditValue(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitEdit();
							if (e.key === "Escape") cancelEdit();
						}}
						onBlur={commitEdit}
						placeholder={t("pathBarPlaceholder")}
						style={{ flex: 1 }}
						styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
					/>
				) : (
					<UnstyledButton
						onClick={startEditing}
						style={{
							flex: 1,
							fontFamily: "monospace",
							fontSize: 12,
							padding: "4px 8px",
							borderRadius: 4,
							border: "1px solid var(--mantine-color-dark-4)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							minHeight: 30,
							display: "flex",
							alignItems: "center",
						}}
					>
						{data?.path || (isAtDriveRoot ? t("computer") : "~")}
					</UnstyledButton>
				)}
				{!editing && (
					<Tooltip label={t("editPath")} openDelay={400}>
						<ActionIcon variant="subtle" size="sm" onClick={startEditing}>
							<IconPencil size={14} />
						</ActionIcon>
					</Tooltip>
				)}
			</Group>

			<Divider />

			{/* ── Main content: shortcuts sidebar + directory listing ── */}
			<Group gap={0} wrap="nowrap" align="stretch" style={{ minHeight: 350 }}>
				{/* Shortcuts sidebar */}
				<Box
					style={{
						width: 140,
						flexShrink: 0,
						borderRight: "1px solid var(--mantine-color-dark-4)",
					}}
				>
					<Text size="xs" fw={600} c="dimmed" px="xs" py={6}>
						{t("quickAccess")}
					</Text>
					<Stack gap={0}>
						{shortcutsData?.shortcuts.map((s) => (
							<NavLink
								key={s.key}
								label={shortcutLabel(s.key)}
								leftSection={shortcutIcon(s.key)}
								active={data?.path === s.path}
								onClick={() => navigateTo(s.path)}
								py={4}
								styles={{
									label: { fontSize: 12 },
									root: { borderRadius: 0 },
								}}
							/>
						))}
						{/* Windows drives */}
						{shortcutsData?.drives?.map((drive) => (
							<NavLink
								key={drive.path}
								label={drive.name}
								leftSection={<IconDeviceDesktop size={16} />}
								active={data?.path?.startsWith(drive.path)}
								onClick={() => navigateTo(drive.path)}
								py={4}
								styles={{
									label: { fontSize: 12 },
									root: { borderRadius: 0 },
								}}
							/>
						))}
					</Stack>
				</Box>

				{/* Directory listing */}
				<ScrollArea style={{ flex: 1 }} h={350} type="auto" offsetScrollbars>
					{isLoading && <Loader size="sm" m="auto" display="block" mt="xl" />}
					{error && (
						<Text c="red" size="sm" ta="center" mt="xl" px="sm">
							{(error as Error).message}
						</Text>
					)}
					{data && (
						<Stack gap={0}>
							{/* Drive letters (Windows) — shown in main area when at drive root */}
							{isAtDriveRoot && hasDrives && (
								<>
									<Group gap="xs" px="sm" py={4} wrap="wrap">
										{data.drives?.map((drive) => (
											<Button
												key={drive.path}
												variant="subtle"
												size="compact-sm"
												leftSection={<IconDeviceDesktop size={14} />}
												onClick={() => navigateTo(drive.path)}
											>
												{drive.name}
											</Button>
										))}
									</Group>
									<Divider />
								</>
							)}
							{/* Subdirectories */}
							{data.entries.map((entry) => (
								<UnstyledButton
									key={entry.path}
									onClick={() => navigateTo(entry.path)}
									onDoubleClick={() => handleEntryDoubleClick(entry.path)}
									px="sm"
									py={5}
									className="dir-entry"
									style={{ borderRadius: 0 }}
								>
									<Group gap="xs" wrap="nowrap">
										<IconFolder
											size={16}
											style={{
												flexShrink: 0,
												opacity: entry.name.startsWith(".") ? 0.5 : 0.8,
											}}
										/>
										<Text size="sm" truncate c={entry.name.startsWith(".") ? "dimmed" : undefined}>
											{entry.name}
										</Text>
									</Group>
								</UnstyledButton>
							))}
							{/* Inline new folder input */}
							{creatingFolder && data.path && (
								<Group gap="xs" px="sm" py={4} wrap="nowrap">
									<IconFolder size={16} style={{ flexShrink: 0 }} />
									<TextInput
										ref={newFolderInputRef}
										size="xs"
										placeholder={t("newFolderPlaceholder")}
										value={newFolderName}
										onChange={(e) => {
											setNewFolderName(e.currentTarget.value);
											mkdirMutation.reset();
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") submitNewFolder();
											if (e.key === "Escape") setCreatingFolder(false);
										}}
										error={mkdirMutation.error?.message}
										style={{ flex: 1 }}
										disabled={mkdirMutation.isPending}
									/>
									<Button
										size="compact-xs"
										onClick={submitNewFolder}
										disabled={!newFolderName.trim()}
										loading={mkdirMutation.isPending}
									>
										{t("create")}
									</Button>
								</Group>
							)}
							{data.path && !data.entries.length && !creatingFolder && (
								<Text c="dimmed" size="sm" ta="center" mt="xl">
									{t("emptyDirectory")}
								</Text>
							)}
						</Stack>
					)}
				</ScrollArea>
			</Group>

			<Divider />

			{/* ── Bottom bar ── */}
			<Group justify="space-between" px="sm" py={8}>
				<Text size="xs" c="dimmed" truncate style={{ flex: 1 }} ff="monospace">
					{data?.path}
				</Text>
				<Group gap="xs">
					<Button variant="default" size="sm" onClick={onCancel}>
						{t("cancel")}
					</Button>
					<Button
						size="sm"
						onClick={() => data?.path && onSelect(data.path)}
						disabled={!data?.path}
					>
						{t("selectThisDirectory")}
					</Button>
				</Group>
			</Group>
		</Stack>
	);
}
