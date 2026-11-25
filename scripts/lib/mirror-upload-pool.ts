/** Compatibility exports for release producers; the pool is shared with server-side downloads. */
export {
	groupMirrorUploads,
	MirrorTransferPool as MirrorUploadPool,
	type MirrorUploadAsset,
	type MirrorUploadGroup,
	mirrorUploadDiskBytes,
	orderMirrorUploads,
} from "../../shared/mirror-transfer-pool";
