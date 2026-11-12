/**
 * The reports' entry at the top of the outline home (汇报, P2 PR 11; design §5.2): the latest
 * day's report with its item count and whether it is unread, linking to the reports page. Reads
 * the list's first page (heads only), which the page then reuses. The host opens the link
 * (`OutlineHrefLink`).
 */
import { Anchor, Badge, Group, Paper, Text } from "@mantine/core";
import { IconNews } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useOutlineReportList } from "../../../hooks/useOutlineReports";
import { OutlineHrefLink } from "../outline-nav";
import { DIGEST_TODAY, dayEntries, reportPath } from "./digest-model";
import { useDigestDayLabel } from "./report-format";

export function OutlineReportEntry() {
	const { t } = useTranslation("outline");
	const dayLabel = useDigestDayLabel();
	const list = useOutlineReportList();
	const latest = dayEntries(list.data?.pages).find((entry) => entry.key !== DIGEST_TODAY) ?? null;
	return (
		<Anchor
			component={OutlineHrefLink}
			path={reportPath()}
			underline="never"
			c="inherit"
			data-testid="outline-report-entry"
			style={{ display: "block", minWidth: 0 }}
		>
			<Paper withBorder p="sm" radius="md">
				<Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
					<IconNews size={18} style={{ flexShrink: 0 }} />
					<Text size="sm" fw={600}>
						{latest ? t("report.dayOf", { day: dayLabel(latest.key) }) : t("report.title")}
					</Text>
					{latest ? (
						<>
							<Text size="sm" c="dimmed">
								{t("report.items", { count: latest.head.itemCount })}
							</Text>
							{!latest.head.seenAt && (
								<Badge size="sm" variant="filled" color="indigo" tt="none">
									{t("report.unread")}
								</Badge>
							)}
						</>
					) : (
						list.isSuccess && (
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
								{t("report.entryNone")}
							</Text>
						)
					)}
				</Group>
			</Paper>
		</Anchor>
	);
}
