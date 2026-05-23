import { describe, expect, test } from "bun:test";
import {
	getBenchmarkContainerExecutionCapability,
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
	getNarratorPermissionsCapability,
	getNarratorPlanModeCapability,
	getNarratorRetryRecoveryCapability,
	getNarratorReviewToolsCapability,
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
				goMainMigrations: false,
				goEnsureColumns: false,
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

describe("getChapterSplitCapability", () => {
	test("defaults to supported when split capability is absent", () => {
		const result = getChapterSplitCapability(undefined);

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
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
			compressedAISummarySupported: true,
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
			compressedAISummarySupported: true,
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
				},
			},
		});

		expect(result.supported).toBe(true);
		expect(result.routes.list).toBe(true);
		expect(result.routes.start).toBe(false);
		expect(result.routes.stop).toBe(true);
		expect(result.routes.logs).toBe(false);
		expect(result.routes.remove).toBe(false);
		expect(result.routes.pause).toBe(true);
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
	});
});

describe("getProviderModelRefreshCapability", () => {
	test("defaults to supported when capability is absent", () => {
		const result = getProviderModelRefreshCapability(undefined, "openai");

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
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
					trustMode: "client-or-env-manifest-url",
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
				trustMode: "client-or-env-manifest-url",
			},
			apply: {
				supported: false,
				reason: "no handoff manager",
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

	test("preserves Go gateway platform limits and disabled Weixin QR metadata", () => {
		const capabilities: RuntimeCapabilities = {
			gateway: {
				persistentRuntimes: true,
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
		const result = getGatewayCapability({ gateway: { persistentRuntimes: false } });

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
						runtime: "go-rod",
						storage: "go-owned-optional-table",
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
			runtime: "go-rod",
			storage: "go-owned-optional-table",
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
						cutover: "go-backend-browser-tool-default-off",
						rollback: "enable manually in settings",
						reason: "native browser extension disabled by default",
					},
				},
			}),
		).toEqual({
			defaultEnabled: false,
			cutover: "go-backend-browser-tool-default-off",
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
			supported: true,
			reason: undefined,
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
					awaitBashReason: "Go Await supports agent tasks only",
				},
			},
		});

		expect(result.awaitAgent).toBe(true);
		expect(result.awaitBash).toBe(false);
		expect(result.awaitBashWaitForText).toBe(false);
		expect(result.awaitBashReason).toBe("Go Await supports agent tasks only");
	});
});

describe("getProviderAgentModeCapability", () => {
	test("defaults to supported when provider agent mode capability is absent", () => {
		const result = getProviderAgentModeCapability(undefined, "openai");

		expect(result.supported).toBe(true);
		expect(result.reason).toBeUndefined();
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
					browser: {
						supported: true,
						parity: "partial",
						runtime: "go-rod",
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
			runtime: "go-rod",
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
						source: "go-embedded-compatibility-tools-plus-discovered-metadata",
					},
					toolsCall: {
						supported: false,
						reason: "tools/call disabled",
						scope: "go-embedded-compatibility-tools",
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
				source: "go-embedded-compatibility-tools-plus-discovered-metadata",
			},
			toolsCall: {
				supported: false,
				reason: "tools/call disabled",
				scope: "go-embedded-compatibility-tools",
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

	test("preserves partial parity metadata for stdio agent injection", () => {
		const capabilities: RuntimeCapabilities = {
			mcp: {
				externalAgentInjection: {
					supported: true,
					fallback: false,
					parity: "partial",
					transport: "stdio",
					lifecycle: "per-call",
					reason: "Connected stdio MCP tools are injected into Go narrator provider tool lists.",
				},
			},
		};

		expect(getMcpExternalAgentCapability(capabilities)).toEqual({
			supported: true,
			reason: "Connected stdio MCP tools are injected into Go narrator provider tool lists.",
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

	test("preserves loose validation metadata from Go backend", () => {
		expect(
			getSettingsValidationCapability({
				settings: {
					validation: {
						tsZodParity: false,
						mode: "loose-json-with-normalization",
						reason: "go backend normalizes loose settings payloads",
					},
				},
			}),
		).toEqual({
			tsZodParity: false,
			looseValidation: true,
			mode: "loose-json-with-normalization",
			reason: "go backend normalizes loose settings payloads",
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
		expect(result.cleanup.containers.supported).toBe(true);
		expect(result.cleanup.worktrees.supported).toBe(false);
		expect(result.cleanup.worktrees.reason).toBe("worktree cleanup disabled");
	});
});

describe("getStorageDatabasePreviewCapability", () => {
	test("defaults database preview to supported for older backends", () => {
		expect(getStorageDatabasePreviewCapability(undefined)).toEqual({ supported: true });
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
					worktrees: { supported: true, mode: "go-extension" },
				},
			},
		};

		const result = getStorageCleanupOperationCapabilities(capabilities);

		expect(result.worktrees.route).toBe("runtime");
		expect(result.worktrees.runtimeTarget).toBe("worktrees");
		expect(result.worktrees.supported).toBe(true);
		expect(result.worktrees.mode).toBe("go-extension");
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
	test("keeps vacuum disabled by default while allowing ordinary cleanup targets", () => {
		const result = getStorageCapability(undefined);

		expect(result.scanSupported).toBe(true);
		expect(result.cachedSupported).toBe(true);
		expect(result.vacuumSupported).toBe(false);
		expect(result.cleanup.uploads.supported).toBe(true);
		expect(result.cleanup.uploads.preservesMessageImageRefs).toBeUndefined();
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

describe("getUploadCapability", () => {
	test("defaults upload serving features to supported", () => {
		expect(getUploadCapability(undefined)).toEqual({
			serveNarratorImages: { supported: true, reason: undefined },
			serveAvatars: { supported: true, reason: undefined },
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

	test("preserves disk fallback metadata for non-ephemeral shares", () => {
		const capabilities: RuntimeCapabilities = {
			shares: {
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
