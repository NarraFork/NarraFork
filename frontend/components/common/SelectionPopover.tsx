import { ActionIcon, Group, Portal, Tooltip } from "@mantine/core";
import { IconCopy, IconSend } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SelectionPopoverProps {
	containerRef: React.RefObject<HTMLElement | null>;
	onAction: (text: string) => void;
	label: string;
	/** External selection text (e.g. from xterm). When provided, shows popover based on this text instead of DOM selection. */
	externalSelection?: string;
	/** Anchor position for external selection (e.g. touch point). When provided, popover appears near this point. */
	externalAnchor?: { x: number; y: number } | null;
}

export function SelectionPopover({
	containerRef,
	onAction,
	label,
	externalSelection,
	externalAnchor,
}: SelectionPopoverProps) {
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const selectedTextRef = useRef("");
	const popoverRef = useRef<HTMLDivElement>(null);
	const [copied, setCopied] = useState(false);
	const { t } = useTranslation("common");

	const handleMouseUp = useCallback(() => {
		// Small delay to let selection finalize
		setTimeout(() => {
			const selection = window.getSelection();
			const text = selection?.toString().trim();
			if (!text || !containerRef.current) {
				setPosition(null);
				return;
			}

			// Check if selection is within our container
			const range = selection?.getRangeAt(0);
			if (!range || !containerRef.current.contains(range.commonAncestorContainer)) {
				setPosition(null);
				return;
			}

			const rect = range.getBoundingClientRect();
			selectedTextRef.current = text;
			setPosition({
				top: Math.max(4, rect.top - 36),
				left: Math.min(window.innerWidth - 36, Math.max(4, rect.left + rect.width / 2 - 16)),
			});
		}, 10);
	}, [containerRef]);

	const handleMouseDown = useCallback((e: MouseEvent) => {
		// Don't dismiss if clicking the popover itself
		if (popoverRef.current?.contains(e.target as Node)) return;
		setPosition(null);
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		container.addEventListener("mouseup", handleMouseUp);
		document.addEventListener("mousedown", handleMouseDown);

		return () => {
			container.removeEventListener("mouseup", handleMouseUp);
			document.removeEventListener("mousedown", handleMouseDown);
		};
	}, [containerRef, handleMouseUp, handleMouseDown]);

	// Handle external selection (e.g. from xterm canvas)
	useEffect(() => {
		if (externalSelection) {
			selectedTextRef.current = externalSelection;
			if (externalAnchor) {
				// Position popover above the touch point
				setPosition({
					top: Math.max(4, externalAnchor.y - 44),
					left: Math.min(window.innerWidth - 80, Math.max(4, externalAnchor.x - 36)),
				});
			} else {
				const container = containerRef.current;
				if (container) {
					const rect = container.getBoundingClientRect();
					setPosition({
						top: Math.max(4, rect.top - 36),
						left: Math.min(window.innerWidth - 36, Math.max(4, rect.left + rect.width / 2 - 16)),
					});
				}
			}
			setCopied(false);
		} else if (externalSelection === "") {
			setPosition(null);
		}
	}, [externalSelection, externalAnchor, containerRef]);

	const handleClick = useCallback(() => {
		if (selectedTextRef.current) {
			onAction(selectedTextRef.current);
			setPosition(null);
			window.getSelection()?.removeAllRanges();
		}
	}, [onAction]);

	const handleCopy = useCallback(() => {
		if (selectedTextRef.current) {
			navigator.clipboard.writeText(selectedTextRef.current);
			setCopied(true);
			setTimeout(() => {
				setPosition(null);
				setCopied(false);
			}, 600);
		}
	}, []);

	if (!position) return null;

	return (
		<Portal>
			<div
				ref={popoverRef}
				style={{
					position: "fixed",
					top: position.top,
					left: position.left,
					zIndex: 1000,
				}}
			>
				<Group gap={4}>
					<Tooltip label={t("copy")} position="top" withArrow>
						<ActionIcon
							variant="filled"
							color={copied ? "green" : "gray"}
							size="sm"
							radius="xl"
							onClick={handleCopy}
						>
							<IconCopy size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={label} position="top" withArrow>
						<ActionIcon variant="filled" color="blue" size="sm" radius="xl" onClick={handleClick}>
							<IconSend size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</div>
		</Portal>
	);
}
