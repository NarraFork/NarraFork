import { describe, expect, test } from "bun:test";
import {
	type ManagerFieldSettings,
	preserveExternalManagerFields,
	readManagerOwnedFields,
} from "../settings-manager-fields";

describe("preserveExternalManagerFields", () => {
	test("服务没改过的字段保留磁盘上的面板修改", () => {
		const next: ManagerFieldSettings & { agent: { keep: boolean } } = {
			server: { host: "127.0.0.1", port: 7779, openBrowser: "browser" },
			branding: { name: "Old", iconColor: "#111111" },
			agent: { keep: true },
		};
		const seen = readManagerOwnedFields({
			server: { host: "127.0.0.1", port: 7779, openBrowser: "browser" },
			branding: { name: "Old", iconColor: "#111111" },
		});
		const disk = readManagerOwnedFields({
			server: { host: "0.0.0.0", port: 8080, openBrowser: "app" },
			branding: { name: "Lab", iconColor: "#abcdef" },
		});

		preserveExternalManagerFields(next, disk, seen);

		expect(next.server).toEqual({ host: "0.0.0.0", port: 8080, openBrowser: "app" });
		expect(next.branding).toEqual({ name: "Lab", iconColor: "#abcdef" });
		expect(next.agent).toEqual({ keep: true });
	});

	test("服务自己改过的字段不被磁盘旧值盖回", () => {
		const next: ManagerFieldSettings = {
			server: { host: "10.0.0.8", port: 7779, openBrowser: "off" },
			branding: { name: "FromUi" },
		};
		const seen = readManagerOwnedFields({
			server: { host: "127.0.0.1", port: 7779, openBrowser: "browser" },
			branding: { name: "Old" },
		});
		const disk = readManagerOwnedFields({
			server: { host: "0.0.0.0", port: 9, openBrowser: "app" },
			branding: { name: "FromPanel" },
		});

		preserveExternalManagerFields(next, disk, seen);

		expect(next.server.host).toBe("10.0.0.8");
		expect(next.server.port).toBe(9);
		expect(next.server.openBrowser).toBe("off");
		expect(next.branding?.name).toBe("FromUi");
	});
});
