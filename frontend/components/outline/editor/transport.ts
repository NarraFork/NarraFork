/**
 * The live sessions' transport in the app: binary frames on the narrator socket
 * (`frontend/lib/narrator-ws-manager.ts`), shared by every open page. Frames are decoded once and
 * handed to every client, which keeps those with its handle. Handles (1–255) stay with a client
 * across reconnects, so a client rejoins under the same one.
 */
import { decodeLiveFrame, type LiveFrame } from "@shared/outline-live-protocol";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import type { LiveTransport } from "./live-client";

interface Socketish {
	readonly connected: boolean;
	sendBinary(bytes: Uint8Array): boolean;
	addBinaryListener(listener: (bytes: Uint8Array) => void): () => void;
	onConnectionChange(listener: (connected: boolean, reconnect: boolean) => void): () => void;
}

export function createLiveTransport(socket: Socketish): LiveTransport {
	const frameListeners = new Set<(frame: LiveFrame) => void>();
	const handles = new Set<number>();
	let detach: (() => void) | null = null;
	const ensure = () => {
		detach ??= socket.addBinaryListener((bytes) => {
			const frame = decodeLiveFrame(bytes);
			if (!frame) return;
			for (const listener of frameListeners) listener(frame);
		});
	};
	return {
		get connected() {
			return socket.connected;
		},
		send: (frame) => socket.sendBinary(frame),
		onFrame(listener) {
			ensure();
			frameListeners.add(listener);
			return () => {
				frameListeners.delete(listener);
				if (frameListeners.size === 0 && detach) {
					detach();
					detach = null;
				}
			};
		},
		onConnectionChange(listener) {
			return socket.onConnectionChange((connected) => listener(connected));
		},
		allocateHandle() {
			for (let h = 1; h < 256; h++) {
				if (!handles.has(h)) {
					handles.add(h);
					return h;
				}
			}
			return null;
		},
		releaseHandle(handle) {
			handles.delete(handle);
		},
	};
}

let shared: LiveTransport | null = null;
let override: LiveTransport | null = null;

/** The app's transport over the narrator socket. */
export function liveTransport(): LiveTransport {
	if (override) return override;
	shared ??= createLiveTransport(narratorWSManager);
	return shared;
}

/**
 * Browser fixtures: carry every editor's frames over this transport instead of the narrator
 * socket (null restores it). Only test entry points call this.
 */
export function overrideLiveTransportForTests(transport: LiveTransport | null): void {
	override = transport;
}
