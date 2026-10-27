/**
 * The outline dock panel: an outline page (or a space's pages, or the outline home) beside a
 * session, in a workspace, or beside the outline page's own main panel.
 *
 * The panel's params ARE its state (`lib/outline-panel.ts`): every navigation inside it writes
 * them, so the layout restores the same focus, view and time, and the URL never changes. The tab
 * is named after what loaded and that name is not stored: a restored panel says "Outline" until
 * it has read its place, and keeps saying so when it cannot. The page is live only while the
 * panel is on screen (`OutlineSurface`); a background tab shows it read only. Links
 * Ctrl/Cmd-clicked open another panel through the surface's opener; "open in outline page"
 * leaves for the outline route. Whether the person may see anything is the outline routes'
 * answer: a space that became unreadable shows the not-found state, and with the outline off
 * the panel says so instead of rendering.
 */
import { ActionIcon, Center, Loader, Tooltip } from "@mantine/core";
import { IconExternalLink, IconListTree } from "@tabler/icons-react";
import type { IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineOpener } from "../../../lib/outline-opener";
import {
	normalizeOutlinePanelState,
	type OutlinePanelState,
	outlinePanelTarget,
} from "../../../lib/outline-panel";
import { useOpenOutlinePage } from "../../../lib/outline-router";
import { OutlineHostProvider } from "../../outline/outline-host";
import { DockviewNarratorPanelVisibilityProvider } from "../narrator-panel-visibility";
import type { OutlinePanelParams } from "../panels/panel-kind";
import { useNarratorDockContext } from "./NarratorDockContext";
import { outlineParamsPatch } from "./outline-dock";
import { ToolPanelShell } from "./panels";

const OutlinePanelContent = lazy(() =>
	import("../../outline/OutlinePanelContent").then((m) => ({ default: m.OutlinePanelContent })),
);

export function OutlineDockPanel(props: IDockviewPanelProps<OutlinePanelParams>) {
	const { t } = useTranslation("outline");
	const dock = useNarratorDockContext();
	const opener = useOutlineOpener();
	const openPage = useOpenOutlinePage();
	const { api, params } = props;
	const state = useMemo(() => normalizeOutlinePanelState(params), [params]);
	const generic = t("title");

	// The tab's name: what loaded, else the generic name (a restored panel has no stored title,
	// so dockview shows its id until this runs).
	const [title, setTitle] = useState(api.title ?? "");
	useEffect(() => {
		const subscription = api.onDidTitleChange(() => setTitle(api.title ?? ""));
		return () => subscription.dispose();
	}, [api]);
	useLayoutEffect(() => {
		if (!api.title || api.title === api.id) api.setTitle(generic);
	}, [api, generic]);
	const onTitle = useCallback(
		(next: string | null) => {
			const name = next ?? generic;
			if (api.title !== name) api.setTitle(name);
		},
		[api, generic],
	);

	const onChange = useCallback(
		(next: OutlinePanelState) => api.updateParameters(outlineParamsPatch(next)),
		[api],
	);
	const onOpenNew = useCallback(
		(next: OutlinePanelState) => {
			if (!opener?.open(next, { newPanel: true })) onChange(next);
		},
		[opener, onChange],
	);
	// The session's dock opens an agent commit's session in its secondary area (focusing its
	// own chat when the commit is this session's); elsewhere the surrounding host decides.
	const openSession = dock?.openSubagentPanel;
	const content = (
		<OutlinePanelContent
			state={state}
			onChange={onChange}
			onOpenNew={onOpenNew}
			onTitle={onTitle}
		/>
	);

	return (
		<ToolPanelShell
			title={title && title !== api.id ? title : generic}
			icon={<IconListTree size={16} color="var(--mantine-color-indigo-4)" />}
			actions={
				<Tooltip label={t("panel.openPage")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("panel.openPage")}
						onClick={() => openPage(state)}
					>
						<IconExternalLink size={14} />
					</ActionIcon>
				</Tooltip>
			}
			props={props}
			subjectId={`__outline__:${api.id}`}
			detachKind="outline"
			resourceId={JSON.stringify(outlinePanelTarget(state))}
		>
			<Suspense
				fallback={
					<Center h="100%">
						<Loader size="sm" />
					</Center>
				}
			>
				<DockviewNarratorPanelVisibilityProvider api={api}>
					{openSession ? (
						<OutlineHostProvider openSession={openSession}>{content}</OutlineHostProvider>
					) : (
						content
					)}
				</DockviewNarratorPanelVisibilityProvider>
			</Suspense>
		</ToolPanelShell>
	);
}
