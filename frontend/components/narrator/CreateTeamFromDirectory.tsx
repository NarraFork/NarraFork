/**
 * The team half of the new-session dialog ("start as a team"): the same name / base branch /
 * brief as the project page's "new team" dialog, for the directory picked on the left.
 *
 * Submitting resolves the directory to its project with `create: true` (the project of a git
 * repository that has none is made, as a session started there would make it), then calls the
 * team route (`POST /api/projects/:projectId/teams`) and opens the team page. Loaded only once
 * the user switches to the team option, so the dialog's session path never pulls in the router.
 */
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { TeamDetail } from "@shared/project-teams";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { CreateTeamPayload } from "../../lib/api/teams";
import { describeApiError } from "../../lib/api-error";
import { TeamCreateFields, useTeamDraft } from "../teams/TeamCreateFields";
import {
	resolveDirectoryQueryKey,
	type TeamStartBlock,
	type TeamStartEligibility,
	teamStartEligibility,
} from "./create-narrator-team";

/** The directory changed between the check and the submit; carries the reason to show. */
class TeamStartBlocked extends Error {
	constructor(readonly reason: TeamStartBlock) {
		super(reason);
	}
}

export interface CreateTeamFromDirectoryProps {
	cwd: string;
	eligibility: TeamStartEligibility;
	onCancel: () => void;
	/** Called after the team exists, before the team page opens (the dialog closes itself). */
	onDone: () => void;
	/** Replaces opening the team page, e.g. in a fixture without a router. */
	onTeamCreated?: (team: TeamDetail) => void;
}

export function CreateTeamFromDirectory({
	cwd,
	eligibility,
	onCancel,
	onDone,
	onTeamCreated,
}: CreateTeamFromDirectoryProps) {
	const { t } = useTranslation("narrators");
	const { t: tp } = useTranslation("projects");
	const queryClient = useQueryClient();
	// No warning outside a router: a caller without one passes `onTeamCreated`.
	const router = useRouter({ warn: false });
	const draft = useTeamDraft();
	const create = useMutation({
		mutationFn: async (payload: CreateTeamPayload) => {
			const directory = cwd.trim();
			const resolved = await api.resolveProjectDirectory({ cwd: directory, create: true });
			const verdict = teamStartEligibility({
				isRemoteDevice: false,
				cwd: directory,
				lookedUpCwd: directory,
				isLoading: false,
				error: null,
				data: resolved,
			});
			if (!verdict.ok) throw new TeamStartBlocked(verdict.reason);
			if (resolved.status !== "project") throw new TeamStartBlocked("checking");
			return await api.createProjectTeam(resolved.project.id, payload);
		},
		// The failure is shown in the dialog.
		meta: { suppressErrorToast: true },
		onSuccess: (team) => {
			void queryClient.invalidateQueries({ queryKey: ["teams", "project", team.projectId] });
			void queryClient.invalidateQueries({ queryKey: ["narrators", "project", team.projectId] });
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			void queryClient.invalidateQueries({ queryKey: resolveDirectoryQueryKey(cwd.trim()) });
			draft.reset();
			onDone();
			if (onTeamCreated) onTeamCreated(team);
			else
				void router?.navigate({
					to: "/projects/$projectId/teams/$teamId",
					params: { projectId: team.projectId, teamId: team.id },
				});
		},
	});

	const submit = () => {
		if (!eligibility.ok) return;
		const payload = draft.submit();
		if (payload) create.mutate(payload);
	};

	const failure = create.isError
		? create.error instanceof TeamStartBlocked
			? t(`teamStart.reason.${create.error.reason}`)
			: describeApiError(create.error, tp).message
		: null;

	return (
		<Stack gap="md" data-testid="create-team-from-directory">
			<Text
				size="sm"
				c={eligibility.ok ? "dimmed" : "orange"}
				data-testid="team-start-status"
				data-ok={eligibility.ok ? "true" : "false"}
			>
				{eligibility.ok
					? "project" in eligibility
						? t("teamStart.inProject", { name: eligibility.project.name })
						: t("teamStart.newProject", { root: eligibility.repositoryRoot })
					: t(`teamStart.reason.${eligibility.reason}`)}
			</Text>
			<TeamCreateFields draft={draft} autoFocus={false} />
			{failure && (
				<Alert color="red" title={tp("teams.create.failed")} data-testid="team-start-error">
					{failure}
				</Alert>
			)}
			<Group justify="flex-end" gap="xs">
				<Button variant="default" onClick={onCancel}>
					{tp("teams.create.cancel")}
				</Button>
				<Button
					onClick={submit}
					loading={create.isPending}
					disabled={!eligibility.ok}
					data-testid="team-start-submit"
				>
					{tp("teams.create.submit")}
				</Button>
			</Group>
		</Stack>
	);
}
