import { ActionIcon, Group, Portal, Tooltip } from "@mantine/core";
import { IconCopy, IconSend } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "../../lib/clipboard";
import { collectSelectionTextPreview } from "../../lib/dom-text";
import { Z } from "../../lib/z-index";

interface SelectionPopoverProps {
	containerRef: React.RefObject<HTMLElement | null>;
	onAction: (text: string) => void;
	label: string;
	/** External selection text (e.g. from xterm). When provided, shows popover based on this text instead of DOM selection. */
	externalSelection?: string;
	/** Anchor position for external selection (e.g. touch point). When provided, popover appears near this point. */
	externalAnchor?: { x: number; y: number } | null;
}

const MAX_SELECTION_POPOVER_TEXT_CHARS = 200_000;

function clampSelectionPopoverText(text: string): string {
	return text.length > MAX_SELECTION_POPOVER_TEXT_CHARS
		? text.slice(0, MAX_SELECTION_POPOVER_TEXT_CHARS)
		: text;
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
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { t } = useTranslation("common");

	const clearSelection = useCallback(() => {
		selectedTextRef.current = "";
		setPosition(null);
	}, []);

	const handleMouseUp = useCallback(() => {
		// Small delay to let selection finalize
		setTimeout(() => {
			const selection = window.getSelection();
			const text = collectSelectionTextPreview(selection, MAX_SELECTION_POPOVER_TEXT_CHARS);
			if (!text || !containerRef.current) {
				clearSelection();
				return;
			}

			// Check if selection is within our container
			const range = selection?.getRangeAt(0);
			if (!range || !containerRef.current.contains(range.commonAncestorContainer)) {
				clearSelection();
				return;
			}

			const rect = range.getBoundingClientRect();
			selectedTextRef.current = text;
			setPosition({
				top: Math.max(4, rect.top - 36),
				left: Math.min(window.innerWidth - 36, Math.max(4, rect.left + rect.width / 2 - 16)),
			});
		}, 10);
	}, [clearSelection, containerRef]);

	const handleMouseDown = useCallback(
		(e: MouseEvent) => {
			// Don't dismiss if clicking the popover itself
			if (popoverRef.current?.contains(e.target as Node)) return;
			clearSelection();
		},
		[clearSelection],
	);

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
			selectedTextRef.current = clampSelectionPopoverText(externalSelection);
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
			clearSelection();
		}
	}, [externalSelection, externalAnchor, containerRef, clearSelection]);

	const handleClick = useCallback(() => {
		if (selectedTextRef.current) {
			onAction(selectedTextRef.current);
			clearSelection();
			window.getSelection()?.removeAllRanges();
		}
	}, [clearSelection, onAction]);

	const handleCopy = useCallback(() => {
		const text = selectedTextRef.current;
		if (!text) return;
		void copyTextToClipboard(text)
			.then(() => {
				selectedTextRef.current = "";
				setCopied(true);
				copyTimerRef.current = setTimeout(() => {
					clearSelection();
					setCopied(false);
				}, 600);
			})
			.catch(() => {});
	}, [clearSelection]);

	// Cleanup copy timer on unmount
	useEffect(() => {
		return () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
			selectedTextRef.current = "";
		};
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
					zIndex: Z.popover,
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
