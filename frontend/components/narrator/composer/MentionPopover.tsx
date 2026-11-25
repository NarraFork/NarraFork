import {
	Badge,
	Box,
	Group,
	Paper,
	Text,
	UnstyledButton,
	useComputedColorScheme,
} from "@mantine/core";
import {
	foldHandle,
	HANDLE_CHAR_RE,
	HANDLE_START_RE,
	MAX_HANDLE_LENGTH,
} from "@shared/narrator-handle";
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../../../lib/z-index";
import { composerPopoverOffset, useComposerPopoverSide } from "./composer-popover-placement";

export interface MentionCandidate {
	id: string;
	handle?: string | null;
	title?: string | null;
	status?: string;
	isRecent?: boolean;
	canConnect?: boolean;
	parentTitle?: string | null;
}
interface MentionPopoverProps {
	candidates: MentionCandidate[];
	query: string | null;
	visible: boolean;
	loading?: boolean;
	error?: boolean;
	anchorRef?: RefObject<HTMLElement | null>;
	onSelect: (candidate: MentionCandidate) => void;
	onClose: () => void;
}
const MENTION_BOUNDARY_RE = /[\s(,:;!?，。！？、（【「《]/u;
/** Detect only the contiguous typed token; ordinary text never acquires reference identity. */
export function getMentionQuery(value: string, caret: number): string | null {
	const upto = value.slice(0, caret);
	const at = upto.lastIndexOf("@");
	if (at === -1 || (at > 0 && !MENTION_BOUNDARY_RE.test(upto[at - 1]))) return null;
	const partial = upto.slice(at + 1);
	if (partial === "") return "";
	const chars = [...partial.normalize("NFC")];
	if (
		chars.length > MAX_HANDLE_LENGTH ||
		!HANDLE_START_RE.test(chars[0]) ||
		chars.some((ch) => !HANDLE_CHAR_RE.test(ch))
	)
		return null;
	return foldHandle(partial);
}

export function MentionPopover({
	candidates,
	query,
	visible,
	loading = false,
	error = false,
	anchorRef,
	onSelect,
	onClose,
}: MentionPopoverProps) {
	const { t } = useTranslation("narrator");
	const isDark = useComputedColorScheme("dark") === "dark";
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	// The unified reader already filters local rows and bounds the merged page.
	const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];
	const optionId = useCallback((id: string) => `${listId}-${encodeURIComponent(id)}`, [listId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A new typed token resets selection; result enrichment must not.
	useEffect(() => {
		setSelectedId(null);
	}, [query]);
	useEffect(() => {
		if (selected && selectedId !== selected.id) setSelectedId(selected.id);
	}, [selected, selectedId]);
	useEffect(() => {
		const item = listRef.current?.ownerDocument.getElementById(
			selected ? optionId(selected.id) : "",
		);
		item?.scrollIntoView?.({ block: "nearest" });
	}, [selected, optionId]);
	useEffect(() => {
		const anchor = anchorRef?.current;
		if (!anchor || !visible) return;
		anchor.setAttribute("aria-controls", listId);
		anchor.setAttribute("aria-expanded", "true");
		if (selected) anchor.setAttribute("aria-activedescendant", optionId(selected.id));
		else anchor.removeAttribute("aria-activedescendant");
		return () => {
			anchor.removeAttribute("aria-controls");
			anchor.removeAttribute("aria-expanded");
			anchor.removeAttribute("aria-activedescendant");
		};
	}, [visible, anchorRef, listId, selected, optionId]);
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (!visible) return;
			const anchor = anchorRef?.current;
			if (
				anchorRef &&
				(!anchor ||
					!event.target ||
					!(event.target as Node).nodeType ||
					!anchor.contains(event.target as Node))
			)
				return;
			if (event.isComposing || event.keyCode === 229) return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				event.stopPropagation();
				if (!candidates.length) return;
				const index = candidates.findIndex((c) => c.id === selected?.id);
				setSelectedId(
					candidates[
						(index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length
					].id,
				);
			} else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
				// Empty/loading/error states still own confirmation; never leak Enter into send.
				event.preventDefault();
				event.stopPropagation();
				if (selected && selected.canConnect !== false) onSelect(selected);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}
		},
		[visible, anchorRef, candidates, selected, onSelect, onClose],
	);
	useEffect(() => {
		if (!visible) return;
		const doc = anchorRef?.current?.ownerDocument ?? document;
		doc.addEventListener("keydown", handleKeyDown, true);
		return () => doc.removeEventListener("keydown", handleKeyDown, true);
	}, [visible, handleKeyDown, anchorRef]);
	const side = useComposerPopoverSide(anchorRef, visible, 248);
	if (!visible) return null;
	return (
		<Paper
			ref={listRef}
			shadow="md"
			radius="sm"
			withBorder
			style={{
				position: "absolute",
				...composerPopoverOffset(side),
				left: 0,
				right: 0,
				maxHeight: 240,
				overflow: "auto",
				zIndex: Z.dropdown,
			}}
		>
			<Box id={listId} role="listbox" aria-label={t("mentionPopoverTitle")} aria-busy={loading}>
				{candidates.map((candidate, index) => (
					<Box key={candidate.id}>
						{(index === 0 || candidates[index - 1].isRecent !== candidate.isRecent) && (
							<Text size="xs" c="dimmed" px={10} py={4}>
								{t(candidate.isRecent ? "mentionRecentSessions" : "mentionMoreSessions")}
							</Text>
						)}
						<UnstyledButton
							id={optionId(candidate.id)}
							role="option"
							aria-selected={selected?.id === candidate.id}
							aria-disabled={candidate.canConnect === false}
							data-mention-item
							onPointerDown={(event) => event.preventDefault()}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								if (candidate.canConnect !== false) onSelect(candidate);
							}}
							onMouseEnter={() => setSelectedId(candidate.id)}
							style={{
								display: "flex",
								width: "100%",
								padding: 0,
								backgroundColor:
									selected?.id === candidate.id
										? isDark
											? "var(--mantine-color-dark-5)"
											: "var(--mantine-color-gray-1)"
										: undefined,
								opacity: candidate.canConnect === false ? 0.5 : 1,
							}}
						>
							<Group gap="xs" wrap="nowrap" style={{ flex: 1, padding: "8px 10px", minWidth: 0 }}>
								<Box style={{ minWidth: 0, flex: 1 }}>
									<Text size="sm" fw={600} truncate="end">
										{candidate.title || candidate.handle || candidate.id}
									</Text>
									{(candidate.handle || candidate.parentTitle) && (
										<Text size="xs" c="dimmed" truncate="end">
											{candidate.handle ? `@${candidate.handle}` : candidate.parentTitle}
										</Text>
									)}
								</Box>
								{candidate.status && candidate.status !== "idle" && (
									<Badge size="xs" variant="light" color="blue">
										{t(`status_${candidate.status}`, candidate.status)}
									</Badge>
								)}
							</Group>
						</UnstyledButton>
					</Box>
				))}
			</Box>
			{(loading || error || !candidates.length) && (
				<Text role="status" size="xs" c="dimmed" px={10} py={6}>
					{t(loading ? "mentionSearching" : error ? "mentionSearchError" : "mentionNoResults")}
				</Text>
			)}
		</Paper>
	);
}
