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
import { IconArrowUp, IconDeviceDesktop, IconFolder, IconFolderOpen } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface DirectoryPickerProps {
	value: string;
	onChange: (path: string) => void;
	label?: string;
	placeholder?: string;
	description?: string;
	required?: boolean;
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
			<ActionIcon variant="subtle" onClick={handleOpen} aria-label={t("browse")}>
				<IconFolderOpen size={18} />
			</ActionIcon>
		</Group>
	) : (
		<ActionIcon variant="subtle" onClick={handleOpen} aria-label={t("browse")}>
			<IconFolderOpen size={18} />
		</ActionIcon>
	);

	return (
		<>
			<TextInput
				label={label}
				placeholder={placeholder}
				description={description}
				required={required}
				value={value}
				onChange={(e) => onChange(e.currentTarget.value)}
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

function DirectoryBrowser({ initialPath, onSelect, onCancel }: DirectoryBrowserProps) {
	const { t } = useTranslation("common");
	const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);

	const { data, isLoading, error } = useQuery({
		queryKey: ["fs-browse", currentPath],
		queryFn: () => api.fsBrowse(currentPath),
	});

	const hasDrives = (data?.drives?.length ?? 0) > 0;
	// At drive root when path is null (initial) or undefined
	const isAtDriveRoot = !data?.path && hasDrives;

	const navigateTo = useCallback((path: string) => {
		setCurrentPath(path);
	}, []);

	// Go back to drive selection screen
	const goToDrives = useCallback(() => {
		setCurrentPath(undefined);
	}, []);

	const goUp = useCallback(() => {
		if (data?.parent) {
			setCurrentPath(data.parent);
		} else if (hasDrives) {
			// At drive root (e.g. C:\) — go back to drive selection
			setCurrentPath(undefined);
		}
	}, [data, hasDrives]);

	// Build breadcrumb segments from current path
	const breadcrumbs = data?.path ? buildBreadcrumbs(data.path, data.sep) : [];

	return (
		<Stack gap="sm">
			{/* Breadcrumb navigation bar */}
			<Group gap="xs" wrap="nowrap">
				<ActionIcon variant="subtle" onClick={goUp} disabled={isAtDriveRoot} aria-label={t("goUp")}>
					<IconArrowUp size={18} />
				</ActionIcon>
				<ScrollArea type="auto" style={{ flex: 1 }} offsetScrollbars={false}>
					<Breadcrumbs separator={data?.sep || "/"} styles={{ separator: { margin: "0 2px" } }}>
						{/* On Windows, always show a clickable "Computer" root to go back to drives */}
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
			</Group>

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
						{/* Drive letters (Windows) — horizontal row, always visible when drives exist */}
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
						{data.entries.map((entry) => (
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
										{entry.name}
									</Text>
								</Group>
							</UnstyledButton>
						))}
						{data.path && !data.entries.length && (
							<Text c="dimmed" size="sm" ta="center" mt="xl">
								{t("emptyDirectory")}
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
