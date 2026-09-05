import {
	Badge,
	Box,
	Group,
	Paper,
	Text,
	UnstyledButton,
	useComputedColorScheme,
} from "@mantine/core";
import { foldHandle, HANDLE_CHAR_RE, HANDLE_START_RE } from "@shared/narrator-handle";
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

/** Boundary chars allowed immediately before `@` (mirrors the backend rules,
 * incl. common CJK punctuation so `你好，@小明` works). */
const MENTION_BOUNDARY_RE = /[\s(,:;!?，。！？、（【「《]/u;

/**
 * Given a textarea value and caret position, detect whether the caret is inside
 * an `@handle` token being typed, and return the partial handle (case-folded) or
 * null. Mirrors the mention rules: token starts at `@` that is at string start
 * or preceded by a boundary char, then Unicode letters/digits/_/- (incl. CJK).
 * The returned value is folded (NFC + lowercase) so callers compare against
 * folded handles.
 */
export function getMentionQuery(value: string, caret: number): string | null {
	const upto = value.slice(0, caret);
	// Find the last @ before the caret.
	const at = upto.lastIndexOf("@");
	if (at === -1) return null;
	// Char before @ must be a boundary (start, whitespace, or punctuation).
	if (at > 0 && !MENTION_BOUNDARY_RE.test(upto[at - 1])) return null;
	const partial = upto.slice(at + 1);
	// Empty right after @ is allowed (popover shows all candidates).
	if (partial === "") return "";
	// Token must start with a letter/digit, then allow letters/digits/_/- .
	const chars = [...partial];
	if (!HANDLE_START_RE.test(chars[0])) return null;
	for (const ch of chars) {
		if (!HANDLE_CHAR_RE.test(ch)) return null;
	}
	return foldHandle(partial);
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
			(c) => foldHandle(c.handle).startsWith(q) || foldHandle(c.title ?? "").includes(q),
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
			// The listener is capture-phase, so it sees the keystroke before the IME
			// candidate list does. While a CJK query is being composed, Enter/Tab pick
			// a candidate and the arrows move through them — stealing those left the
			// user unable to finish the word they were typing into the query.
			if (e.isComposing) return;
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
