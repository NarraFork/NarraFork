import { DateTimePicker, type DateTimePickerProps } from "@mantine/dates";
import "dayjs/locale/zh-cn";
import { useTranslation } from "react-i18next";

/** Keep calendar labels localized without changing wall-time semantics or global dayjs state. */
export function TaskDateTimePicker(props: DateTimePickerProps) {
	const { t, i18n } = useTranslation("scheduledTasks");
	return (
		<DateTimePicker
			locale={i18n.language.startsWith("zh") ? "zh-cn" : "en"}
			firstDayOfWeek={1}
			ariaLabels={{
				monthLevelControl: t("calendar.chooseMonth"),
				yearLevelControl: t("calendar.chooseYear"),
				nextMonth: t("calendar.nextMonth"),
				previousMonth: t("calendar.previousMonth"),
				nextYear: t("calendar.nextYear"),
				previousYear: t("calendar.previousYear"),
				nextDecade: t("calendar.nextDecade"),
				previousDecade: t("calendar.previousDecade"),
			}}
			timePickerProps={{
				hoursInputLabel: t("calendar.hours"),
				minutesInputLabel: t("calendar.minutes"),
			}}
			submitButtonProps={{ "aria-label": t("calendar.confirm") }}
			clearButtonProps={{ "aria-label": t("calendar.clear") }}
			{...props}
		/>
	);
}
