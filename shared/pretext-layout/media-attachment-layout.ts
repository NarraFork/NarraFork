/** Stable audio/video geometry, shared by the player and virtual-list reservation. */
export const MEDIA_ATTACHMENT_WIDTH = 300;
export const MEDIA_ATTACHMENT_FILENAME_HEIGHT = 24;
export const AUDIO_ATTACHMENT_CONTROL_HEIGHT = 54;
export const VIDEO_ATTACHMENT_CONTROL_HEIGHT = 200;
export const AUDIO_ATTACHMENT_HEIGHT =
	AUDIO_ATTACHMENT_CONTROL_HEIGHT + MEDIA_ATTACHMENT_FILENAME_HEIGHT;
export const VIDEO_ATTACHMENT_HEIGHT =
	VIDEO_ATTACHMENT_CONTROL_HEIGHT + MEDIA_ATTACHMENT_FILENAME_HEIGHT;

export function mediaAttachmentHeight(type: "audio" | "video"): number {
	return type === "audio" ? AUDIO_ATTACHMENT_HEIGHT : VIDEO_ATTACHMENT_HEIGHT;
}
