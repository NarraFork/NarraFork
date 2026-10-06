/**
 * Platform constants and validation.
 */
import type { Platform } from "../types";

export const VALID_PLATFORMS: Platform[] = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-x64-baseline",
	"linux-arm64",
	"win-x64",
	"win-x64-baseline",
	"win-arm64",
];

export function isValidPlatform(value: string): value is Platform {
	return VALID_PLATFORMS.includes(value as Platform);
}

export function isValidChannel(value: string): value is "stable" | "beta" {
	return value === "stable" || value === "beta";
}
