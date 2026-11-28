import { createAgentReferenceStore } from "@frontend/lib/agent-reference-store";
import { assetUrl } from "@frontend/lib/base-path";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { getEffectiveNarratorDisplay } from "@frontend/lib/status-registry";
import { normalizeAgentReferenceLabel } from "@shared/agent-reference";
import { agentReferenceMetrics } from "@shared/pretext-layout/agent-reference-flow";
import { getTypographyRevision, onTypographyChange } from "@shared/pretext-layout/typography";
import { IconCircleDashed } from "@tabler/icons-react";
import {
	type CSSProperties,
	createContext,
	useCallback,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { NarratorStatusIcon } from "../../nav/NarratorStatusIcon";
import { getNarratorStatusDisplaySubstatus } from "../../nav/narrator-status-icon-logic";
import classes from "./AgentReferenceLink.module.css";

export const AgentReferenceOpenerContext = createContext<((id: string) => void) | null>(null);
const store = createAgentReferenceStore(narratorWSManager);
const noopSubscribe = () => () => {};

/** One atomic title chip: typography inside the Markdown label never creates extra boxes. */
export function AgentReferenceLink({
	id,
	label,
	className,
	style,
	occupiedWidth,
}: {
	id: string;
	label: string;
	className?: string;
	style?: CSSProperties;
	/** Pretext's complete atom advance, including icon, padding and outer margins. */
	occupiedWidth?: number;
}) {
	const open = useContext(AgentReferenceOpenerContext);
	const subscribe = useCallback((notify: () => void) => store.subscribe(id, notify), [id]);
	const getSnapshot = useCallback(() => store.get(id), [id]);
	const state = useSyncExternalStore(open ? subscribe : noopSubscribe, getSnapshot, getSnapshot);
	useSyncExternalStore(onTypographyChange, getTypographyRevision, getTypographyRevision);
	const metrics = agentReferenceMetrics();
	const marginBudget = metrics.marginX * 2;
	const margin =
		occupiedWidth === undefined
			? `min(${metrics.marginX}px, 50%)`
			: Math.min(metrics.marginX, occupiedWidth / 2);
	const paintedWidth =
		occupiedWidth === undefined
			? undefined
			: Math.max(0, occupiedWidth - Math.min(marginBudget, occupiedWidth));
	const leadingGap = style?.marginLeft ?? 0;
	const leadingGapCss = typeof leadingGap === "number" ? `${leadingGap}px` : leadingGap;
	const marginCss = typeof margin === "number" ? `${margin}px` : margin;
	const title = useMemo(() => normalizeAgentReferenceLabel(label) || id, [label, id]);
	const { t } = useTranslation(["narrator", "common"]);
	const ready = open && state.kind === "ready" ? state : undefined;
	const unavailable = state.kind === "unavailable";
	const status = ready
		? t(getEffectiveNarratorDisplay(ready.status, ready.substatus).i18nKey, { ns: "common" })
		: t(unavailable ? "agentReference.unavailable" : "agentReference.unknown");
	const content = (
		<>
			<span
				className={classes.status}
				style={{ width: metrics.statusWidth }}
				data-agent-status=""
				role="img"
				aria-label={status}
			>
				{ready ? (
					<NarratorStatusIcon
						size={14}
						status={ready.status}
						substatus={getNarratorStatusDisplaySubstatus(ready)}
					/>
				) : (
					<IconCircleDashed size={14} color="var(--mantine-color-dimmed)" />
				)}
			</span>
			<span className={classes.label} data-agent-label="">
				{title}
			</span>
		</>
	);
	const linkClassName =
		!open || unavailable ? className?.replace(/\bis-link\b/g, "").trim() : className;
	const props = {
		className: `${linkClassName ?? ""} ${classes.reference}`,
		style: {
			...style,
			display: "inline-grid",
			gridTemplateColumns: `${metrics.statusWidth}px minmax(0, 1fr)`,
			// Pretext peers use intrinsic font boxes; flowing Markdown keeps its body line box.
			font:
				occupiedWidth === undefined
					? metrics.font.replace(/(\d+(?:\.\d+)?)px/, `$1px/${metrics.height}px`)
					: metrics.font,
			height: metrics.height,
			letterSpacing: `${metrics.letterSpacing}px`,
			maxWidth: `min(${metrics.maxWidth - marginBudget}px, max(0px, calc(100% - ${marginBudget}px)))`,
			paddingInline:
				paintedWidth === undefined
					? `clamp(0px, calc((100% - ${marginBudget}px) / 2), ${metrics.paddingX}px)`
					: Math.min(metrics.paddingX, paintedWidth / 2),
			whiteSpace: "nowrap",
			// Reserved outer spacing is part of the atom, not unmeasured extra advance.
			marginLeft: `calc(${leadingGapCss} + ${marginCss})`,
			marginRight: margin,
			...(paintedWidth !== undefined ? { width: paintedWidth, maxWidth: paintedWidth } : {}),
		} satisfies CSSProperties,
		title: `${title} · ${status}`,
		"data-agent-reference": id,
		"data-agent-state": ready?.status ?? (unavailable ? "unavailable" : "unknown"),
	};
	if (!open || unavailable) return <span {...props}>{content}</span>;
	return (
		<a
			{...props}
			href={assetUrl(`/narrators/${encodeURIComponent(id)}`)}
			onClick={(event) => {
				if (
					event.defaultPrevented ||
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				open(id);
			}}
		>
			{content}
		</a>
	);
}
