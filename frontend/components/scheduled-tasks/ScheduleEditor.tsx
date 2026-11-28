import {
	Chip,
	Group,
	NumberInput,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import {
	type RepeatRule,
	type RepeatUnit,
	SCHEDULE_LIMITS,
	type ScheduleEnd,
	type TaskSchedule,
} from "@shared/scheduled-task-schedule";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScheduleTimeInputs } from "./ScheduleTimeInputs";
import { pickerToWall, WEEKDAY_KEYS, wallToPicker } from "./schedule-presentation";
import { TaskDateTimePicker } from "./TaskDateTimePicker";

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

function defaultRule(unit: RepeatUnit, interval = 1): RepeatRule {
	if (unit === "minute") return { unit, interval };
	if (unit === "hour") return { unit, interval, minute: 0 };
	if (unit === "week") return { unit, interval, weekdays: [1], times: ["09:00"] };
	if (unit === "month") return { unit, interval, monthDays: [1], times: ["09:00"] };
	return { unit, interval, times: ["09:00"] };
}

export function ScheduleEditor({
	schedule,
	timezone,
	allowServerTimezone,
	onChange,
	onTimezoneChange,
	errorPath,
	error,
}: {
	schedule: TaskSchedule;
	timezone: string;
	allowServerTimezone?: boolean;
	onChange: (schedule: TaskSchedule) => void;
	onTimezoneChange: (timezone: string) => void;
	errorPath?: string;
	error?: string;
}) {
	const { t } = useTranslation("scheduledTasks");
	const zones = useMemo(
		() => [
			...new Set(["UTC", ...(timezone ? [timezone] : []), ...Intl.supportedValuesOf("timeZone")]),
		],
		[timezone],
	);
	const fieldError = (path: string) =>
		errorPath === path || errorPath?.startsWith(`${path}.`) ? error : undefined;
	const setRule = (rule: RepeatRule) => {
		if (schedule.kind === "repeat") onChange({ ...schedule, rule });
	};
	const setEnd = (end: ScheduleEnd) => {
		if (schedule.kind !== "at") onChange({ ...schedule, end });
	};
	return (
		<Stack gap="md">
			<SegmentedControl
				fullWidth
				value={schedule.kind}
				onChange={(kind) =>
					onChange(
						kind === "at"
							? { kind, times: [""] }
							: kind === "cron"
								? { kind, expr: "0 9 * * *", end: { type: "never" } }
								: { kind: "repeat", rule: defaultRule("day"), end: { type: "never" } },
					)
				}
				data={[
					{ value: "at", label: t("kind.at") },
					{ value: "repeat", label: t("kind.repeat") },
					{ value: "cron", label: t("kind.cron") },
				]}
			/>
			<Select
				label={t("timezone")}
				description={t("timezoneDesc")}
				required={!allowServerTimezone}
				searchable
				limit={50}
				data={[
					...(allowServerTimezone ? [{ value: "", label: t("serverTimezone") }] : []),
					...zones.map((zone) => ({ value: zone, label: zone })),
				]}
				value={timezone}
				onChange={(value) => onTimezoneChange(value ?? "")}
				error={fieldError("timezone")}
			/>
			{schedule.kind === "at" && (
				<Stack gap="xs">
					<Text size="sm">{t("specificTimes")}</Text>
					<ScheduleTimeInputs
						key="at"
						date
						times={schedule.times}
						limit={SCHEDULE_LIMITS.maxAtTimes}
						onChange={(times) => onChange({ ...schedule, times })}
						fieldError={(index) =>
							fieldError(`times.${index}`) ?? (index === 0 ? fieldError("times") : undefined)
						}
					/>
				</Stack>
			)}
			{schedule.kind === "repeat" && (
				<>
					<Group align="flex-start" grow>
						<NumberInput
							label={t("everyInterval")}
							min={1}
							max={SCHEDULE_LIMITS.interval[schedule.rule.unit]}
							allowDecimal={false}
							value={schedule.rule.interval}
							onChange={(value) => setRule({ ...schedule.rule, interval: Number(value) })}
							error={fieldError("rule.interval")}
						/>
						<Select
							label={t("repeatUnit")}
							value={schedule.rule.unit}
							data={["minute", "hour", "day", "week", "month"].map((unit) => ({
								value: unit,
								label: t(`unit.${unit}`),
							}))}
							onChange={(unit) => setRule(defaultRule(unit as RepeatUnit))}
						/>
					</Group>
					{schedule.rule.unit === "hour" && (
						<NumberInput
							label={t("hourlyMinuteLabel")}
							min={0}
							max={59}
							allowDecimal={false}
							value={schedule.rule.minute}
							onChange={(value) => {
								if (schedule.rule.unit === "hour")
									setRule({ ...schedule.rule, minute: Number(value) });
							}}
							error={fieldError("rule.minute")}
						/>
					)}
					{schedule.rule.unit === "week" && (
						<Stack gap="xs">
							<Text size="sm">{t("weekday")}</Text>
							<Chip.Group
								multiple
								value={schedule.rule.weekdays.map(String)}
								onChange={(weekdays) => {
									if (schedule.rule.unit === "week")
										setRule({ ...schedule.rule, weekdays: weekdays.map(Number) });
								}}
							>
								<Group gap="xs">
									{[1, 2, 3, 4, 5, 6, 0].map((day) => (
										<Chip value={String(day)} key={day} size="xs">
											{t(WEEKDAY_KEYS[day])}
										</Chip>
									))}
								</Group>
							</Chip.Group>
							{fieldError("rule.weekdays") && (
								<Text c="red" size="xs">
									{error}
								</Text>
							)}
						</Stack>
					)}
					{schedule.rule.unit === "month" && (
						<Stack gap="xs">
							<Text size="sm">{t("monthDays")}</Text>
							<Chip.Group
								multiple
								value={schedule.rule.monthDays.map(String)}
								onChange={(days) => {
									if (schedule.rule.unit === "month")
										setRule({
											...schedule.rule,
											monthDays: days.map((day) => (day === "last" ? "last" : Number(day))),
										});
								}}
							>
								<Group gap={6}>
									{MONTH_DAYS.map((day) => (
										<Chip size="xs" key={day} value={String(day)}>
											{day}
										</Chip>
									))}
									<Chip size="xs" value="last">
										{t("lastDay")}
									</Chip>
								</Group>
							</Chip.Group>
							<Text c={fieldError("rule.monthDays") ? "red" : "dimmed"} size="xs">
								{fieldError("rule.monthDays") || t("monthDaysHint")}
							</Text>
						</Stack>
					)}
					{"times" in schedule.rule && (
						<Stack gap="xs">
							<Text size="sm">{t("timesOfDay")}</Text>
							<ScheduleTimeInputs
								key={schedule.rule.unit}
								times={schedule.rule.times}
								limit={SCHEDULE_LIMITS.maxTimesOfDay}
								onChange={(times) => {
									if ("times" in schedule.rule) setRule({ ...schedule.rule, times });
								}}
								fieldError={(index) =>
									fieldError(`rule.times.${index}`) ??
									(index === 0 ? fieldError("rule.times") : undefined)
								}
							/>
						</Stack>
					)}
				</>
			)}
			{schedule.kind === "cron" && (
				<TextInput
					label={t("cronExpr")}
					description={t("cronExprDesc")}
					value={schedule.expr}
					onChange={(event) => onChange({ ...schedule, expr: event.currentTarget.value })}
					error={fieldError("expr")}
				/>
			)}
			{schedule.kind !== "at" && (
				<>
					<TaskDateTimePicker
						clearable
						label={t("startAt")}
						valueFormat="YYYY-MM-DD HH:mm"
						value={wallToPicker(schedule.startAt)}
						onChange={(value) => onChange({ ...schedule, startAt: pickerToWall(value) || null })}
						error={fieldError("startAt")}
					/>
					<Select
						label={t("endCondition")}
						value={schedule.end.type}
						data={[
							{ value: "never", label: t("end.never") },
							{ value: "count", label: t("end.count") },
							{ value: "until", label: t("end.until") },
						]}
						onChange={(type) =>
							setEnd(
								type === "count"
									? { type, count: 3 }
									: type === "until"
										? { type, until: "" }
										: { type: "never" },
							)
						}
					/>
					{schedule.end.type === "count" && (
						<NumberInput
							label={t("plannedCount")}
							description={t("countHint")}
							min={1}
							max={SCHEDULE_LIMITS.maxCount}
							allowDecimal={false}
							value={schedule.end.count}
							onChange={(value) => setEnd({ type: "count", count: Number(value) })}
							error={fieldError("end.count")}
						/>
					)}
					{schedule.end.type === "until" && (
						<TaskDateTimePicker
							label={t("until")}
							valueFormat="YYYY-MM-DD HH:mm"
							value={wallToPicker(schedule.end.until)}
							onChange={(value) => setEnd({ type: "until", until: pickerToWall(value) })}
							error={fieldError("end")}
						/>
					)}
				</>
			)}
		</Stack>
	);
}
