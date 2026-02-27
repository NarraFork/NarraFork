import { Tabs } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { GitChangesTab } from "./GitChangesTab";
import { GitCommitsTab } from "./GitCommitsTab";
import { GitStashTab } from "./GitStashTab";

export function GitPanel({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");

	return (
		<Tabs defaultValue="changes" variant="outline" keepMounted={false}>
			<Tabs.List>
				<Tabs.Tab value="changes">{t("panel.changes")}</Tabs.Tab>
				<Tabs.Tab value="commits">{t("panel.commits")}</Tabs.Tab>
				<Tabs.Tab value="stash">{t("panel.stash")}</Tabs.Tab>
			</Tabs.List>

			<Tabs.Panel value="changes" pt="xs">
				<GitChangesTab chapterId={chapterId} />
			</Tabs.Panel>
			<Tabs.Panel value="commits" pt="xs">
				<GitCommitsTab chapterId={chapterId} />
			</Tabs.Panel>
			<Tabs.Panel value="stash" pt="xs">
				<GitStashTab chapterId={chapterId} />
			</Tabs.Panel>
		</Tabs>
	);
}
