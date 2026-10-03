export interface DocumentPaintToken {
	start: number;
	end: number;
	color?: string;
	fontStyle?: number;
	pending?: boolean;
}

/** Preserve confirmed colour in old windows; gaps remain readable and explicitly pending. */
export function documentPaintTokens(
	start: number,
	end: number,
	incoming: readonly DocumentPaintToken[],
	retained: readonly DocumentPaintToken[] = [],
): DocumentPaintToken[] {
	if (end <= start) return [];
	const clip = (tokens: readonly DocumentPaintToken[]) =>
		tokens
			.filter((token) => token.end > start && token.start < end && token.end > token.start)
			.map((token) => ({
				...token,
				start: Math.max(start, token.start),
				end: Math.min(end, token.end),
			}))
			.sort((a, b) => a.start - b.start || a.end - b.end);
	const current = clip(incoming);
	const old = clip(retained);
	const boundaries = [
		...new Set([
			start,
			end,
			...current.flatMap((token) => [token.start, token.end]),
			...old.flatMap((token) => [token.start, token.end]),
		]),
	].sort((a, b) => a - b);
	const result: DocumentPaintToken[] = [];
	let currentIndex = 0;
	let oldIndex = 0;
	for (let index = 0; index < boundaries.length - 1; index++) {
		const left = boundaries[index];
		const right = boundaries[index + 1];
		while (currentIndex < current.length && current[currentIndex].end <= left) currentIndex++;
		while (oldIndex < old.length && old[oldIndex].end <= left) oldIndex++;
		const fresh = current[currentIndex]?.start <= left ? current[currentIndex] : undefined;
		const prior = old[oldIndex]?.start <= left ? old[oldIndex] : undefined;
		const style = fresh ?? prior;
		const token = {
			start: left,
			end: right,
			color: style?.color ?? "inherit",
			fontStyle: style?.fontStyle,
			...(!fresh ? { pending: true } : {}),
		};
		const last = result.at(-1);
		if (
			last &&
			last.end === left &&
			last.color === token.color &&
			last.fontStyle === token.fontStyle &&
			last.pending === token.pending
		)
			last.end = right;
		else result.push(token);
	}
	return result;
}
