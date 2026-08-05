/**
 * NarratorImageGenFixAction.tsx — the error card's "turn off image generation and
 * retry" button (chunked message list).
 *
 * A LABELLED button, not an icon: this is the one action that actually resolves
 * the failure, and an icon-only control explains itself only through a hover
 * tooltip — which touch users never see, leaving the fix undiscoverable.
 *
 * Renders nothing unless the failure is the image-generation refusal and the user
 * can act on it; see useCodexImageGenerationFix for the eligibility rule. The
 * virtual list paints the same button through its injected `ErrorNoticeActions`
 * slot instead of mounting this component.
 */

import { Button } from "@mantine/core";
import { IconPhotoOff } from "@tabler/icons-react";
import { useCodexImageGenerationFix } from "./useCodexImageGenerationFix";

export function NarratorImageGenFixAction({
	narratorId,
	errorMessage,
}: {
	narratorId: string;
	errorMessage: string;
}) {
	const fix = useCodexImageGenerationFix(narratorId);
	if (!fix.canFix(errorMessage)) return null;

	return (
		<Button
			size="compact-xs"
			variant="light"
			color="red"
			leftSection={<IconPhotoOff size={12} />}
			style={{ alignSelf: "flex-start" }}
			loading={fix.busy}
			onClick={fix.run}
		>
			{fix.label}
		</Button>
	);
}
