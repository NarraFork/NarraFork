import type { InstalledPackageResult, PackageStoreLimits } from "./plugin-package-store";
import type { SbomInstallPolicy } from "./plugin-sbom";
import type { TrustedPluginKey } from "./plugin-signature";

export const PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION = 1;
export const PLUGIN_PACKAGE_STAGE_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const PLUGIN_PACKAGE_STAGE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PLUGIN_PACKAGE_STAGE_MAX_CONTROL_BYTES = 64 * 1024;
export const PLUGIN_PACKAGE_STAGE_MAX_ERROR_BYTES = 4 * 1024;
export const PLUGIN_PACKAGE_STAGE_MAX_PATH_BYTES = 16 * 1024;
export const PLUGIN_PACKAGE_STAGE_TIMEOUT_MS = 120_000;
export const PLUGIN_PACKAGE_STAGE_STARTUP_TIMEOUT_MS = 5_000;
export const PLUGIN_PACKAGE_STAGE_EXIT_TIMEOUT_MS = 5_000;

export interface PluginPackageStageResult extends InstalledPackageResult {
	signatureIdentity: string | null;
	previousSignatureIdentity: string | null;
	signatureKeyId?: string;
}

export type PluginPackageStageTrustKey = Omit<TrustedPluginKey, "publicKey"> & {
	publicKey: string;
};

export interface PluginPackageStageTrustPolicy {
	enabled: boolean;
	requireSignature: boolean;
	keyringConfigured?: boolean;
	key?: PluginPackageStageTrustKey;
	sbomPolicy?: SbomInstallPolicy;
}

export type PluginPackageStageRequest =
	| { action: "ping" }
	| {
			action: "plugin_package_stage";
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
			id: number;
			root: string;
			source: string | ArrayBuffer;
			limits?: Partial<PackageStoreLimits>;
			oldPackagePath?: string;
			expectedArchiveSha256?: string;
	  }
	| {
			action: "plugin_package_inspect";
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
			id: number;
			root: string;
			source: string;
			limits?: Partial<PackageStoreLimits>;
			identity: { pluginId: string; version: string; hash: string };
	  }
	| {
			action: "plugin_package_verify";
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
			id: number;
			policy: PluginPackageStageTrustPolicy;
	  };

export type PluginPackageStageResponse =
	| {
			packageStageReady: true;
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
	  }
	| {
			type: "staged";
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
			id: number;
			/** Serialized and byte-capped in the Worker, before structured-cloning to the host. */
			resultJson: string;
	  }
	| {
			type: "verified";
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
			id: number;
			verified: true;
	  }
	| {
			type: "error";
			protocolVersion: typeof PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION;
			id: number;
			error: string;
			code: string;
	  };

export function isPluginPackageStageReady(message: unknown): boolean {
	return Boolean(
		message &&
			typeof message === "object" &&
			!Array.isArray(message) &&
			(message as { packageStageReady?: unknown }).packageStageReady === true &&
			(message as { protocolVersion?: unknown }).protocolVersion ===
				PLUGIN_PACKAGE_STAGE_PROTOCOL_VERSION,
	);
}
