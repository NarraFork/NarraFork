import { describe, expect, test } from "bun:test";
import { analyzeShellCommand } from "@server/lib/agent/bash-analyze";
import { robotDiagnosticRuleSet } from "@server/lib/robot-diagnostic-policy";
import { compileExecutionPolicy } from "@server/services/execution-policy/compiler";
import { normalizeExecutionPolicyRuleSet } from "@server/services/execution-policy/normalize";
import {
	classifyDanger,
	shouldTriggerDangerReflection,
} from "@server/services/narrator-permission";

/**
 * The point of the preset is latency: an external diagnostic narrator runs under
 * bypassPermissions, where anything the risk engine cannot classify as read-only is paused
 * for a danger reflection turn. These tests pin the end-to-end outcome — whether a command
 * actually reflects — rather than only whether a pattern matches, so a regression in either
 * the preset or the risk engine surfaces here.
 */

const EMPTY_POLICY = compileExecutionPolicy(normalizeExecutionPolicyRuleSet({}, "narrator"), null);
const PRESET_POLICY = compileExecutionPolicy(robotDiagnosticRuleSet(), null);

/** Robot hosts run POSIX shells; cwd mirrors a robot working directory, not the NarraFork host. */
const ROBOT_CWD = "/home/robot";

async function reflects(command: string, preset: boolean): Promise<boolean> {
	const analysis = await analyzeShellCommand(command, ROBOT_CWD, "posix", false);
	const danger = classifyDanger(
		"Bash",
		{ command },
		ROBOT_CWD,
		analysis,
		[],
		[],
		false,
		preset ? PRESET_POLICY : EMPTY_POLICY,
		null,
	);
	// "standard" is the shipped default reflection level.
	return danger ? shouldTriggerDangerReflection(danger, "standard") : false;
}

const ROUTINE_INSPECTION = [
	"systemctl is-active rl_deploy",
	"systemctl status basic_server --no-pager",
	"systemctl show -p NRestarts localization",
	"journalctl -u basic_server -n 200 --no-pager",
	"chronyc tracking",
	"timedatectl status",
	"ss -tlnH",
	"ping -c 1 -W 1 10.21.33.201",
	"pgrep -f video0",
	"free -h",
	"df -h",
	"dmesg -T",
	"ip addr show eth2",
	"lsusb",
];

const STATE_CHANGING = [
	"systemctl restart rl_deploy",
	"systemctl stop basic_server",
	"rm -rf /var/opt/robot/log/2026_0101",
	"sudo journalctl -u basic_server",
	"ip link set eth0 down",
	"sysctl -w net.ipv4.ip_forward=1",
];

describe("robot diagnostic preset suppresses reflection for routine inspection", () => {
	test("routine read-only commands reflect without the preset", async () => {
		// Establishes that these commands really are the ones costing a reflection turn today,
		// so the assertions below are attributable to the preset and not to something else.
		const reflecting: string[] = [];
		for (const command of ROUTINE_INSPECTION) {
			if (await reflects(command, false)) reflecting.push(command);
		}
		expect(reflecting.length).toBeGreaterThan(0);
	});

	test("routine read-only commands do not reflect with the preset", async () => {
		for (const command of ROUTINE_INSPECTION) {
			expect(await reflects(command, true)).toBe(false);
		}
	});

	test("state-changing commands still reflect with the preset enabled", async () => {
		for (const command of STATE_CHANGING) {
			expect(await reflects(command, true)).toBe(true);
		}
	});

	// Reading robot config/logs resolves to a low-severity external-path finding, which the
	// default "standard" threshold already ignores; the preset removes the finding entirely.
	test("reading robot config and logs never reflects", async () => {
		for (const command of [
			"cat /etc/hostname",
			"cat /etc/netplan/01-netcfg.yaml",
			"cat /var/opt/robot/conf/HWI.toml",
			"tail -n 200 /var/opt/robot/log/2026_0101/rsdriver.log",
			"cat /proc/cpuinfo",
		]) {
			expect(await reflects(command, true)).toBe(false);
			expect(await reflects(command, false)).toBe(false);
		}
	});

	test("writing under a preset directory still reflects", async () => {
		// The directory rules grant readOnly, so a write beneath them is not admitted.
		expect(await reflects("rm /etc/netplan/01-netcfg.yaml", true)).toBe(true);
	});
});
