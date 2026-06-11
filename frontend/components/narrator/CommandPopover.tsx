import {
	Badge,
	Box,
	Group,
	Paper,
	Text,
	UnstyledButton,
	useComputedColorScheme,
} from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface CommandParam {
	name: string;
	description?: string;
	required?: boolean;
	defaultValue?: string;
}

export interface CommandItem {
	name: string;
	prompt: string;
	description?: string;
	source: string;
	type: "command" | "skill" | "tool";
	runBashFirst?: boolean;
	bashCommand?: string;
	params?: CommandParam[];
}

interface CommandPopoverProps {
	commands: CommandItem[];
	input: string;
	visible: boolean;
	onSelect: (command: CommandItem) => void;
	onClose: () => void;
	/** Ref to the textarea element for positioning */
	anchorRef?: React.RefObject<HTMLElement | null>;
}

const MAX_COMMAND_POPOVER_ITEMS = 120;
const MAX_COMMAND_POPOVER_DESCRIPTION_CHARS = 300;

function capCommandPopoverText(text: string): string {
	if (text.length <= MAX_COMMAND_POPOVER_DESCRIPTION_CHARS) return text;
	return `${text.slice(0, MAX_COMMAND_POPOVER_DESCRIPTION_CHARS)}…`;
}

/** Left color bar based on item type + source */
function getBarColor(item: CommandItem): string {
	if (item.type === "skill") {
		if (item.source === "workspace") return "var(--mantine-color-cyan-6)";
		return item.source === "project"
			? "var(--mantine-color-teal-6)"
			: "var(--mantine-color-violet-6)";
	}
	if (item.type === "tool") {
		return "var(--mantine-color-yellow-6)";
	}
	// command
	return item.source === "project"
		? "var(--mantine-color-indigo-6)"
		: "var(--mantine-color-indigo-4)";
}

function getSourceBadge(item: CommandItem, t: (key: string) => string) {
	if (item.type === "skill") {
		const color =
			item.source === "workspace" ? "cyan" : item.source === "project" ? "teal" : "violet";
		const label =
			item.source === "workspace"
				? t("commandSourceWorkspaceSkill")
				: item.source === "project"
					? t("commandSourceProjectSkill")
					: t("commandSourceGlobalSkill");
		return (
			<Badge size="xs" variant="light" color={color}>
				{label}
			</Badge>
		);
	}
	return (
		<Badge size="xs" variant="light" color={item.source === "project" ? "teal" : "gray"}>
			{item.source === "project" ? t("commandSourceProject") : t("commandSourceUser")}
		</Badge>
	);
}

export function CommandPopover({
	commands,
	input,
	visible,
	onSelect,
	onClose,
}: CommandPopoverProps) {
	const { t } = useTranslation("narrator");
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	// Filter commands based on input after /
	const query = input.startsWith("/") ? input.slice(1).toLowerCase() : "";
	const filtered = useMemo(() => {
		// When query starts with "load "/"unload ", show only matching sub-items.
		if (query.startsWith("load ") || query.startsWith("unload ")) {
			const parent = query.startsWith("load ") ? "load" : "unload";
			return commands.filter(
				(c) => c.name.toLowerCase().startsWith(query) && c.name.toLowerCase() !== parent,
			);
		}
		// Otherwise, hide the sub-items (load <tool>/unload <tool>) and only show parent entries
		return commands.filter((c) => {
			if (c.type === "tool" && c.name.includes(" ")) return false;
			return c.name.toLowerCase().startsWith(query);
		});
	}, [commands, query]);
	const visibleCommands = useMemo(() => filtered.slice(0, MAX_COMMAND_POPOVER_ITEMS), [filtered]);
	const hiddenCommandCount = Math.max(0, filtered.length - visibleCommands.length);

	// Reset selection when filter changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on query change
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	useEffect(() => {
		if (selectedIndex >= visibleCommands.length) {
			setSelectedIndex(Math.max(0, visibleCommands.length - 1));
		}
	}, [selectedIndex, visibleCommands.length]);

	// Scroll selected item into view
	useEffect(() => {
		if (!listRef.current) return;
		const items = listRef.current.querySelectorAll("[data-command-item]");
		items[selectedIndex]?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!visible || visibleCommands.length === 0) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => (i + 1) % visibleCommands.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => (i - 1 + visibleCommands.length) % visibleCommands.length);
			} else if (e.key === "Enter" && !e.shiftKey) {
				// If input exactly matches a no-param command, let Enter bubble to send
				const selected = visibleCommands[selectedIndex];
				const exactMatch = selected && selected.name.toLowerCase() === query;
				const hasParams =
					selected?.type === "command" &&
					(selected.params?.length ||
						selected.prompt.includes("{{input}}") ||
						selected.prompt.includes("{{"));
				if (exactMatch && !hasParams) {
					// Don't intercept — let the send handler fire
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				onSelect(visibleCommands[selectedIndex]);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			} else if (e.key === "Tab") {
				e.preventDefault();
				onSelect(visibleCommands[selectedIndex]);
			}
		},
		[visible, visibleCommands, selectedIndex, onSelect, onClose, query],
	);

	useEffect(() => {
		if (visible) {
			document.addEventListener("keydown", handleKeyDown, true);
			return () => document.removeEventListener("keydown", handleKeyDown, true);
		}
	}, [visible, handleKeyDown]);

	if (!visible || visibleCommands.length === 0) return null;

	return (
		<Paper
			shadow="md"
			radius="sm"
			withBorder
			style={{
				position: "absolute",
				bottom: "100%",
				left: 0,
				right: 0,
				marginBottom: 4,
				maxHeight: 240,
				overflow: "auto",
				zIndex: 1000,
			}}
			ref={listRef}
		>
			{visibleCommands.map((cmd, i) => (
				<UnstyledButton
					key={`${cmd.type}-${cmd.name}`}
					data-command-item
					onClick={() => onSelect(cmd)}
					onMouseEnter={() => setSelectedIndex(i)}
					style={{
						display: "flex",
						width: "100%",
						padding: 0,
						backgroundColor:
							i === selectedIndex
								? isDark
									? "var(--mantine-color-dark-5)"
									: "var(--mantine-color-gray-1)"
								: undefined,
						borderRadius: 0,
					}}
				>
					{/* Color bar */}
					<Box
						style={{
							width: 3,
							flexShrink: 0,
							backgroundColor: getBarColor(cmd),
							borderRadius: "2px 0 0 2px",
						}}
					/>
					<Group gap="xs" wrap="nowrap" style={{ flex: 1, padding: "6px 10px" }}>
						<Text size="sm" fw={600} c={cmd.type === "skill" ? "violet.4" : "indigo.4"}>
							/{cmd.name}
						</Text>
						{(cmd.description || cmd.prompt) && (
							<Text size="xs" c="dimmed" truncate="end" style={{ flex: 1 }}>
								{capCommandPopoverText(cmd.description || cmd.prompt)}
							</Text>
						)}
						{cmd.type === "command" && cmd.runBashFirst && cmd.bashCommand && (
							<Badge size="xs" variant="light" color="yellow" title={cmd.bashCommand}>
								{t("commandRunBashFirstBadge")}
							</Badge>
						)}
						{getSourceBadge(cmd, t)}
					</Group>
				</UnstyledButton>
			))}
			{hiddenCommandCount > 0 && (
				<Text size="xs" c="dimmed" ta="center" py={6}>
					Showing first {visibleCommands.length} items; keep typing to narrow {hiddenCommandCount}{" "}
					more.
				</Text>
			)}
		</Paper>
	);
}
