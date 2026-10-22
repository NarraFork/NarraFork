import {
	type DiffWordStyles,
	DiffWordTokens,
} from "@frontend/components/narrator/diff/DiffWordTokens";
import { useShikiTokens } from "@frontend/hooks/useShikiTokens";
import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
import { useComputedColorScheme } from "@mantine/core";
import { buildDiffHighlightPlan, type DiffLine } from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import { type UIEvent, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import classes from "./GitSplitDiff.module.css";
import { alignUnifiedDiffToSplit, type SplitDiffSide } from "./split-diff";

export function GitSplitDiff({
	lines,
	hunks,
	language,
	maxHeight = 500,
	fill = false,
	onNearBottom,
}: {
	lines: readonly DiffLine[];
	hunks: readonly ParsedDiffHunk[];
	language?: string;
	maxHeight?: number;
	fill?: boolean;
	onNearBottom?: () => void;
}) {
	const { t } = useTranslation("git");
	const dark = useComputedColorScheme("dark") !== "light";
	const wordStyles = useMemo<DiffWordStyles>(
		() => ({
			removedWord: {
				backgroundColor: dark ? "var(--mantine-color-red-light-hover)" : "rgba(255, 99, 71, 0.25)",
				borderRadius: 2,
			},
			addedWord: {
				backgroundColor: dark
					? "var(--mantine-color-green-light-hover)"
					: "rgba(46, 160, 67, 0.25)",
				borderRadius: 2,
			},
		}),
		[dark],
	);
	const entries = useMemo(() => alignUnifiedDiffToSplit(lines, hunks), [lines, hunks]);
	const plan = useMemo(() => buildDiffHighlightPlan(lines), [lines]);
	const oldTokens = useShikiTokens(plan?.sources[0] ?? "", language);
	const newTokens = useShikiTokens(plan?.sources[1] ?? "", language);
	const tokenTables = [oldTokens, newTokens];
	const scrollerRef = useRef<HTMLElement>(null);
	const armed = useRef(true);
	const lineCount = lines.length;

	useEffect(() => {
		if (lineCount < 0) return;
		armed.current = true;
	}, [lineCount]);

	const onScroll = (event: UIEvent<HTMLElement>) => {
		if (!onNearBottom || !armed.current) return;
		const el = event.currentTarget;
		if (el.scrollHeight <= el.clientHeight + 8) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
			armed.current = false;
			onNearBottom();
		}
	};

	return (
		<div className={fill ? classes.fill : undefined}>
			<section
				ref={scrollerRef}
				className={classes.scroller}
				data-diff-layout="split"
				aria-label={t("commitPreview.splitDiff")}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the split diff is a keyboard scrollport
				tabIndex={0}
				onScroll={onScroll}
				style={fill ? undefined : { maxHeight }}
			>
				<div className={classes.table}>
					<div className={classes.head}>{t("commitPreview.diffOriginal")}</div>
					<div className={`${classes.head} ${classes.headNew}`}>
						{t("commitPreview.diffModified")}
					</div>
					{entries.map((entry) =>
						entry.kind === "hunk" ? (
							<div
								key={splitEntryKey(entry)}
								className={classes.hunk}
								data-diff-hunk-separator="true"
							>
								{`@@ ${entry.hunk.range} @@${entry.hunk.heading ? ` ${entry.hunk.heading}` : ""}`}
							</div>
						) : (
							<SplitRow
								key={splitEntryKey(entry)}
								left={entry.left}
								right={entry.right}
								tokensFor={(sourceIndex, edge) => {
									const ref = plan?.rows[sourceIndex];
									if (!ref) return undefined;
									const chosen = edge === "old" && ref.old ? ref.old : ref;
									return tokenTables[chosen.source]?.[chosen.line];
								}}
								wordStyles={wordStyles}
							/>
						),
					)}
				</div>
			</section>
		</div>
	);
}

function splitEntryKey(entry: ReturnType<typeof alignUnifiedDiffToSplit>[number]): string {
	if (entry.kind === "hunk") {
		return `hunk:${entry.hunk.rowIndex}:${entry.hunk.range}:${entry.hunk.heading}`;
	}
	const left = entry.left ? `${entry.left.sourceIndex}:${entry.left.type}` : "empty-old";
	const right = entry.right ? `${entry.right.sourceIndex}:${entry.right.type}` : "empty-new";
	return `row:${left}:${right}`;
}

function SplitRow({
	left,
	right,
	tokensFor,
	wordStyles,
}: {
	left: SplitDiffSide | null;
	right: SplitDiffSide | null;
	tokensFor: (sourceIndex: number, edge: "old" | "new") => readonly ShikiToken[] | undefined;
	wordStyles: DiffWordStyles;
}) {
	return (
		<>
			<SplitCell
				edge="old"
				side={left}
				tokens={left ? tokensFor(left.sourceIndex, "old") : undefined}
				wordStyles={wordStyles}
			/>
			<SplitCell
				edge="new"
				side={right}
				tokens={right ? tokensFor(right.sourceIndex, "new") : undefined}
				wordStyles={wordStyles}
			/>
		</>
	);
}

function SplitCell({
	edge,
	side,
	tokens,
	wordStyles,
}: {
	edge: "old" | "new";
	side: SplitDiffSide | null;
	tokens?: readonly ShikiToken[];
	wordStyles: DiffWordStyles;
}) {
	const edgeClass = edge === "new" ? classes.sideNew : "";
	if (!side) {
		return (
			<div
				className={`${classes.side} ${classes.empty} ${edgeClass}`}
				data-diff-side={edge}
				data-diff-empty="true"
				aria-hidden="true"
			/>
		);
	}
	return (
		<div
			className={`${classes.side} ${classes[side.type]} ${edgeClass}`}
			data-diff-row={side.type}
			data-diff-side={edge}
			data-diff-line={side.lineNo ?? undefined}
		>
			<span className={classes.lineNo}>{side.lineNo ?? ""}</span>
			<span className={classes.code}>
				<SplitCode side={side} tokens={tokens} wordStyles={wordStyles} />
			</span>
		</div>
	);
}

function SplitCode({
	side,
	tokens,
	wordStyles,
}: {
	side: SplitDiffSide;
	tokens?: readonly ShikiToken[];
	wordStyles: DiffWordStyles;
}) {
	if (side.wordChanges && side.wordChanges.length > 0) {
		return <DiffWordTokens wordChanges={side.wordChanges} tokens={tokens} styles={wordStyles} />;
	}
	if (tokens && tokens.length > 0) {
		return tokens.map((token, index) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: tokens are an ordered partition of this line
			<span key={index} style={token.color ? { color: token.color } : undefined}>
				{token.content}
			</span>
		));
	}
	return side.content.length > 0 ? side.content : " ";
}
