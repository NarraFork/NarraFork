/**
 * 导出消息范围的输入：片段在框内，点叉删除；也可以直接敲 `3-10` 回车追加。
 *
 * 对外的值始终是规范化的原始串（`1-10,15`），所以导出与弹窗都只认一种格式。
 */
import { Input, Pill, PillsInput, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	expandTurnRange,
	formatTurnRange,
	parseTurnRange,
	TURN_RANGE_MAX_TURNS,
	type TurnRange,
} from "../../../../shared/export-turn-range";

export function TurnRangeInput({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const [draft, setDraft] = useState("");
	// 没能并进范围的输入要当场说出来：留在框里却不生效，导出时会被悄悄忽略。
	const [draftError, setDraftError] = useState<string | null>(null);
	const ranges = parseTurnRange(value);
	const invalid = ranges === null;

	/** 合并后超过上限的范围服务端会拒绝（400），在这里就挡住。 */
	const apply = (next: readonly TurnRange[]): boolean => {
		if (!expandTurnRange(next)) {
			setDraftError(t("details.exportRangeTooLarge", { max: TURN_RANGE_MAX_TURNS }));
			return false;
		}
		onChange(formatTurnRange(next));
		setDraft("");
		setDraftError(null);
		return true;
	};

	const appendDraft = () => {
		const raw = draft.trim();
		if (!raw) {
			setDraftError(null);
			return;
		}
		const parsed = parseTurnRange(raw);
		if (!parsed) {
			setDraftError(t("details.exportRangeInvalid"));
			return;
		}
		// 合并交给 formatTurnRange/parseTurnRange：重叠与相邻会自己并起来。
		apply([...(ranges ?? []), ...parsed]);
	};

	return (
		<Input.Wrapper
			label={t("details.exportRange")}
			error={invalid ? t("details.exportRangeInvalid") : (draftError ?? undefined)}
		>
			<PillsInput disabled={disabled}>
				{!invalid &&
					ranges.map((range) => (
						<Pill
							key={`${range.from}-${range.to}`}
							withRemoveButton
							onRemove={() => apply(ranges.filter((item) => item !== range))}
							removeButtonProps={{ "aria-label": t("details.exportRangeRemove") }}
						>
							{range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`}
						</Pill>
					))}
				<PillsInput.Field
					value={draft}
					placeholder={ranges?.length ? "" : t("details.exportRangePlaceholder")}
					disabled={disabled}
					onChange={(event) => {
						setDraft(event.currentTarget.value);
						setDraftError(null);
					}}
					onKeyDown={(event) => {
						if (event.key !== "Enter" && event.key !== ",") return;
						event.preventDefault();
						appendDraft();
					}}
					onBlur={() => appendDraft()}
					onPaste={(event) => {
						// 粘贴一长串时直接解析，省得逐段回车。
						const text = event.clipboardData.getData("text");
						const parsed = parseTurnRange(text);
						if (!parsed) return;
						event.preventDefault();
						if (!apply([...(ranges ?? []), ...parsed])) setDraft(text);
					}}
				/>
			</PillsInput>
			{invalid ? (
				<Text size="xs" c="red" mt={4}>
					{value}
				</Text>
			) : null}
		</Input.Wrapper>
	);
}
