import { ActionIcon, Button, Group, Stack, TextInput } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pickerToWall, wallToPicker } from "./schedule-presentation";
import { TaskDateTimePicker } from "./TaskDateTimePicker";

/** Mounted per schedule kind/unit; edits keep row identity even when values are empty or duplicated. */
export function ScheduleTimeInputs({
	times,
	date,
	limit,
	onChange,
	fieldError,
}: {
	times: string[];
	date?: boolean;
	limit: number;
	onChange: (times: string[]) => void;
	fieldError: (index: number) => string | undefined;
}) {
	const { t } = useTranslation("scheduledTasks");
	const [keys, setKeys] = useState(() => times.map((_, index) => index));
	const nextKey = useRef(times.length);
	return (
		<Stack gap="xs">
			{times.map((time, index) => (
				<Group key={keys[index]} align="flex-end" wrap="nowrap">
					{date ? (
						<TaskDateTimePicker
							style={{ flex: 1, minWidth: 0 }}
							label={t("timeNumber", { number: index + 1 })}
							valueFormat="YYYY-MM-DD HH:mm"
							value={wallToPicker(time)}
							onChange={(value) =>
								onChange(times.map((old, i) => (i === index ? pickerToWall(value) : old)))
							}
							error={fieldError(index)}
						/>
					) : (
						<TextInput
							type="time"
							style={{ flex: 1, minWidth: 0 }}
							label={t("timeNumber", { number: index + 1 })}
							value={time}
							onChange={(event) =>
								onChange(times.map((old, i) => (i === index ? event.currentTarget.value : old)))
							}
							error={fieldError(index)}
						/>
					)}
					<ActionIcon
						variant="subtle"
						color="red"
						aria-label={t("removeTime")}
						disabled={times.length <= 1}
						onClick={() => {
							setKeys((old) => old.filter((_, i) => i !== index));
							onChange(times.filter((_, i) => i !== index));
						}}
					>
						<IconTrash size={16} />
					</ActionIcon>
				</Group>
			))}
			<Button
				variant="light"
				size="xs"
				w="fit-content"
				leftSection={<IconPlus size={14} />}
				disabled={times.length >= limit}
				onClick={() => {
					const key = nextKey.current++;
					setKeys((old) => [...old, key]);
					onChange([...times, date ? "" : "12:00"]);
				}}
			>
				{t("addTime")}
			</Button>
		</Stack>
	);
}
