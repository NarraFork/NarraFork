/**
 * ToolChangeRows.tsx — the change list of an outline tool card (`ToolChangeRowsDetail`).
 *
 * One single line per change: a glyph, a few words, the block as a titled outline link, chips.
 * Geometry mirrors `measureToolBody`'s `change-rows` case: each row is one fixed line of
 * `changeRowHeight()` (the reader's live xs line, at least a badge) with `CHANGE_ROW_GAP` between
 * rows, and the fold row under them after `CHANGE_TOGGLE_GAP`. Nothing here can wrap: a row too
 * long for its card gives way from its links first (truncated, the full title and the address on
 * hover), then its words and chips (each down to about three characters).
 *
 * Links go through `useOutlineLinkProps`: inside a session they open the outline panel, outside
 * one (nothing can open them) they are plain text.
 */

import { Badge } from "@mantine/core";
import type { ToolChangePart, ToolChangeRow } from "@shared/pretext-layout/tool-detail";
import {
	IconAlertCircle,
	IconArrowBackUp,
	IconArrowForward,
	IconAt,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCircleCheck,
	IconCircleDot,
	IconCircleX,
	IconClockPause,
	IconDots,
	IconHash,
	IconHelpCircle,
	IconMessageReply,
	IconMinus,
	IconPencil,
	IconPlus,
	IconPoint,
	type IconProps,
} from "@tabler/icons-react";
import type { ComponentType, CSSProperties } from "react";
import { useOutlineLinkProps } from "../../../../lib/outline-opener";
import type { BlockFrame, PreparedBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";

const GLYPHS: Record<NonNullable<ToolChangeRow["glyph"]>, ComponentType<IconProps>> = {
	status: IconCircleDot,
	done: IconCheck,
	add: IconPlus,
	child: IconPoint,
	move: IconArrowForward,
	edit: IconPencil,
	delete: IconMinus,
	assign: IconAt,
	alias: IconHash,
	pending: IconClockPause,
	confirm: IconCircleCheck,
	reject: IconCircleX,
	question: IconHelpCircle,
	withdraw: IconArrowBackUp,
	answer: IconMessageReply,
	failed: IconAlertCircle,
	more: IconDots,
};

const GLYPH_COLOR: Partial<Record<NonNullable<ToolChangeRow["glyph"]>, string>> = {
	done: "var(--mantine-color-green-text)",
	add: "var(--mantine-color-teal-text)",
	delete: "var(--mantine-color-red-text)",
	pending: "var(--mantine-color-orange-text)",
	confirm: "var(--mantine-color-green-text)",
	reject: "var(--mantine-color-red-text)",
	failed: "var(--mantine-color-red-text)",
};

/** The glyph lane, and the indent of a row under another (what an add created). */
const GLYPH_SIZE = 12;
const GLYPH_LANE = 14;
const INDENT = 16;
const PART_GAP = 4;

/** The reader's xs text, at the transcript's live typography (measure uses the same line). */
function rowText(): CSSProperties {
	return {
		font: typographyMetrics().font.xs,
		lineHeight: `${typographyMetrics().line.xs}px`,
		letterSpacing: typographyMetrics().letterSpacing.xs || undefined,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	};
}

/**
 * A rough width for `text` in em: CJK 1em, a space 0.3em, anything else 0.6em. Only the
 * minimum a link or a phrase keeps when the row is short of room (never measured geometry).
 */
function emWidth(text: string): number {
	let em = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		em += code >= 0x2e80 ? 1 : ch === " " ? 0.3 : 0.6;
		if (em > 12) break;
	}
	return em;
}

function ChangeLink({ part }: { part: Extract<ToolChangePart, { kind: "link" }> }) {
	const outlineLink = useOutlineLinkProps(part.href);
	const href = outlineLink === null ? null : (outlineLink?.href ?? part.href);
	const tip = part.tip ? `${part.text}\n${part.tip}` : part.text;
	const style: CSSProperties = {
		...rowText(),
		// A link gives way first, down to about four characters.
		flex: "0 8 auto",
		minWidth: `min(${Math.min(emWidth(part.text), 4).toFixed(1)}em, 40%)`,
		color: href ? "var(--mantine-color-teal-text)" : undefined,
		textDecoration: href ? "underline" : undefined,
		textDecorationColor: href ? "var(--mantine-color-teal-outline)" : undefined,
		textUnderlineOffset: 2,
	};
	if (!href) {
		return (
			<span data-change-part="link" title={tip} style={style}>
				{part.text}
			</span>
		);
	}
	return (
		<a
			data-change-part="link"
			href={href}
			title={tip}
			{...(outlineLink
				? { onClick: outlineLink.onClick, "data-outline-link": "" }
				: { target: "_blank", rel: "noopener noreferrer" })}
			style={style}
		>
			{part.text}
		</a>
	);
}

function ChangePart({ part }: { part: ToolChangePart }) {
	if (part.kind === "link") return <ChangeLink part={part} />;
	if (part.kind === "chip") {
		return (
			<Badge
				data-change-part="chip"
				size="xs"
				// A gray chip is outlined: a light gray one has the card's own background.
				variant={part.color === "gray" ? "outline" : "light"}
				color={part.color}
				// An id or an alias is case-sensitive: never upper-cased. The localized words of the
				// other chips are not upper-cased either, to read as the rest of the row does.
				tt="none"
				title={part.label}
				// A chip keeps its words while it can, then gives way after the links and the words
				// (truncated, in full on hover), so a narrow row never cuts one off at its edge.
				style={{ flex: "0 1 auto", minWidth: "3em", maxWidth: "40%" }}
			>
				{part.label}
			</Badge>
		);
	}
	return (
		<span
			data-change-part="text"
			title={part.text.length > 24 ? part.text : undefined}
			style={{
				...rowText(),
				flex: "0 1 auto",
				minWidth: `min(${Math.min(emWidth(part.text), 6).toFixed(1)}em, 30%)`,
				color:
					part.tone === "red"
						? "var(--mantine-color-red-text)"
						: part.tone === "dim"
							? "var(--mantine-color-dimmed)"
							: undefined,
			}}
		>
			{part.text}
		</span>
	);
}

function ChangeRowLine({ row, width }: { row: ToolChangeRow; width: number }) {
	const Glyph = row.glyph ? GLYPHS[row.glyph] : null;
	const indent = row.indent === 1 ? INDENT : 0;
	return (
		<div
			data-outline-change-row=""
			style={{
				display: "flex",
				alignItems: "center",
				gap: PART_GAP,
				height: "100%",
				width: width - indent,
				marginLeft: indent,
				minWidth: 0,
				overflow: "hidden",
				color:
					row.tone === "red"
						? "var(--mantine-color-red-text)"
						: row.tone === "dim"
							? "var(--mantine-color-dimmed)"
							: undefined,
			}}
		>
			<span
				style={{
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: GLYPH_LANE,
					flexShrink: 0,
					color: (row.glyph && GLYPH_COLOR[row.glyph]) ?? "var(--mantine-color-dimmed)",
				}}
			>
				{Glyph ? <Glyph size={GLYPH_SIZE} /> : null}
			</span>
			{row.parts.map((part, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a row's parts are a stable ordered list
				<ChangePart key={i} part={part} />
			))}
		</div>
	);
}

/** The change list's blocks, each at its measured place. */
export function ToolChangeRows({
	blocks,
	frames,
	availableWidth,
	height,
	onToggleRaw,
}: {
	blocks: readonly PreparedBlock[];
	frames: readonly BlockFrame[];
	availableWidth: number;
	height: number;
	/** Opens / closes the raw input and model result under the list. Absent: shown, inert. */
	onToggleRaw?: () => void;
}) {
	return (
		<div data-outline-changes="" style={{ position: "relative", width: availableWidth, height }}>
			{blocks.map((block, index) => {
				const frame = frames[index];
				if (!frame || block.kind !== "fixed") return null;
				const box: CSSProperties = {
					position: "absolute",
					top: frame.top,
					left: 0,
					width: availableWidth,
					height: frame.height,
				};
				const data = block.data ?? {};
				if (block.tag === "detail-change-row" && data.row) {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
						<div key={index} style={box}>
							<ChangeRowLine row={data.row as ToolChangeRow} width={availableWidth} />
						</div>
					);
				}
				if (block.tag === "detail-change-toggle" && data.toggle) {
					const toggle = data.toggle as { open: boolean; label: string };
					const Chevron = toggle.open ? IconChevronDown : IconChevronRight;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable ordered list
						<div key={index} style={{ ...box, display: "flex", alignItems: "center" }}>
							<button
								type="button"
								data-outline-raw-toggle=""
								aria-expanded={toggle.open}
								disabled={!onToggleRaw}
								onClick={(event) => {
									event.stopPropagation();
									onToggleRaw?.();
								}}
								style={{
									...rowText(),
									display: "inline-flex",
									alignItems: "center",
									gap: 2,
									maxWidth: "100%",
									padding: 0,
									border: 0,
									background: "none",
									color: "var(--mantine-color-dimmed)",
									cursor: onToggleRaw ? "pointer" : "default",
								}}
							>
								<Chevron size={GLYPH_SIZE} style={{ flexShrink: 0 }} />
								<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{toggle.label}</span>
							</button>
						</div>
					);
				}
				return null;
			})}
		</div>
	);
}
