/**
 * Notification sound playback using Web Audio API.
 * Supports built-in oscillator-based sounds and custom audio files.
 */

import { authorizedFetch, clearTokenOnSessionFailure } from "./api";
import { apiUrl } from "./base-path";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
	if (!audioCtx) audioCtx = new AudioContext();
	return audioCtx;
}

// --- Volume + concurrency control ---

/** Base gain for built-in oscillator sounds at 100% volume. */
const BUILTIN_BASE_GAIN = 0.3;
/** Base gain for custom audio files at 100% volume. */
const CUSTOM_BASE_GAIN = 0.5;

export const DEFAULT_SOUND_VOLUME = 100;
export const DEFAULT_SOUND_MAX_CONCURRENT = 2;
export const MIN_SOUND_MAX_CONCURRENT = 1;
export const MAX_SOUND_MAX_CONCURRENT = 10;

/** Clamp a stored volume percentage (0-100) into a 0..1 gain multiplier. */
export function resolveVolumeMultiplier(volume?: number | null): number {
	if (typeof volume !== "number" || !Number.isFinite(volume)) return 1;
	return Math.min(100, Math.max(0, volume)) / 100;
}

/** Clamp a stored concurrency limit into the supported range. */
export function resolveMaxConcurrent(max?: number | null): number {
	if (typeof max !== "number" || !Number.isFinite(max)) return DEFAULT_SOUND_MAX_CONCURRENT;
	return Math.min(MAX_SOUND_MAX_CONCURRENT, Math.max(MIN_SOUND_MAX_CONCURRENT, Math.round(max)));
}

/*
 * Number of sounds currently playing. A slow client can queue up many narrator
 * status events at once (e.g. after the tab was frozen or the server was busy),
 * and playing every one of them overlapping is painfully loud. We cap how many
 * can sound simultaneously and simply drop the overflow — a notification sound
 * only needs to signal "something happened", not "N things happened".
 */
let activeSoundCount = 0;

/**
 * Fallback ceiling for a slot whose real duration is unknown — a custom audio
 * file, whose length is only known once it decodes. Without it an <audio>
 * element that never fires ended/error would hold the slot forever and silence
 * every later notification.
 */
const SOUND_SLOT_MAX_HOLD_MS = 15_000;

/**
 * Grace added to a known playback duration before the slot is force-released.
 * Absorbs scheduling jitter and the AudioContext's own start latency, so the
 * safety net never fires while the sound is genuinely still playing.
 */
const SOUND_SLOT_HOLD_GRACE_MS = 500;

/**
 * Try to reserve a playback slot; returns a release fn, or null when full.
 *
 * `maxHoldMs` is a safety net, not the expected lifetime — the normal release is
 * driven by the sound actually ending. Callers that know how long their sound
 * lasts pass that duration, so a playback which never signals completion (a
 * suspended AudioContext with no user gesture yet, an <audio> that fires
 * neither ended nor error) frees the slot on roughly its own timescale instead
 * of blocking notifications for many seconds.
 */
function acquireSoundSlot(maxConcurrent: number, maxHoldMs: number): (() => void) | null {
	const limit = resolveMaxConcurrent(maxConcurrent);
	if (activeSoundCount >= limit) return null;
	activeSoundCount++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		clearTimeout(timer);
		activeSoundCount = Math.max(0, activeSoundCount - 1);
	};
	const timer = setTimeout(release, Math.max(1, maxHoldMs));
	return release;
}

/** Test/inspection helper: how many sounds are currently counted as playing. */
export function getActiveSoundCount(): number {
	return activeSoundCount;
}

/** Test helper: reset the concurrency counter. */
export function resetActiveSoundCount(): void {
	activeSoundCount = 0;
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

/**
 * Total wall-clock length of a built-in sound, in ms.
 *
 * Mirrors the scheduling loop in `playBuiltinSound`: every note contributes its
 * own duration, and audible notes additionally contribute the 20ms gap that the
 * loop inserts after them. Used to bound the playback slot, so a built-in sound
 * that never reports completion frees its slot in well under a second rather
 * than holding it for the unknown-duration fallback.
 */
function builtinSoundDurationMs(def: BuiltinSoundDef): number {
	let total = 0;
	for (const [freqMul, durMul] of def.notes) {
		total += def.duration * durMul;
		if (freqMul !== 0) total += 20;
	}
	return total;
}

export interface PlaybackOptions {
	/** Volume percentage 0-100 (default 100). */
	volume?: number | null;
	/** Max sounds allowed to play at once (default 2). */
	maxConcurrent?: number | null;
	/** Skip the concurrency limit (used by the settings preview button). */
	bypassLimit?: boolean;
}

export function playBuiltinSound(name: string, options: PlaybackOptions = {}): void {
	const def = BUILTIN_SOUNDS[name];
	if (!def) return;

	const gain = BUILTIN_BASE_GAIN * resolveVolumeMultiplier(options.volume);
	if (gain <= 0) return;

	const release = options.bypassLimit
		? () => {}
		: acquireSoundSlot(
				options.maxConcurrent ?? DEFAULT_SOUND_MAX_CONCURRENT,
				builtinSoundDurationMs(def) + SOUND_SLOT_HOLD_GRACE_MS,
			);
	if (!release) return;

	const ctx = getAudioContext();
	if (ctx.state === "suspended") ctx.resume();

	const gainNode = ctx.createGain();
	gainNode.connect(ctx.destination);
	gainNode.gain.value = gain;

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
			release();
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
		release();
		return;
	}

	// Fade out gain at the end
	gainNode.gain.setValueAtTime(gain, offset - 0.05);
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

export async function playCustomSound(url: string, options: PlaybackOptions = {}): Promise<void> {
	const volume = CUSTOM_BASE_GAIN * resolveVolumeMultiplier(options.volume);
	if (volume <= 0) return;

	/*
	 * Reserve the slot before the (possibly slow) fetch so a burst of
	 * notifications can't all pass the check while the first download is still
	 * in flight and then play together.
	 */
	const release = options.bypassLimit
		? () => {}
		: acquireSoundSlot(
				options.maxConcurrent ?? DEFAULT_SOUND_MAX_CONCURRENT,
				// A user-supplied file has no known length here (it is fetched and decoded
				// below), and it can legitimately run for several seconds, so this slot
				// keeps the generic ceiling. The normal release is `ended`/`error`.
				SOUND_SLOT_MAX_HOLD_MS,
			);
	if (!release) return;

	let blobUrl = audioCache.get(url);
	if (blobUrl) {
		touchAudioCache(url, blobUrl);
	} else {
		try {
			const res = await authorizedFetch(url);
			if (!res.ok) {
				await clearTokenOnSessionFailure(res);
				release();
				return;
			}
			const blob = await res.blob();
			if (blob.size > MAX_CUSTOM_AUDIO_BLOB_BYTES) {
				release();
				return;
			}
			blobUrl = URL.createObjectURL(blob);
			touchAudioCache(url, blobUrl);
			trimAudioCache();
		} catch {
			release();
			return;
		}
	}
	const audio = new Audio(blobUrl);
	const cleanup = () => {
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		release();
	};
	audio.volume = Math.min(1, volume);
	audio.addEventListener("ended", cleanup, { once: true });
	audio.addEventListener("error", cleanup, { once: true });
	audio.play().catch(cleanup);
}

// --- Unified playback ---

export interface NotificationSoundPrefs {
	notifySoundType: "builtin" | "custom";
	notifySoundBuiltin: string;
	notifySoundFileId: string | null;
	notifySoundVolume?: number | null;
	notifySoundMaxConcurrent?: number | null;
}

export function playNotificationSound(prefs: NotificationSoundPrefs): void {
	const options: PlaybackOptions = {
		volume: prefs.notifySoundVolume ?? DEFAULT_SOUND_VOLUME,
		maxConcurrent: prefs.notifySoundMaxConcurrent ?? DEFAULT_SOUND_MAX_CONCURRENT,
	};
	if (prefs.notifySoundType === "custom" && prefs.notifySoundFileId) {
		playCustomSound(apiUrl(`/notification-sounds/${prefs.notifySoundFileId}`), options);
	} else {
		playBuiltinSound(prefs.notifySoundBuiltin || "gentle", options);
	}
}
