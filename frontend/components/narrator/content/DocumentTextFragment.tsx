import type { ReactNode } from "react";

/** Tab stops belong to the original visual line, not the horizontally clipped fragment. */
export function DocumentTextFragment({
	text,
	start,
	positions,
}: {
	text: string;
	start: number;
	positions: ReadonlyMap<number, number>;
}) {
	if (!text.includes("\t")) return text;
	const pieces: ReactNode[] = [];
	let previous = 0;
	for (let index = text.indexOf("\t"); index >= 0; index = text.indexOf("\t", previous)) {
		if (index > previous)
			pieces.push(
				<span
					key={start + previous}
					data-source-start={start + previous}
					data-source-end={start + index}
				>
					{text.slice(previous, index)}
				</span>,
			);
		const left = positions.get(start + index);
		const right = positions.get(start + index + 1);
		pieces.push(
			left !== undefined && right !== undefined ? (
				<span
					key={start + index}
					aria-hidden="true"
					data-source-start={start + index}
					data-source-end={start + index + 1}
					style={{ display: "inline-block", width: Math.max(0, right - left) }}
				/>
			) : (
				"\t"
			),
		);
		previous = index + 1;
	}
	if (previous < text.length)
		pieces.push(
			<span
				key={start + previous}
				data-source-start={start + previous}
				data-source-end={start + text.length}
			>
				{text.slice(previous)}
			</span>,
		);
	return pieces;
}
