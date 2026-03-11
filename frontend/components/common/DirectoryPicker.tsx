import {
	ActionIcon,
	Breadcrumbs,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArrowUp,
	IconDeviceDesktop,
	IconFolder,
	IconFolderOpen,
	IconFolderPlus,
	IconPencil,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
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
			<Modal opened={opened} onClose={close} title={t("selectDirectory")} size="lg">
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
	const newFolderInputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	// Editable path bar state
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [filter, setFilter] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["fs-browse", currentPath],
		queryFn: () => api.fsBrowse(currentPath),
	});

	const mkdirMutation = useMutation({
		mutationFn: ({ parent, name }: { parent: string; name: string }) => api.fsMkdir(parent, name),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: ["fs-browse", currentPath] });
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
		setFilter("");
	}, []);

	// Go back to drive selection screen
	const goToDrives = useCallback(() => {
		setCurrentPath(undefined);
		setCreatingFolder(false);
		setEditing(false);
		setFilter("");
	}, []);

	const goUp = useCallback(() => {
		setCreatingFolder(false);
		setEditing(false);
		setFilter("");
		if (data?.parent) {
			setCurrentPath(data.parent);
		} else if (hasDrives) {
			setCurrentPath(undefined);
		}
	}, [data, hasDrives]);

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
		setFilter("");
		setEditing(true);
		setTimeout(() => {
			editInputRef.current?.focus();
			editInputRef.current?.select();
		}, 0);
	}, [data?.path]);

	// Commit the edited path — navigate to it
	const commitEdit = useCallback(() => {
		const v = editValue.trim();
		if (v) {
			setCurrentPath(v);
			setFilter("");
		}
		setEditing(false);
	}, [editValue]);

	// Cancel editing
	const cancelEdit = useCallback(() => {
		setEditing(false);
		setFilter("");
	}, []);

	// Derive the filter text from editValue vs currentPath
	// When user types in the edit bar, the part after the last separator is the filter
	useEffect(() => {
		if (!editing) return;
		const sep = data?.sep || "/";
		const base = data?.path ?? "";
		// Check if editValue is within the current directory (base + sep prefix or exact match)
		const baseWithSep = base.endsWith(sep) ? base : base + sep;
		if (base && (editValue === base || editValue.startsWith(baseWithSep))) {
			const tail = editValue.slice(base.length);
			// Remove leading separator
			const stripped = tail.startsWith(sep) ? tail.slice(sep.length) : tail;
			// If there's another separator, the user is typing a deeper path — navigate there
			if (stripped.includes(sep)) {
				const dirPart = editValue.slice(0, editValue.lastIndexOf(sep));
				if (dirPart && dirPart !== base) {
					setCurrentPath(dirPart);
					setFilter("");
					return;
				}
			}
			setFilter(stripped.toLowerCase());
		} else if (editValue && editValue !== base) {
			// User typed a completely different path — don't filter, just let them commit
			setFilter("");
		}
	}, [editValue, editing, data?.path, data?.sep]);

	// Build breadcrumb segments from current path
	const breadcrumbs = data?.path ? buildBreadcrumbs(data.path, data.sep) : [];

	// Filter entries when filter is active
	const filteredEntries =
		filter && data?.entries
			? data.entries.filter((e) => e.name.toLowerCase().includes(filter))
			: (data?.entries ?? []);

	return (
		<Stack gap="sm">
			{/* Breadcrumb / editable path bar */}
			<Group gap="xs" wrap="nowrap">
				<ActionIcon variant="subtle" onClick={goUp} disabled={isAtDriveRoot} aria-label={t("goUp")}>
					<IconArrowUp size={18} />
				</ActionIcon>
				<ActionIcon
					variant="subtle"
					onClick={startCreatingFolder}
					disabled={!data?.path}
					aria-label={t("newFolder")}
				>
					<IconFolderPlus size={18} />
				</ActionIcon>
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
						onBlur={cancelEdit}
						style={{ flex: 1 }}
						styles={{ input: { fontFamily: "monospace", fontSize: 13 } }}
					/>
				) : (
					<>
						<ScrollArea type="auto" style={{ flex: 1 }} offsetScrollbars={false}>
							<Breadcrumbs separator={data?.sep || "/"} styles={{ separator: { margin: "0 2px" } }}>
								{hasDrives && (
									<UnstyledButton
										onClick={goToDrives}
										fz="sm"
										fw={isAtDriveRoot ? 600 : undefined}
										style={{ whiteSpace: "nowrap" }}
									>
										<Group gap={4} wrap="nowrap">
											<IconDeviceDesktop size={14} />
											{t("computer")}
										</Group>
									</UnstyledButton>
								)}
								{breadcrumbs.map((seg) => (
									<UnstyledButton
										key={seg.path}
										onClick={() => navigateTo(seg.path)}
										fz="sm"
										style={{ whiteSpace: "nowrap" }}
									>
										{seg.name}
									</UnstyledButton>
								))}
							</Breadcrumbs>
						</ScrollArea>
						<ActionIcon variant="subtle" size="sm" onClick={startEditing} aria-label={t("edit")}>
							<IconPencil size={16} />
						</ActionIcon>
					</>
				)}
			</Group>

			{/* Filter indicator */}
			{editing && filter && (
				<Text size="xs" c="dimmed" px="sm">
					{t("filteringBy", { filter })}
				</Text>
			)}

			{/* Directory listing */}
			<ScrollArea h={350} type="auto" offsetScrollbars>
				{isLoading && <Loader size="sm" m="auto" display="block" mt="xl" />}
				{error && (
					<Text c="red" size="sm" ta="center" mt="xl">
						{(error as Error).message}
					</Text>
				)}
				{data && (
					<Stack gap={2}>
						{/* Drive letters (Windows) */}
						{hasDrives && (
							<>
								<Group gap="xs" px="sm" py={4} wrap="wrap">
									{data.drives?.map((drive) => (
										<Button
											key={drive.path}
											variant={data.path?.startsWith(drive.path) ? "light" : "subtle"}
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
						{filteredEntries.map((entry) => (
							<UnstyledButton
								key={entry.path}
								onClick={() => navigateTo(entry.path)}
								px="sm"
								py={6}
								style={{ borderRadius: 4 }}
								className="dir-entry"
							>
								<Group gap="xs" wrap="nowrap">
									<IconFolder size={18} style={{ flexShrink: 0 }} />
									<Text size="sm" truncate>
										{filter ? highlightMatch(entry.name, filter) : entry.name}
									</Text>
								</Group>
							</UnstyledButton>
						))}
						{/* Inline new folder input */}
						{creatingFolder && data.path && (
							<Group gap="xs" px="sm" py={4} wrap="nowrap">
								<IconFolder size={18} style={{ flexShrink: 0 }} />
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
						{data.path && !filteredEntries.length && !creatingFolder && (
							<Text c="dimmed" size="sm" ta="center" mt="xl">
								{filter ? t("noMatchingDirectories") : t("emptyDirectory")}
							</Text>
						)}
					</Stack>
				)}
			</ScrollArea>

			{/* Actions */}
			<Group justify="space-between">
				<Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Highlight the matching substring in a folder name. */
function highlightMatch(name: string, filter: string): React.ReactNode {
	if (!filter) return name;
	const idx = name.toLowerCase().indexOf(filter);
	if (idx === -1) return name;
	return (
		<>
			{name.slice(0, idx)}
			<span style={{ fontWeight: 700, color: "var(--mantine-color-indigo-4)" }}>
				{name.slice(idx, idx + filter.length)}
			</span>
			{name.slice(idx + filter.length)}
		</>
	);
}

function buildBreadcrumbs(fullPath: string, sep: string): Array<{ name: string; path: string }> {
	const parts = fullPath.split(sep).filter(Boolean);
	const result: Array<{ name: string; path: string }> = [];

	// Windows: "C:\Users\foo" → ["C:", "Users", "foo"]
	if (sep === "\\" && /^[A-Z]:$/i.test(parts[0])) {
		let accumulated = `${parts[0]}\\`;
		result.push({ name: `${parts[0]}\\`, path: accumulated });
		for (let i = 1; i < parts.length; i++) {
			accumulated = `${accumulated}${parts[i]}\\`;
			result.push({ name: parts[i], path: accumulated.replace(/\\$/, "") });
		}
	} else {
		// Unix: "/home/user/projects" → ["/", "home", "user", "projects"]
		result.push({ name: "/", path: "/" });
		for (let i = 0; i < parts.length; i++) {
			const path = `/${parts.slice(0, i + 1).join("/")}`;
			result.push({ name: parts[i], path });
		}
	}

	return result;
}
