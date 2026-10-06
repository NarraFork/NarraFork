import { Button, Modal } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type AsyncQuestionAnswerSnapshot,
	AsyncQuestionDetail,
} from "../question/AsyncQuestionDetail";

/** Header-only action: its modal never contributes to the measured row height. */
export function QuestionEventAction({
	viewingNarratorId,
	reference,
	snapshot,
}: {
	/** The session displaying the event, not its original actor. */
	viewingNarratorId?: string;
	reference: { narratorId: string; questionId: string };
	snapshot?: AsyncQuestionAnswerSnapshot;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const historicalOnly = viewingNarratorId !== reference.narratorId;
	// Missing viewing identity must never authorize access to another actor's live record.
	if (historicalOnly && !snapshot) return null;
	return (
		<>
			<Button
				size="compact-xs"
				variant="subtle"
				style={{ height: "100%", minHeight: 0, flexShrink: 0 }}
				onClick={() => setOpened(true)}
			>
				{t("asyncQuestionDetails")}
			</Button>
			<Modal
				opened={opened}
				onClose={() => setOpened(false)}
				title={t("asyncQuestionDetails")}
				size="lg"
			>
				{opened && (
					<AsyncQuestionDetail
						narratorId={reference.narratorId}
						questionId={reference.questionId}
						snapshot={snapshot}
						historicalOnly={historicalOnly}
					/>
				)}
			</Modal>
		</>
	);
}
