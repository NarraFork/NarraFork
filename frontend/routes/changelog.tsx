import {
	ActionIcon,
	Badge,
	Box,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	Timeline,
	Title,
} from "@mantine/core";
import { pickLocalizedValue } from "@shared/i18n-locales";
import { IconArrowLeft, IconTag } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "../components/narrator/MarkdownContent";
import { useChangelogs } from "../hooks/use-changelogs";
import { normalizeLanguage } from "../lib/i18n";
import { formatLocaleDate } from "../lib/intl-format";

export const Route = createFileRoute("/changelog")({
	component: ChangelogPage,
});

function ChangelogPage() {
	const { t, i18n } = useTranslation("settings");
	const { data: changelogs, isLoading } = useChangelogs();
	const lang = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
	const router = useRouter();

	return (
		<Center>
			<Box maw={800} w="100%" p="md">
				<Group mb="lg" gap="sm">
					<ActionIcon variant="subtle" onClick={() => router.history.back()} aria-label="Back">
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={2}>{t("changelogLink")}</Title>
				</Group>

				{isLoading && (
					<Center py="xl">
						<Loader size="sm" />
					</Center>
				)}

				{changelogs && changelogs.length === 0 && (
					<Text c="dimmed" ta="center" py="xl">
						{t("changelogEmpty")}
					</Text>
				)}

				{changelogs && changelogs.length > 0 && (
					<Timeline active={0} bulletSize={28} lineWidth={2}>
						{changelogs.map((entry) => (
							<Timeline.Item
								key={entry.version}
								bullet={<IconTag size={14} />}
								title={
									<Group gap="sm">
										<Badge variant="filled" size="lg">
											v{entry.version}
										</Badge>
										<Text size="sm" c="dimmed">
											{formatLocaleDate(entry.date, {
												year: "numeric",
												month: "short",
												day: "numeric",
											})}
										</Text>
									</Group>
								}
							>
								<Stack gap={0} mt="xs">
									<MarkdownContent text={pickLocalizedValue(entry, lang)} />
								</Stack>
							</Timeline.Item>
						))}
					</Timeline>
				)}
			</Box>
		</Center>
	);
}
