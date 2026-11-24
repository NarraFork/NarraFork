/**
 * NarraFork.app launcher (experimental — see docs/MACOS_APP.md).
 *
 * CFBundleExecutable of the packaged .app. Two behaviors:
 *
 *  1. A NarraFork server already answers `GET /api/health` on the configured port
 *     (~/.narrafork/settings.json `server.port`, or `--port=` in argv):
 *     `open http://127.0.0.1:<port>/` and exit — relaunching the app acts as
 *     "show the UI" instead of hitting the instance lock and dying silently.
 *
 *  2. Otherwise: append stdout/stderr to ~/.narrafork/narrafork-app.log, set
 *     NARRAFORK_APP_BUNDLE=1, and exec the bundled `narrafork-server` next to this
 *     executable. exec() keeps the process identity, so quitting the Dock icon
 *     delivers SIGTERM straight to the server.
 *
 * Port probing scans [port, port+10) because the server auto-retries the next
 * port when the configured one is taken (MAX_PORT_RETRIES in server/main.ts).
 */

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#define DEFAULT_PORT 7778
#define PORT_SCAN_SPAN 11
#define PROBE_TIMEOUT_MS 400
#define LOG_FILE_NAME "narrafork-app.log"

static const char *narrafork_home(char *buf, size_t size) {
	const char *env = getenv("NARRAFORK_HOME");
	if (env && env[0]) {
		snprintf(buf, size, "%s", env);
		return buf;
	}
	const char *home = getenv("HOME");
	if (!home || !home[0]) home = "/tmp";
	snprintf(buf, size, "%s/.narrafork", home);
	return buf;
}

/** Naive scan: first `"port"` after `"server"` in settings.json. 0 on failure. */
static int read_configured_port(const char *home) {
	char path[PATH_MAX];
	snprintf(path, sizeof(path), "%s/settings.json", home);
	FILE *f = fopen(path, "r");
	if (!f) return 0;
	char *json = NULL;
	long len = 0;
	fseek(f, 0, SEEK_END);
	len = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (len > 0 && len < 1024 * 1024) {
		json = malloc((size_t)len + 1);
		if (json && fread(json, 1, (size_t)len, f) == (size_t)len) json[len] = '\0';
		else {
			free(json);
			json = NULL;
		}
	}
	fclose(f);
	if (!json) return 0;

	int port = 0;
	char *server = strstr(json, "\"server\"");
	char *portKey = strstr(server ? server : json, "\"port\"");
	if (portKey) {
		char *colon = strchr(portKey, ':');
		if (colon) {
			long value = strtol(colon + 1, NULL, 10);
			if (value > 0 && value < 65536) port = (int)value;
		}
	}
	free(json);
	return port;
}

/** Explicit `--port=NNNN` in argv wins over the settings file. */
static int port_from_argv(int argc, char **argv) {
	for (int i = 1; i < argc; i++) {
		if (strncmp(argv[i], "--port=", 7) == 0) {
			long value = strtol(argv[i] + 7, NULL, 10);
			if (value > 0 && value < 65536) return (int)value;
		}
	}
	return 0;
}

static int probe_health_on(int family, int port) {
	int fd = socket(family, SOCK_STREAM, 0);
	if (fd < 0) return 0;

	struct timeval tv;
	tv.tv_sec = 0;
	tv.tv_usec = PROBE_TIMEOUT_MS * 1000;
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

	struct sockaddr_storage addr;
	socklen_t addrLen;
	memset(&addr, 0, sizeof(addr));
	if (family == AF_INET6) {
		struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)&addr;
		a6->sin6_family = AF_INET6;
		a6->sin6_port = htons((unsigned short)port);
		inet_pton(AF_INET6, "::1", &a6->sin6_addr);
		addrLen = sizeof(*a6);
	} else {
		struct sockaddr_in *a4 = (struct sockaddr_in *)&addr;
		a4->sin_family = AF_INET;
		a4->sin_port = htons((unsigned short)port);
		inet_pton(AF_INET, "127.0.0.1", &a4->sin_addr);
		addrLen = sizeof(*a4);
	}

	if (connect(fd, (struct sockaddr *)&addr, addrLen) != 0) {
		close(fd);
		return 0;
	}

	static const char request[] = "GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n";
	if (send(fd, request, sizeof(request) - 1, 0) < 0) {
		close(fd);
		return 0;
	}

	char buf[4096];
	ssize_t n = recv(fd, buf, sizeof(buf) - 1, 0);
	close(fd);
	if (n <= 0) return 0;
	buf[n] = '\0';
	return strstr(buf, " 200") != NULL && strstr(buf, "\"status\"") != NULL;
}

/** 1 when <port> answers GET /api/health on either loopback stack, else 0. */
static int probe_health(int port) {
	// The server binds [::1] for host=localhost on macOS; check v6 then v4.
	return probe_health_on(AF_INET6, port) || probe_health_on(AF_INET, port);
}

/** Replace this process with `open <url>` so the app's exit code is `open`'s. */
static void open_url(int port) {
	char url[64];
	snprintf(url, sizeof(url), "http://localhost:%d/", port);
	execl("/usr/bin/open", "open", url, (char *)NULL);
	_exit(127); // exec failed
}

/** Send the app's future stdout/stderr to the log file, then return its fd. */
static void redirect_output_to_log(const char *home) {
	mkdir(home, 0755);
	char path[PATH_MAX];
	snprintf(path, sizeof(path), "%s/%s", home, LOG_FILE_NAME);
	int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
	if (fd < 0) return;
	dup2(fd, STDOUT_FILENO);
	dup2(fd, STDERR_FILENO);
	if (fd > STDERR_FILENO) close(fd);
	fprintf(stdout, "\n--- launcher: starting narrafork-server (%s) ---\n", __DATE__ " " __TIME__);
	fflush(stdout);
}

int main(int argc, char **argv) {
	char home[PATH_MAX];
	narrafork_home(home, sizeof(home));

	int port = port_from_argv(argc, argv);
	if (!port) port = read_configured_port(home);
	if (!port) port = DEFAULT_PORT;

	/* With an explicit --port the user asked for exactly that address; without
	 * one, scan the retry range the server itself uses. */
	int last = port_from_argv(argc, argv) ? port : port + PORT_SCAN_SPAN - 1;
	for (int p = port; p <= last; p++) {
		if (probe_health(p)) open_url(p);
	}

	/* No server yet: become it. Resolve the bundled binary next to ourselves. */
	char self[PATH_MAX];
	uint32_t size = sizeof(self);
	if (_NSGetExecutablePath(self, &size) != 0) {
		fprintf(stderr, "narrafork launcher: cannot resolve own path\n");
		return 127;
	}
	char server[PATH_MAX];
	snprintf(server, sizeof(server), "%s", self);
	char *slash = strrchr(server, '/');
	if (!slash) {
		fprintf(stderr, "narrafork launcher: malformed executable path\n");
		return 127;
	}
	strcpy(slash + 1, "narrafork-server");

	redirect_output_to_log(home);
	setenv("NARRAFORK_APP_BUNDLE", "1", 1);

	argv[0] = server;
	execv(server, argv);
	fprintf(stderr, "narrafork launcher: exec %s failed: %s\n", server, strerror(errno));
	return 127;
}
