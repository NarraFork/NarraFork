import { formatLocaleNumber } from "@frontend/lib/intl-format";
import { Box, Group, Progress, Stack, Text } from "@mantine/core";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { useTranslation } from "react-i18next";
import { MODELTRACE_LAYOUT as C, modelTraceRowHeight } from "../measure/measure-modeltrace-result";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";

export function RenderModelTraceResult({ measured }: { measured: MeasuredElement }) {
	const { t, i18n } = useTranslation("narrator");
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const data = block.data as unknown as ModelTraceResultBlock;
	const footnote = data.decision === "partial" ? t("modelTracePartial") : t("modelTraceFootnote");
	const emptyMessage =
		data.error ||
		(data.decision === "not_model"
			? t("modelTraceNotModel")
			: data.decision === "unscorable"
				? t("modelTraceUnscorable")
				: t("modelTraceUnavailable"));
	const cacheNote = data.cacheReadTokens?.length
		? t("modelTraceCacheReads", {
				reads: data.cacheReadTokens
					.map((tokens) =>
						tokens === null
							? t("modelTraceCacheUnknown")
							: formatLocaleNumber(tokens, {}, i18n.language),
					)
					.join(" · "),
			})
		: undefined;
	const notes = [
		data.calibrationRequested && data.decision !== "scored"
			? t("modelTraceCalibrationIncomplete")
			: undefined,
		cacheNote,
	];
	return (
		<Box
			data-modeltrace-result
			p={C.padding}
			style={{
				height: measured.height,
				width: "100%",
				minWidth: 0,
				boxSizing: "border-box",
				overflow: "hidden",
			}}
		>
			<Stack gap={C.gap} style={{ minWidth: 0 }}>
				{data.results.length > 0 ? (
					<>
						<Stack gap={C.gap}>
							{data.results.map((row, index) => {
								const winner = index === 0;
								const lineHeight = winner ? C.winnerName : C.name;
								const name = row.displayName || row.model;
								const percentage = row.probability === null ? null : row.probability * 100;
								return (
									<Stack key={row.model} gap={C.barGap} h={modelTraceRowHeight(winner)}>
										<Group gap={8} wrap="nowrap" h={lineHeight}>
											<Text
												fz={winner ? 17 : 12}
												fw={winner ? 700 : 400}
												lh={`${lineHeight}px`}
												c={winner ? "var(--mantine-primary-color-light-color)" : undefined}
												style={{ flex: 1, minWidth: 0 }}
												truncate
												title={name}
											>
												{name}
											</Text>
											{percentage !== null && (
												<Text
													fz={winner ? 17 : 12}
													fw={winner ? 700 : 500}
													lh={`${lineHeight}px`}
													style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
												>
													{percentage.toFixed(1)}%
												</Text>
											)}
										</Group>
										{percentage !== null && (
											<Progress
												value={percentage}
												size={winner ? C.winnerBar : C.bar}
												aria-label={name}
												color={winner ? undefined : "gray"}
											/>
										)}
									</Stack>
								);
							})}
						</Stack>
						<Text
							fz={11}
							lh={`${C.footnote}px`}
							h={C.footnote}
							c="dimmed"
							title={footnote}
							truncate
						>
							{footnote}
						</Text>
					</>
				) : (
					<Text fz={12} lh={`${C.name}px`} h={C.name} c="red" truncate title={emptyMessage}>
						{emptyMessage}
					</Text>
				)}
				{notes.map(
					(note) =>
						note && (
							<Text
								key={note}
								fz={11}
								lh={`${C.footnote}px`}
								h={C.footnote}
								c="dimmed"
								title={note}
								truncate
							>
								{note}
							</Text>
						),
				)}
			</Stack>
		</Box>
	);
}
