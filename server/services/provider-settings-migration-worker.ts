import { parentPort } from "node:worker_threads";
import { sealSecretRecord, secretRecordKeyId } from "@server/lib/secret-store";
import { providerSettingsContributionSchema } from "@shared/provider-settings";
import {
	isBoundedProviderSettingsData,
	PROVIDER_SETTINGS_VALUE_LIMITS,
} from "@shared/provider-settings-values";
import { parseSettingAddress, settingRowId } from "./plugin-settings-store";
import type { ProviderSettingsConfigContext } from "./provider-settings-config-policy";
import { ProviderSettingsConfigPolicy } from "./provider-settings-config-policy";
import { providerSettingRecordBinding } from "./provider-settings-data";

parentPort?.on("message", (input: unknown) => {
	if (input && typeof input === "object" && "action" in input && input.action === "ping") {
		parentPort?.postMessage({ ready: true });
		return;
	}
	try {
		if (!input || typeof input !== "object") throw Error();
		const message = input as {
			context: ProviderSettingsConfigContext;
			declaration: unknown;
			request: unknown;
		};
		if (
			!isBoundedProviderSettingsData(message.context, 4096) ||
			!isBoundedProviderSettingsData(message.request, PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes)
		)
			throw Error();
		const declaration = providerSettingsContributionSchema.parse(message.declaration),
			policy = new ProviderSettingsConfigPolicy(declaration),
			prepared = policy.prepare(message.context, message.request);
		if (!message.context.target) throw Error();
		const address = parseSettingAddress({
			pluginId: message.context.pluginId,
			contributionId: declaration.id,
			targetKind: message.context.target.kind,
			targetId: message.context.target.id,
		});
		const configText = JSON.stringify(prepared.config),
			bindingFingerprint = policy.view(message.context).bindingRevision;
		const identity = {
			id: settingRowId(address),
			installationId: message.context.installationId,
			revision: 1,
			schemaFingerprint: policy.schemaFingerprint,
			bindingFingerprint,
			configText,
		};
		const secrets = Object.fromEntries(
			Object.entries(prepared.secretWrites).flatMap(([key, edit]) =>
				edit.operation === "set" ? [[key, edit.value]] : [],
			),
		);
		let secretsEnvelope: string | null = null,
			keyId: string | null = null;
		if (Object.keys(secrets).length) {
			const plain = Buffer.from(JSON.stringify(secrets));
			try {
				secretsEnvelope = sealSecretRecord(plain, providerSettingRecordBinding(identity));
				keyId = secretRecordKeyId(secretsEnvelope);
			} finally {
				plain.fill(0);
			}
		}
		parentPort?.postMessage({
			ok: true,
			mutation: {
				address,
				expectedRevision: 0,
				value: {
					installationId: identity.installationId,
					state: "active",
					schemaVersion: 1,
					schemaFingerprint: identity.schemaFingerprint,
					bindingFingerprint,
					configText,
					secretsEnvelope,
					keyId,
				},
			},
		});
	} catch {
		parentPort?.postMessage({ ok: false });
	}
});
