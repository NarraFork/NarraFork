/**
 * Sessions to open beside an outline page: the recent sessions of the page's space (its
 * project's, its own session for a session space, the person's for a personal space), a menu
 * of them, and "discuss this page in a session" (pick one or start one, with a link to the page
 * put in its composer).
 */
import {
	ActionIcon,
	Button,
	Group,
	Loader,
	Menu,
	Modal,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import type { OutlineSpaceDetail } from "@shared/outline-api";
import { IconMessageCircle, IconMessagePlus, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProject } from "../../hooks/useProjects";
import { api } from "../../lib/api";
import classes from "../outline/Outline.module.css";

const CreateNarratorModal = lazy(() =>
	import("../narrator/CreateNarratorModal").then((m) => ({ default: m.CreateNarratorModal })),
);

/** How many recent sessions a list shows. */
export const OUTLINE_PAGE_SESSIONS_LIMIT = 15;

export interface OutlinePageSession {
	id: string;
	title: string;
	cwd: string | null;
}

/** The sessions to offer beside a page of `space`, most recently active first. */
export function useOutlineSpaceSessions(space: OutlineSpaceDetail | undefined, enabled: boolean) {
	return useQuery({
		queryKey: ["outline", "space-sessions", space?.id ?? "", space?.kind ?? ""],
		enabled: enabled && !!space,
		staleTime: 15_000,
		retry: false,
		queryFn: async (): Promise<OutlinePageSession[]> => {
			if (!space) return [];
			const of = (item: Record<string, unknown>): OutlinePageSession => ({
				id: String(item.id),
				title: typeof item.title === "string" && item.title.trim() ? item.title : String(item.id),
				cwd: typeof item.cwd === "string" ? item.cwd : null,
			});
			if (space.kind === "session") {
				if (!space.narratorId) return [];
				try {
					return [of((await api.getNarrator(space.narratorId)) as Record<string, unknown>)];
				} catch {
					return [];
				}
			}
			const page = await api.listNarratorsPaginated({
				...(space.kind === "project" && space.projectId ? { projectId: space.projectId } : {}),
				limit: OUTLINE_PAGE_SESSIONS_LIMIT,
			});
			return page.items.map((item) => of(item as Record<string, unknown>));
		},
	});
}

/** The text put in a session's composer to discuss a page: its address and title, linked. */
export function outlinePageReference(page: {
	address: string;
	title: string;
	url: string;
}): string {
	const title = page.title.replace(/[[\]\n]/g, " ").trim();
	return `[${page.address}${title ? ` · ${title}` : ""}](${page.url})`;
}

function SessionRows({
	sessions,
	onPick,
}: {
	sessions: OutlinePageSession[];
	onPick: (narratorId: string) => void;
}) {
	return (
		<Stack gap={2}>
			{sessions.map((session) => (
				<UnstyledButton
					key={session.id}
					className={classes.listItem}
					onClick={() => onPick(session.id)}
					data-testid="outline-page-session"
				>
					<Text size="sm" fw={500} className={classes.ellipsis}>
						{session.title}
					</Text>
					{session.cwd && (
						<Text size="xs" c="dimmed" className={classes.ellipsis}>
							{session.cwd}
						</Text>
					)}
				</UnstyledButton>
			))}
		</Stack>
	);
}

/** The recent sessions of the page's space, each opened beside the page. */
export function OutlinePageSessionsMenu({
	space,
	onOpen,
}: {
	space: OutlineSpaceDetail | undefined;
	onOpen: (narratorId: string) => void;
}) {
	const { t } = useTranslation("outline");
	const [opened, setOpened] = useState(false);
	const sessions = useOutlineSpaceSessions(space, opened);
	return (
		<Menu opened={opened} onChange={setOpened} position="bottom-end" withinPortal>
			<Menu.Target>
				<Tooltip label={t("dock.sessions")} disabled={opened}>
					<ActionIcon
						variant="subtle"
						color="gray"
						aria-label={t("dock.sessions")}
						data-testid="outline-page-sessions"
					>
						<IconMessageCircle size={18} />
					</ActionIcon>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown miw={240} maw={360}>
				<Menu.Label>{t("dock.recentSessions")}</Menu.Label>
				{sessions.isLoading && <Loader size="xs" m="xs" />}
				{sessions.isSuccess && sessions.data.length === 0 && (
					<Text size="xs" c="dimmed" px="sm" py={4}>
						{t("dock.noSessions")}
					</Text>
				)}
				{sessions.data?.map((session) => (
					<Menu.Item key={session.id} onClick={() => onOpen(session.id)}>
						<Text size="sm" className={classes.ellipsis}>
							{session.title}
						</Text>
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}

/**
 * "Discuss this page in a session": pick a recent session of the space or start one; the pick
 * gets a link to the page in its composer (`onPick`).
 */
export function DiscussPageButton({
	space,
	onPick,
	disabled = false,
}: {
	space: OutlineSpaceDetail | undefined;
	onPick: (narratorId: string) => void;
	/** The page shown has not loaded yet (its reference would name the previous one). */
	disabled?: boolean;
}) {
	const { t } = useTranslation("outline");
	const [opened, setOpened] = useState(false);
	const [creating, setCreating] = useState(false);
	const sessions = useOutlineSpaceSessions(space, opened);
	const projectId = space?.kind === "project" ? (space.projectId ?? "") : "";
	const project = useProject(opened ? projectId : "");
	const pick = (narratorId: string) => {
		setOpened(false);
		setCreating(false);
		onPick(narratorId);
	};
	return (
		<>
			<Tooltip label={t("dock.discuss")}>
				<ActionIcon
					variant="subtle"
					color="gray"
					aria-label={t("dock.discuss")}
					disabled={disabled}
					onClick={() => setOpened(true)}
					data-testid="outline-page-discuss"
				>
					<IconMessagePlus size={18} />
				</ActionIcon>
			</Tooltip>
			<Modal
				opened={opened && !creating}
				onClose={() => setOpened(false)}
				title={t("dock.discussTitle")}
			>
				<Stack gap="sm">
					<Text size="sm" c="dimmed">
						{t("dock.discussHint")}
					</Text>
					{sessions.isLoading && <Loader size="sm" />}
					{sessions.isSuccess && sessions.data.length === 0 && (
						<Text size="sm" c="dimmed">
							{t("dock.noSessions")}
						</Text>
					)}
					{sessions.data && <SessionRows sessions={sessions.data} onPick={pick} />}
					<Group justify="flex-end">
						<Button
							variant="light"
							leftSection={<IconPlus size={14} />}
							onClick={() => setCreating(true)}
						>
							{t("dock.newSession")}
						</Button>
					</Group>
				</Stack>
			</Modal>
			{opened && creating && (
				<Suspense fallback={null}>
					<CreateNarratorModal
						opened
						onClose={() => setCreating(false)}
						{...(projectId ? { contextProjectId: projectId } : {})}
						{...(project.data?.gitPath ? { initialCwd: project.data.gitPath } : {})}
						onCreated={(session) => pick(session.id)}
					/>
				</Suspense>
			)}
		</>
	);
}
