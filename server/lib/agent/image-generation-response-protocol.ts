import type { DiskSafetySettings } from "../disk-safety-config";

export interface ImageGenerationWorkerRequest {
	action: "ping" | "process";
	responseId?: string;
	narratorId?: string;
	responsePath?: string;
	uploadsRoot?: string;
	diskSafety?: DiskSafetySettings;
	httpStatus?: number;
}

export interface StoredImageWorkerResult {
	imageId: string;
	mediaType: string;
	uploadNarratorId: string;
	filePath: string;
	width?: number;
	height?: number;
}

export interface ImageGenerationWorkerSuccess {
	ok: true;
	images: StoredImageWorkerResult[];
}

export interface ImageGenerationWorkerFailure {
	ok: false;
	error: string;
	code?: string;
}

export type ImageGenerationWorkerReply =
	| { ready: true }
	| ImageGenerationWorkerSuccess
	| ImageGenerationWorkerFailure;
