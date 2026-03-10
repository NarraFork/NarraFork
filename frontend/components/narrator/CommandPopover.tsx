import {
	Badge,
	Box,
	Group,
	Paper,
	Text,
	UnstyledButton,
	useMantineColorScheme,
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

/** Left color bar based on item type + source */
function getBarColor(item: CommandItem): string {
	if (item.type === "skill") {
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
		return (
			<Badge size="xs" variant="light" color={item.source === "project" ? "teal" : "violet"}>
				{item.source === "project" ? t("commandSourceProjectSkill") : t("commandSourceGlobalSkill")}
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
	const { colorScheme } = useMantineColorScheme();
	const isDark = colorScheme === "dark";
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	// Filter commands based on input after /
	const query = input.startsWith("/") ? input.slice(1).toLowerCase() : "";
	const filtered = useMemo(() => {
		// When query starts with "load " (with space), show only the sub-items (load <tool>)
		if (query.startsWith("load ")) {
			return commands.filter(
				(c) => c.name.toLowerCase().startsWith(query) && c.name.toLowerCase() !== "load",
			);
		}
		// Otherwise, hide the sub-items (load <tool>) and only show the parent /load entry
		return commands.filter((c) => {
			if (c.type === "tool" && c.name.includes(" ")) return false;
			return c.name.toLowerCase().startsWith(query);
		});
	}, [commands, query]);

	// Reset selection when filter changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on query change
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	// Scroll selected item into view
	useEffect(() => {
		if (!listRef.current) return;
		const items = listRef.current.querySelectorAll("[data-command-item]");
		items[selectedIndex]?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!visible || filtered.length === 0) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => (i + 1) % filtered.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
			} else if (e.key === "Enter" && !e.shiftKey) {
				// If input exactly matches a no-param command, let Enter bubble to send
				const selected = filtered[selectedIndex];
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
				onSelect(filtered[selectedIndex]);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			} else if (e.key === "Tab") {
				e.preventDefault();
				onSelect(filtered[selectedIndex]);
			}
		},
		[visible, filtered, selectedIndex, onSelect, onClose, query],
	);

	useEffect(() => {
		if (visible) {
			document.addEventListener("keydown", handleKeyDown, true);
			return () => document.removeEventListener("keydown", handleKeyDown, true);
		}
	}, [visible, handleKeyDown]);

	if (!visible || filtered.length === 0) return null;

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
			{filtered.map((cmd, i) => (
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
								{cmd.description || cmd.prompt}
							</Text>
						)}
						{getSourceBadge(cmd, t)}
					</Group>
				</UnstyledButton>
			))}
		</Paper>
	);
}
