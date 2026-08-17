/**
 * Ruler's anchoring notices, collapsed into one corner badge.
 *
 * These used to be two permanently expanded cards pinned to the top-left of the canvas,
 * stacked via hand-tuned `top` offsets. Together they covered the start of the backbone —
 * the very region a user looks at when a chapter seems to be missing — and neither could
 * be dismissed or collapsed. The "load older commits" button inside the first one is also
 * the Ruler's ONLY paging control, which is why the card could not simply be deleted.
 *
 * So: collapsed to a small badge by default, expandable on demand, and the paging action
 * lives inside the expanded panel. Ruler is deprecated and will not gain the scroll-driven
 * auto-paging that would have made the notice unnecessary, so the goal here is to stop it
 * blocking the view, not to fix the underlying anchoring story.
 *
 * The two situations stay separate inside the panel because they are not the same claim:
 * unplaced chapters are NOT drawn at all, while rewritten-anchor chapters ARE on screen
 * and merely sit at an approximate position.
 */

import { ActionIcon, Button, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface AnchorNoticeChapter {
	id: string;
	title: string;
}

interface RulerAnchorNoticesProps {
	/** Chapters with no backbone position at all — these are not drawn. */
	missingTickChapters: AnchorNoticeChapter[];
	/** Chapters drawn at their fork point because the trunk was rewritten under them. */
	rewrittenAnchorChapters: AnchorNoticeChapter[];
	/** Whether older commits remain to be paged in — i.e. whether paging can still help. */
	hasPreviousPage: boolean;
	isFetchingPreviousPage: boolean;
	onLoadOlder: () => void;
	/** Formats a chapter title list with the caller's own truncation rules. */
	formatTitles: (titles: string[]) => string;
	/** Offset from the top of the canvas, so a degraded-mode banner can push this down. */
	top: number;
}

export function RulerAnchorNotices({
	missingTickChapters,
	rewrittenAnchorChapters,
	hasPreviousPage,
	isFetchingPreviousPage,
	onLoadOlder,
	formatTitles,
	top,
}: RulerAnchorNoticesProps) {
	const { t } = useTranslation("graph");
	const [expanded, setExpanded] = useState(false);

	const total = missingTickChapters.length + rewrittenAnchorChapters.length;
	if (total === 0) return null;

	return (
		<Card
			withBorder
			padding={expanded ? "xs" : 4}
			data-testid="ruler-anchor-notices"
			style={{
				position: "absolute",
				top,
				left: 12,
				zIndex: 50,
				maxWidth: expanded ? 520 : undefined,
			}}
		>
			<Stack gap={expanded ? 6 : 0}>
				{/* The collapsed affordance is the whole header, not a separate hit target:
				    at 4px padding the card is barely larger than the icon itself. */}
				<Tooltip label={expanded ? t("ruler.anchorNoticesHide") : t("ruler.anchorNoticesShow")}>
					<Group
						gap={4}
						wrap="nowrap"
						style={{ cursor: "pointer" }}
						onClick={() => setExpanded((value) => !value)}
					>
						<IconAlertTriangle size={14} color="var(--mantine-color-yellow-5)" />
						<Text size="xs" c="yellow" fw={600}>
							{total}
						</Text>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="gray"
							aria-label={expanded ? t("ruler.anchorNoticesHide") : t("ruler.anchorNoticesShow")}
							data-testid="ruler-anchor-notices-toggle"
							onClick={(event) => {
								// The Group already handles this; stop it counting twice.
								event.stopPropagation();
								setExpanded((value) => !value);
							}}
						>
							{expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
						</ActionIcon>
					</Group>
				</Tooltip>

				{/* Conditional rather than a <Collapse>: whether Mantine keeps collapsed
				    children mounted is an implementation detail, and "collapsed" here has to
				    mean the titles are genuinely absent — not merely zero-height, which a
				    screen reader would still announce. */}
				{expanded && (
					<Stack gap="xs">
						{missingTickChapters.length > 0 && (
							<Stack gap={4} data-testid="ruler-off-backbone-notice">
								<Text size="xs" c="orange">
									{t("ruler.offRulerChapters", {
										count: missingTickChapters.length,
										titles: formatTitles(missingTickChapters.map((ch) => ch.title)),
									})}
								</Text>
								<Text size="xs" c="dimmed">
									{hasPreviousPage
										? t("ruler.offRulerChaptersDesc")
										: t("ruler.offRulerChaptersExhausted")}
								</Text>
								{/* A real <Button>, not a clickable <Text>. This is the only way back to
								    a chapter that fell outside the loaded window, and as a bare
								    `<Text onClick>` it had no role, no tab stop and no key handler — a
								    keyboard or screen-reader user could not reach the single recovery
								    path at all. */}
								{hasPreviousPage && (
									<Group gap="xs">
										<Button
											size="compact-xs"
											variant="subtle"
											loading={isFetchingPreviousPage}
											onClick={onLoadOlder}
										>
											{isFetchingPreviousPage
												? t("ruler.loadingOlderCommits")
												: t("ruler.loadOlderCommits")}
										</Button>
									</Group>
								)}
							</Stack>
						)}

						{/* Informational, not an error: these cards are on screen and fully usable.
						    Said out loud anyway because the position is approximate, and a card
						    sitting at a commit that is not the one the chapter records is
						    otherwise a quiet lie. */}
						{rewrittenAnchorChapters.length > 0 && (
							<Stack gap={4} data-testid="ruler-rewritten-anchor-notice">
								<Text size="xs" c="yellow">
									{t("ruler.rewrittenAnchorChapters", {
										count: rewrittenAnchorChapters.length,
										titles: formatTitles(rewrittenAnchorChapters.map((ch) => ch.title)),
									})}
								</Text>
								<Text size="xs" c="dimmed">
									{t("ruler.rewrittenAnchorChaptersDesc")}
								</Text>
							</Stack>
						)}
					</Stack>
				)}
			</Stack>
		</Card>
	);
}
