import {
	clearCache,
	type LayoutCursor,
	prepareWithSegments,
	setLocale,
	walkLineRanges,
} from "@chenglou/pretext";

export interface TextDocumentTypography {
	font: string;
	lineHeight: number;
	letterSpacing: number;
	tabSize: number;
	width: number;
	wrap: boolean;
	fontRevision?: number | string;
	locale?: string;
}
export interface TextDocumentVisualLine {
	start: number;
	end: number;
	width: number;
	/** Raw grapheme boundaries, including invisible source characters. */
	offsets: Uint32Array;
	x: Float64Array;
}

let typographyKey = "";
/** Cache invalidation is explicit: loaded fonts and locale are layout inputs, not globals. */
export function prepareDocumentTypography(options: TextDocumentTypography): void {
	const key = JSON.stringify([options.font, options.fontRevision, options.locale]);
	if (key !== typographyKey) {
		clearCache();
		setLocale(options.locale);
		typographyKey = key;
	}
}

/** pretext owns actual canvas font measurement, soft wrapping and tab stops. */
export function layoutTextDocumentLine(
	text: string,
	start: number,
	options: TextDocumentTypography,
): TextDocumentVisualLine[] {
	prepareDocumentTypography(options);
	if (!text)
		return [
			{ start, end: start, width: 0, offsets: new Uint32Array([start]), x: new Float64Array([0]) },
		];
	const original = prepareWithSegments(text, options.font, {
		whiteSpace: "pre-wrap",
		letterSpacing: options.letterSpacing,
	});
	// Clone the public shape: cached prepared values must not accumulate tab scaling.
	const prepared = {
		...original,
		tabStopAdvance: (original.tabStopAdvance * Math.max(1, options.tabSize)) / 8,
	};
	const segmentOffsets = [0];
	const graphemes: number[][] = [];
	const segmenter = new Intl.Segmenter(options.locale, { granularity: "grapheme" });
	for (const segment of prepared.segments) {
		segmentOffsets.push(segmentOffsets[segmentOffsets.length - 1] + segment.length);
		const offsets = Array.from(segmenter.segment(segment), (part) => part.index);
		offsets.push(segment.length);
		graphemes.push(offsets);
	}
	const sourceOffset = (cursor: LayoutCursor) =>
		segmentOffsets[cursor.segmentIndex] +
		(graphemes[cursor.segmentIndex]?.[cursor.graphemeIndex] ?? 0);
	const rows: TextDocumentVisualLine[] = [];
	let consumed = 0;
	walkLineRanges(
		prepared,
		options.wrap ? Math.max(1, options.width) : Number.MAX_SAFE_INTEGER,
		(range) => {
			let stop = sourceOffset(range.end);
			// Keep discretionary/invisible source chars owned, even when pretext's next start skips them.
			if (range.end.graphemeIndex === 0) {
				let segment = range.end.segmentIndex;
				while (["soft-hyphen", "zero-width-break", "space"].includes(prepared.kinds[segment] ?? ""))
					segment++;
				stop = Math.max(stop, segmentOffsets[segment] ?? stop);
			}
			const offsets = [start + consumed];
			const xs = [0];
			let x = 0,
				painted = false;
			for (
				let segment = range.start.segmentIndex;
				segment <= range.end.segmentIndex && segment < prepared.segments.length;
				segment++
			) {
				const boundaries = graphemes[segment];
				const begin = segment === range.start.segmentIndex ? range.start.graphemeIndex : 0;
				const end =
					segment === range.end.segmentIndex ? range.end.graphemeIndex : boundaries.length - 1;
				const kind = prepared.kinds[segment];
				const advances = prepared.breakableFitAdvances[segment];
				for (let g = begin; g < end; g++) {
					const invisible =
						kind === "soft-hyphen" || kind === "zero-width-break" || kind === "hard-break";
					if (!invisible && painted) x += options.letterSpacing;
					if (kind === "tab") {
						const tab = prepared.tabStopAdvance;
						x += tab > 0 ? tab - (x % tab) : 0;
					} else if (!invisible) {
						// Same measured advances used by pretext's line breaker. Never an average glyph width.
						if (advances) x += advances[g] ?? 0;
						else if (boundaries.length === 2) x += prepared.widths[segment];
						else {
							// Preserved space runs are not overflow-breakable in pretext. Measure each
							// actual grapheme through the same font engine rather than divide the run.
							const unit = prepared.segments[segment].slice(boundaries[g], boundaries[g + 1]);
							const measured = prepareWithSegments(unit, options.font, { whiteSpace: "pre-wrap" });
							x += measured.widths.reduce((sum, width) => sum + width, 0);
						}
					}
					if (!invisible) painted = true;
					offsets.push(start + segmentOffsets[segment] + boundaries[g + 1]);
					xs.push(x);
				}
			}
			if (offsets[offsets.length - 1] < start + stop) {
				offsets.push(start + stop);
				xs.push(range.width);
			}
			// pretext corrects shaping/emoji width at segment boundaries. Keep the row edge exact.
			if (xs.length > 1) xs[xs.length - 1] = range.width;
			rows.push({
				start: start + consumed,
				end: start + stop,
				width: range.width,
				offsets: new Uint32Array(offsets),
				x: new Float64Array(xs),
			});
			consumed = stop;
		},
	);
	if (!rows.length)
		rows.push({
			start,
			end: start + text.length,
			width: 0,
			offsets: new Uint32Array([start, start + text.length]),
			x: new Float64Array([0, 0]),
		});
	return rows;
}

export function documentBoundaryAtX(line: TextDocumentVisualLine, x: number): number {
	let lo = 0,
		hi = line.x.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (line.x[mid] < x) lo = mid + 1;
		else hi = mid;
	}
	if (!lo) return 0;
	if (lo === line.x.length) return lo - 1;
	return x - line.x[lo - 1] < line.x[lo] - x ? lo - 1 : lo;
}

/** Only a bounded horizontal slice is sent, including one grapheme on either edge. */
export function sliceDocumentVisualLine(line: TextDocumentVisualLine, left: number, width: number) {
	const from = Math.max(0, documentBoundaryAtX(line, Math.max(0, left)) - 1);
	const to = Math.min(
		line.offsets.length - 1,
		documentBoundaryAtX(line, left + Math.max(1, width)) + 1,
	);
	return {
		start: line.offsets[from],
		end: line.offsets[to],
		left: line.x[from],
		points: Array.from(line.offsets.subarray(from, to + 1), (offset, index) => ({
			offset,
			x: line.x[from + index],
		})),
	};
}
