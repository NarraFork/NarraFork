import { ActionIcon, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPin } from "@tabler/icons-react";
import type { IDockviewPanelProps } from "dockview-react";
import {
	type PointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { NarratorPanelVisibilityProvider } from "../narrator-panel-visibility";
import { PanelHeaderControlsProvider } from "../panels/panel-header-controls";
import { useWorkspaceDock } from "./workspace-dock";

/** Supplies host controls to the existing panel header, never a second title bar. */
export function WorkspaceResourceFrame({
	props,
	children,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: resource frames only use panel api, never heterogeneous params.
	props: IDockviewPanelProps<any>;
	children: ReactNode;
}) {
	const store = useWorkspaceDock();
	const { t } = useTranslation("narrators");
	useSyncExternalStore(
		store?.subscribeResources ?? (() => () => {}),
		store?.getResourceRevision ?? (() => 0),
	);
	const [, refresh] = useReducer((value: number) => value + 1, 0);
	const [highlighted, setHighlighted] = useState<HTMLElement | null>(null);
	useEffect(() => {
		const disposables = [
			props.api.onDidLocationChange(refresh),
			props.api.onDidVisibilityChange(refresh),
			props.containerApi.onDidLayoutChange(refresh),
		];
		return () => {
			for (const disposable of disposables) disposable.dispose();
		};
	}, [props.api, props.containerApi]);
	useEffect(() => {
		highlighted?.classList.add("workspace-resource-target");
		return () => highlighted?.classList.remove("workspace-resource-target");
	}, [highlighted]);
	const onPointerDown = useCallback(
		(event: PointerEvent) => store?.startFloatingResourceDrag(props.api.id, event) ?? false,
		[store, props.api.id],
	);
	const temporary = !!store?.isTemporary(props.api.id) && props.api.location.type === "floating";
	const target = temporary ? store?.getPinTargets(props.api.id)[0] : undefined;
	const singleSlot = temporary && store?.hasSingleGridSlot();
	const label = singleSlot
		? t(store?.getDirectorActive() ? "resourceFloat.pinRightDirector" : "resourceFloat.pinRight")
		: target
			? t(store?.getDirectorActive() ? "resourceFloat.pinDirector" : "resourceFloat.pin", {
					target: target.title,
				})
			: t("resourceFloat.noNeighbour");
	const highlightTarget = () => {
		const root = target?.group.element.closest(".workspace-resource-surface");
		const directorHost =
			store?.getDirectorActive() && root
				? [...root.querySelectorAll<HTMLElement>("[data-workspace-panel-id]")].find((host) =>
						target?.group.panels.some((panel) => panel.id === host.dataset.workspacePanelId),
					)
				: undefined;
		setHighlighted(directorHost ?? target?.group.element ?? null);
	};
	const pinAction = temporary ? (
		<Tooltip label={label} withinPortal>
			<span className="nodrag" style={{ display: "flex", flexShrink: 0 }}>
				<ActionIcon
					className="nodrag"
					size={28}
					variant="subtle"
					color="indigo"
					aria-label={label}
					data-workspace-resource-pin={props.api.id}
					disabled={!store?.canPinResource(props.api.id)}
					onPointerDown={(event) => event.stopPropagation()}
					onMouseEnter={highlightTarget}
					onMouseLeave={() => setHighlighted(null)}
					onFocus={highlightTarget}
					onBlur={() => setHighlighted(null)}
					onClick={(event) => {
						event.stopPropagation();
						setHighlighted(null);
						if (!store?.pinResource(props.api.id))
							notifications.show({ color: "orange", message: t("resourceFloat.pinFailed") });
					}}
				>
					<IconPin size={18} />
				</ActionIcon>
			</span>
		</Tooltip>
	) : undefined;
	const controls = useMemo(() => ({ pinAction, onPointerDown }), [pinAction, onPointerDown]);
	const visible =
		props.api.isVisible &&
		(!temporary || !store?.isManagedPreview(props.api.id) || store.isActivePreview(props.api.id));
	return (
		<PanelHeaderControlsProvider value={controls}>
			<NarratorPanelVisibilityProvider value={visible}>{children}</NarratorPanelVisibilityProvider>
		</PanelHeaderControlsProvider>
	);
}
