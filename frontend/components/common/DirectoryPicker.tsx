import {
	ActionIcon,
	Breadcrumbs,
	Button,
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
		// Start browsing from current value if set, otherwise let API decide (home dir)
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

	const navigateTo = useCallback((path: string) => {
		setCurrentPath(path);
	}, []);

	const goUp = useCallback(() => {
		if (data?.parent) {
			setCurrentPath(data.parent);
		} else if (data?.drives) {
			// Already at root with drives — nowhere to go
		} else {
			setCurrentPath(undefined);
		}
	}, [data]);

	// Build breadcrumb segments from current path
	const breadcrumbs = data?.path ? buildBreadcrumbs(data.path, data.sep) : [];

	return (
		<Stack gap="sm">
			{/* Current path display */}
			<Group gap="xs" wrap="nowrap">
				<ActionIcon
					variant="subtle"
					onClick={goUp}
					disabled={!data?.parent && !data?.drives}
					aria-label={t("goUp")}
				>
					<IconArrowUp size={18} />
				</ActionIcon>
				<ScrollArea type="auto" style={{ flex: 1 }} offsetScrollbars={false}>
					<Breadcrumbs separator={data?.sep || "/"} styles={{ separator: { margin: "0 2px" } }}>
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
						{/* Drive letters (Windows) */}
						{data.drives?.map((drive) => (
							<UnstyledButton
								key={drive.path}
								onClick={() => navigateTo(drive.path)}
								px="sm"
								py={6}
								style={{ borderRadius: 4 }}
								className="dir-entry"
							>
								<Group gap="xs" wrap="nowrap">
									<IconDeviceDesktop size={18} style={{ flexShrink: 0 }} />
									<Text size="sm" truncate>
										{drive.name}
									</Text>
								</Group>
							</UnstyledButton>
						))}
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
						{!data.drives?.length && !data.entries.length && (
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

	// Windows drive root: "C:" → "C:\"
	if (sep === "\\" && /^[A-Z]:$/i.test(parts[0])) {
		result.push({ name: parts[0], path: `${parts[0]}\\` });
		for (let i = 1; i < parts.length; i++) {
			const path = result[result.length - 1].path + parts[i] + (i < parts.length - 1 ? sep : "");
			result.push({ name: parts[i], path });
		}
	} else {
		// Unix: starts with /
		for (let i = 0; i < parts.length; i++) {
			const path = `/${parts.slice(0, i + 1).join("/")}`;
			result.push({ name: i === 0 ? `/${parts[0]}` : parts[i], path });
		}
	}

	return result;
}
