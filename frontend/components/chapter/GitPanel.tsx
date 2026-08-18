import { Tabs } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { GitChangesTab } from "./GitChangesTab";
import { GitCommitsTab } from "./GitCommitsTab";
import { GitStashTab } from "./GitStashTab";

/**
 * Only the ACTIVE panel is mounted (`keepMounted={false}`), so it can safely take
 * all the remaining height. `minHeight: 0` is what lets the inner scroll area
 * shrink instead of pushing the flex parent taller.
 */
const TAB_PANEL_STYLE = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column",
} as const;

export function GitPanel({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");

	return (
		<Tabs
			defaultValue="changes"
			variant="outline"
			keepMounted={false}
			// The panel host gives this component the full dock height, so the tab body
			// must claim what is left after the tab strip. Without this the tabs collapse
			// to their content height and each tab has to guess a pixel cap of its own.
			style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
		>
			<Tabs.List style={{ flexShrink: 0 }}>
				<Tabs.Tab value="changes">{t("panel.changes")}</Tabs.Tab>
				<Tabs.Tab value="commits">{t("panel.commits")}</Tabs.Tab>
				<Tabs.Tab value="stash">{t("panel.stash")}</Tabs.Tab>
			</Tabs.List>

			<Tabs.Panel value="changes" pt="xs" style={TAB_PANEL_STYLE}>
				<GitChangesTab chapterId={chapterId} />
			</Tabs.Panel>
			<Tabs.Panel value="commits" pt="xs" style={TAB_PANEL_STYLE}>
				<GitCommitsTab chapterId={chapterId} />
			</Tabs.Panel>
			<Tabs.Panel value="stash" pt="xs" style={TAB_PANEL_STYLE}>
				<GitStashTab chapterId={chapterId} />
			</Tabs.Panel>
		</Tabs>
	);
}
