import { Box, Button, Text } from "@mantine/core";
import { resolveAssistantTextDisplay, type TextCitation } from "@shared/citations";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContentViewer } from "./ContentViewer";
import { useRenderInteractive, useRenderLod } from "./RenderLodCtx";

/** Clamp long assistant text at L1 to roughly this height. */
const CLAMP_MAX_HEIGHT = 160;
/** Only texts longer than this are clamped — short texts render in full. */
const CLAMP_MIN_CHARS = 600;

/**
 * ClampableText — an assistant markdown text block that, at render LOD L1,
 * clamps long content to a fixed height behind a gradient mask with an
 * expand/collapse toggle. Short texts and higher LODs render unchanged.
 * Streaming content always renders in full (live output must not be clipped).
 */
export const ClampableText = memo(function ClampableText({
	text,
	citations,
	blockIndex,
	streaming,
}: {
	text: string;
	/** Source citations for `text`; projected into display-only Markdown. */
	citations?: TextCitation[];
	blockIndex?: number;
	streaming?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const lod = useRenderLod();
	const interactive = useRenderInteractive();
	const [expanded, setExpanded] = useState(false);
	// Reset the manual expansion when the level changes so a new level applies.
	const [prevLod, setPrevLod] = useState(lod);
	if (prevLod !== lod) {
		setPrevLod(lod);
		setExpanded(false);
	}

	// Display gets numbered references (clickable when the source resolved to a
	// URL); the clipboard keeps the prose the model actually wrote. Historical
	// rows without structured citations still get their internal markers stripped
	// here, so no DB migration is needed to stop showing them.
	const { display, copyText } = useMemo(
		() => resolveAssistantTextDisplay(text, citations),
		[text, citations],
	);

	const clampable = !streaming && lod <= 1 && display.length > CLAMP_MIN_CHARS;
	const clamped = clampable && !expanded;

	const viewer = (
		<ContentViewer
			content={display}
			copyText={copyText ?? undefined}
			markdown
			contentType="markdown"
			blockIndex={blockIndex}
			streaming={streaming}
		/>
	);

	if (!clampable) return viewer;

	return (
		<Box style={{ position: "relative" }}>
			{/* Clamp by an outer clipping container (not ContentViewer's maxHeight,
			    which would introduce an inner scrollbar) so the fade mask reads as
			    a hard cut. */}
			<Box style={clamped ? { maxHeight: CLAMP_MAX_HEIGHT, overflow: "hidden" } : undefined}>
				{viewer}
			</Box>
			{clamped && (
				<Box
					style={{
						position: "absolute",
						left: 0,
						right: 0,
						bottom: 0,
						height: 48,
						pointerEvents: "none",
						background: "linear-gradient(to bottom, transparent, var(--mantine-color-body) 85%)",
					}}
				/>
			)}
			{interactive && (
				<Button
					variant="subtle"
					size="compact-xs"
					c="dimmed"
					mt={2}
					leftSection={expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
					onClick={() => setExpanded((v) => !v)}
				>
					<Text size="xs">{expanded ? t("showLess") : t("showMore")}</Text>
				</Button>
			)}
		</Box>
	);
});
