/**
 * Notification sound playback using Web Audio API.
 * Supports built-in oscillator-based sounds and custom audio files.
 */

import { authorizedFetch, clearTokenOnSessionFailure } from "./api";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
	if (!audioCtx) audioCtx = new AudioContext();
	return audioCtx;
}

// --- Built-in sounds via OscillatorNode ---

interface BuiltinSoundDef {
	/** Base frequency in Hz */
	freq: number;
	/** Note duration in ms */
	duration: number;
	/** Oscillator type */
	type: OscillatorType;
	/** Sequence of [freqMultiplier, durationMultiplier] pairs */
	notes: [number, number][];
}

const BUILTIN_SOUNDS: Record<string, BuiltinSoundDef> = {
	gentle: {
		freq: 523,
		duration: 150,
		type: "sine",
		notes: [
			[1, 1],
			[1.25, 1],
			[1.5, 1.5],
		],
	},
	chime: {
		freq: 880,
		duration: 120,
		type: "sine",
		notes: [
			[1, 1],
			[0.75, 0.8],
			[1, 1.2],
		],
	},
	alert: {
		freq: 660,
		duration: 80,
		type: "square",
		notes: [
			[1, 1],
			[0, 0.5],
			[1.2, 1],
			[0, 0.5],
			[1.4, 1],
		],
	},
	soft: {
		freq: 440,
		duration: 250,
		type: "sine",
		notes: [
			[1, 1],
			[1.33, 1.5],
		],
	},
};

export const BUILTIN_SOUND_NAMES = Object.keys(BUILTIN_SOUNDS);

export function playBuiltinSound(name: string): void {
	const def = BUILTIN_SOUNDS[name];
	if (!def) return;

	const ctx = getAudioContext();
	if (ctx.state === "suspended") ctx.resume();

	const gainNode = ctx.createGain();
	gainNode.connect(ctx.destination);
	gainNode.gain.value = 0.3;

	let offset = ctx.currentTime;
	let activeOscillators = 0;
	const cleanupOscillator = (osc: OscillatorNode) => {
		try {
			osc.disconnect();
		} catch {
			// Already disconnected.
		}
		activeOscillators--;
		if (activeOscillators <= 0) {
			try {
				gainNode.disconnect();
			} catch {
				// Already disconnected.
			}
		}
	};
	for (const [freqMul, durMul] of def.notes) {
		if (freqMul === 0) {
			// silence gap
			offset += (def.duration * durMul) / 1000;
			continue;
		}
		const osc = ctx.createOscillator();
		activeOscillators++;
		osc.type = def.type;
		osc.frequency.value = def.freq * freqMul;
		osc.connect(gainNode);
		osc.addEventListener("ended", () => cleanupOscillator(osc), { once: true });

		const noteDuration = (def.duration * durMul) / 1000;
		osc.start(offset);
		osc.stop(offset + noteDuration);
		offset += noteDuration + 0.02; // small gap between notes
	}

	if (activeOscillators === 0) {
		gainNode.disconnect();
		return;
	}

	// Fade out gain at the end
	gainNode.gain.setValueAtTime(0.3, offset - 0.05);
	gainNode.gain.linearRampToValueAtTime(0, offset);
}

// --- Custom audio file playback ---

const audioCache = new Map<string, string>(); // url -> blobUrl
const MAX_AUDIO_CACHE_ENTRIES = 3;
const MAX_CUSTOM_AUDIO_BLOB_BYTES = 10 * 1024 * 1024;

function touchAudioCache(url: string, blobUrl: string) {
	audioCache.delete(url);
	audioCache.set(url, blobUrl);
}

function trimAudioCache() {
	while (audioCache.size > MAX_AUDIO_CACHE_ENTRIES) {
		const oldestUrl = audioCache.keys().next().value;
		if (!oldestUrl) break;
		const oldestBlobUrl = audioCache.get(oldestUrl);
		if (oldestBlobUrl) {
			URL.revokeObjectURL(oldestBlobUrl);
		}
		audioCache.delete(oldestUrl);
	}
}

export async function playCustomSound(url: string): Promise<void> {
	let blobUrl = audioCache.get(url);
	if (blobUrl) {
		touchAudioCache(url, blobUrl);
	} else {
		try {
			const res = await authorizedFetch(url);
			if (!res.ok) {
				await clearTokenOnSessionFailure(res);
				return;
			}
			const blob = await res.blob();
			if (blob.size > MAX_CUSTOM_AUDIO_BLOB_BYTES) return;
			blobUrl = URL.createObjectURL(blob);
			touchAudioCache(url, blobUrl);
			trimAudioCache();
		} catch {
			return;
		}
	}
	const audio = new Audio(blobUrl);
	const cleanup = () => {
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
	};
	audio.volume = 0.5;
	audio.addEventListener("ended", cleanup, { once: true });
	audio.addEventListener("error", cleanup, { once: true });
	audio.play().catch(cleanup);
}

// --- Unified playback ---

export interface NotificationSoundPrefs {
	notifySoundType: "builtin" | "custom";
	notifySoundBuiltin: string;
	notifySoundFileId: string | null;
}

export function playNotificationSound(prefs: NotificationSoundPrefs): void {
	if (prefs.notifySoundType === "custom" && prefs.notifySoundFileId) {
		playCustomSound(`/api/notification-sounds/${prefs.notifySoundFileId}`);
	} else {
		playBuiltinSound(prefs.notifySoundBuiltin || "gentle");
	}
}
