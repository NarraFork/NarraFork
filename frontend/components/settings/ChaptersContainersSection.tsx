import { NumberInput, Stack, Switch, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";

export interface ChaptersContainersSectionProps {
	maxWorktrees: number;
	setMaxWorktrees: (v: number) => void;
	maxContainers: number;
	setMaxContainers: (v: number) => void;
	sizeWarning: number;
	setSizeWarning: (v: number) => void;
	autoSave: boolean;
	setAutoSave: (v: boolean) => void;
	dormantMinutes: number;
	setDormantMinutes: (v: number) => void;
	acReminderLines: number;
	setAcReminderLines: (v: number) => void;
	acReminderFiles: number;
	setAcReminderFiles: (v: number) => void;
	acForceLines: number;
	setAcForceLines: (v: number) => void;
	acForceFiles: number;
	setAcForceFiles: (v: number) => void;
	portStart: number;
	setPortStart: (v: number) => void;
	portEnd: number;
	setPortEnd: (v: number) => void;
	proxyEnabled: boolean;
	setProxyEnabled: (v: boolean) => void;
	proxyPort: number;
	setProxyPort: (v: number) => void;
}

export function ChaptersContainersSection(props: ChaptersContainersSectionProps) {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			{/* Chapters */}
			<Title order={5}>{t("chaptersSubSection")}</Title>
			<NumberInput
				label={t("maxActiveWorktrees")}
				value={props.maxWorktrees}
				onChange={(v) => props.setMaxWorktrees(typeof v === "number" ? v : 10)}
				min={1}
				max={50}
			/>
			<NumberInput
				label={t("maxActiveContainers")}
				value={props.maxContainers}
				onChange={(v) => props.setMaxContainers(typeof v === "number" ? v : 5)}
				min={1}
				max={20}
			/>
			<NumberInput
				label={t("worktreeSizeWarning")}
				value={props.sizeWarning}
				onChange={(v) => props.setSizeWarning(typeof v === "number" ? v : 500)}
				min={100}
				suffix=" MB"
			/>
			<Switch
				label={t("autoSaveOnDormant")}
				checked={props.autoSave}
				onChange={(e) => props.setAutoSave(e.currentTarget.checked)}
			/>
			<NumberInput
				label={t("dormantAfterMinutes")}
				description={t("dormantAfterMinutesDesc")}
				value={props.dormantMinutes}
				onChange={(v) => props.setDormantMinutes(typeof v === "number" ? v : 0)}
				min={0}
			/>

			{/* Auto-Commit Thresholds */}
			<Title order={5} mt="sm">
				{t("autoCommitSection")}
			</Title>
			<NumberInput
				label={t("autoCommitReminderLines")}
				description={t("autoCommitReminderLinesDesc")}
				value={props.acReminderLines}
				onChange={(v) => props.setAcReminderLines(typeof v === "number" ? v : 1000)}
				min={0}
				step={50}
			/>
			<NumberInput
				label={t("autoCommitReminderFiles")}
				description={t("autoCommitReminderFilesDesc")}
				value={props.acReminderFiles}
				onChange={(v) => props.setAcReminderFiles(typeof v === "number" ? v : 10)}
				min={0}
			/>
			<NumberInput
				label={t("autoCommitForceLines")}
				description={t("autoCommitForceLinesDesc")}
				value={props.acForceLines}
				onChange={(v) => props.setAcForceLines(typeof v === "number" ? v : 2000)}
				min={0}
				step={100}
			/>
			<NumberInput
				label={t("autoCommitForceFiles")}
				description={t("autoCommitForceFilesDesc")}
				value={props.acForceFiles}
				onChange={(v) => props.setAcForceFiles(typeof v === "number" ? v : 25)}
				min={0}
			/>

			{/* Containers */}
			<Title order={5} mt="sm">
				{t("containersSubSection")}
			</Title>
			<NumberInput
				label={t("portRangeStart")}
				value={props.portStart}
				onChange={(v) => props.setPortStart(typeof v === "number" ? v : 10000)}
				min={1024}
				max={65535}
			/>
			<NumberInput
				label={t("portRangeEnd")}
				value={props.portEnd}
				onChange={(v) => props.setPortEnd(typeof v === "number" ? v : 20000)}
				min={1024}
				max={65535}
			/>
			<Switch
				label={t("proxyEnabled")}
				description={t("proxyEnabledDesc")}
				checked={props.proxyEnabled}
				onChange={(e) => props.setProxyEnabled(e.currentTarget.checked)}
			/>
			{props.proxyEnabled && (
				<NumberInput
					label={t("proxyPort")}
					description={t("proxyPortDesc")}
					value={props.proxyPort}
					onChange={(v) => props.setProxyPort(typeof v === "number" ? v : 7780)}
					min={1024}
					max={65535}
				/>
			)}
		</Stack>
	);
}
