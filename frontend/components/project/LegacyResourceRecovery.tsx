import { Alert, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useProjectAccess } from "../../hooks/useProjectAccess";
import { api } from "../../lib/api";
import { canOperateLegacyResources } from "./legacy-chapter-redirect";

const ContainerPanel = lazy(() =>
	import("../container/ContainerPanel").then((m) => ({ default: m.ContainerPanel })),
);
const ContainerConfigModal = lazy(() =>
	import("../container/ContainerConfigModal").then((m) => ({ default: m.ContainerConfigModal })),
);
const ChapterForkModal = lazy(() =>
	import("../chapter/ChapterForkModal").then((m) => ({ default: m.ChapterForkModal })),
);
const ChapterMergeModal = lazy(() =>
	import("../chapter/ChapterMergeModal").then((m) => ({ default: m.ChapterMergeModal })),
);

/** Recovery is reachable even when a legacy chapter has no primary narrator. */
export function LegacyResourceRecovery({
	chapterId,
	projectId,
	status,
	containerConfig,
}: {
	chapterId: string;
	projectId: string;
	status?: string;
	containerConfig?: unknown;
}) {
	const { t } = useTranslation("projects");
	const access = useProjectAccess(projectId);
	const { data: user } = useCurrentUser();
	const canOperate = !access.isError && canOperateLegacyResources(access.data, user?.id);
	const [opened, setOpened] = useState(false);
	const [editor, setEditor] = useState<"containers" | "fork" | "merge" | null>(null);
	const queryClient = useQueryClient();
	const wake = useMutation({
		mutationFn: () => api.wakeChapter(chapterId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["chapters"] });
			queryClient.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
	return (
		<>
			<Button variant="subtle" size="xs" onClick={() => setOpened(true)}>
				{t("compatibility.recovery")}
			</Button>
			<Modal
				opened={opened}
				onClose={() => setOpened(false)}
				title={t("compatibility.resources")}
				size="xl"
			>
				<Stack>
					<Text size="sm">{t("compatibility.resourceSource", { id: chapterId })}</Text>
					{!canOperate && <Alert>{t("compatibility.resourceReadOnly")}</Alert>}
					{wake.isError && <Alert color="red">{wake.error.message}</Alert>}
					<Group>
						{status === "dormant" && (
							<Button disabled={!canOperate} loading={wake.isPending} onClick={() => wake.mutate()}>
								{t("compatibility.wake")}
							</Button>
						)}
						<Button variant="light" disabled={!canOperate} onClick={() => setEditor("fork")}>
							{t("compatibility.legacyFork")}
						</Button>
						<Button variant="light" disabled={!canOperate} onClick={() => setEditor("merge")}>
							{t("compatibility.legacyMerge")}
						</Button>
					</Group>
					{opened && canOperate && (
						<Suspense fallback={<Loader size="sm" />}>
							<ContainerPanel chapterId={chapterId} onOpenConfig={() => setEditor("containers")} />
						</Suspense>
					)}
				</Stack>
			</Modal>
			{opened && canOperate && editor && (
				<Suspense fallback={<Loader size="sm" />}>
					{editor === "containers" && (
						<ContainerConfigModal
							chapterId={chapterId}
							currentConfig={containerConfig}
							opened
							onClose={() => setEditor(null)}
						/>
					)}
					{editor === "fork" && (
						<ChapterForkModal
							chapterId={chapterId}
							chapterStatus={status}
							opened
							onClose={() => setEditor(null)}
						/>
					)}
					{editor === "merge" && (
						<ChapterMergeModal
							chapterId={chapterId}
							projectId={projectId}
							opened
							onClose={() => setEditor(null)}
						/>
					)}
				</Suspense>
			)}
		</>
	);
}
