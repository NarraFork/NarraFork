import { Badge, Group, Select, Stack, Text, UnstyledButton } from "@mantine/core";
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@shared/reasoning-effort";
import { isSubagentReasoningEffort } from "@shared/subagent-model-policy";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

export function SubagentReasoningEffortSelect({
	model,
	value,
	onChange,
	disabled,
}: {
	model: string;
	value?: ReasoningEffort;
	onChange: (value: ReasoningEffort | undefined) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group gap="xs" wrap="nowrap">
			<Text size="xs" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
				{model}
			</Text>
			<Select
				aria-label={`${model}: ${t("poolReasoningEffort.title")}`}
				size="xs"
				w={150}
				style={{ flexShrink: 0 }}
				value={value ?? "__unspecified__"}
				data={[
					{ value: "__unspecified__", label: t("poolReasoningEffort.unspecified") },
					...REASONING_EFFORT_VALUES.map((effort) => ({
						value: effort,
						label: t(`reasoning_${effort}`),
					})),
				]}
				disabled={disabled}
				allowDeselect={false}
				onChange={(next) => {
					if (next === "__unspecified__") onChange(undefined);
					else if (isSubagentReasoningEffort(next)) onChange(next);
				}}
			/>
		</Group>
	);
}

/** Disclosure is presentation only: closing never resets or initializes policy. */
export function SubagentReasoningEffortSection({
	count,
	help,
	children,
}: {
	count: number;
	help: string;
	children: ReactNode;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const id = useId();
	return (
		<Stack gap="xs">
			<UnstyledButton aria-expanded={opened} aria-controls={id} onClick={() => setOpened(!opened)}>
				<Group gap={6}>
					{opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
					<Text size="sm">{t("poolReasoningEffort.title")}</Text>
					{count > 0 && <Badge size="xs">{t("poolReasoningEffort.fixedCount", { count })}</Badge>}
				</Group>
			</UnstyledButton>
			<div id={id} hidden={!opened}>
				{opened && (
					<Stack gap="xs">
						<Text size="xs" c="dimmed">
							{help}
						</Text>
						{children}
					</Stack>
				)}
			</div>
		</Stack>
	);
}
