import { Box, Group, Progress, Stack, Text } from "@mantine/core";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { useTranslation } from "react-i18next";
import { MODELTRACE_LAYOUT as C, modelTraceRowHeight } from "../measure/measure-modeltrace-result";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";

export function RenderModelTraceResult({ measured }: { measured: MeasuredElement }) {
	const { t } = useTranslation("narrator");
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const data = block.data as unknown as ModelTraceResultBlock;
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
								const percentage = `${(row.probability * 100).toFixed(1)}%`;
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
											<Text
												fz={winner ? 17 : 12}
												fw={winner ? 700 : 500}
												lh={`${lineHeight}px`}
												style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
											>
												{percentage}
											</Text>
										</Group>
										<Progress
											value={row.probability * 100}
											size={winner ? C.winnerBar : C.bar}
											aria-label={name}
											color={winner ? undefined : "gray"}
										/>
									</Stack>
								);
							})}
						</Stack>
						<Text fz={11} lh={`${C.footnote}px`} h={C.footnote} c="dimmed" truncate>
							{t("modelTraceFootnote")}
						</Text>
					</>
				) : (
					<Text
						fz={12}
						lh={`${C.name}px`}
						h={C.name}
						c="red"
						truncate
						title={data.error || t("modelTraceUnavailable")}
					>
						{data.error || t("modelTraceUnavailable")}
					</Text>
				)}
			</Stack>
		</Box>
	);
}
