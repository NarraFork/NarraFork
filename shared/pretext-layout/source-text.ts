/** Normalized UTF-16 coordinates in a parameter source, not file coordinates. */
export interface SourceTextRange {
	epoch: string;
	startOffset: number;
	endOffset: number;
	/** Zero-based source line and column of the retained first character. */
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	originKnown: boolean;
	complete: boolean;
	/** A terminal CR already counted as LF; a following LF must not count twice. */
	endsWithCR?: boolean;
	/** At most one verified old-coordinate translation, never a version history. */
	remap?: SourceTextRemap;
}

export interface SourceTextRemap {
	fromEpoch: string;
	fromStartOffset: number;
	fromEndOffset: number;
	fromStartLine: number;
	offsetDelta: number;
	lineDelta: number;
	/** Only the old first observed line needs this column translation. */
	columnDelta: number;
}

export interface SourceTextSnapshot {
	/** Original line endings are retained; offsets count normalized CRLF/CR as LF. */
	text: string;
	range: SourceTextRange;
}

export function normalizeSourceText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Move forward, never backward into half of a CRLF or a UTF-16 surrogate pair. */
export function safeSourceSliceStart(text: string, start: number): number {
	const index = Math.max(0, Math.min(text.length, Math.trunc(start)));
	const before = text.charCodeAt(index - 1);
	const after = text.charCodeAt(index);
	return (before === 13 && after === 10) ||
		(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
		? index + 1
		: index;
}

interface SourcePosition {
	offset: number;
	line: number;
	column: number;
}

/** Only deltas and actually evicted characters are scanned on the append path. */
function advance(text: string, position: SourcePosition, previousCR = false): SourcePosition {
	let { offset, line, column } = position;
	for (let i = previousCR && text.startsWith("\n") ? 1 : 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		offset++;
		if (code === 13 || code === 10) {
			line++;
			column = 0;
			if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
		} else column++;
	}
	return { offset, line, column };
}

export function trimSourceText(source: SourceTextSnapshot, limit: number): SourceTextSnapshot {
	const start = safeSourceSliceStart(source.text, source.text.length - Math.max(0, limit));
	if (!start) return source;
	const position = advance(source.text.slice(0, start), {
		offset: source.range.startOffset,
		line: source.range.startLine,
		column: source.range.startColumn,
	});
	return {
		text: source.text.slice(start),
		range: {
			...source.range,
			startOffset: position.offset,
			startLine: position.line,
			startColumn: position.column,
			complete: false,
		},
	};
}

export function createSourceText(
	text: string,
	options: { epoch: string; originKnown?: boolean; complete?: boolean; limit?: number },
): SourceTextSnapshot {
	const end = advance(text, { offset: 0, line: 0, column: 0 });
	const source: SourceTextSnapshot = {
		text,
		range: {
			epoch: options.epoch,
			startOffset: 0,
			endOffset: end.offset,
			startLine: 0,
			startColumn: 0,
			endLine: end.line,
			endColumn: end.column,
			originKnown: options.originKnown ?? true,
			complete: options.complete ?? false,
			endsWithCR: text.endsWith("\r"),
		},
	};
	return options.limit === undefined ? source : trimSourceText(source, options.limit);
}

export function appendSourceText(
	previous: SourceTextSnapshot,
	delta: string,
	limit: number,
): SourceTextSnapshot {
	if (!delta) return previous;
	const end = advance(
		delta,
		{
			offset: previous.range.endOffset,
			line: previous.range.endLine,
			column: previous.range.endColumn,
		},
		previous.range.endsWithCR,
	);
	return trimSourceText(
		{
			text: previous.text + delta,
			range: {
				...previous.range,
				endOffset: end.offset,
				endLine: end.line,
				endColumn: end.column,
				endsWithCR: delta.endsWith("\r"),
				complete: false,
			},
		},
		limit,
	);
}

/** Deterministic and bounded even after arbitrarily many discontinuities. */
export function nextSourceEpoch(epoch: string): string {
	const match = /^(.*):v(\d+)$/.exec(epoch);
	return match ? `${match[1]}:v${Number(match[2]) + 1}` : `${epoch}:v1`;
}

/**
 * A complete parameter can validate coordinates by exact known offsets, or by
 * matching the ENTIRE observed tail against its end. Never search repeated lines.
 * Unknown → known changes coordinate systems, so a new epoch carries one explicit
 * translation; ordinary append/head eviction never changes epochs.
 */
export function reconcileSourceText(
	previous: SourceTextSnapshot | undefined,
	text: string,
	options: { epoch: string; limit?: number },
): SourceTextSnapshot {
	if (!previous) return createSourceText(text, { ...options, complete: true });
	const normalized = normalizeSourceText(text);
	const observed = normalizeSourceText(previous.text);
	const before = previous.range;
	const knownMatch =
		before.originKnown &&
		before.endOffset <= normalized.length &&
		normalized.slice(before.startOffset, before.endOffset) === observed;
	let epoch = knownMatch ? before.epoch : nextSourceEpoch(before.epoch);
	let remap = knownMatch ? before.remap : undefined;
	if (!before.originKnown && observed.length > 0 && normalized.endsWith(observed)) {
		const start = normalized.length - observed.length;
		if (start >= before.startOffset) {
			const position = advance(normalized.slice(0, start), { offset: 0, line: 0, column: 0 });
			remap = {
				fromEpoch: before.epoch,
				fromStartOffset: before.startOffset,
				fromEndOffset: before.endOffset,
				fromStartLine: before.startLine,
				offsetDelta: start - before.startOffset,
				lineDelta: position.line - before.startLine,
				columnDelta: position.column - before.startColumn,
			};
		}
	}
	// Repeated complete snapshots retain the already verified epoch and remap.
	if (knownMatch) epoch = before.epoch;
	const result = createSourceText(text, { epoch, complete: true, limit: options.limit });
	if (remap) result.range.remap = remap;
	return result;
}

/** Reject wire-shaped garbage without inventing a source origin from its text. */
export function isSourceTextRange(value: unknown): value is SourceTextRange {
	if (!value || typeof value !== "object") return false;
	const range = value as SourceTextRange;
	return (
		typeof range.epoch === "string" &&
		typeof range.originKnown === "boolean" &&
		typeof range.complete === "boolean" &&
		[
			range.startOffset,
			range.endOffset,
			range.startLine,
			range.startColumn,
			range.endLine,
			range.endColumn,
		].every((number) => Number.isSafeInteger(number) && number >= 0) &&
		range.endOffset >= range.startOffset &&
		range.endLine >= range.startLine
	);
}
