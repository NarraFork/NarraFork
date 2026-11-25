/**
 * The team's starting state (the redesign R): nobody has spoken to the coordinator and there is
 * no work yet, so the middle of the conversation says what to do — 「告诉协调者这个团队要完成什么」,
 * one line on what happens next, and three example goals that fill the composer when clicked
 * (`lib/composer-append-queue.ts`: the coordinator's composer takes the text once its draft has
 * loaded). Drawn over the empty message area only; the header and the composer stay usable.
 */
import { requestComposerAppend } from "@frontend/lib/composer-append-queue";
import { Box, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { IconRobot, IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { TEAM_START_EXAMPLES } from "./team-page-model";

export function TeamStart({ teamId, onPick }: { teamId: string; onPick?: () => void }) {
	const { t } = useTranslation("projects");
	return (
		<Box
			data-testid="team-start"
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				top: 56,
				bottom: 150,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "var(--mantine-spacing-md)",
				background: "var(--mantine-color-body)",
				overflowY: "auto",
			}}
		>
			<Stack gap="sm" align="center" maw={560} w="100%">
				<ThemeIcon size={44} radius="xl" variant="light" color="indigo">
					<IconRobot size={22} aria-hidden />
				</ThemeIcon>
				<Text fw={700} size="lg" ta="center">
					{t("teams.page.start.title")}
				</Text>
				<Text size="sm" c="dimmed" ta="center">
					{t("teams.page.start.body")}
				</Text>
				<Stack gap={8} mt="xs" w="100%">
					{TEAM_START_EXAMPLES.map((key) => {
						const text = t(`teams.page.start.examples.${key}`);
						return (
							<UnstyledButton
								key={key}
								onClick={() => {
									requestComposerAppend(teamId, text);
									onPick?.();
								}}
								data-testid="team-start-example"
								style={{
									display: "flex",
									gap: 10,
									alignItems: "flex-start",
									padding: "10px 14px",
									borderRadius: "var(--mantine-radius-md)",
									border: "1px solid var(--mantine-color-default-border)",
									background: "var(--mantine-color-default)",
								}}
							>
								<IconSparkles
									size={15}
									aria-hidden
									style={{ flexShrink: 0, marginTop: 3, color: "var(--mantine-color-indigo-4)" }}
								/>
								<Text size="sm">{text}</Text>
							</UnstyledButton>
						);
					})}
				</Stack>
			</Stack>
		</Box>
	);
}

/** The starting state for a read-only member: no prompts to pick, one plain line. */
export function TeamReadOnlyStart() {
	const { t } = useTranslation("projects");
	return (
		<Box
			data-testid="team-start-read-only"
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				top: 56,
				bottom: 150,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "var(--mantine-spacing-md)",
				background: "var(--mantine-color-body)",
				pointerEvents: "none",
			}}
		>
			<Text size="sm" c="dimmed" ta="center">
				{t("teams.page.readOnlyStart")}
			</Text>
		</Box>
	);
}
