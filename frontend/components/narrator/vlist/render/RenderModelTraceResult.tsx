import { narratorsApi } from "@frontend/lib/api/narrators";
import { formatLocaleNumber } from "@frontend/lib/intl-format";
import { Box, Button, Group, Progress, Stack, Text } from "@mantine/core";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	MODELTRACE_LAYOUT as C,
	hasIncompleteCalibration,
	modelTraceRowHeight,
} from "../measure/measure-modeltrace-result";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";

function CalibrationAction({
	narratorId,
	resultId,
	continuing,
}: {
	narratorId: string;
	resultId: string;
	continuing: boolean;
}) {
	const { t } = useTranslation("narrator");
	const submitting = useRef(false);
	const [status, setStatus] = useState<"idle" | "submitting" | "requested">("idle");
	const [error, setError] = useState<string>();
	const calibrate = async () => {
		if (submitting.current || status === "requested") return;
		submitting.current = true;
		setStatus("submitting");
		setError(undefined);
		try {
			// The narrator message stream delivers progress and the new result card.
			await narratorsApi.calibrateModelTrace(narratorId, resultId);
			setStatus("requested");
		} catch (cause) {
			setError(
				cause instanceof Error && cause.message ? cause.message : t("modelTraceCalibrateFailed"),
			);
			setStatus("idle");
		} finally {
			submitting.current = false;
		}
	};
	return (
		<Group h={C.calibration} gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
			<Button
				size="compact-xs"
				variant="light"
				loading={status === "submitting"}
				disabled={status !== "idle"}
				onClick={calibrate}
				style={{ maxWidth: "100%", flexShrink: 0 }}
			>
				{t(
					status === "requested"
						? "modelTraceCalibrationRequested"
						: continuing
							? "modelTraceContinueCalibration"
							: "modelTraceCalibrate",
				)}
			</Button>
			{error && (
				<Text role="alert" fz={11} c="red" truncate title={error} style={{ minWidth: 0 }}>
					{error}
				</Text>
			)}
		</Group>
	);
}

export function RenderModelTraceResult({
	measured,
	calibrationNarratorId,
}: {
	measured: MeasuredElement;
	calibrationNarratorId?: string;
}) {
	const { t, i18n } = useTranslation("narrator");
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const data = block.data as unknown as ModelTraceResultBlock;
	const footnote = data.decision === "partial" ? t("modelTracePartial") : t("modelTraceFootnote");
	const emptyMessage =
		data.error ||
		(data.progressOnly
			? t("modelTraceSampling")
			: data.decision === "not_model"
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
		hasIncompleteCalibration(data) ? t("modelTraceCalibrationIncomplete") : undefined,
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
					<Text
						fz={12}
						lh={`${C.name}px`}
						h={C.name}
						c={data.progressOnly && !data.error ? "dimmed" : "red"}
						truncate
						title={emptyMessage}
					>
						{emptyMessage}
					</Text>
				)}
				{data.sampleProgress?.map((slot, index) => {
					const state = t(`modelTraceSampleState.${slot.state}`);
					const label = t("modelTraceSampleSlot", { slot: index + 1, state });
					const attempt = slot.attempt && t("modelTraceSampleAttempt", { attempt: slot.attempt });
					const description = [label, attempt, slot.text].filter(Boolean).join(" · ");
					return (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed protocol slots never reorder
							key={index + 1}
							data-modeltrace-sample-state={slot.state}
							fz={11}
							lh={`${C.footnote}px`}
							h={C.footnote}
							c={slot.state === "failed" ? "red" : "dimmed"}
							truncate
							title={description}
						>
							{description}
						</Text>
					);
				})}
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
				{data.calibrationId && calibrationNarratorId && (
					<CalibrationAction
						key={JSON.stringify([calibrationNarratorId, data.calibrationId])}
						narratorId={calibrationNarratorId}
						resultId={data.calibrationId}
						continuing={data.calibrationRequested === true}
					/>
				)}
			</Stack>
		</Box>
	);
}
