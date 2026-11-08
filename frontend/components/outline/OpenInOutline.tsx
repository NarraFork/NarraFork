/**
 * "Open in the outline": a link to a block (in the view of everything, where tasks and questions
 * are not folded away), going through the host's link renderer (`outline-nav.tsx`). `onOpen` runs
 * on the click, so a drawer can close as the outline opens.
 */
import { Anchor } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

export function OpenInOutline({
	spaceId,
	blockId,
	onOpen,
}: {
	spaceId: string;
	blockId: string;
	onOpen?: () => void;
}) {
	const { t } = useTranslation("outline");
	return (
		<Anchor
			size="xs"
			component={OutlineLink}
			to={outlineBlockTarget(spaceId, blockId, "all")}
			onClick={() => onOpen?.()}
		>
			{t("questions.openInOutline")}
		</Anchor>
	);
}
