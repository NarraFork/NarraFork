import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	ActionIcon,
	Group,
	Modal,
	Paper,
	SegmentedControl,
	Stack,
	Switch,
	Text,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconFolderOpen, IconTrash } from "@tabler/icons-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { PathInput } from "./PathInput";

const DirectoryBrowser = lazy(() =>
	import("./DirectoryPicker").then((m) => ({ default: m.DirectoryBrowser })),
);

export interface WhitelistEntry {
	path: string;
	accessLevel: string;
	enabled?: boolean;
}

export interface BlacklistEntry {
	path: string;
	denyLevel: string;
	enabled?: boolean;
}

const WL_LEVELS = ["readOnly", "readWrite", "full"] as const;
const BL_LEVELS = ["denyWrite", "denyAll"] as const;

interface WhitelistEditorProps {
	dirs: WhitelistEntry[];
	onChange: (dirs: WhitelistEntry[]) => void;
	mode: "whitelist";
	labels: { empty: string; add: string; placeholder: string; levels: Record<string, string> };
}

interface BlacklistEditorProps {
	dirs: BlacklistEntry[];
	onChange: (dirs: BlacklistEntry[]) => void;
	mode: "blacklist";
	labels: { empty: string; add: string; placeholder: string; levels: Record<string, string> };
}

type DirListEditorProps = WhitelistEditorProps | BlacklistEditorProps;

function isWhitelist(props: DirListEditorProps): props is WhitelistEditorProps {
	return props.mode === "whitelist";
}

export function DirListEditor(props: DirListEditorProps) {
	const { dirs, labels } = props;
	const { t } = useTranslation("common");
	const levels = isWhitelist(props) ? WL_LEVELS : BL_LEVELS;
	const [opened, { open, close }] = useDisclosure(false);
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

	const addDir = (path: string) => {
		if (dirs.some((d) => d.path === path)) return;
		if (isWhitelist(props)) {
			props.onChange([...props.dirs, { path, accessLevel: "readOnly", enabled: true }]);
		} else {
			props.onChange([...props.dirs, { path, denyLevel: "denyAll", enabled: true }]);
		}
	};

	const removeDir = (idx: number) => {
		if (isWhitelist(props)) {
			props.onChange(props.dirs.filter((_, i) => i !== idx));
		} else {
			props.onChange(props.dirs.filter((_, i) => i !== idx));
		}
	};

	const updateEnabled = (idx: number, enabled: boolean) => {
		if (isWhitelist(props)) {
			props.onChange(props.dirs.map((item, i) => (i === idx ? { ...item, enabled } : item)));
		} else {
			props.onChange(props.dirs.map((item, i) => (i === idx ? { ...item, enabled } : item)));
		}
	};

	const updateLevel = (idx: number, value: string) => {
		if (isWhitelist(props)) {
			props.onChange(
				props.dirs.map((item, i) => (i === idx ? { ...item, accessLevel: value } : item)),
			);
		} else {
			props.onChange(
				props.dirs.map((item, i) => (i === idx ? { ...item, denyLevel: value } : item)),
			);
		}
	};

	const getLevelValue = (dir: WhitelistEntry | BlacklistEntry): string =>
		isWhitelist(props) ? (dir as WhitelistEntry).accessLevel : (dir as BlacklistEntry).denyLevel;

	return (
		<Stack gap={8}>
			{dirs.length === 0 && (
				<Text size="xs" c="dimmed">
					{labels.empty}
				</Text>
			)}
			{dirs.map((dir, idx) =>
				isMobile ? (
					<Paper key={dir.path} withBorder p="xs" radius="sm">
						<Stack gap="xs">
							<Group justify="space-between" wrap="nowrap" gap="xs">
								<Switch
									size="xs"
									checked={dir.enabled !== false}
									onChange={(e) => updateEnabled(idx, e.currentTarget.checked)}
									aria-label={`Toggle ${dir.path}`}
								/>
								<Text
									size="xs"
									style={{
										flex: 1,
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										opacity: dir.enabled !== false ? 1 : 0.5,
									}}
									title={dir.path}
								>
									{dir.path}
								</Text>
								<ActionIcon variant="subtle" color="red" size="xs" onClick={() => removeDir(idx)}>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
							<SegmentedControl
								size="xs"
								fullWidth
								value={getLevelValue(dir)}
								onChange={(v) => updateLevel(idx, v)}
								data={levels.map((l) => ({ value: l, label: labels.levels[l] ?? l }))}
							/>
						</Stack>
					</Paper>
				) : (
					<Group key={dir.path} gap={6} wrap="nowrap" align="center">
						<Switch
							size="xs"
							checked={dir.enabled !== false}
							onChange={(e) => updateEnabled(idx, e.currentTarget.checked)}
							aria-label={`Toggle ${dir.path}`}
						/>
						<Text
							size="xs"
							style={{
								flex: 1,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								opacity: dir.enabled !== false ? 1 : 0.5,
							}}
							title={dir.path}
						>
							{dir.path}
						</Text>
						<SegmentedControl
							size="xs"
							value={getLevelValue(dir)}
							onChange={(v) => updateLevel(idx, v)}
							data={levels.map((l) => ({ value: l, label: labels.levels[l] ?? l }))}
							style={{ flexShrink: 0 }}
						/>
						<ActionIcon variant="subtle" color="red" size="xs" onClick={() => removeDir(idx)}>
							<IconTrash size={14} />
						</ActionIcon>
					</Group>
				),
			)}
			<PathInput
				placeholder={labels.placeholder}
				onConfirm={addDir}
				rightSection={
					<ActionIcon variant="subtle" onClick={open} aria-label={t("browse")}>
						<IconFolderOpen size={18} />
					</ActionIcon>
				}
			/>
			<Modal
				opened={opened}
				onClose={close}
				title={t("selectDirectory")}
				size={isWide ? 880 : "md"}
				styles={{
					body: {
						padding: 0,
						maxHeight: "85vh",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					},
				}}
			>
				{opened && (
					<Suspense fallback={null}>
						<DirectoryBrowser
							onSelect={(path) => {
								addDir(path);
								close();
							}}
							onCancel={close}
							isWide={isWide}
						/>
					</Suspense>
				)}
			</Modal>
		</Stack>
	);
}
