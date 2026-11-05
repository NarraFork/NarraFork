/**
 * Knowledge browse page (docs/KNOWLEDGE_UI_REDESIGN.md §5.1). All view state is in the URL
 * (`collection`, `q`, `tag`, `level`, `status`, `sort` — `lib/knowledge-browse-search.ts`):
 * collection tree on the left, a cursor-paginated table of entries on the right. Admins get an
 * "Admin" entry point to `/knowledge/admin` in the header.
 *
 * Legacy tab URLs redirect in `beforeLoad` (§4.2): `?tab=review[&submission=<id>]` → inbox /
 * request page, `?tab=mylibrary` → `/knowledge/mine`, `?tab=admin` → `/knowledge/admin`.
 */

import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import { Badge, Button, Container, Group, Menu, Stack, Text, Title, Tooltip } from "@mantine/core";
import {
	IconChevronDown,
	IconFilePlus,
	IconGitPullRequest,
	IconNotebook,
	IconPlus,
	IconShieldLock,
} from "@tabler/icons-react";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrowsePanel } from "../../components/knowledge/browse/BrowsePanel";
import { CreateEntryModal } from "../../components/knowledge/browse/CreateEntryModal";
import { useCurrentUser } from "../../hooks/useAuth";
import { useKnowledgeCollections, useReviewInboxCount } from "../../hooks/useKnowledge";
import { parseKnowledgeBrowseSearch } from "../../lib/knowledge-browse-search";
import { legacyKnowledgeIndexRedirect } from "../../lib/knowledge-review-nav";

export const Route = createFileRoute("/knowledge/")({
	// Reads the raw location search: validateSearch drops the legacy values.
	beforeLoad: ({ location }) => {
		const target = legacyKnowledgeIndexRedirect(location.search as Record<string, unknown>);
		if (target) throw redirect({ ...target, replace: true });
	},
	component: KnowledgePage,
	validateSearch: parseKnowledgeBrowseSearch,
});

function KnowledgePage() {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate({ from: "/knowledge/" });
	const search = Route.useSearch();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const collections = useKnowledgeCollections();
	const [createOpen, setCreateOpen] = useState(false);
	// Bounded server-side count; `capped` means "at least this many" → render "100+".
	const inbox = useReviewInboxCount();
	const inboxCount = inbox.data?.count ?? 0;
	const inboxLabel = inbox.data?.capped ? `${inboxCount}+` : String(inboxCount);

	// Only collections the server lets the caller create entries in (viewerCaps.canCreateEntry).
	const creatable = (collections.data ?? [])
		.filter((c) => c.viewerCaps.canCreateEntry)
		.map((c) => ({ value: c.id, label: c.name }));

	return (
		<Container size="xl" py="lg">
			<Group justify="space-between" align="flex-start" mb="md" wrap="wrap">
				<Stack gap={4}>
					<Group gap="xs" wrap="nowrap">
						<MobileNavButton />
						<Title order={2}>{t("title")}</Title>
					</Group>
					<Text size="sm" c="dimmed">
						{t("subtitle")}
					</Text>
				</Stack>
				<Group gap="xs">
					<Menu position="bottom-end" withinPortal>
						<Menu.Target>
							<Button
								leftSection={<IconPlus size={16} />}
								rightSection={<IconChevronDown size={14} />}
							>
								{t("browseNew")}
							</Button>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Item
								leftSection={<IconFilePlus size={14} />}
								disabled={creatable.length === 0}
								onClick={() => setCreateOpen(true)}
							>
								{t("createEntry")}
							</Menu.Item>
							<Menu.Item
								leftSection={<IconNotebook size={14} />}
								onClick={() => navigate({ to: "/knowledge/mine/new" })}
							>
								{t("newPersonalEntry")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>
					<Button
						component={Link}
						to="/knowledge/mine"
						variant="light"
						leftSection={<IconNotebook size={16} />}
					>
						{t("mineTitle")}
					</Button>
					<Button
						component={Link}
						to="/knowledge/review"
						variant="light"
						leftSection={<IconGitPullRequest size={16} />}
						rightSection={
							inboxCount > 0 ? (
								<Tooltip label={t("reviewInboxTooltip", { count: inboxCount })}>
									<Badge size="sm" circle variant="filled" color="indigo">
										{inboxLabel}
									</Badge>
								</Tooltip>
							) : null
						}
					>
						{t("reviewInboxTitle")}
					</Button>
					{isAdmin ? (
						<Button
							component={Link}
							to="/knowledge/admin"
							variant="default"
							leftSection={<IconShieldLock size={16} />}
						>
							{t("adminEntry")}
						</Button>
					) : null}
				</Group>
			</Group>

			<BrowsePanel search={search} />

			<CreateEntryModal
				opened={createOpen}
				onClose={() => setCreateOpen(false)}
				collectionId={
					search.collection && creatable.some((o) => o.value === search.collection)
						? search.collection
						: null
				}
				collectionOptions={creatable}
			/>
		</Container>
	);
}
