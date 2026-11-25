/**
 * The narrator panel reports its socket state to a host that hides the panel's header (the team
 * page's coordinator column, `hideHeader`): the header's 「连接断开」 badge goes with it, so the
 * host shows the state and reconnects through the panel. The panel keeps the only socket logic.
 */
import { useEffect, useRef } from "react";
import type { NarratorPanelConnection } from "./narrator-panel-types";

/**
 * Calls `onConnectionChange` when the reported state changes (and when the callback does). The
 * `reconnect` it hands over is stable and always runs the panel's current reconnect.
 */
export function useReportPanelConnection(
	onConnectionChange: ((connection: NarratorPanelConnection) => void) | undefined,
	disconnected: boolean,
	reconnect: () => void,
): void {
	const reconnectRef = useRef(reconnect);
	reconnectRef.current = reconnect;
	useEffect(() => {
		onConnectionChange?.({ disconnected, reconnect: () => reconnectRef.current() });
	}, [onConnectionChange, disconnected]);
}
