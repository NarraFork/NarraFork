/**
 * Add an outline page to a workspace as a member of its own: pick a page you visited recently,
 * search every space you can read, or take a space's page list. The pick becomes a membership
 * row (`kind: "outline"`, config `{ spaceId, blockId }`), so it is saved and restored with the
 * workspace like a session.
 */
import {
	Alert,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { WorkspaceOutlineConfig } from "@shared/workspace-panels";
import { IconSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSearch, useOutlineSpaces } from "../../../hooks/useOutline";
import { workspaceQueryKey } from "../../../hooks/useWorkspace";
import { api } from "../../../lib/api";
import { describeApiError } from "../../../lib/api-error";
import { readOutlineRecents } from "../../../lib/outline-recents";
import classes from "../../outline/Outline.module.css";
import { useOutlineSpaceName } from "../../outline/OutlineSpaceName";

export function AddOutlinePanelModal({
	workspaceId,
	opened,
	onClose,
}: {
	workspaceId: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("outline");
	const qc = useQueryClient();
	const spaceName = useOutlineSpaceName();
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 250);
	const search = useOutlineSearch(debounced, null, opened);
	const spaces = useOutlineSpaces(opened);
	const recents = useMemo(() => (opened ? readOutlineRecents() : []), [opened]);
	const [adding, setAdding] = useState(false);

	const add = async (config: WorkspaceOutlineConfig) => {
		setAdding(true);
		try {
			await api.addWorkspacePanel(workspaceId, { kind: "outline", config });
			await qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
			onClose();
		} catch (error) {
			notifications.show({ color: "red", message: describeApiError(error, t).message });
		} finally {
			setAdding(false);
		}
	};

	const allSpaces = spaces.data?.pages.flatMap((page) => page.spaces) ?? [];
	return (
		<Modal opened={opened} onClose={onClose} title={t("workspace.addTitle")} size="lg">
			<Stack gap="sm" data-testid="add-outline-panel">
				<TextInput
					leftSection={<IconSearch size={16} />}
					placeholder={t("home.searchPlaceholder")}
					aria-label={t("home.searchPlaceholder")}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					data-autofocus
				/>
				{debounced.trim() ? (
					<Stack gap={2}>
						{search.isFetching && !search.data && <Loader size="xs" />}
						{search.data && search.data.hits.length === 0 && (
							<Text size="sm" c="dimmed">
								{t("home.noResults")}
							</Text>
						)}
						{search.data?.hits.map((hit) => (
							<UnstyledButton
								key={hit.blockId}
								className={classes.listItem}
								disabled={adding}
								onClick={() => void add({ spaceId: hit.spaceId, blockId: hit.blockId })}
							>
								<Text size="sm" fw={500} className={classes.ellipsis}>
									{hit.title || hit.address}
								</Text>
								{hit.path.length > 0 && (
									<Text size="xs" c="dimmed" className={classes.ellipsis}>
										{hit.path.join(" › ")}
									</Text>
								)}
							</UnstyledButton>
						))}
					</Stack>
				) : (
					<>
						<Text size="sm" fw={600}>
							{t("home.recent")}
						</Text>
						{recents.length === 0 ? (
							<Text size="sm" c="dimmed">
								{t("home.noRecent")}
							</Text>
						) : (
							<Stack gap={2}>
								{recents.map((recent) => (
									<UnstyledButton
										key={recent.blockId}
										className={classes.listItem}
										disabled={adding}
										onClick={() => void add({ spaceId: recent.spaceId, blockId: recent.blockId })}
									>
										<Text size="sm" className={classes.ellipsis}>
											{recent.title}
										</Text>
									</UnstyledButton>
								))}
							</Stack>
						)}
						<Text size="sm" fw={600}>
							{t("home.spaces")}
						</Text>
						{spaces.isLoading && <Loader size="sm" />}
						{spaces.isError && (
							<Alert color="red" variant="light">
								{t("loadFailed")}
							</Alert>
						)}
						<Stack gap={2}>
							{allSpaces.map((space) => (
								<UnstyledButton
									key={space.id}
									className={classes.listItem}
									disabled={adding}
									onClick={() => void add({ spaceId: space.id })}
								>
									<Group gap="xs" wrap="nowrap" justify="space-between">
										<Text size="sm" className={classes.ellipsis}>
											{spaceName(space)}
										</Text>
										<Text size="xs" c="dimmed">
											{t(`space.kind.${space.kind}`)}
										</Text>
									</Group>
								</UnstyledButton>
							))}
						</Stack>
						{spaces.hasNextPage && (
							<Button
								variant="light"
								loading={spaces.isFetchingNextPage}
								onClick={() => void spaces.fetchNextPage()}
							>
								{t("loadMore")}
							</Button>
						)}
					</>
				)}
			</Stack>
		</Modal>
	);
}
