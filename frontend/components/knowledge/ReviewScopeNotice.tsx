/**
 * "Why do I see these publish requests?" — states the current user's review authority
 * explicitly instead of leaving them to infer it from whichever submissions happen to appear.
 *
 * Two axes, matching the server-side authorization split:
 *  - review tags held → which LINKED entries they may review (all of an entry's review tags
 *    must be covered).
 *  - writable collections → which STANDALONE publishes they may approve.
 *
 * An admin gets one sentence instead of an enumeration: their authority is unconditional, so
 * listing every tag and collection would be noise.
 */
import { Alert, Badge, Group, Stack, Text } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useMyKnowledgeReviewScope } from "../../hooks/useKnowledge";

export function ReviewScopeNotice() {
	const { t } = useTranslation("knowledge");
	const scope = useMyKnowledgeReviewScope();

	// Stay silent while loading or on error: this is an explainer, not a gate, and a failed
	// fetch must not imply "you have no review rights".
	if (!scope.data) return null;
	const { isAdmin, reviewTags, collections, truncated } = scope.data;

	if (isAdmin) {
		return (
			<Alert
				color="indigo"
				variant="light"
				icon={<IconShieldCheck size={16} />}
				title={t("reviewScopeTitle")}
				p="xs"
			>
				<Text size="xs">{t("reviewScopeAdmin")}</Text>
			</Alert>
		);
	}

	const hasNothing = reviewTags.length === 0 && collections.length === 0;

	return (
		<Alert
			color={hasNothing ? "yellow" : "indigo"}
			variant="light"
			icon={<IconShieldCheck size={16} />}
			title={t("reviewScopeTitle")}
			p="xs"
		>
			<Stack gap={6}>
				{hasNothing ? (
					<Text size="xs">{t("reviewScopeNone")}</Text>
				) : (
					<>
						{reviewTags.length > 0 ? (
							<div>
								<Group gap={4} wrap="wrap">
									<Text size="xs" fw={500}>
										{t("reviewScopeTagsLabel")}
									</Text>
									{reviewTags.map((tag) => (
										<Badge key={tag.id} size="xs" variant="light" color="teal">
											{tag.name}
										</Badge>
									))}
								</Group>
								<Text size="xs" c="dimmed">
									{t("reviewScopeTagsHint")}
								</Text>
							</div>
						) : null}
						{collections.length > 0 ? (
							<div>
								<Group gap={4} wrap="wrap">
									<Text size="xs" fw={500}>
										{t("reviewScopeCollectionsLabel")}
									</Text>
									{collections.map((c) => (
										<Badge key={c.id} size="xs" variant="light" color="blue">
											{c.name}
										</Badge>
									))}
								</Group>
								<Text size="xs" c="dimmed">
									{t("reviewScopeCollectionsHint")}
								</Text>
							</div>
						) : null}
					</>
				)}
				{truncated ? (
					<Text size="xs" c="dimmed" fs="italic">
						{t("reviewScopeTruncated")}
					</Text>
				) : null}
			</Stack>
		</Alert>
	);
}
