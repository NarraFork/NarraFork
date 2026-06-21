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
import { Z } from "../../lib/z-index";

export interface MentionCandidate {
	id: string;
	handle: string;
	title?: string | null;
	status?: string;
}

interface MentionPopoverProps {
	/** Named-narrator candidates to choose from. */
	candidates: MentionCandidate[];
	/** The active @token query (text after @, without the @). null = not mentioning. */
	query: string | null;
	visible: boolean;
	/** Called with the chosen handle when the user selects/confirms. */
	onSelect: (candidate: MentionCandidate) => void;
	onClose: () => void;
}

const MAX_MENTION_ITEMS = 50;

/**
 * Given a textarea value and caret position, detect whether the caret is inside
 * an `@handle` token being typed, and return the partial handle (lowercased) or
 * null. Mirrors the mention rules: token starts at `@` that is at string start
 * or preceded by whitespace/( , : ; ! ?, then [a-z0-9_-].
 */
export function getMentionQuery(value: string, caret: number): string | null {
	const upto = value.slice(0, caret);
	// Find the last @ before the caret.
	const at = upto.lastIndexOf("@");
	if (at === -1) return null;
	// Char before @ must be a boundary (start, whitespace, or punctuation).
	if (at > 0 && !/[\s(,:;!?]/.test(upto[at - 1])) return null;
	const partial = upto.slice(at + 1);
	// Token must start with a letter/digit then allow letters/digits/_/- (or be
	// empty right after @). Mirrors the backend handle rules.
	if (!/^([a-z0-9][a-z0-9_-]*)?$/i.test(partial)) return null;
	return partial.toLowerCase();
}

export function MentionPopover({
	candidates,
	query,
	visible,
	onSelect,
	onClose,
}: MentionPopoverProps) {
	const { t } = useTranslation("narrator");
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	const filtered = useMemo(() => {
		const q = query ?? "";
		const matches = candidates.filter(
			(c) => c.handle.toLowerCase().startsWith(q) || (c.title ?? "").toLowerCase().includes(q),
		);
		return matches.slice(0, MAX_MENTION_ITEMS);
	}, [candidates, query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	useEffect(() => {
		if (selectedIndex >= filtered.length) {
			setSelectedIndex(Math.max(0, filtered.length - 1));
		}
	}, [selectedIndex, filtered.length]);

	useEffect(() => {
		if (!listRef.current) return;
		const items = listRef.current.querySelectorAll("[data-mention-item]");
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
			} else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				onSelect(filtered[selectedIndex]);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
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
				zIndex: Z.dropdown,
			}}
			ref={listRef}
		>
			<Text size="xs" c="dimmed" px={10} py={4}>
				{t("mentionPopoverTitle")}
			</Text>
			{filtered.map((c, i) => (
				<UnstyledButton
					key={c.id}
					data-mention-item
					// Prevent the textarea from losing focus before the click lands —
					// otherwise onBlur tears down this popover and the click never fires.
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => onSelect(c)}
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
					<Box
						style={{
							width: 3,
							flexShrink: 0,
							backgroundColor: "var(--mantine-color-grape-6)",
							borderRadius: "2px 0 0 2px",
						}}
					/>
					<Group gap="xs" wrap="nowrap" style={{ flex: 1, padding: "6px 10px" }}>
						<Text size="sm" fw={600} c="grape.4">
							@{c.handle}
						</Text>
						{c.title && (
							<Text size="xs" c="dimmed" truncate="end" style={{ flex: 1 }}>
								{c.title}
							</Text>
						)}
						{c.status && c.status !== "idle" && (
							<Badge size="xs" variant="light" color="blue">
								{t(`status_${c.status}`, c.status)}
							</Badge>
						)}
					</Group>
				</UnstyledButton>
			))}
		</Paper>
	);
}
