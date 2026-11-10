import { ActionIcon, Button, Group, Modal, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconSparkles } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateWorkspace, workspaceQueryKey } from "../../../hooks/useWorkspace";
import { api } from "../../../lib/api";
import { ApiError } from "../../../lib/api/client";

interface TitleCandidate {
	title: string;
	expectedTitleRevision: number;
}

/** Generation returns a candidate; only a revision-guarded write can adopt it. */
export function WorkspaceTitleGenerator({
	workspaceId,
	titleSource,
	titleRevision,
	editing,
}: {
	workspaceId: string;
	titleSource: "default" | "auto" | "manual";
	titleRevision: number;
	editing: boolean;
}) {
	const { t } = useTranslation("narrators");
	const update = useUpdateWorkspace();
	const qc = useQueryClient();
	const [candidate, setCandidate] = useState<TitleCandidate | null>(null);
	const generationEpoch = useRef(0);
	const generating = useRef(false);
	const saving = useRef(false);
	const alive = useRef(true);
	const latest = useRef({ titleRevision, editing });
	latest.current = { titleRevision, editing };
	// Editing, including an abandoned edit, invalidates the in-flight UI action.
	useEffect(() => {
		if (editing) {
			generationEpoch.current++;
			setCandidate(null);
		}
	}, [editing]);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			generationEpoch.current++;
		};
	}, []);

	const showError = (error: unknown) => {
		if (!alive.current) return;
		// Recover missed WS revision updates as well as server-rejected stale candidates.
		void qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		const code = error instanceof ApiError ? error.data?.code : undefined;
		notifications.show({
			color: "red",
			title: t("workspaceTitleGenerationFailed"),
			message:
				code === "WORKSPACE_TITLE_NO_CONTENT"
					? t("workspaceTitleNoContent")
					: code === "WORKSPACE_TITLE_CONFLICT"
						? t("workspaceTitleChanged")
						: error instanceof Error
							? error.message
							: t("workspaceTitleUnchanged"),
		});
	};
	const adopt = async (value: TitleCandidate) => {
		if (saving.current) return;
		saving.current = true;
		try {
			await update.mutateAsync({
				id: workspaceId,
				title: value.title,
				expectedTitleRevision: value.expectedTitleRevision,
			});
			if (alive.current) setCandidate(null);
		} finally {
			saving.current = false;
		}
	};
	const generate = useMutation({
		mutationFn: async () => {
			const epoch = ++generationEpoch.current;
			const source = titleSource;
			const value = await api.generateWorkspaceTitle(workspaceId);
			if (!alive.current || epoch !== generationEpoch.current || latest.current.editing) return;
			if (value.expectedTitleRevision !== latest.current.titleRevision) {
				throw new Error(t("workspaceTitleChanged"));
			}
			if (source === "default") await adopt(value);
			else setCandidate(value);
		},
		onError: showError,
		onSettled: () => {
			generating.current = false;
		},
	});
	const stale = candidate !== null && candidate.expectedTitleRevision !== titleRevision;
	return (
		<>
			<Tooltip label={t("workspaceGenerateTitle")}>
				<ActionIcon
					size="sm"
					variant="subtle"
					aria-label={t("workspaceGenerateTitle")}
					data-testid="workspace-generate-title"
					style={{ WebkitAppRegion: "no-drag" }}
					loading={generate.isPending}
					disabled={editing || update.isPending}
					onClick={() => {
						if (generating.current || saving.current) return;
						generating.current = true;
						generate.mutate();
					}}
				>
					<IconSparkles size={16} />
				</ActionIcon>
			</Tooltip>
			<Modal
				opened={candidate !== null}
				onClose={() => setCandidate(null)}
				title={t("workspaceTitleCandidate")}
				centered
			>
				<Stack gap="md">
					<Text>{candidate?.title}</Text>
					<Text size="sm" c={stale ? "red" : "dimmed"}>
						{t(stale ? "workspaceTitleChanged" : "workspaceTitleReplaceHint")}
					</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setCandidate(null)}>
							{t("workspaceTitleKeep")}
						</Button>
						<Button
							disabled={stale}
							loading={update.isPending}
							onClick={() => {
								if (candidate) void adopt(candidate).catch(showError);
							}}
						>
							{t("workspaceTitleReplace")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
