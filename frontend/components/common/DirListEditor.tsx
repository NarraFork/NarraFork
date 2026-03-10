import {
	ActionIcon,
	Button,
	Group,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useState } from "react";

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
	const [newPath, setNewPath] = useState("");
	const levels = isWhitelist(props) ? WL_LEVELS : BL_LEVELS;

	const addDir = () => {
		const path = newPath.trim();
		if (!path) return;
		if (dirs.some((d) => d.path === path)) return;
		if (isWhitelist(props)) {
			props.onChange([...props.dirs, { path, accessLevel: "readOnly", enabled: true }]);
		} else {
			props.onChange([...props.dirs, { path, denyLevel: "denyAll", enabled: true }]);
		}
		setNewPath("");
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
			{dirs.map((dir, idx) => (
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
			))}
			<Group gap={4} wrap="nowrap">
				<TextInput
					size="xs"
					placeholder={labels.placeholder}
					value={newPath}
					onChange={(e) => setNewPath(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") addDir();
					}}
					style={{ flex: 1 }}
				/>
				<Button
					size="xs"
					variant="light"
					color={!isWhitelist(props) ? "red" : undefined}
					disabled={!newPath.trim()}
					onClick={addDir}
				>
					{labels.add}
				</Button>
			</Group>
		</Stack>
	);
}
