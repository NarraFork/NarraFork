import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { ConfirmDialogProvider } from "../components/common/ConfirmDialogProvider";
import { StorageSection } from "../components/settings/StorageSection";
import { api } from "../lib/api";
import commonLocale from "../locales/en/common.json";
import settingsLocale from "../locales/en/settings.json";
import {
	getBenchmarkContainerExecutionCapability,
	getChapterBatchMergeCapability,
	getChapterContainersCapability,
	getChapterSplitCapability,
	getCodexManagerParityCapability,
	getContentCapability,
	getDatabaseCapability,
	getFileSystemCapability,
	getGatewayCapability,
	getMcpBuiltinToolsCapability,
	getMcpExternalAgentCapability,
	getMcpExternalServerManagementCapability,
	getMcpExternalToolsCapability,
	getMcpProtocolCapability,
	getMcpServerSettingsStorageCapability,
	getMcpTransportsCapability,
	getNarratorBrowserSessionsCapability,
	getNarratorCompactCapability,
	getNarratorContainerBrowserToolAutoEnableCapability,
	getNarratorDeleteCapability,
	getNarratorPermissionsCapability,
	getNarratorPlanModeCapability,
	getNarratorRetryRecoveryCapability,
	getNarratorReviewToolsCapability,
	getNarratorRollbackEditRegenerateCapability,
	getNarratorSubagentsCapability,
	getNarratorToolInventoryCapability,
	getProviderAgentModeCapability,
	getProviderModelRefreshCapability,
	getProviderQuotaCapability,
	getProviderRouteCapability,
	getProviderRuntimeCapability,
	getRuntimeMaintenanceCapability,
	getSettingsFeatureCapability,
	getSettingsValidationCapability,
	getShareCapability,
	getStorageCapability,
	getStorageCapabilityForHealth,
	getStorageCleanupOperationCapabilities,
	getStorageDatabaseCleanupCapabilities,
	getStorageDatabasePreviewCapability,
	getTerminalCapability,
	getUpdateCapability,
	getUploadCapability,
	getVNetCapability,
	type RuntimeCapabilities,
} from "./usePlatform";

describe("getTerminalCapability", () => {
	test("defaults to supported with no terminal runtime detail metadata", () => {
		expect(getTerminalCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			dtachSupported: undefined,
			dtachAvailable: undefined,
			detachedReattach: undefined,
			orphanRecovery: undefined,
			scrollbackReplay: undefined,
			scrollbackReplayMode: undefined,
			bufferStateReplay: undefined,
			bufferStateMode: undefined,
			xtermSerializedReplay: undefined,
			xtermSerializedReplayReason: undefined,
			multiClientResizeMode: undefined,
			processTree: undefined,
		});
	});

	test("requires explicit terminal support when capability payload is present", () => {
		expect(getTerminalCapability({})).toEqual({
			supported: false,
			reason: undefined,
			dtachSupported: undefined,
			dtachAvailable: undefined,
			detachedReattach: undefined,
			orphanRecovery: undefined,
			scrollbackReplay: undefined,
			scrollbackReplayMode: undefined,
			bufferStateReplay: undefined,
			bufferStateMode: undefined,
			xtermSerializedReplay: undefined,
			xtermSerializedReplayReason: undefined,
			multiClientResizeMode: undefined,
			processTree: undefined,
		});
	});

	test("preserves terminal runtime detail metadata", () => {
		const capabilities: RuntimeCapabilities = {
			terminal: {
				supported: true,
				dtachSupported: true,
				dtachAvailable: false,
				detachedReattach: false,
				orphanRecovery: false,
				scrollbackReplay: true,
				scrollbackReplayMode: "raw-capped-buffer",
				bufferStateReplay: true,
				bufferStateMode: "raw-capped-buffer",
				xtermSerializedReplay: false,
				xtermSerializedReplayReason: "raw replay only",
				multiClientResizeMode: "last-input-client",
				processTree: { supported: false, platform: "unsupported" },
			},
		};

		expect(getTerminalCapability(capabilities)).toEqual({
			supported: true,
			reason: undefined,
			dtachSupported: true,
			dtachAvailable: false,
			detachedReattach: false,
			orphanRecovery: false,
			scrollbackReplay: true,
			scrollbackReplayMode: "raw-capped-buffer",
			bufferStateReplay: true,
			bufferStateMode: "raw-capped-buffer",
			xtermSerializedReplay: false,
			xtermSerializedReplayReason: "raw replay only",
			multiClientResizeMode: "last-input-client",
			processTree: { supported: false, platform: "unsupported" },
		});
	});
});

describe("getDatabaseCapability", () => {
	test("returns undefined when database capability is absent", () => {
		expect(getDatabaseCapability(undefined)).toBeUndefined();
	});

	test("returns database capability payload as-is", () => {
		const capabilities: RuntimeCapabilities = {
			database: {
				engine: "sqlite",
				mainSchemaOwner: "typescript-drizzle",
				ftsRepair: false,
				mode: "ts-owned-db-compatibility",
				searchMode: "sqlite-fts5-with-like-fallback",
				reason: "read-only compatibility",
			},
		};

		expect(getDatabaseCapability(capabilities)).toEqual(capabilities.database);
	});
});

describe("getFileSystemCapability", () => {
	test("defaults filesystem route capabilities to supported for older backends", () => {
		expect(getFileSystemCapability(undefined)).toEqual({
			browse: { supported: true, reason: undefined },
			shortcuts: { supported: true, reason: undefined },
			mkdir: { supported: true, reason: undefined },
			preview: {
				supported: true,
				reason: undefined,
				maxTextBytes: undefined,
				maxBinaryBytes: undefined,
			},
			reveal: { supported: true, reason: undefined },
		});
	});

	test("requires explicit filesystem support when capability metadata is present", () => {
		expect(getFileSystemCapability({ fs: {} })).toEqual({
			browse: { supported: false, reason: undefined },
			shortcuts: { supported: false, reason: undefined },
			mkdir: { supported: false, reason: undefined },
			preview: {
				supported: false,
				reason: undefined,
				maxTextBytes: undefined,
				maxBinaryBytes: undefined,
			},
			reveal: { supported: false, reason: undefined },
		});
	});

	test("preserves explicit unsupported filesystem route capabilities", () => {
		const capabilities: RuntimeCapabilities = {
			fs: {
				browse: { supported: false, reason: "browse disabled" },
				shortcuts: { supported: false, reason: "shortcuts disabled" },
				mkdir: { supported: false, reason: "mkdir disabled" },
				preview: {
					supported: false,
					reason: "preview disabled",
					maxTextBytes: 1024,
					maxBinaryBytes: 2048,
				},
				reveal: { supported: false, reason: "reveal disabled" },
			},
		};

		expect(getFileSystemCapability(capabilities)).toEqual({
			browse: { supported: false, reason: "browse disabled" },
			shortcuts: { supported: false, reason: "shortcuts disabled" },
			mkdir: { supported: false, reason: "mkdir disabled" },
			preview: {
				supported: false,
				reason: "preview disabled",
				maxTextBytes: 1024,
				maxBinaryBytes: 2048,
			},
			reveal: { supported: false, reason: "reveal disabled" },
		});
	});
});

describe("getChapterBatchMergeCapability", () => {
	test("defaults to supported when batch merge capability is absent", () => {
		const result = getChapterBatchMergeCapability(undefined);

		expect(result.supported).toBe(true);
		expect(result.startRouteSupported).toBe(true);
		expect(result.sessionRouteSupported).toBe(true);
		expect(result.mergeSessionIdResponse).toBe(true);
		expect(result.decisionWs).toBe(true);
		expect(result.events).toEqual([]);
	});

	test("requires explicit batch merge route and response support when metadata is present", () => {
		const result = getChapterBatchMergeCapability({
			chapters: {
				batchMerge: {
					supported: true,
					routes: { start: true },
				},
			},
		});

		expect(result.supported).toBe(true);
		expect(result.startRouteSupported).toBe(true);
		expect(result.sessionRouteSupported).toBe(false);
		expect(result.mergeSessionIdResponse).toBe(false);
		expect(result.targetChapterIdResponse).toBe(false);
		expect(result.createdTargetResponse).toBe(false);
		expect(result.statusResponse).toBe(false);
		expect(result.decisionWs).toBe(false);
		expect(result.staleSessionCleanup).toBe(false);
		expect(result.createdTargetRollback).toBe(false);
	});

	test("respects explicit unsupported batch merge capability", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				batchMerge: {
					supported: false,
					reason: "batch merge unavailable",
					routes: { start: true, session: true },
				},
			},
		};

		const result = getChapterBatchMergeCapability(capabilities);

		expect(result.supported).toBe(false);
		expect(result.reason).toBe("batch merge unavailable");
		expect(result.startRouteSupported).toBe(false);
		expect(result.sessionRouteSupported).toBe(false);
		expect(result.mergeSessionIdResponse).toBe(false);
		expect(result.decisionWs).toBe(false);
	});

	test("preserves async merge-session capability details", () => {
		const result = getChapterBatchMergeCapability({
			chapters: {
				batchMerge: {
					supported: true,
					fallback: false,
					mode: "async-merge-session",
					routes: { start: true, session: true },
					response: {
						mergeSessionId: true,
						targetChapterId: true,
						createdTarget: true,
						status: true,
					},
					events: ["merge:started", "merge:conflict", "merge:completed"],
					decisionWs: true,
					staleSessionCleanup: true,
					createdTargetRollback: true,
					frontendCompletionMode: "progress-event-or-session-poll",
				},
			},
		});

		expect(result).toEqual({
			supported: true,
			reason: undefined,
			mode: "async-merge-session",
			startRouteSupported: true,
			sessionRouteSupported: true,
			mergeSessionIdResponse: true,
			targetChapterIdResponse: true,
			createdTargetResponse: true,
			statusResponse: true,
			decisionWs: true,
			staleSessionCleanup: true,
			createdTargetRollback: true,
			frontendCompletionMode: "progress-event-or-session-poll",
			events: ["merge:started", "merge:conflict", "merge:completed"],
		});
	});
});

describe("getChapterSplitCapability", () => {
	/**
	 * This case asserted the opposite until the split route was implemented, and
	 * fail-closed was correct for as long as that was true: `/api/health` has never
	 * advertised a capabilities block, and enabling the UI against a backend with no
	 * `POST /chapters/:id/split` would only have produced a 404.
	 *
	 * Now that the route exists, fail-closed makes the feature permanently
	 * unreachable, so this getter joins the 30+ others that read "no capabilities
	 * block at all" as "the TypeScript backend, which implements this". An
	 * explicitly-sent capabilities object still decides on its own contents — the
	 * cases below cover that.
	 */
	test("assumes support when the backend sends no capabilities block", () => {
		const result = getChapterSplitCapability(undefined);

		expect(result).toEqual({
			supported: true,
			reason: undefined,
			mode: undefined,
			compressedAISummarySupported: false,
			compressedAISummaryFallback: false,
			compressedAISummaryMode: undefined,
			compressedAISummaryReason: undefined,
		});
	});

	test("still requires explicit support once a capabilities block is present", () => {
		const result = getChapterSplitCapability({});

		expect(result.supported).toBe(false);
	});

	test("respects explicit unsupported split capability", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				split: {
					supported: false,
					reason: "split unavailable",
				},
			},
		};

		const result = getChapterSplitCapability(capabilities);

		expect(result).toEqual({
			supported: false,
			reason: "split unavailable",
			mode: undefined,
			compressedAISummarySupported: false,
			compressedAISummaryFallback: false,
			compressedAISummaryMode: undefined,
			compressedAISummaryReason: undefined,
		});
	});

	test("disables split when splitAtCommit route is explicitly unsupported", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				split: {
					supported: true,
					routes: { splitAtCommit: false },
					reason: "split route disabled",
				},
			},
		};

		const result = getChapterSplitCapability(capabilities);

		expect(result).toEqual({
			supported: false,
			reason: "split route disabled",
			mode: undefined,
			compressedAISummarySupported: false,
			compressedAISummaryFallback: false,
			compressedAISummaryMode: undefined,
			compressedAISummaryReason: undefined,
		});
	});

	test("requires explicit split support even when splitAtCommit route metadata is present", () => {
		const result = getChapterSplitCapability({
			chapters: {
				split: {
					mode: "split-at-commit",
					routes: { splitAtCommit: true },
				},
			},
		});

		expect(result).toEqual({
			supported: false,
			reason: undefined,
			mode: "split-at-commit",
			compressedAISummarySupported: false,
			compressedAISummaryFallback: false,
			compressedAISummaryMode: undefined,
			compressedAISummaryReason: undefined,
		});
	});

	test("disables split when splitAtCommit route metadata is absent", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				split: {
					supported: true,
					mode: "split-at-commit",
				},
			},
		};

		const result = getChapterSplitCapability(capabilities);

		expect(result).toEqual({
			supported: false,
			reason: undefined,
			mode: "split-at-commit",
			compressedAISummarySupported: false,
			compressedAISummaryFallback: false,
			compressedAISummaryMode: undefined,
			compressedAISummaryReason: undefined,
		});
	});

	test("does not assume compressed summary support when partial metadata is absent", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				split: {
					supported: true,
					mode: "split-at-commit",
					routes: { splitAtCommit: true },
				},
			},
		};

		const result = getChapterSplitCapability(capabilities);

		expect(result).toEqual({
			supported: true,
			reason: undefined,
			mode: "split-at-commit",
			compressedAISummarySupported: false,
			compressedAISummaryFallback: false,
			compressedAISummaryMode: undefined,
			compressedAISummaryReason: undefined,
		});
	});

	test("preserves compressed split summary fallback metadata", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				split: {
					supported: true,
					mode: "split-at-commit",
					routes: { splitAtCommit: true },
					partials: {
						compressedAISummary: {
							supported: false,
							fallback: true,
							mode: "deterministic-summary-placeholder",
							reason: "compressed summary fallback",
						},
					},
				},
			},
		};

		const result = getChapterSplitCapability(capabilities);

		expect(result).toEqual({
			supported: true,
			reason: undefined,
			mode: "split-at-commit",
			compressedAISummarySupported: false,
			compressedAISummaryFallback: true,
			compressedAISummaryMode: "deterministic-summary-placeholder",
			compressedAISummaryReason: "compressed summary fallback",
		});
	});
});

describe("getChapterContainersCapability", () => {
	test("defaults to supported when chapter container capability is absent", () => {
		const result = getChapterContainersCapability(undefined);

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(result.routes.list).toBe(true);
		expect(result.routes.start).toBe(true);
		expect(result.routes.stop).toBe(true);
		expect(result.routes.logs).toBe(true);
		expect(result.runtime.backgroundStart).toBeUndefined();
		expect(result.ports.legacyHostPortAllocation).toBeUndefined();
		expect(result.proxy.reverseProxyServer).toBeUndefined();
	});

	test("requires explicit chapter container route support when metadata is present", () => {
		const result = getChapterContainersCapability({
			chapters: {
				containers: {
					supported: true,
					routes: { list: true, logs: true },
				},
			},
		});

		expect(result.supported).toBe(true);
		expect(result.routes.list).toBe(true);
		expect(result.routes.logs).toBe(true);
		expect(result.routes.start).toBe(false);
		expect(result.routes.stop).toBe(false);
		expect(result.routes.pause).toBe(false);
		expect(result.routes.remove).toBe(false);
	});

	test("respects explicit unsupported chapter container capability", () => {
		const capabilities: RuntimeCapabilities = {
			chapters: {
				containers: {
					supported: false,
					reason: "containers unavailable",
				},
			},
		};

		const result = getChapterContainersCapability(capabilities);

		expect(result.supported).toBe(false);
		expect(result.reason).toBe("containers unavailable");
		expect(result.routes.list).toBe(false);
		expect(result.routes.start).toBe(false);
		expect(result.routes.stop).toBe(false);
		expect(result.routes.logs).toBe(false);
		expect(result.runtime.backgroundStart).toBeUndefined();
		expect(result.ports.portRelease).toBeUndefined();
		expect(result.proxy.http).toBeUndefined();
	});

	test("preserves per-route chapter container capabilities", () => {
		const result = getChapterContainersCapability({
			chapters: {
				containers: {
					supported: true,
					routes: {
						list: true,
						start: false,
						stop: true,
						logs: false,
						remove: false,
					},
					runtime: {
						podmanCompose: true,
						podmanComposeFallbackCommand: true,
						boundedOutput: true,
						syncStartRequest: false,
						backgroundStart: true,
						backgroundStartReason: "starts in background",
						streamingLogs: true,
						perChapterLock: true,
					},
					ports: {
						legacyHostPortAllocation: true,
						portRelease: true,
					},
					proxy: {
						metadataSupported: true,
						requiresPastaPasst: true,
						overridePortsReset: true,
						reverseProxyServer: true,
						http: true,
						websocket: true,
						dynamicSettingsHook: true,
					},
				},
			},
		});

		expect(result.supported).toBe(true);
		expect(result.routes.list).toBe(true);
		expect(result.routes.start).toBe(false);
		expect(result.routes.stop).toBe(true);
		expect(result.routes.logs).toBe(false);
		expect(result.routes.remove).toBe(false);
		expect(result.routes.pause).toBe(false);
		expect(result.runtime).toEqual({
			podmanCompose: true,
			podmanComposeFallbackCommand: true,
			boundedOutput: true,
			syncStartRequest: false,
			backgroundStart: true,
			backgroundStartReason: "starts in background",
			streamingLogs: true,
			perChapterLock: true,
		});
		expect(result.ports).toEqual({ legacyHostPortAllocation: true, portRelease: true });
		expect(result.proxy).toEqual({
			metadataSupported: true,
			requiresPastaPasst: true,
			overridePortsReset: true,
			reverseProxyServer: true,
			http: true,
			websocket: true,
			dynamicSettingsHook: true,
		});
	});
});

describe("getProviderModelRefreshCapability", () => {
	test("defaults to supported when capability is absent", () => {
		const result = getProviderModelRefreshCapability(undefined, "openai");

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test("requires explicit model refresh support when provider metadata is present", () => {
		const result = getProviderModelRefreshCapability(
			{ providers: { openai: { models: {} } } },
			"openai",
		);

		expect(result).toEqual({ supported: false, reason: undefined });
	});

	test("respects explicit unsupported refresh capability", () => {
		const capabilities: RuntimeCapabilities = {
			providers: {
				openai: {
					models: {
						refreshSupported: false,
						reason: "refresh blocked",
					},
				},
			},
		};

		const result = getProviderModelRefreshCapability(capabilities, "openai");

		expect(result).toEqual({ supported: false, reason: "refresh blocked" });
	});

	test("preserves a custom reason when refresh is supported", () => {
		const capabilities: RuntimeCapabilities = {
			providers: {
				anthropic: {
					models: {
						refreshSupported: true,
						reason: "legacy fallback",
					},
				},
			},
		};

		const result = getProviderModelRefreshCapability(capabilities, "anthropic");

		expect(result).toEqual({ supported: true, reason: "legacy fallback" });
	});
});

describe("getVNetCapability", () => {
	test("defaults to supported relay-safe vnet capability", () => {
		expect(getVNetCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			mode: undefined,
			ws: true,
			peerCleanup: true,
			udpRendezvous: false,
			udpRendezvousReason: undefined,
		});
	});

	test("requires explicit VNet relay support when capability payload is present", () => {
		expect(getVNetCapability({})).toEqual({
			supported: false,
			reason: undefined,
			mode: undefined,
			ws: false,
			peerCleanup: false,
			udpRendezvous: false,
			udpRendezvousReason: undefined,
		});

		expect(getVNetCapability({ vnet: { supported: true, ws: true } })).toEqual({
			supported: true,
			reason: undefined,
			mode: undefined,
			ws: true,
			peerCleanup: false,
			udpRendezvous: false,
			udpRendezvousReason: undefined,
		});
	});

	test("preserves relay mode and disabled udp rendezvous metadata", () => {
		const capabilities: RuntimeCapabilities = {
			vnet: {
				supported: true,
				mode: "relay",
				ws: true,
				peerCleanup: true,
				udpRendezvous: false,
				udpRendezvousReason: "relay-only mode",
			},
		};

		expect(getVNetCapability(capabilities)).toEqual({
			supported: true,
			reason: undefined,
			mode: "relay",
			ws: true,
			peerCleanup: true,
			udpRendezvous: false,
			udpRendezvousReason: "relay-only mode",
		});
	});
});

describe("getUpdateCapability", () => {
	test("defaults update flow to self-update capable", () => {
		expect(getUpdateCapability(undefined)).toEqual({
			selfUpdateAvailable: true,
			manualOnly: false,
			canAutoRestart: true,
			download: {
				supported: true,
				reason: undefined,
				sse: true,
				sha512: true,
				maxBytes: undefined,
				trustMode: undefined,
			},
			apply: {
				supported: true,
				reason: undefined,
				handoff: undefined,
			},
		});
	});

	test("requires explicit update download/apply support when capability payload is present", () => {
		expect(getUpdateCapability({})).toEqual({
			selfUpdateAvailable: false,
			manualOnly: false,
			canAutoRestart: false,
			download: {
				supported: false,
				reason: undefined,
				sse: false,
				sha512: false,
				maxBytes: undefined,
				trustMode: undefined,
			},
			apply: {
				supported: false,
				reason: undefined,
				handoff: undefined,
			},
		});

		expect(
			getUpdateCapability({
				update: { download: { supported: true, sse: true } },
			}),
		).toEqual({
			selfUpdateAvailable: false,
			manualOnly: false,
			canAutoRestart: false,
			download: {
				supported: true,
				reason: undefined,
				sse: true,
				sha512: false,
				maxBytes: undefined,
				trustMode: undefined,
			},
			apply: {
				supported: false,
				reason: undefined,
				handoff: undefined,
			},
		});
	});

	test("preserves manual-only update fallback", () => {
		const capabilities: RuntimeCapabilities = {
			update: {
				selfUpdateAvailable: false,
				manualOnly: true,
				canAutoRestart: false,
				download: {
					supported: true,
					sse: true,
					sha512: true,
					maxBytes: 512,
					trustMode: "server-configured-trusted-source",
				},
				apply: {
					supported: false,
					reason: "no handoff manager",
				},
			},
		};

		expect(getUpdateCapability(capabilities)).toEqual({
			selfUpdateAvailable: false,
			manualOnly: true,
			canAutoRestart: false,
			download: {
				supported: true,
				reason: undefined,
				sse: true,
				sha512: true,
				maxBytes: 512,
				trustMode: "server-configured-trusted-source",
			},
			apply: {
				supported: false,
				reason: "no handoff manager",
				handoff: undefined,
			},
		});
	});

	test("treats partial manual-only update metadata as non-auto-applicable", () => {
		const capabilities: RuntimeCapabilities = {
			update: {
				manualOnly: true,
				download: {
					supported: true,
					sse: true,
					sha512: true,
				},
			},
		};

		expect(getUpdateCapability(capabilities)).toEqual({
			selfUpdateAvailable: false,
			manualOnly: true,
			canAutoRestart: false,
			download: {
				supported: true,
				reason: undefined,
				sse: true,
				sha512: true,
				maxBytes: undefined,
				trustMode: undefined,
			},
			apply: {
				supported: false,
				reason: undefined,
				handoff: undefined,
			},
		});
	});
});

describe("getGatewayCapability", () => {
	test("defaults gateway runtime to persistent runtimes with QR support", () => {
		const result = getGatewayCapability(undefined);

		expect(result.persistentRuntimes).toBe(true);
		expect(result.weixinQrSupported).toBe(true);
		expect(result.webhookSupported).toBe(true);
		expect(result.isPlatformSupported("telegram")).toBe(true);
		expect(result.isPlatformSupported("weixin")).toBe(true);
		expect(result.platformUnsupportedReason("weixin")).toBeUndefined();
	});

	test("requires explicit gateway platform support when capability payload is present", () => {
		const result = getGatewayCapability({});

		expect(result.persistentRuntimes).toBe(false);
		expect(result.weixinQrSupported).toBe(false);
		expect(result.webhookSupported).toBe(false);
		expect(result.isPlatformSupported("webhook")).toBe(false);
		expect(result.isPlatformSupported("telegram")).toBe(false);
		expect(result.isPlatformSupported("weixin")).toBe(false);
	});

	test("does not assume persistent runtimes or Weixin QR when gateway metadata is partial", () => {
		const result = getGatewayCapability({
			gateway: {
				webhook: { supported: true },
			},
		});

		expect(result.persistentRuntimes).toBe(false);
		expect(result.weixinQrSupported).toBe(false);
		expect(result.webhookSupported).toBe(true);
		expect(result.isPlatformSupported("webhook")).toBe(true);
		expect(result.isPlatformSupported("telegram")).toBe(false);
		expect(result.isPlatformSupported("weixin")).toBe(false);
	});

	test("preserves gateway platform limits and disabled Weixin QR metadata", () => {
		const capabilities: RuntimeCapabilities = {
			gateway: {
				persistentRuntimes: true,
				webhook: { supported: true },
				supportedPlatforms: ["telegram", "webhook"],
				unsupportedPlatforms: { weixin: "QR/runtime not implemented" },
				weixinQr: { supported: false, reason: "QR runtime unavailable" },
				reason: "persistent-plus-http-webhook",
			},
		};

		const result = getGatewayCapability(capabilities);

		expect(result.persistentRuntimes).toBe(true);
		expect(result.supportedPlatforms).toEqual(["telegram", "webhook"]);
		expect(result.weixinQrSupported).toBe(false);
		expect(result.weixinQrReason).toBe("QR runtime unavailable");
		expect(result.webhookSupported).toBe(true);
		expect(result.isPlatformSupported("telegram")).toBe(true);
		expect(result.isPlatformSupported("webhook")).toBe(true);
		expect(result.isPlatformSupported("weixin")).toBe(false);
		expect(result.platformUnsupportedReason("weixin")).toBe("QR/runtime not implemented");
		expect(result.reason).toBe("persistent-plus-http-webhook");
	});

	test("falls back to webhook only when persistent runtimes are disabled", () => {
		const result = getGatewayCapability({
			gateway: { persistentRuntimes: false, webhook: { supported: true } },
		});

		expect(result.persistentRuntimes).toBe(false);
		expect(result.webhookSupported).toBe(true);
		expect(result.isPlatformSupported("webhook")).toBe(true);
		expect(result.isPlatformSupported("telegram")).toBe(false);
	});

	test("honors disabled webhook capability and surfaces its reason", () => {
		const result = getGatewayCapability({
			gateway: {
				persistentRuntimes: false,
				webhook: { supported: false, reason: "webhook runtime unavailable" },
			},
		});

		expect(result.webhookSupported).toBe(false);
		expect(result.webhookReason).toBe("webhook runtime unavailable");
		expect(result.isPlatformSupported("webhook")).toBe(false);
		expect(result.platformUnsupportedReason("webhook")).toBe("webhook runtime unavailable");
	});
});

describe("getNarratorBrowserSessionsCapability", () => {
	test("defaults browser sessions to supported", () => {
		expect(getNarratorBrowserSessionsCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			defaultEnabled: undefined,
			runtime: undefined,
			storage: undefined,
			cutover: undefined,
			rollback: undefined,
			narratorBound: undefined,
			lifecycleEvents: undefined,
			artifactPersistence: undefined,
			resourceLimits: undefined,
			requiresChrome: undefined,
		});
	});

	test("requires explicit browser session support when narrator capability metadata is present", () => {
		expect(
			getNarratorBrowserSessionsCapability({
				narrator: {
					planMode: { supported: true },
				},
			}),
		).toEqual({
			supported: false,
			reason: undefined,
			defaultEnabled: undefined,
			runtime: undefined,
			storage: undefined,
			cutover: undefined,
			rollback: undefined,
			narratorBound: undefined,
			lifecycleEvents: undefined,
			artifactPersistence: undefined,
			resourceLimits: undefined,
			requiresChrome: undefined,
		});
	});

	test("preserves disabled browser sessions metadata", () => {
		expect(
			getNarratorBrowserSessionsCapability({
				narrator: {
					browserSessions: {
						supported: false,
						reason: "browser sessions runtime disabled",
					},
				},
			}),
		).toEqual({
			supported: false,
			reason: "browser sessions runtime disabled",
			defaultEnabled: undefined,
			runtime: undefined,
			storage: undefined,
			cutover: undefined,
			rollback: undefined,
			narratorBound: undefined,
			lifecycleEvents: undefined,
			artifactPersistence: undefined,
			resourceLimits: undefined,
			requiresChrome: undefined,
		});
	});

	test("preserves enabled browser session runtime metadata", () => {
		expect(
			getNarratorBrowserSessionsCapability({
				narrator: {
					browserSessions: {
						supported: true,
						defaultEnabled: false,
						reason: "opt-in browser sessions",
						runtime: "browser-runtime",
						storage: "backend-owned-optional-table",
						cutover: "explicit-enable",
						rollback: "explicit-disable-or-export",
						narratorBound: true,
						lifecycleEvents: true,
						artifactPersistence: true,
						resourceLimits: true,
						requiresChrome: true,
					},
				},
			}),
		).toEqual({
			supported: true,
			reason: "opt-in browser sessions",
			defaultEnabled: false,
			runtime: "browser-runtime",
			storage: "backend-owned-optional-table",
			cutover: "explicit-enable",
			rollback: "explicit-disable-or-export",
			narratorBound: true,
			lifecycleEvents: true,
			artifactPersistence: true,
			resourceLimits: true,
			requiresChrome: true,
		});
	});
});

describe("getNarratorContainerBrowserToolAutoEnableCapability", () => {
	test("returns undefined when container browser auto-enable metadata is absent", () => {
		expect(getNarratorContainerBrowserToolAutoEnableCapability(undefined)).toBeUndefined();
	});

	test("preserves container browser auto-enable metadata", () => {
		expect(
			getNarratorContainerBrowserToolAutoEnableCapability({
				narrator: {
					containerBrowserToolAutoEnable: {
						defaultEnabled: false,
						cutover: "backend-browser-tool-default-off",
						rollback: "enable manually in settings",
						reason: "native browser extension disabled by default",
					},
				},
			}),
		).toEqual({
			defaultEnabled: false,
			cutover: "backend-browser-tool-default-off",
			rollback: "enable manually in settings",
			reason: "native browser extension disabled by default",
		});
	});
});

describe("getProviderRouteCapability", () => {
	test("defaults provider routes to supported for older backends", () => {
			supported: true,
			reason: undefined,
		});
	});

	test("requires explicit provider route support when provider metadata is present", () => {
		expect(
			getProviderRouteCapability(
				{ providers: { codex: { routes: { supported: true } } } },
				"codex",
				"credentialDelete",
			),
		).toEqual({ supported: false, reason: undefined });
	});

	test("disables a route when the provider route group is unsupported", () => {
		expect(
			getProviderRouteCapability(
				{
					providers: {
						},
					},
				},
				"credentialDelete",
			),
	});

	test("disables only explicitly unsupported provider routes", () => {
		const capabilities: RuntimeCapabilities = {
			providers: {
				codex: {
					routes: {
						supported: true,
						credentialUsage: false,
						credentialDelete: true,
						reason: "usage route unavailable",
					},
				},
			},
		};

		expect(getProviderRouteCapability(capabilities, "codex", "credentialUsage")).toEqual({
			supported: false,
			reason: "usage route unavailable",
		});
		expect(getProviderRouteCapability(capabilities, "codex", "credentialDelete")).toEqual({
			supported: true,
			reason: undefined,
		});
		expect(getProviderRouteCapability(capabilities, "codex", "status")).toEqual({
			supported: false,
			reason: "usage route unavailable",
		});
	});

	test("uses route-specific unsupported reasons when present", () => {
		const capabilities: RuntimeCapabilities = {
			providers: {
					routes: {
						supported: true,
						chat: false,
					},
				},
			},
		};

			supported: false,
		});
	});
});

describe("getProviderRuntimeCapability", () => {
	test("returns undefined when provider runtime capability is absent", () => {
		expect(getProviderRuntimeCapability(undefined, "codex")).toBeUndefined();
	});

	test("returns provider-specific runtime capability metadata", () => {
		expect(
			getProviderRuntimeCapability(
				{
					providers: {
						codex: {
							quota: { supported: false, reason: "quota unavailable" },
							agentMode: { supported: true },
							routes: { supported: true, status: true, browserAuth: true },
							agentRuntime: { supported: true, responsesWebSocket: true },
							pluginBridge: {
								supported: true,
								requiresBun: true,
								reason: "external bridge required",
							},
							mcp: { listToolsRoute: true, searchRoute: true, agentInjection: false },
						},
						openai: {
							models: { refreshSupported: false, reason: "refresh disabled" },
						},
					},
				},
				"codex",
			),
		).toEqual({
			quota: { supported: false, reason: "quota unavailable" },
			agentMode: { supported: true },
			routes: { supported: true, status: true, browserAuth: true },
			agentRuntime: { supported: true, responsesWebSocket: true },
			pluginBridge: {
				supported: true,
				requiresBun: true,
				reason: "external bridge required",
			},
			mcp: { listToolsRoute: true, searchRoute: true, agentInjection: false },
		});
	});
});

describe("getCodexManagerParityCapability", () => {
	test("defaults codex manager parity to undefined", () => {
		expect(getCodexManagerParityCapability(undefined)).toBeUndefined();
	});

	test("preserves codex manager parity metadata", () => {
		expect(
			getCodexManagerParityCapability({
				providers: {
					codex: {
						managerParity: {
							tsCodexManagerEquivalent: false,
							usageQueueParity: "partial",
							usageQueueClearSupported: false,
							snapshotPaginationParity: "partial",
							reason: "usage queue lagging behind",
						},
					},
				},
			}),
		).toEqual({
			tsCodexManagerEquivalent: false,
			usageQueueParity: "partial",
			usageQueueClearSupported: false,
			snapshotPaginationParity: "partial",
			reason: "usage queue lagging behind",
		});
	});
});

describe("getNarratorPlanModeCapability", () => {
	test("defaults to supported when plan mode capability is absent", () => {
		expect(getNarratorPlanModeCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			api: undefined,
			toolReflection: undefined,
			previousModeRestore: undefined,
		});
	});

	test("requires explicit plan mode support when capability metadata is present", () => {
		expect(getNarratorPlanModeCapability({ narrator: {} })).toEqual({
			supported: false,
			reason: undefined,
			api: undefined,
			toolReflection: undefined,
			previousModeRestore: undefined,
		});
	});

	test("preserves unsupported plan mode metadata", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				planMode: {
					supported: false,
					reason: "plan mode disabled",
					api: false,
					toolReflection: false,
					previousModeRestore: false,
				},
			},
		};

		expect(getNarratorPlanModeCapability(capabilities)).toEqual({
			supported: false,
			reason: "plan mode disabled",
			api: false,
			toolReflection: false,
			previousModeRestore: false,
		});
	});
});

describe("getNarratorDeleteCapability", () => {
	test("defaults narrator deletion to supported for older backends", () => {
		expect(getNarratorDeleteCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			code: undefined,
			feature: undefined,
		});
	});

	test("requires explicit delete support when narrator capability metadata is present", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				planMode: { supported: true },
			},
		};

		expect(getNarratorDeleteCapability(capabilities)).toEqual({
			supported: false,
			reason: undefined,
			code: undefined,
			feature: undefined,
		});
	});

	test("preserves disabled narrator deletion metadata", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				delete: {
					supported: false,
					code: "FEATURE_DISABLED",
					feature: "narrators.delete",
					reason: "safe deletion unavailable",
				},
			},
		};

		expect(getNarratorDeleteCapability(capabilities)).toEqual({
			supported: false,
			reason: "safe deletion unavailable",
			code: "FEATURE_DISABLED",
			feature: "narrators.delete",
		});
	});
});

describe("getNarratorRollbackEditRegenerateCapability", () => {
	test("defaults rollback/edit-regenerate to supported for older backends", () => {
		expect(getNarratorRollbackEditRegenerateCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			rollback: undefined,
			editAndRegenerate: undefined,
			copyOnWrite: undefined,
			messageRefTruncation: undefined,
			fileStateRebuild: undefined,
			toolCallInvalidation: undefined,
			agentRerun: undefined,
			optionalFileRevert: undefined,
			optionalAgentRerun: undefined,
			wsEvents: undefined,
		});
	});

	test("requires explicit rollback/edit-regenerate support when narrator metadata is present", () => {
		expect(
			getNarratorRollbackEditRegenerateCapability({
				narrator: {
					planMode: { supported: true },
				},
			}),
		).toEqual({
			supported: false,
			reason: undefined,
			rollback: undefined,
			editAndRegenerate: undefined,
			copyOnWrite: undefined,
			messageRefTruncation: undefined,
			fileStateRebuild: undefined,
			toolCallInvalidation: undefined,
			agentRerun: undefined,
			optionalFileRevert: undefined,
			optionalAgentRerun: undefined,
			wsEvents: undefined,
		});
	});

	test("preserves supported rollback/edit-regenerate metadata", () => {
		expect(
			getNarratorRollbackEditRegenerateCapability({
				narrator: {
					rollbackEditRegenerate: {
						supported: true,
						reason: "active rollback routes",
						rollback: true,
						editAndRegenerate: true,
						copyOnWrite: true,
						messageRefTruncation: true,
						fileStateRebuild: true,
						toolCallInvalidation: true,
						agentRerun: true,
						optionalFileRevert: true,
						optionalAgentRerun: true,
						wsEvents: true,
					},
				},
			}),
		).toEqual({
			supported: true,
			reason: "active rollback routes",
			rollback: true,
			editAndRegenerate: true,
			copyOnWrite: true,
			messageRefTruncation: true,
			fileStateRebuild: true,
			toolCallInvalidation: true,
			agentRerun: true,
			optionalFileRevert: true,
			optionalAgentRerun: true,
			wsEvents: true,
		});
	});
});

describe("getNarratorRetryRecoveryCapability", () => {
	test("defaults to supported when retry recovery capability is absent", () => {
		expect(getNarratorRetryRecoveryCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			retry: undefined,
			continue: undefined,
			interrupt: undefined,
			manualOverride: undefined,
			rollback: undefined,
			editAndRegenerate: undefined,
		});
	});

	test("requires explicit retry recovery support and action flags when metadata is present", () => {
		expect(
			getNarratorRetryRecoveryCapability({
				narrator: {
					retryRecovery: { supported: true, retry: true },
				},
			}),
		).toEqual({
			supported: true,
			reason: undefined,
			retry: true,
			continue: false,
			interrupt: false,
			manualOverride: false,
			rollback: false,
			editAndRegenerate: false,
		});

		expect(getNarratorRetryRecoveryCapability({ narrator: {} })).toEqual({
			supported: false,
			reason: undefined,
			retry: false,
			continue: false,
			interrupt: false,
			manualOverride: false,
			rollback: false,
			editAndRegenerate: false,
		});
	});

	test("preserves unsupported retry recovery metadata", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				retryRecovery: {
					supported: false,
					reason: "retry recovery disabled",
					retry: false,
					continue: false,
					interrupt: false,
					manualOverride: false,
					rollback: false,
					editAndRegenerate: false,
				},
			},
		};

		expect(getNarratorRetryRecoveryCapability(capabilities)).toEqual({
			supported: false,
			reason: "retry recovery disabled",
			retry: false,
			continue: false,
			interrupt: false,
			manualOverride: false,
			rollback: false,
			editAndRegenerate: false,
		});
	});
});

describe("getNarratorPermissionsCapability", () => {
	test("defaults permission modes and decision metadata to supported", () => {
		expect(getNarratorPermissionsCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			modes: ["default", "acceptEdits", "bypassPermissions", "readOnly", "dontAsk"],
			approveDeny: true,
			updatedInput: true,
			pauseResume: undefined,
			reflections: ["danger", "plan", "goal"],
		});
	});

	test("requires explicit narrator permission support and actions when metadata is present", () => {
		expect(getNarratorPermissionsCapability({ narrator: {} })).toEqual({
			supported: false,
			reason: undefined,
			modes: [],
			approveDeny: false,
			updatedInput: false,
			pauseResume: undefined,
			reflections: [],
		});

		expect(
			getNarratorPermissionsCapability({
				narrator: {
					permissions: { supported: true, modes: ["default"], approveDeny: true },
				},
			}),
		).toEqual({
			supported: true,
			reason: undefined,
			modes: ["default"],
			approveDeny: true,
			updatedInput: false,
			pauseResume: undefined,
			reflections: [],
		});
	});

	test("preserves explicit permission mode restrictions", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				permissions: {
					supported: true,
					reason: "limited permission runtime",
					modes: ["default", "readOnly"],
					approveDeny: false,
					updatedInput: false,
					pauseResume: "none",
					reflections: ["danger"],
				},
			},
		};

		expect(getNarratorPermissionsCapability(capabilities)).toEqual({
			supported: true,
			reason: "limited permission runtime",
			modes: ["default", "readOnly"],
			approveDeny: false,
			updatedInput: false,
			pauseResume: "none",
			reflections: ["danger"],
		});
	});
});

describe("getNarratorReviewToolsCapability", () => {
	test("defaults review tools to supported for older backends", () => {
		expect(getNarratorReviewToolsCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			concludeReview: true,
			feedbackInjection: true,
			promote: true,
			dismiss: true,
			convertToSubagent: true,
			staleMergeGuard: true,
		});
	});

	test("requires explicit review tool support and actions when metadata is present", () => {
		expect(getNarratorReviewToolsCapability({ narrator: {} })).toEqual({
			supported: false,
			reason: undefined,
			concludeReview: false,
			feedbackInjection: false,
			promote: false,
			dismiss: false,
			convertToSubagent: false,
			staleMergeGuard: false,
		});

		expect(
			getNarratorReviewToolsCapability({
				narrator: {
					reviewTools: { supported: true, concludeReview: true, promote: true },
				},
			}),
		).toEqual({
			supported: true,
			reason: undefined,
			concludeReview: true,
			feedbackInjection: false,
			promote: true,
			dismiss: false,
			convertToSubagent: false,
			staleMergeGuard: false,
		});
	});

	test("preserves disabled review tool actions", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				reviewTools: {
					supported: false,
					reason: "review tools disabled",
					concludeReview: false,
					feedbackInjection: false,
					promote: false,
					dismiss: false,
					convertToSubagent: false,
					staleMergeGuard: false,
				},
			},
		};

		expect(getNarratorReviewToolsCapability(capabilities)).toEqual({
			supported: false,
			reason: "review tools disabled",
			concludeReview: false,
			feedbackInjection: false,
			promote: false,
			dismiss: false,
			convertToSubagent: false,
			staleMergeGuard: false,
		});
	});
});

describe("getNarratorSubagentsCapability", () => {
	test("defaults subagent runtime actions to supported for older backends", () => {
		expect(getNarratorSubagentsCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			foreground: true,
			background: true,
			awaitAgent: true,
			awaitBash: true,
			awaitBashWaitForText: true,
			awaitBashReason: undefined,
			send: true,
			teamStatus: true,
			detachAttach: true,
			detachUnblocksParent: true,
			reattachBlocksParent: true,
			reattachFallback: false,
			reattachReason: undefined,
			backgroundResultInjection: true,
			staleRecovery: true,
		});
	});

	test("requires explicit subagent support and runtime actions when metadata is present", () => {
		expect(getNarratorSubagentsCapability({ narrator: {} })).toEqual({
			supported: false,
			reason: undefined,
			foreground: false,
			background: false,
			awaitAgent: false,
			awaitBash: false,
			awaitBashWaitForText: false,
			awaitBashReason: undefined,
			send: false,
			teamStatus: false,
			detachAttach: false,
			detachUnblocksParent: false,
			reattachBlocksParent: false,
			reattachFallback: false,
			reattachReason: undefined,
			backgroundResultInjection: false,
			staleRecovery: false,
		});

		expect(
			getNarratorSubagentsCapability({
				narrator: {
					subagents: { supported: true, foreground: true, background: true },
				},
			}),
		).toEqual({
			supported: true,
			reason: undefined,
			foreground: true,
			background: true,
			awaitAgent: false,
			awaitBash: false,
			awaitBashWaitForText: false,
			awaitBashReason: undefined,
			send: false,
			teamStatus: false,
			detachAttach: false,
			detachUnblocksParent: false,
			reattachBlocksParent: false,
			reattachFallback: false,
			reattachReason: undefined,
			backgroundResultInjection: false,
			staleRecovery: false,
		});
	});

	test("preserves disabled subagent runtime actions", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				subagents: {
					supported: false,
					reason: "subagents disabled",
					foreground: false,
					background: false,
					awaitAgent: false,
					awaitBash: false,
					awaitBashWaitForText: false,
					awaitBashReason: "bash await unsupported",
					send: false,
					teamStatus: false,
					detachAttach: false,
					detachUnblocksParent: false,
					reattachBlocksParent: false,
					reattachFallback: true,
					reattachReason: "reattach cannot block parent",
					backgroundResultInjection: false,
					staleRecovery: false,
				},
			},
		};

		expect(getNarratorSubagentsCapability(capabilities)).toEqual({
			supported: false,
			reason: "subagents disabled",
			foreground: false,
			background: false,
			awaitAgent: false,
			awaitBash: false,
			awaitBashWaitForText: false,
			awaitBashReason: "bash await unsupported",
			send: false,
			teamStatus: false,
			detachAttach: false,
			detachUnblocksParent: false,
			reattachBlocksParent: false,
			reattachFallback: true,
			reattachReason: "reattach cannot block parent",
			backgroundResultInjection: false,
			staleRecovery: false,
		});
	});

	test("preserves await bash degradation metadata", () => {
		const result = getNarratorSubagentsCapability({
			narrator: {
				subagents: {
					supported: true,
					awaitAgent: true,
					awaitBash: false,
					awaitBashWaitForText: false,
					awaitBashReason: "This backend supports awaiting agent tasks only",
				},
			},
		});

		expect(result.awaitAgent).toBe(true);
		expect(result.awaitBash).toBe(false);
		expect(result.awaitBashWaitForText).toBe(false);
		expect(result.awaitBashReason).toBe("This backend supports awaiting agent tasks only");
	});
});

describe("getProviderAgentModeCapability", () => {
	test("defaults to supported when provider agent mode capability is absent", () => {
		const result = getProviderAgentModeCapability(undefined, "openai");

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test("requires explicit provider agent mode support when provider metadata is present", () => {
		const result = getProviderAgentModeCapability(
			{ providers: { openai: { agentMode: {} } } },
			"openai",
		);

		expect(result).toEqual({ supported: false, reason: undefined });
	});

	test("respects explicit unsupported provider agent mode capability", () => {
		const capabilities: RuntimeCapabilities = {
			providers: {
				cline: {
					agentMode: {
						supported: false,
						reason: "cline agent runtime disabled",
					},
				},
			},
		};

		const result = getProviderAgentModeCapability(capabilities, "cline");

		expect(result).toEqual({ supported: false, reason: "cline agent runtime disabled" });
	});
});

describe("getProviderQuotaCapability", () => {
	test("defaults to supported when provider quota capability is absent", () => {
		const result = getProviderQuotaCapability(undefined, "nug");

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	test("requires explicit provider quota support when provider metadata is present", () => {
		const result = getProviderQuotaCapability({ providers: { nug: { quota: {} } } }, "nug");

		expect(result).toEqual({ supported: false, reason: undefined });
	});

	test("respects explicit unsupported provider quota capability", () => {
		const capabilities: RuntimeCapabilities = {
			providers: {
				anthropic: {
					quota: {
						supported: false,
						reason: "quota unavailable",
					},
				},
			},
		};

		const result = getProviderQuotaCapability(capabilities, "anthropic");

		expect(result).toEqual({ supported: false, reason: "quota unavailable" });
	});
});

describe("getNarratorCompactCapability", () => {
	test("defaults to supported when compact capability is absent", () => {
		expect(getNarratorCompactCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			mode: undefined,
			fallbackSummary: undefined,
			fallbackReason: undefined,
		});
	});

	test("requires explicit compact support when narrator metadata is present", () => {
		expect(getNarratorCompactCapability({ narrator: {} })).toEqual({
			supported: false,
			reason: undefined,
			mode: undefined,
			fallbackSummary: undefined,
			fallbackReason: undefined,
		});
	});

	test("preserves unsupported compact capability and fallback metadata", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				compact: {
					supported: false,
					reason: "compact disabled",
					mode: "deterministic-fallback-or-caller-summary",
					fallbackSummary: true,
					fallbackReason: "deterministic summary only",
				},
			},
		};

		expect(getNarratorCompactCapability(capabilities)).toEqual({
			supported: false,
			reason: "compact disabled",
			mode: "deterministic-fallback-or-caller-summary",
			fallbackSummary: true,
			fallbackReason: "deterministic summary only",
		});
	});
});

describe("getNarratorToolInventoryCapability", () => {
	test("defaults to supported with no unsupported optional tools", () => {
		const result = getNarratorToolInventoryCapability(undefined);

		expect(result.supported).toBe(true);
		expect(result.unsupportedOptionalTools).toEqual([]);
		expect(result.browser.sharePreview).toBe(true);
		expect(result.browser.imageContentBlock).toBe(true);
		expect(result.browser.fileOutput).toBe(true);
		expect(result.browser.traceShare).toBe(true);
		expect(result.browser.traceFileOutput).toBe(true);
	});

	test("requires explicit tool inventory and optional tool support when metadata is present", () => {
		expect(getNarratorToolInventoryCapability({ narrator: {} })).toMatchObject({
			supported: false,
			supportedOptionalTools: [],
			unsupportedOptionalTools: [],
			webFetch: { supported: false },
			browser: {
				supported: false,
				sharePreview: false,
				imageContentBlock: false,
				fileOutput: false,
				traceShare: false,
				traceFileOutput: false,
			},
		});

		expect(
			getNarratorToolInventoryCapability({
				narrator: {
					toolInventory: {
						supported: true,
						webFetch: { supported: true },
						browser: { supported: true, fileOutput: true },
					},
				},
			}),
		).toMatchObject({
			supported: true,
			webFetch: { supported: true },
			browser: {
				supported: true,
				sharePreview: false,
				imageContentBlock: false,
				fileOutput: true,
				traceShare: false,
				traceFileOutput: false,
			},
		});
	});

	test("preserves supported and unsupported optional tool lists", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				toolInventory: {
					supported: true,
					supportedOptionalTools: ["Terminal", "ShareFile"],
					unsupportedOptionalTools: ["Recall", "ForkNarrator"],
				},
			},
		};

		const result = getNarratorToolInventoryCapability(capabilities);

		expect(result.supportedOptionalTools).toEqual(["Terminal", "ShareFile"]);
		expect(result.unsupportedOptionalTools).toEqual(["Recall", "ForkNarrator"]);
	});

	test("preserves WebFetch mode parity metadata", () => {
		const capabilities: RuntimeCapabilities = {
			narrator: {
				toolInventory: {
					supported: true,
					webFetch: {
						supported: true,
						parity: "partial",
						mode: "raw-only",
						defaultMode: "raw",
						supportedModes: ["raw"],
						unsupportedModes: ["readability", "dom", "smart", "screenshot"],
						protocols: ["http", "https", "data"],
						policy: "permission-policy-and-proxy-consumed",
						reason: "raw fetch only",
					},
				},
			},
		};

		const result = getNarratorToolInventoryCapability(capabilities);

		expect(result.webFetch).toEqual({
			supported: true,
			reason: "raw fetch only",
			parity: "partial",
			mode: "raw-only",
			defaultMode: "raw",
			supportedModes: ["raw"],
			unsupportedModes: ["readability", "dom", "smart", "screenshot"],
			protocols: ["http", "https", "data"],
			policy: "permission-policy-and-proxy-consumed",
		});
	});

	test("preserves Browser screenshot preview parity metadata", () => {
		const result = getNarratorToolInventoryCapability({
			narrator: {
				toolInventory: {
					supported: true,
					browser: {
						supported: true,
						parity: "partial",
						runtime: "browser-runtime",
						screenshotPreviewMode: "inline-base64-or-file-artifact",
						sharePreview: false,
						imageContentBlock: false,
						fileOutput: true,
						traceFormat: "chrome-devtools-json",
						traceShare: true,
						traceFileOutput: true,
						traceShareUrl: "/api/shares/{shareId}",
						reason: "base64 screenshots only",
					},
				},
			},
		});

		expect(result.browser).toEqual({
			supported: true,
			reason: "base64 screenshots only",
			parity: "partial",
			runtime: "browser-runtime",
			screenshotPreviewMode: "inline-base64-or-file-artifact",
			sharePreview: false,
			imageContentBlock: false,
			fileOutput: true,
			traceFormat: "chrome-devtools-json",
			traceShare: true,
			traceFileOutput: true,
			traceShareUrl: "/api/shares/{shareId}",
		});
	});
});

describe("getMcpServerSettingsStorageCapability", () => {
	test("defaults MCP server settings storage to supported", () => {
		expect(getMcpServerSettingsStorageCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
		});
	});

	test("requires explicit MCP server settings storage support when MCP metadata is present", () => {
		expect(getMcpServerSettingsStorageCapability({ mcp: {} })).toEqual({
			supported: false,
			reason: undefined,
		});
	});

	test("preserves disabled MCP server settings storage metadata", () => {
		expect(
			getMcpServerSettingsStorageCapability({
				mcp: {
					serverSettingsStorage: {
						supported: false,
						reason: "settings storage unavailable",
					},
				},
			}),
		).toEqual({ supported: false, reason: "settings storage unavailable" });
	});
});

describe("getMcpExternalToolsCapability", () => {
	test("defaults external MCP tools injection to supported", () => {
		expect(getMcpExternalToolsCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			parity: undefined,
			transport: undefined,
			lifecycle: undefined,
		});
	});

	test("requires explicit external MCP tools injection support when MCP metadata is present", () => {
		expect(getMcpExternalToolsCapability({ mcp: {} })).toEqual({
			supported: false,
			reason: undefined,
			parity: undefined,
			transport: undefined,
			lifecycle: undefined,
		});
	});

	test("preserves disabled external MCP tools injection metadata", () => {
		expect(
			getMcpExternalToolsCapability({
				mcp: {
					externalToolsInjection: {
						supported: false,
						reason: "external tools disabled",
						parity: "partial",
						transport: "stdio",
						lifecycle: "per-call",
					},
				},
			}),
		).toEqual({
			supported: false,
			reason: "external tools disabled",
			parity: "partial",
			transport: "stdio",
			lifecycle: "per-call",
		});
	});
});

describe("getMcpExternalServerManagementCapability", () => {
	test("defaults external server management to fully supported", () => {
		expect(getMcpExternalServerManagementCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			storage: undefined,
			permissions: true,
			import: true,
		});
	});

	test("requires explicit external server management support when MCP metadata is present", () => {
		expect(getMcpExternalServerManagementCapability({ mcp: {} })).toEqual({
			supported: false,
			reason: undefined,
			storage: undefined,
			permissions: false,
			import: false,
		});
	});

	test("preserves disabled server management metadata", () => {
		const capabilities: RuntimeCapabilities = {
			mcp: {
				externalServerManagement: {
					supported: false,
					reason: "external server management disabled",
					storage: "none",
					permissions: false,
					import: false,
				},
			},
		};

		expect(getMcpExternalServerManagementCapability(capabilities)).toEqual({
			supported: false,
			reason: "external server management disabled",
			storage: "none",
			permissions: false,
			import: false,
		});
	});
});

describe("getMcpProtocolCapability", () => {
	test("defaults MCP protocol, tools/list, and tools/call to supported", () => {
		expect(getMcpProtocolCapability(undefined)).toEqual({
			builtinProtocol: {
				supported: true,
				reason: undefined,
				initialize: undefined,
				toolsList: undefined,
				toolsCall: undefined,
			},
			toolsList: { supported: true, reason: undefined, source: undefined },
			toolsCall: { supported: true, reason: undefined, scope: undefined },
		});
	});

	test("requires explicit MCP protocol/list/call support when MCP metadata is present", () => {
		expect(getMcpProtocolCapability({ mcp: {} })).toEqual({
			builtinProtocol: {
				supported: false,
				reason: undefined,
				initialize: undefined,
				toolsList: undefined,
				toolsCall: undefined,
			},
			toolsList: { supported: false, reason: undefined, source: undefined },
			toolsCall: { supported: false, reason: undefined, scope: undefined },
		});
	});

	test("preserves MCP protocol tools list/call runtime metadata", () => {
		expect(
			getMcpProtocolCapability({
				mcp: {
					builtinProtocol: {
						supported: true,
						initialize: true,
						toolsList: true,
						toolsCall: true,
					},
					toolsList: {
						supported: true,
						source: "embedded-compatibility-tools-plus-discovered-metadata",
					},
					toolsCall: {
						supported: false,
						reason: "tools/call disabled",
						scope: "embedded-compatibility-tools",
					},
				},
			}),
		).toEqual({
			builtinProtocol: {
				supported: true,
				reason: undefined,
				initialize: true,
				toolsList: true,
				toolsCall: true,
			},
			toolsList: {
				supported: true,
				reason: undefined,
				source: "embedded-compatibility-tools-plus-discovered-metadata",
			},
			toolsCall: {
				supported: false,
				reason: "tools/call disabled",
				scope: "embedded-compatibility-tools",
			},
		});
	});
});

describe("getMcpBuiltinToolsCapability", () => {
	test("defaults to supported with no missing built-in MCP tool fields", () => {
		expect(getMcpBuiltinToolsCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			parity: undefined,
			missing: [],
		});
	});

	test("requires explicit built-in MCP tools support when MCP metadata is present", () => {
		expect(getMcpBuiltinToolsCapability({ mcp: {} })).toEqual({
			supported: false,
			reason: undefined,
			parity: undefined,
			missing: [],
		});
	});

	test("preserves partial parity missing built-in MCP tool fields", () => {
		const capabilities: RuntimeCapabilities = {
			mcp: {
				builtinTools: {
					supported: true,
					parity: "partial",
					missing: ["generatedContextSummary"],
				},
			},
		};

		expect(getMcpBuiltinToolsCapability(capabilities)).toEqual({
			supported: true,
			reason: undefined,
			parity: "partial",
			missing: ["generatedContextSummary"],
		});
	});
});

describe("getMcpExternalAgentCapability", () => {
	test("defaults to supported when external agent capability is absent", () => {
		expect(getMcpExternalAgentCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
			parity: undefined,
			transport: undefined,
			lifecycle: undefined,
		});
	});

	test("requires explicit external MCP agent injection support when MCP metadata is present", () => {
		expect(getMcpExternalAgentCapability({ mcp: {} })).toEqual({
			supported: false,
			reason: undefined,
			parity: undefined,
			transport: undefined,
			lifecycle: undefined,
		});
	});

	test("preserves partial parity metadata for stdio agent injection", () => {
		const capabilities: RuntimeCapabilities = {
			mcp: {
				externalAgentInjection: {
					supported: true,
					fallback: false,
					parity: "partial",
					transport: "stdio",
					lifecycle: "per-call",
					reason: "Connected stdio MCP tools are injected into narrator provider tool lists.",
				},
			},
		};

		expect(getMcpExternalAgentCapability(capabilities)).toEqual({
			supported: true,
			reason: "Connected stdio MCP tools are injected into narrator provider tool lists.",
			parity: "partial",
			transport: "stdio",
			lifecycle: "per-call",
		});
	});
});

describe("getMcpTransportsCapability", () => {
	test("defaults all transports to supported when capability is absent", () => {
		const result = getMcpTransportsCapability(undefined);

		expect(result.stdio.supported).toBe(true);
		expect(result.sse.supported).toBe(true);
		expect(result.streamableHttp.supported).toBe(true);
	});

	test("requires explicit MCP transport support when capability metadata is present", () => {
		const capabilities: RuntimeCapabilities = {
			mcp: {
				builtinProtocol: { supported: true },
			},
		};

		const result = getMcpTransportsCapability(capabilities);

		expect(result.stdio).toEqual({ supported: false, reason: undefined });
		expect(result.sse).toEqual({ supported: false, reason: undefined });
		expect(result.streamableHttp).toEqual({ supported: false, reason: undefined });
	});

	test("preserves unsupported SSE and streamable HTTP transport capabilities", () => {
		const capabilities: RuntimeCapabilities = {
			mcp: {
				transports: {
					stdio: { supported: true },
					sse: { supported: false, reason: "sse disabled" },
					streamableHttp: { supported: false, reason: "http disabled" },
				},
			},
		};

		const result = getMcpTransportsCapability(capabilities);

		expect(result.stdio).toEqual({ supported: true, reason: undefined });
		expect(result.sse).toEqual({ supported: false, reason: "sse disabled" });
		expect(result.streamableHttp).toEqual({ supported: false, reason: "http disabled" });
	});
});

describe("getSettingsFeatureCapability", () => {
	test("defaults settings features to supported", () => {
		const result = getSettingsFeatureCapability(undefined);

		expect(result).toEqual({
			storageSupported: true,
			storagePath: undefined,
			patchSupported: true,
			secretMasking: true,
			providerModelAugmentation: true,
			tlsGeneration: true,
			retryRules: true,
		});
	});

	test("requires explicit settings feature support when capability metadata is present", () => {
		expect(getSettingsFeatureCapability({ settings: {} })).toEqual({
			storageSupported: false,
			storagePath: undefined,
			patchSupported: false,
			secretMasking: false,
			providerModelAugmentation: false,
			tlsGeneration: false,
			retryRules: false,
		});
	});

	test("preserves explicit settings runtime capability metadata", () => {
		const capabilities: RuntimeCapabilities = {
			settings: {
				storage: { supported: true, path: "~/.narrafork/settings.json" },
				patch: { supported: false, reason: "settings patch disabled" },
				secretMasking: false,
				providerModelAugmentation: false,
				tlsGeneration: false,
				retryRules: false,
			},
		};

		expect(getSettingsFeatureCapability(capabilities)).toEqual({
			storageSupported: true,
			storagePath: "~/.narrafork/settings.json",
			patchSupported: false,
			secretMasking: false,
			providerModelAugmentation: false,
			tlsGeneration: false,
			retryRules: false,
		});
	});
});

describe("getSettingsValidationCapability", () => {
	test("defaults settings validation to strict TS/Zod parity", () => {
		expect(getSettingsValidationCapability(undefined)).toEqual({
			tsZodParity: true,
			looseValidation: false,
			mode: undefined,
			reason: undefined,
		});
	});

	test("preserves loose validation metadata from a backend", () => {
		expect(
			getSettingsValidationCapability({
				settings: {
					validation: {
						tsZodParity: false,
						mode: "loose-json-with-normalization",
						reason: "the backend normalizes loose settings payloads",
					},
				},
			}),
		).toEqual({
			tsZodParity: false,
			looseValidation: true,
			mode: "loose-json-with-normalization",
			reason: "the backend normalizes loose settings payloads",
		});
	});
});

describe("getBenchmarkContainerExecutionCapability", () => {
	test("defaults benchmark container execution to supported", () => {
		expect(getBenchmarkContainerExecutionCapability(undefined)).toEqual({
			supported: true,
			reason: undefined,
		});
	});

	test("requires explicit benchmark container execution support when benchmark metadata is present", () => {
		expect(getBenchmarkContainerExecutionCapability({ benchmark: {} })).toEqual({
			supported: false,
			reason: undefined,
		});
	});

	test("preserves disabled benchmark container execution metadata", () => {
		expect(
			getBenchmarkContainerExecutionCapability({
				benchmark: {
					containerExecution: {
						supported: false,
						reason: "podman unavailable",
					},
				},
			}),
		).toEqual({ supported: false, reason: "podman unavailable" });
	});
});

describe("getRuntimeMaintenanceCapability", () => {
	test("defaults runtime metadata, scan, cache, and cleanup targets", () => {
		const result = getRuntimeMaintenanceCapability(undefined);

		expect(result.backend).toBeUndefined();
		expect(result.buildChannel).toBeUndefined();
		expect(result.scanSupported).toBe(true);
		expect(result.cachedSupported).toBe(true);
		expect(result.cleanup.terminals.supported).toBe(true);
		expect(result.cleanup.containers.supported).toBe(true);
		expect(result.cleanup.browsers.supported).toBe(true);
		expect(result.cleanup.worktrees.supported).toBe(true);
	});

	test("requires explicit runtime maintenance support when runtime metadata is present", () => {
		const result = getRuntimeMaintenanceCapability({ runtime: { backend: "go" } });

		expect(result.backend).toBe("go");
		expect(result.scanSupported).toBe(false);
		expect(result.cachedSupported).toBe(false);
		expect(result.cleanup.terminals.supported).toBe(false);
		expect(result.cleanup.containers.supported).toBe(false);
		expect(result.cleanup.browsers.supported).toBe(false);
		expect(result.cleanup.worktrees.supported).toBe(false);
	});

	test("respects explicit unsupported runtime maintenance capabilities", () => {
		const capabilities: RuntimeCapabilities = {
			runtime: {
				backend: "go",
				buildChannel: "sidecar",
				scan: { supported: false, reason: "runtime scan disabled" },
				cached: { supported: false, reason: "runtime cache disabled" },
				cleanup: {
					terminals: { supported: false, reason: "terminal cleanup disabled" },
					browsers: { supported: false, reason: "browser cleanup disabled", mode: "preview" },
					worktrees: { supported: false, reason: "worktree cleanup disabled" },
				},
			},
		};

		const result = getRuntimeMaintenanceCapability(capabilities);

		expect(result.backend).toBe("go");
		expect(result.buildChannel).toBe("sidecar");
		expect(result.scanSupported).toBe(false);
		expect(result.scanReason).toBe("runtime scan disabled");
		expect(result.cachedSupported).toBe(false);
		expect(result.cachedReason).toBe("runtime cache disabled");
		expect(result.cleanup.terminals).toEqual({
			supported: false,
			reason: "terminal cleanup disabled",
			mode: undefined,
		});
		expect(result.cleanup.browsers).toEqual({
			supported: false,
			reason: "browser cleanup disabled",
			mode: "preview",
		});
		expect(result.cleanup.containers.supported).toBe(false);
		expect(result.cleanup.worktrees.supported).toBe(false);
		expect(result.cleanup.worktrees.reason).toBe("worktree cleanup disabled");
	});
});

describe("getStorageDatabasePreviewCapability", () => {
	test("defaults database preview to supported for older backends", () => {
		expect(getStorageDatabasePreviewCapability(undefined)).toEqual({ supported: true });
	});

	test("requires explicit database preview support when storage metadata is present", () => {
		expect(getStorageDatabasePreviewCapability({ storage: {} })).toEqual({ supported: false });
		expect(
			getStorageDatabasePreviewCapability({ storage: { database: { preview: true } } }),
		).toEqual({ supported: true });
	});

	test("respects explicit unsupported database preview capability", () => {
		expect(
			getStorageDatabasePreviewCapability({ storage: { database: { preview: false } } }),
		).toEqual({
			supported: false,
		});
	});
});

describe("getStorageDatabaseCleanupCapabilities", () => {
	test("defaults all database cleanup targets to supported for older backends", () => {
		const result = getStorageDatabaseCleanupCapabilities(undefined);

		expect(result.archivedSessions.supported).toBe(true);
		expect(result.staleSessions.supported).toBe(true);
		expect(result.apiRequestDumps.supported).toBe(true);
	});

	test("requires explicit database cleanup target support when storage metadata is present", () => {
		const result = getStorageDatabaseCleanupCapabilities({
			storage: { database: { cleanup: true } },
		});

		expect(result.archivedSessions.supported).toBe(false);
		expect(result.staleSessions.supported).toBe(false);
		expect(result.apiRequestDumps.supported).toBe(false);
	});

	test("preserves per-target disabled cleanup capabilities", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				database: {
					cleanup: true,
					cleanupTargets: {
						archivedSessions: {
							supported: false,
							fallback: true,
							code: "FEATURE_DISABLED",
							reason: "safe deletion unavailable",
						},
						staleSessions: {
							supported: false,
							reason: "stale cleanup unavailable",
						},
						apiRequestDumps: { supported: true },
					},
				},
			},
		};

		const result = getStorageDatabaseCleanupCapabilities(capabilities);

		expect(result.archivedSessions).toEqual({
			supported: false,
			reason: "safe deletion unavailable",
			code: "FEATURE_DISABLED",
			fallback: true,
		});
		expect(result.staleSessions.supported).toBe(false);
		expect(result.staleSessions.reason).toBe("stale cleanup unavailable");
		expect(result.apiRequestDumps.supported).toBe(true);
	});

	test("disables all targets when database cleanup is globally unsupported", () => {
		const result = getStorageDatabaseCleanupCapabilities({
			storage: { database: { cleanup: false } },
		});

		expect(result.archivedSessions.supported).toBe(false);
		expect(result.staleSessions.supported).toBe(false);
		expect(result.apiRequestDumps.supported).toBe(false);
	});
});

describe("getStorageCleanupOperationCapabilities", () => {
	test("uses storage routes by default", () => {
		const result = getStorageCleanupOperationCapabilities(undefined);

		expect(result.worktrees.route).toBe("storage");
		expect(result.worktrees.supported).toBe(true);
		expect(result.containers.route).toBe("storage");
	});

	test("reroutes worktree cleanup to runtime when storage cleanup is explicitly unsupported", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				cleanup: {
					worktrees: {
						supported: false,
						reason: "use runtime cleanup",
						alternative: "runtime.cleanup.worktrees",
					},
				},
			},
			runtime: {
				cleanup: {
					worktrees: { supported: true, mode: "backend-extension" },
				},
			},
		};

		const result = getStorageCleanupOperationCapabilities(capabilities);

		expect(result.worktrees.route).toBe("runtime");
		expect(result.worktrees.runtimeTarget).toBe("worktrees");
		expect(result.worktrees.supported).toBe(true);
		expect(result.worktrees.mode).toBe("backend-extension");
		expect(result.containers.route).toBe("storage");
	});

	test("keeps container storage cleanup disabled even when runtime cleanup exists", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				cleanup: {
					containers: {
						supported: false,
						reason: "podman prune disabled",
						alternative: "runtime.cleanup.containers",
					},
				},
			},
			runtime: {
				cleanup: {
					containers: { supported: true, mode: "stop-running-db-records" },
				},
			},
		};

		const result = getStorageCleanupOperationCapabilities(capabilities);

		expect(result.containers.route).toBe("storage");
		expect(result.containers.supported).toBe(false);
		expect(result.containers.reason).toBe("podman prune disabled");
		expect(result.containers.alternative).toBe("runtime.cleanup.containers");
	});

	test("consumes storage cleanup fallback capabilities without enabling unsafe storage actions", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				cleanup: {
					uploads: {
						supported: true,
						preservesMessageImageRefs: true,
					},
					shares: { supported: true },
					worktrees: {
						supported: false,
						fallback: true,
						reason: "use chapter/runtime cleanup",
						alternative: "runtime.cleanup.worktrees",
					},
					containers: {
						supported: false,
						fallback: true,
						reason: "podman prune disabled",
						alternative: "runtime.cleanup.containers",
					},
				},
			},
			runtime: {
				cleanup: {
					worktrees: { supported: true, mode: "backend-extension" },
					containers: { supported: true, mode: "stop-running-db-records" },
				},
			},
		};

		const result = getStorageCleanupOperationCapabilities(capabilities);

		expect(result.uploads.route).toBe("storage");
		expect(result.uploads.supported).toBe(true);
		expect(result.uploads.preservesMessageImageRefs).toBe(true);
		expect(result.worktrees.route).toBe("runtime");
		expect(result.worktrees.runtimeTarget).toBe("worktrees");
		expect(result.worktrees.supported).toBe(true);
		expect(result.worktrees.mode).toBe("backend-extension");
		expect(result.containers.route).toBe("storage");
		expect(result.containers.supported).toBe(false);
		expect(result.containers.alternative).toBe("runtime.cleanup.containers");
		expect(result.containers.reason).toBe("podman prune disabled");
	});

	test("keeps worktree cleanup disabled when runtime cleanup metadata is absent", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				cleanup: {
					worktrees: { supported: false, reason: "storage disabled" },
				},
			},
		};

		const result = getStorageCleanupOperationCapabilities(capabilities);

		expect(result.worktrees.route).toBe("storage");
		expect(result.worktrees.supported).toBe(false);
		expect(result.worktrees.reason).toBe("storage disabled");
	});

	test("keeps worktree cleanup disabled when both storage and runtime are unsupported", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				cleanup: {
					worktrees: { supported: false, reason: "storage disabled" },
				},
			},
			runtime: {
				cleanup: {
					worktrees: { supported: false, reason: "runtime disabled" },
				},
			},
		};

		const result = getStorageCleanupOperationCapabilities(capabilities);

		expect(result.worktrees.route).toBe("storage");
		expect(result.worktrees.supported).toBe(false);
		expect(result.worktrees.reason).toBe("storage disabled");
	});
});

describe("getStorageCapability", () => {
	test("allows admin VACUUM on the legacy TS SQLite backend", () => {
		const result = getStorageCapability(undefined);

		expect(result.scanSupported).toBe(true);
		expect(result.cachedSupported).toBe(true);
		expect(result.vacuumSupported).toBe(true);
		expect(result.cleanup.uploads.supported).toBe(true);
		expect(result.cleanup.uploads.preservesMessageImageRefs).toBeUndefined();
	});

	test("requires explicit storage support when storage metadata is present", () => {
		const result = getStorageCapability({ storage: {} });

		expect(result.scanSupported).toBe(false);
		expect(result.cachedSupported).toBe(false);
		expect(result.cleanup.uploads.supported).toBe(false);
		expect(result.cleanup.shares.supported).toBe(false);
		expect(result.cleanup.worktrees.supported).toBe(false);
		expect(result.cleanup.containers.supported).toBe(false);
	});

	test("preserves upload cleanup safety metadata", () => {
		const capabilities: RuntimeCapabilities = {
			storage: {
				scan: { supported: false, reason: "scan disabled" },
				cached: { supported: false, reason: "cache disabled" },
				vacuum: { supported: false, reason: "no vacuum" },
				cleanup: {
					uploads: {
						supported: true,
						preservesMessageImageRefs: false,
						reason: "unsafe uploads cleanup",
					},
				},
			},
		};

		const result = getStorageCapability(capabilities);

		expect(result.scanSupported).toBe(false);
		expect(result.scanReason).toBe("scan disabled");
		expect(result.cachedSupported).toBe(false);
		expect(result.cachedReason).toBe("cache disabled");
		expect(result.vacuumReason).toBe("no vacuum");
		expect(result.cleanup.uploads).toEqual({
			supported: true,
			reason: "unsafe uploads cleanup",
			mode: undefined,
			alternative: undefined,
			preservesMessageImageRefs: false,
		});
	});
});

describe("getStorageCapabilityForHealth", () => {
	test("fails closed while health is loading", () => {
		const result = getStorageCapabilityForHealth({ status: "loading" });

		expect(result.healthState).toBe("loading");
		expect(result.healthReady).toBe(false);
		expect(result.scanSupported).toBe(false);
		expect(result.cachedSupported).toBe(false);
		expect(result.vacuumSupported).toBe(false);
		expect(result.cleanup.uploads.supported).toBe(false);
	});

	test("fails closed on health error even when cached capabilities exist", () => {
		const result = getStorageCapabilityForHealth({
			status: "error",
			capabilities: {
				storage: {
					scan: { supported: true },
					cached: { supported: true },
					vacuum: { supported: true },
					cleanup: { uploads: { supported: true } },
				},
			},
		});

		expect(result.healthState).toBe("error");
		expect(result.healthReady).toBe(false);
		expect(result.scanSupported).toBe(false);
		expect(result.cachedSupported).toBe(false);
		expect(result.vacuumSupported).toBe(false);
		expect(result.cleanup.uploads.supported).toBe(false);
	});

	test("keeps legacy TS behavior only after a successful health response without capabilities", () => {
		const result = getStorageCapabilityForHealth({ status: "success" });

		expect(result.healthState).toBe("legacy");
		expect(result.healthReady).toBe(true);
		expect(result.scanSupported).toBe(true);
		expect(result.cachedSupported).toBe(true);
		expect(result.vacuumSupported).toBe(true);
		expect(result.cleanup.uploads.supported).toBe(true);
	});

	test("uses explicit storage capabilities after a successful health response", () => {
		const result = getStorageCapabilityForHealth({
			status: "success",
			capabilities: { storage: { scan: { supported: true } } },
		});

		expect(result.healthState).toBe("capabilities");
		expect(result.healthReady).toBe(true);
		expect(result.scanSupported).toBe(true);
		expect(result.cachedSupported).toBe(false);
		expect(result.vacuumSupported).toBe(false);
		expect(result.cleanup.uploads.supported).toBe(false);
	});
});

describe("getUploadCapability", () => {
	test("defaults upload serving features to supported", () => {
		expect(getUploadCapability(undefined)).toEqual({
			serveNarratorImages: { supported: true, reason: undefined },
			serveAvatars: { supported: true, reason: undefined },
			cleanupPreservesMessageImageRefs: { supported: true, reason: undefined },
		});
	});

	test("requires explicit upload serving support when capability payload is present", () => {
		expect(getUploadCapability({ uploads: {} })).toEqual({
			serveNarratorImages: { supported: false, reason: undefined },
			serveAvatars: { supported: false, reason: undefined },
			cleanupPreservesMessageImageRefs: { supported: false, reason: undefined },
		});

		expect(
			getUploadCapability({
				uploads: {
					serveNarratorImages: { supported: true },
					cleanupPreservesMessageImageRefs: { supported: true },
				},
			}),
		).toEqual({
			serveNarratorImages: { supported: true, reason: undefined },
			serveAvatars: { supported: false, reason: undefined },
			cleanupPreservesMessageImageRefs: { supported: true, reason: undefined },
		});
	});

	test("preserves explicit unsupported upload serving capabilities", () => {
		const capabilities: RuntimeCapabilities = {
			uploads: {
				serveNarratorImages: { supported: false, reason: "image serving disabled" },
				serveAvatars: { supported: false, reason: "avatar serving disabled" },
				cleanupPreservesMessageImageRefs: {
					supported: false,
					reason: "upload cleanup is unsafe",
				},
			},
		};

		expect(getUploadCapability(capabilities)).toEqual({
			serveNarratorImages: { supported: false, reason: "image serving disabled" },
			serveAvatars: { supported: false, reason: "avatar serving disabled" },
			cleanupPreservesMessageImageRefs: {
				supported: false,
				reason: "upload cleanup is unsafe",
			},
		});
	});
});

describe("getShareCapability", () => {
	test("defaults share features to supported when capability is absent", () => {
		expect(getShareCapability(undefined)).toEqual({
			createSupported: true,
			publicDownloadSupported: true,
			previewSupported: true,
			previewHtmlMode: undefined,
			previewReason: undefined,
			ephemeralOnlySupported: true,
			ephemeralOnlyFallback: false,
			ephemeralOnlyReason: undefined,
		});
	});

	test("requires explicit share support when capability payload is present", () => {
		expect(getShareCapability({ shares: {} })).toEqual({
			createSupported: false,
			publicDownloadSupported: false,
			previewSupported: false,
			previewHtmlMode: undefined,
			previewReason: undefined,
			ephemeralOnlySupported: false,
			ephemeralOnlyFallback: false,
			ephemeralOnlyReason: undefined,
		});

		expect(
			getShareCapability({
				shares: { create: { supported: true }, preview: { supported: true } },
			}),
		).toEqual({
			createSupported: true,
			publicDownloadSupported: false,
			previewSupported: true,
			previewHtmlMode: undefined,
			previewReason: undefined,
			ephemeralOnlySupported: false,
			ephemeralOnlyFallback: false,
			ephemeralOnlyReason: undefined,
		});
	});

	test("preserves disk fallback metadata for non-ephemeral shares", () => {
		const capabilities: RuntimeCapabilities = {
			shares: {
				create: { supported: true },
				publicDownload: { supported: true },
				ephemeralOnly: {
					supported: false,
					fallback: true,
					reason: "shares may be restored from disk",
				},
				preview: {
					supported: true,
					htmlMode: "escaped-pre",
					reason: "html preview is escaped",
				},
			},
		};

		expect(getShareCapability(capabilities)).toEqual({
			createSupported: true,
			publicDownloadSupported: true,
			previewSupported: true,
			previewHtmlMode: "escaped-pre",
			previewReason: "html preview is escaped",
			ephemeralOnlySupported: false,
			ephemeralOnlyFallback: true,
			ephemeralOnlyReason: "shares may be restored from disk",
		});
	});
});

describe("getContentCapability", () => {
	test("defaults project routines and skills to supported when capability is absent", () => {
		const result = getContentCapability(undefined);

		expect(result.projectRoutines.supported).toBe(true);
		expect(result.projectSkills.supported).toBe(true);
	});

	test("requires explicit project content support when capability payload is present", () => {
		expect(getContentCapability({ content: {} })).toEqual({
			projectRoutines: { supported: false, reason: undefined, storage: undefined },
			projectSkills: { supported: false, reason: undefined, storage: undefined },
		});

		expect(
			getContentCapability({
				content: { projectRoutines: { supported: true, storage: "db" } },
			}),
		).toEqual({
			projectRoutines: { supported: true, reason: undefined, storage: "db" },
			projectSkills: { supported: false, reason: undefined, storage: undefined },
		});
	});

	test("preserves explicit unsupported project content capabilities", () => {
		const capabilities: RuntimeCapabilities = {
			content: {
				projectRoutines: {
					supported: false,
					reason: "routines unavailable",
					storage: "none",
				},
				projectSkills: {
					supported: false,
					reason: "skills unavailable",
					storage: "none",
				},
			},
		};

		const result = getContentCapability(capabilities);

		expect(result.projectRoutines).toEqual({
			supported: false,
			reason: "routines unavailable",
			storage: "none",
		});
		expect(result.projectSkills).toEqual({
			supported: false,
			reason: "skills unavailable",
			storage: "none",
		});
	});
});

type HealthResponse = Awaited<ReturnType<typeof api.health>>;

const storageHealthI18n = i18next.createInstance();
const originalStorageHealthApi = {
	health: api.health,
	getSettings: api.getSettings,
	getCachedStorage: api.getCachedStorage,
};
const STORAGE_DOM_GLOBALS = [
	"window",
	"document",
	"navigator",
	"Event",
	"Document",
	"ShadowRoot",
	"HTMLElement",
	"HTMLButtonElement",
	"Element",
	"Node",
	"Text",
	"ResizeObserver",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

class StorageTestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let storageRoot: Root | undefined;
let storageContainer: HTMLDivElement | undefined;
let storageQueryClient: QueryClient | undefined;
let previousStorageDomGlobals: Map<string, PropertyDescriptor | undefined> | undefined;

function legacyHealthResponse(): HealthResponse {
	return {
		status: "ok",
		version: "test",
		commit: "test",
		platform: "linux",
		gitAvailable: true,
	};
}

function installStorageTestDom() {
	previousStorageDomGlobals = new Map(
		STORAGE_DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});

	Object.assign(window, {
		ResizeObserver: StorageTestResizeObserver,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: StorageTestResizeObserver,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle:
			window.getComputedStyle?.bind(window) ??
			(() => ({
				getPropertyValue: () => "",
			})),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

function restoreStorageTestDom() {
	if (!previousStorageDomGlobals) return;
	for (const [key, descriptor] of previousStorageDomGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousStorageDomGlobals = undefined;
}

async function initStorageHealthI18n() {
	if (storageHealthI18n.isInitialized) return;
	await storageHealthI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		ns: ["settings", "common"],
		resources: {
			en: {
				settings: settingsLocale,
				common: commonLocale,
			},
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
}

function renderStorageSection() {
	if (!storageRoot) throw new Error("storage test root is not initialized");
	storageQueryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnMount: false,
			},
		},
	});
	storageRoot.render(
		createElement(
			I18nextProvider,
			{ i18n: storageHealthI18n },
			createElement(
				MantineProvider,
				{ env: "test" },
				createElement(
					QueryClientProvider,
					{ client: storageQueryClient },
					createElement(ConfirmDialogProvider, null, createElement(StorageSection)),
				),
			),
		),
	);
}

async function settleStorageSection() {
	for (let turn = 0; turn < 6; turn++) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function findStorageButton(label: string): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!button) throw new Error(`storage button not found: ${label}`);
	return button as HTMLButtonElement;
}

describe("StorageSection health states", () => {
	beforeEach(async () => {
		installStorageTestDom();
		await initStorageHealthI18n();
		api.health = async () => legacyHealthResponse();
		api.getSettings = async () =>
			({}) as Awaited<ReturnType<typeof originalStorageHealthApi.getSettings>>;
		api.getCachedStorage = async () => ({ cached: false });
		storageContainer = document.createElement("div");
		document.body.appendChild(storageContainer);
		storageRoot = createRoot(storageContainer);
	});

	afterEach(async () => {
		storageRoot?.unmount();
		storageQueryClient?.clear();
		for (let turn = 0; turn < 3; turn++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		storageContainer?.remove();
		storageRoot = undefined;
		storageQueryClient = undefined;
		storageContainer = undefined;
		api.health = originalStorageHealthApi.health;
		api.getSettings = originalStorageHealthApi.getSettings;
		api.getCachedStorage = originalStorageHealthApi.getCachedStorage;
		restoreStorageTestDom();
	});

	test("shows an explicit loading state without claiming storage is unsupported", async () => {
		api.health = () => new Promise<HealthResponse>(() => {});

		renderStorageSection();
		await settleStorageSection();

		const text = document.body.textContent ?? "";
		expect(text).toContain("Loading storage capabilities");
		expect(text).not.toContain("Storage scan unavailable");
		expect(findStorageButton("Scan").disabled).toBe(true);
	});

	test("shows the health error and retries into the legacy success path", async () => {
		let attempts = 0;
		api.health = async () => {
			attempts++;
			if (attempts === 1) throw new Error("health endpoint offline");
			return legacyHealthResponse();
		};

		renderStorageSection();
		await settleStorageSection();

		let text = document.body.textContent ?? "";
		expect(text).toContain("Storage status unavailable");
		expect(text).toContain("health endpoint offline");
		expect(text).not.toContain("Storage scan unavailable");
		expect(findStorageButton("Scan").disabled).toBe(true);

		findStorageButton("Retry").click();
		await settleStorageSection();

		text = document.body.textContent ?? "";
		expect(attempts).toBe(2);
		expect(text).not.toContain("Storage status unavailable");
		expect(text).toContain("Click Scan to analyze storage usage");
		expect(findStorageButton("Scan").disabled).toBe(false);
	});

	test("keeps the successful legacy backend behavior enabled", async () => {
		renderStorageSection();
		await settleStorageSection();

		const text = document.body.textContent ?? "";
		expect(text).toContain("Click Scan to analyze storage usage");
		expect(text).not.toContain("Loading storage capabilities");
		expect(text).not.toContain("Storage status unavailable");
		expect(findStorageButton("Scan").disabled).toBe(false);
	});
});
