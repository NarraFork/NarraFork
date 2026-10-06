import { Anchor, Box, Button, Group, Modal, NumberInput, Stack, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type ContextManagementDraft,
	DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
	DEFAULT_CONTEXT_THRESHOLDS_DRAFT,
	normalizeContextManagementDraft,
} from "./types";

export function ContextThresholdSettingsModal({
	opened,
	onClose,
	current,
	onSave,
	saving,
	canSave,
	onOpenGlobalSettings,
}: {
	opened: boolean;
	onClose: () => void;
	/** Effective settings used to seed the draft each time the modal opens. */
	current: ContextManagementDraft;
	/** Persist the normalized draft. The modal has already clamped/rounded it. */
	onSave: (normalized: ContextManagementDraft) => void;
	saving: boolean;
	canSave: boolean;
	onOpenGlobalSettings: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { t: ts } = useTranslation("settings");
	const [draft, setDraft] = useState<ContextManagementDraft>(current);

	// Reseed the draft from the effective settings whenever the modal (re)opens,
	// so a cancelled edit never leaks into the next open.
	useEffect(() => {
		if (opened) setDraft(current);
	}, [opened, current]);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("contextThresholdSettingsTitle")}
			centered
			size="lg"
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("contextThresholdSettingsIntro")}
				</Text>
				<NumberInput
					label={ts("autoCompactKeepPairs")}
					description={ts("autoCompactKeepPairsDesc")}
					value={draft.autoCompactKeepPairs}
					onChange={(value) =>
						setDraft((prev) => ({
							...prev,
							autoCompactKeepPairs:
								typeof value === "number" ? value : DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
						}))
					}
					min={1}
					max={25}
					allowDecimal={false}
				/>
				<Box style={{ borderTop: "1px solid var(--mantine-color-default-border)" }} />
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{ts("contextThresholdsStandard")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("contextThresholdSettingsStandardDesc")}
					</Text>
					<NumberInput
						label={ts("compactStart")}
						description={ts("compactStartDesc")}
						value={draft.contextThresholds.standard.compactStart}
						onChange={(value) =>
							setDraft((prev) => ({
								...prev,
								contextThresholds: {
									...prev.contextThresholds,
									standard: {
										compactStart:
											typeof value === "number"
												? value
												: DEFAULT_CONTEXT_THRESHOLDS_DRAFT.standard.compactStart,
									},
								},
							}))
						}
						min={50}
						max={100}
						allowDecimal={false}
						suffix="%"
					/>
				</Stack>
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{ts("contextThresholdsLarge")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("contextThresholdSettingsLargeDesc")}
					</Text>
					<NumberInput
						label={ts("compactStart")}
						description={ts("compactStartDesc")}
						value={draft.contextThresholds.large.compactStart}
						onChange={(value) =>
							setDraft((prev) => ({
								...prev,
								contextThresholds: {
									...prev.contextThresholds,
									large: {
										compactStart:
											typeof value === "number"
												? value
												: DEFAULT_CONTEXT_THRESHOLDS_DRAFT.large.compactStart,
									},
								},
							}))
						}
						min={10}
						max={100}
						allowDecimal={false}
						suffix="%"
					/>
				</Stack>
				<Group justify="space-between">
					<Anchor
						component="button"
						type="button"
						size="xs"
						onClick={onOpenGlobalSettings}
						style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
					>
						{t("globalAgentSettings")}
						<IconExternalLink size={12} />
					</Anchor>
					<Group gap="xs">
						<Button variant="default" onClick={onClose}>
							{tc("cancel")}
						</Button>
						<Button
							onClick={() => onSave(normalizeContextManagementDraft(draft))}
							loading={saving}
							disabled={!canSave}
						>
							{tc("save")}
						</Button>
					</Group>
				</Group>
			</Stack>
		</Modal>
	);
}
