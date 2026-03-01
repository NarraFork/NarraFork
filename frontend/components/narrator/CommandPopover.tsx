import { Badge, Group, Paper, Text, UnstyledButton } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface CommandItem {
	name: string;
	prompt: string;
	description?: string;
	source: string;
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

export function CommandPopover({
	commands,
	input,
	visible,
	onSelect,
	onClose,
}: CommandPopoverProps) {
	const { t } = useTranslation("narrator");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	// Filter commands based on input after /
	const query = input.startsWith("/") ? input.slice(1).toLowerCase() : "";
	const filtered = useMemo(
		() => commands.filter((c) => c.name.toLowerCase().startsWith(query)),
		[commands, query],
	);

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
		[visible, filtered, selectedIndex, onSelect, onClose],
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
					key={cmd.name}
					data-command-item
					onClick={() => onSelect(cmd)}
					onMouseEnter={() => setSelectedIndex(i)}
					style={(theme) => ({
						display: "block",
						width: "100%",
						padding: "6px 10px",
						backgroundColor: i === selectedIndex ? theme.colors.dark[5] : undefined,
						borderRadius: 0,
					})}
				>
					<Group gap="xs" wrap="nowrap">
						<Text size="sm" fw={600} c="indigo.4">
							/{cmd.name}
						</Text>
						{cmd.description && (
							<Text size="xs" c="dimmed" truncate="end" style={{ flex: 1 }}>
								{cmd.description}
							</Text>
						)}
						<Badge size="xs" variant="light" color={cmd.source === "project" ? "teal" : "gray"}>
							{cmd.source === "project" ? t("commandSourceProject") : t("commandSourceUser")}
						</Badge>
					</Group>
				</UnstyledButton>
			))}
		</Paper>
	);
}
