import { describe, expect, test } from "bun:test";
import { commandPatternMatches } from "@server/services/execution-policy/command-policy";
import {
	ROBOT_DIAGNOSTIC_COMMAND_WHITELIST,
	ROBOT_DIAGNOSTIC_READONLY_DIRS,
	robotDiagnosticRuleSet,
} from "../robot-diagnostic-policy";

function isAllowed(command: string): boolean {
	const tokens = command.split(/\s+/).filter(Boolean);
	return ROBOT_DIAGNOSTIC_COMMAND_WHITELIST.some((pattern) =>
		commandPatternMatches(tokens, pattern),
	);
}

describe("robot diagnostic command preset", () => {
	// The inspection forms the Lynx skills actually run in the field.
	test("admits the read-only diagnostic commands", () => {
		const allowed = [
			"systemctl is-active rl_deploy",
			"systemctl is-enabled basic_server",
			"systemctl is-failed localization",
			"systemctl status rsdriver --no-pager",
			"systemctl show -p NRestarts rl_deploy",
			"systemctl cat basic_server",
			"systemctl list-units --type=service --no-pager",
			"journalctl -u basic_server -n 200 --no-pager",
			"journalctl -n 500",
			"journalctl --since 2026-01-01 --until 2026-01-02",
			"journalctl -b -1 -p err",
			"journalctl --list-boots",
			"coredumpctl list --no-legend",
			"pgrep -x mediamtx",
			"pgrep -f video0",
			"ps aux",
			"ps -p 1234 -o pid,rss,pcpu,comm",
			// The explicit read verb is required; see the bare-form note in the preset.
			"ip addr show",
			"ip addr show eth2",
			"ip -j addr show",
			"ip -s link show eth0",
			"ip link show",
			"ip route show",
			"ip route get 10.21.33.201",
			"ip neigh show",
			"ifconfig",
			"arp -n",
			"route -n",
			"ss -tlnH",
			"ss -tlnp",
			"ss -tuln",
			"ss -s",
			"netstat -tlnp",
			"netstat",
			"ping -c 1 -W 1 10.21.33.201",
			"nc -z -w 2 10.21.31.103 30000",
			"traceroute 10.21.31.106",
			"timedatectl status",
			"timedatectl show --property=Timezone --value",
			"chronyc tracking",
			"chronyc sources -v",
			"ntpq -p",
			"uptime",
			"free -h",
			"df -h",
			"du -sh /var/opt/robot/log",
			"lsblk -f",
			"lsusb",
			"lscpu",
			"lsmod",
			"lsof -p 1234",
			"dmesg -T",
			"sysctl -a",
			"sysctl -n net.ipv4.ip_forward",
			"strings /opt/robot/basic_server",
			"readlink -f /etc/localtime",
			"stat /etc/os-release",
		];
		for (const command of allowed) {
			expect(isAllowed(command)).toBe(true);
		}
	});

	/**
	 * Guard rail. Every entry here mutates robot or system state, so it must stay outside the
	 * preset and keep its danger-reflection review. A failure here means someone widened a
	 * pattern (e.g. to a bare `systemctl *`) and silently removed that review.
	 */
	test("never admits state-changing commands", () => {
		const denied = [
			"systemctl restart rl_deploy",
			"systemctl stop basic_server",
			"systemctl start rsdriver",
			"systemctl enable localization",
			"systemctl disable planner",
			"systemctl mask rl_deploy",
			"systemctl daemon-reload",
			"ip link set eth0 down",
			"ip link delete veth0",
			"ip route add default via 10.21.31.1",
			"ip route del default",
			"ip route flush cache",
			"ip addr add 10.21.31.9/24 dev eth0",
			"ip addr del 10.21.31.9/24 dev eth0",
			"ip addr flush dev eth0",
			"ip neigh flush all",
			"ip neigh del 10.21.31.1 dev eth0",
			"ip -j link set eth0 up",
			"sysctl -w net.ipv4.ip_forward=1",
			"sysctl net.ipv4.ip_forward=1",
			"timedatectl set-time 2026-01-01",
			"timedatectl set-timezone UTC",
			"timedatectl set-ntp true",
			// Journal maintenance flags delete or roll log data a later step may still need.
			"journalctl --rotate",
			"journalctl --flush",
			"journalctl --sync",
			"journalctl --vacuum-time=1s",
			"journalctl --vacuum-size=1M",
			// Wipes the kernel ring buffer, destroying evidence.
			"dmesg --clear",
			"dmesg -C",
			"dmesg -c",
			// Force-closes sockets, cutting live robot connections.
			"ss -K",
			"ss --kill",
			// coredumpctl beyond listing extracts or attaches a debugger.
			"coredumpctl dump 1",
			"coredumpctl debug 1",
			// chronyc beyond querying steps or forces the clock.
			"chronyc makestep",
			"chronyc burst 1/1",
			"rm -rf /var/opt/robot/log",
			"reboot",
			"shutdown -h now",
			"kill 1234",
			"pkill -f rl_deploy",
			"killall basic_server",
			"apt-get install ros-foxy",
			"dpkg -i robot.deb",
			"mkfs.ext4 /dev/sda1",
			"dd if=/dev/zero of=/dev/sda",
			"drmap mapping",
			"drmap stop_mapping",
			"drmap unpack /tmp/map.tar",
			"x11vnc -display :0 -forever -shared",
			"mount /dev/sda1 /mnt",
			"umount /mnt",
			"chmod 777 /etc",
			"crontab -e",
		];
		for (const command of denied) {
			expect(isAllowed(command)).toBe(false);
		}
	});

	// Token-prefix matching means a sudo-wrapped command starts with the `sudo` token and
	// matches nothing here, so privileged variants keep their review.
	test("never admits sudo-wrapped commands", () => {
		for (const command of [
			"sudo journalctl -u basic_server",
			"sudo systemctl is-active rl_deploy",
			"sudo dmesg -T",
			"sudo arp-scan -l -I eth2 -q",
		]) {
			expect(isAllowed(command)).toBe(false);
		}
	});

	/**
	 * Documents a deliberate trade-off. Matching is a token *prefix* match, so a bare
	 * `ip addr` entry would also admit `ip addr add …`. The Lynx scripts do use the bare
	 * form, so those specific calls keep paying a reflection turn — that is preferred over
	 * silently admitting the mutating verbs. Do not "fix" this by adding the bare entries.
	 */
	test("does not admit the bare ip object forms", () => {
		for (const command of ["ip addr", "ip link", "ip route", "ip neigh"]) {
			expect(isAllowed(command)).toBe(false);
		}
	});

	test("requires ping to bound its packet count", () => {
		expect(isAllowed("ping -c 1 10.21.33.201")).toBe(true);
		expect(isAllowed("ping 10.21.33.201")).toBe(false);
		expect(isAllowed("ping -i 0.2 10.21.33.201")).toBe(false);
	});
});

describe("robot diagnostic directory preset", () => {
	test("grants read-only access to the diagnostic paths", () => {
		const rules = robotDiagnosticRuleSet();
		expect(rules.directoryWhitelist.length).toBe(ROBOT_DIAGNOSTIC_READONLY_DIRS.length);
		for (const rule of rules.directoryWhitelist) {
			expect(rule.accessLevel).toBe("readOnly");
			expect(rule.pathFlavor).toBe("posix");
			expect(rule.enabled).toBe(true);
		}
		const paths = rules.directoryWhitelist.map((rule) => rule.path);
		for (const expected of ["/etc", "/proc", "/var/opt/robot/log", "/opt/robot"]) {
			expect(paths).toContain(expected);
		}
	});

	// The camera node checks in the knowledge base run on the engineer's machine, not as a
	// shell read on the robot, so /dev is deliberately not widened.
	test("does not widen /dev", () => {
		expect(ROBOT_DIAGNOSTIC_READONLY_DIRS).not.toContain("/dev");
	});

	test("carries no blacklist or write-capable rules", () => {
		const rules = robotDiagnosticRuleSet();
		expect(rules.directoryBlacklist).toEqual([]);
		expect(rules.commandBlacklist).toEqual([]);
		expect(rules.commandWhitelist.length).toBe(ROBOT_DIAGNOSTIC_COMMAND_WHITELIST.length);
	});
});
