import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import { IconBrain, IconChevronDown, IconChevronRight, IconDots } from "@tabler/icons-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LazyCollapse } from "./LazyCollapse";
import { MarkdownContent } from "./MarkdownContent";
import type { ReasoningSegment } from "./reasoning-segments";

// Keep the most recent N step titles visible; earlier ones collapse behind a
// "show earlier" toggle. Matches the product decision to render reasoning as a
// live trace with titles always visible.
const MAX_VISIBLE_TITLES = 5;

// --- Cross-remount persistence -------------------------------------------------
// Streaming replaces the transient __streaming__ message with the real message,
// remounting this component. We persist the per-step expansion and the
// "show earlier" toggle in module-level maps (same LRU pattern as
// MessageBubble's reasoningExpandState) so user toggles survive that swap.
const MAX_STATE_ENTRIES = 1000;
const stepExpandState = new Map<string, boolean>();

function readState(key: string | undefined): boolean | undefined {
	if (!key) return undefined;
	const value = stepExpandState.get(key);
	if (value !== undefined) {
		// Refresh LRU recency.
		stepExpandState.delete(key);
		stepExpandState.set(key, value);
	}
	return value;
}

function writeState(key: string | undefined, value: boolean) {
	if (!key) return;
	stepExpandState.delete(key);
	stepExpandState.set(key, value);
	while (stepExpandState.size > MAX_STATE_ENTRIES) {
		const oldest = stepExpandState.keys().next().value;
		if (oldest === undefined) break;
		stepExpandState.delete(oldest);
	}
}

/** Derive a short display title for a step (untitled steps use body head). */
function displayTitle(segment: ReasoningSegment): string {
	if (segment.title != null && segment.title.length > 0) return segment.title;
	const firstLine = segment.body.split("\n").find((l) => l.trim().length > 0) ?? "";
	const trimmed = firstLine.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

const StepRow = memo(function StepRow({
	segment,
	persistKey,
	shimmer,
}: {
	segment: ReasoningSegment;
	persistKey?: string;
	shimmer?: boolean;
}) {
	const expandable = !segment.isEmpty && segment.body.trim().length > 0;
	const persisted = readState(persistKey);
	const [opened, setOpened] = useState(persisted ?? false);
	const title = displayTitle(segment);

	const toggle = () => {
		if (!expandable) return;
		setOpened((v) => {
			const next = !v;
			writeState(persistKey, next);
			return next;
		});
	};

	return (
		<Box>
			<Group
				gap={6}
				wrap="nowrap"
				align="center"
				py={1}
				style={{ cursor: expandable ? "pointer" : "default", userSelect: "none" }}
				onClick={toggle}
			>
				<Box style={{ display: "flex", alignItems: "center", width: 12, justifyContent: "center" }}>
					{expandable ? (
						opened ? (
							<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
						) : (
							<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
						)
					) : (
						<Text span size="xs" c="dimmed" style={{ opacity: 0.5, lineHeight: 1, fontSize: 10 }}>
							•
						</Text>
					)}
				</Box>
				<Text
					size="xs"
					c="dimmed"
					truncate
					className={shimmer ? "reasoning-step-shimmer" : undefined}
					style={{ flex: 1, minWidth: 0 }}
				>
					{title || "…"}
				</Text>
			</Group>
			{expandable && (
				<LazyCollapse in={opened}>
					<Box
						pl="lg"
						py={2}
						style={{
							borderLeft: "2px solid var(--mantine-color-grape-9)",
							opacity: 0.75,
							fontSize: "var(--mantine-font-size-xs)",
						}}
					>
						<MarkdownContent text={segment.body} />
					</Box>
				</LazyCollapse>
			)}
		</Box>
	);
});

export const ReasoningStepsTrace = memo(function ReasoningStepsTrace({
	segments,
	streaming,
	persistKeyBase,
}: {
	segments: ReasoningSegment[];
	streaming?: boolean;
	persistKeyBase?: string;
}) {
	const { t } = useTranslation("narrator");
	const earlierKey = persistKeyBase ? `${persistKeyBase}:earlier` : undefined;
	const [showEarlier, setShowEarlier] = useState(readState(earlierKey) ?? false);

	if (segments.length === 0) return null;

	const hiddenCount = Math.max(0, segments.length - MAX_VISIBLE_TITLES);
	const visibleStart = showEarlier ? 0 : hiddenCount;
	const lastIndex = segments.length - 1;

	const toggleEarlier = () => {
		setShowEarlier((v) => {
			const next = !v;
			writeState(earlierKey, next);
			return next;
		});
	};

	return (
		<Box py={2}>
			<Group gap={6} wrap="nowrap" align="center" py={2}>
				<ThemeIcon size={16} variant="light" color="grape" radius="sm">
					<IconBrain size={10} />
				</ThemeIcon>
				<Text size="xs" c="dimmed" fw={500} style={{ flexShrink: 0 }}>
					{t("reasoning")}
				</Text>
				<Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.5 }}>
					{t("reasoningSteps", { count: segments.length })}
				</Text>
			</Group>

			{hiddenCount > 0 && (
				<Group
					gap={6}
					wrap="nowrap"
					align="center"
					py={1}
					style={{ cursor: "pointer", userSelect: "none" }}
					onClick={toggleEarlier}
				>
					<Box
						style={{ display: "flex", alignItems: "center", width: 12, justifyContent: "center" }}
					>
						<IconDots size={12} style={{ color: "var(--mantine-color-dimmed)", opacity: 0.6 }} />
					</Box>
					<Text size="xs" c="dimmed" style={{ opacity: 0.7 }}>
						{showEarlier
							? t("reasoningHideEarlier")
							: t("reasoningShowEarlier", { count: hiddenCount })}
					</Text>
				</Group>
			)}

			{segments.slice(visibleStart).map((segment, i) => {
				const index = visibleStart + i;
				return (
					<StepRow
						key={persistKeyBase ? `${persistKeyBase}:seg${index}` : index}
						segment={segment}
						persistKey={persistKeyBase ? `${persistKeyBase}:seg${index}` : undefined}
						shimmer={streaming && index === lastIndex}
					/>
				);
			})}
		</Box>
	);
});

// CSS keyframes — inject once. A subtle gradient text shimmer marks the latest
// step title while the model is still thinking.
if (typeof document !== "undefined") {
	const id = "reasoning-step-shimmer-style";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
@keyframes reasoning-step-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.reasoning-step-shimmer {
  background: linear-gradient(
    90deg,
    var(--mantine-color-dimmed) 0%,
    var(--mantine-color-dimmed) 35%,
    light-dark(rgba(0,0,0,.85), rgba(255,255,255,.92)) 50%,
    var(--mantine-color-dimmed) 65%,
    var(--mantine-color-dimmed) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: reasoning-step-shimmer 2.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .reasoning-step-shimmer { animation: none; -webkit-text-fill-color: currentColor; }
}
`;
		document.head.appendChild(style);
	}
}
