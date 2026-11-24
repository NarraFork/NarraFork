/**
 * NarraFork.app launcher (experimental — see docs/MACOS_APP.md).
 *
 * CFBundleExecutable of the packaged .app. A small NSApplication that lives in
 * the menu bar (LSUIElement, no Dock icon):
 *
 *   - On launch: if a NarraFork server already answers GET /api/health on the
 *     configured port (~/.narrafork/settings.json server.port, or --port= in
 *     argv), it is NOT respawned — the menu attaches to it. Otherwise the
 *     bundled narrafork-server is spawned with output appended to
 *     ~/.narrafork/narrafork-app.log and NARRAFORK_APP_BUNDLE=1 in its env.
 *   - A second `open` of the app while the menu-bar agent is alive opens the
 *     page and exits, instead of stacking a second status item.
 *   - Quit terminates the server only when this instance spawned it; a server
 *     found already running is left alone.
 *
 * Port probing scans [port, port+10] because the server auto-retries the next
 * port when the configured one is taken (MAX_PORT_RETRIES in server/main.ts),
 * and probes both loopback stacks since host=localhost binds [::1] on macOS.
 */

#import <Cocoa/Cocoa.h>
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
#define PROBE_TIMEOUT_MS 300
#define LOG_FILE_NAME "narrafork-app.log"
#define LOCK_FILE_NAME "narrafork.lock"
// After a lock-file event, retry the health probe this many times (400 ms
// apart) — the lock lands before the HTTP listener binds.
#define STARTUP_PROBE_MAX_ATTEMPTS 25

// ── Config / health probing (unchanged from the bare launcher) ───────────────

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

static int read_configured_port(const char *home) {
	char path[PATH_MAX];
	snprintf(path, sizeof(path), "%s/settings.json", home);
	FILE *f = fopen(path, "r");
	if (!f) return 0;
	char *json = NULL;
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
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

/** Port where a live server answered, or 0. */
static int find_server_port(int base, int span) {
	for (int p = base; p < base + span; p++) {
		if (probe_health_on(AF_INET6, p) || probe_health_on(AF_INET, p)) return p;
	}
	return 0;
}

// ── Status bar icon: the favicon fork glyph, drawn for template rendering ─────

static NSImage *statusBarIcon(void) {
	const CGFloat s = 18.0;
	NSImage *img = [[NSImage alloc] initWithSize:NSMakeSize(s, s)];
	[img lockFocus];
	// SVG viewBox is 512 and y points down; flip into AppKit's y-up space.
	NSAffineTransform *t = [NSAffineTransform transform];
	[t scaleXBy:s / 512.0 yBy:-s / 512.0];
	[t translateXBy:0 yBy:-512.0];
	[t concat];

	NSBezierPath *stroke = [NSBezierPath bezierPath];
	stroke.lineWidth = 56; // fatter than the svg's 32 so it stays legible at 18pt
	stroke.lineCapStyle = NSLineCapStyleRound;
	stroke.lineJoinStyle = NSLineJoinStyleRound;
	[stroke moveToPoint:NSMakePoint(256, 400)];
	[stroke lineToPoint:NSMakePoint(256, 200)];
	[stroke moveToPoint:NSMakePoint(256, 200)];
	[stroke curveToPoint:NSMakePoint(216, 130)
	       controlPoint1:NSMakePoint(256, 160)
	       controlPoint2:NSMakePoint(216, 130)];
	[stroke lineToPoint:NSMakePoint(176, 108)];
	[stroke moveToPoint:NSMakePoint(256, 200)];
	[stroke curveToPoint:NSMakePoint(296, 130)
	       controlPoint1:NSMakePoint(256, 160)
	       controlPoint2:NSMakePoint(296, 130)];
	[stroke lineToPoint:NSMakePoint(336, 108)];
	[[NSColor blackColor] setStroke];
	[stroke stroke];

	[[NSColor blackColor] setFill];
	const CGFloat pts[3][2] = {{176, 108}, {336, 108}, {256, 400}};
	for (int i = 0; i < 3; i++) {
		CGFloat r = 42;
		[[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(pts[i][0] - r, pts[i][1] - r, 2 * r, 2 * r)]
			fill];
	}
	[img unlockFocus];
	img.template = YES;
	return img;
}

// ── Localization: follow the system's zh/en like the product does ─────────────

static BOOL isZH(void) {
	for (NSString *lang in NSLocale.preferredLanguages) {
		if ([lang hasPrefix:@"zh"]) return YES;
		return NO;
	}
	return NO;
}
static NSString *L(NSString *en, NSString *zh) {
	return isZH() ? zh : en;
}

// ── LaunchAgent for "open at login" ──────────────────────────────────────────

static NSString *loginItemPlistPath(void) {
	NSString *name = [NSString
		stringWithFormat:@"Library/LaunchAgents/%@.plist", NSBundle.mainBundle.bundleIdentifier];
	return [NSHomeDirectory() stringByAppendingPathComponent:name];
}

static BOOL loginItemEnabled(void) {
	return [[NSFileManager defaultManager] fileExistsAtPath:loginItemPlistPath()];
}

static void setLoginItem(BOOL enabled) {
	NSString *path = loginItemPlistPath();
	if (!enabled) {
		[[NSFileManager defaultManager] removeItemAtPath:path error:nil];
		return;
	}
	NSString *exe = NSBundle.mainBundle.executablePath;
	NSString *plist = [NSString
		stringWithFormat:
			@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
			 "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
			 "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
			 "<plist version=\"1.0\"><dict>\n"
			 "<key>Label</key><string>%@</string>\n"
			 "<key>ProgramArguments</key><array><string>%@</string></array>\n"
			 "<key>RunAtLoad</key><true/>\n"
			 "</dict></plist>\n",
			NSBundle.mainBundle.bundleIdentifier,
			exe];
	[plist writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// ── App delegate ─────────────────────────────────────────────────────────────

@interface AppDelegate : NSObject <NSApplicationDelegate, NSMenuDelegate>
@property(nonatomic) int basePort;
@property(nonatomic) int foundPort; // port that answered health, 0 = stopped
@property(nonatomic) BOOL ownServer; // we spawned the running server
@property(nonatomic) NSTask *serverTask;
@property(nonatomic) NSStatusItem *item;
@property(nonatomic) NSMenuItem *statusItem;
@property(nonatomic) NSMenuItem *openItem;
@property(nonatomic) NSMenuItem *openAppItem;
@property(nonatomic) NSMenuItem *loginItem;
@property(nonatomic) NSMenuItem *toggleItem;
@property(nonatomic) NSArray<NSString *> *serverArgs;
@property(nonatomic) NSString *homeDir;
@property(nonatomic) NSString *logPath;
@property(nonatomic) NSString *serverPath;
@property(nonatomic) NSURL *pageURL;
@property(nonatomic) dispatch_source_t lockSource;
@property(nonatomic) unsigned long probeGeneration;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)note {
	// A second `open` while this agent is alive: show the page, then leave.
	for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
		if ([app.bundleIdentifier isEqualToString:NSBundle.mainBundle.bundleIdentifier] &&
			app.processIdentifier != NSRunningApplication.currentApplication.processIdentifier) {
			int p = find_server_port(self.basePort, PORT_SCAN_SPAN);
			if (p) [self openPageAt:p];
			[NSApp terminate:nil];
			return;
		}
	}

	self.item = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
	self.item.button.image = statusBarIcon();
	self.item.button.imagePosition = NSImageOnly;
	self.item.button.toolTip = @"NarraFork";

	NSMenu *menu = [NSMenu new];

	self.statusItem = [menu addItemWithTitle:@"NarraFork" action:nil keyEquivalent:@""];

	self.openItem = [menu addItemWithTitle:L(@"Open NarraFork", @"打开 NarraFork")
									action:@selector(openPage:)
							 keyEquivalent:@"o"];
	self.openItem.target = self;

	NSString *appBrowser = [self appWindowBrowser];
	if (appBrowser) {
		self.openAppItem =
			[menu addItemWithTitle:L(@"Open in app window", @"以应用窗口打开")
							action:@selector(openAppWindow:)
					 keyEquivalent:@"O"];
		self.openAppItem.target = self;
	}

	[menu addItemWithTitle:L(@"View log", @"查看日志")
					action:@selector(showLog:)
			 keyEquivalent:@"l"]
		.target = self;

	[menu addItem:NSMenuItem.separatorItem];

	self.loginItem = [menu addItemWithTitle:L(@"Launch at login", @"登录时自动启动")
									 action:@selector(toggleLoginItem:)
							  keyEquivalent:@""];
	self.loginItem.target = self;
	self.loginItem.state = loginItemEnabled() ? NSControlStateValueOn : NSControlStateValueOff;

	[menu addItem:NSMenuItem.separatorItem];

	self.toggleItem = [menu addItemWithTitle:L(@"Stop server", @"停止服务")
									action:@selector(toggleServer:)
							 keyEquivalent:@"s"];
	self.toggleItem.target = self;

	[menu addItem:NSMenuItem.separatorItem];

	NSMenuItem *quit = [menu addItemWithTitle:L(@"Quit NarraFork", @"退出 NarraFork")
									   action:@selector(quit:)
								keyEquivalent:@"q"];
	quit.target = self;

	menu.delegate = self;
	self.item.menu = menu;

	[self watchLockDir];

	// Attach to a running server, or start ours. Either way the server itself
	// opens the browser when it becomes ready (server.openBrowser). The probe
	// runs off the main thread so a squatting port can't delay app startup.
	[self probeInBackgroundWithGeneration:self.probeGeneration
							   completion:^(int port) {
								   self.foundPort = port;
								   if (!port) [self startServer];
								   [self refreshStatus];
							   }];
	[self refreshStatus];
}

// No polling timer: status is refreshed by events — our NSTask's termination
// handler, lock-file changes in the narrafork home dir, and each menu open.
- (void)refreshStatus {
	int port = self.foundPort;

	BOOL running = port != 0;
	BOOL starting = !running && self.serverTask != nil && self.serverTask.isRunning;

	self.statusItem.title = running
		? [NSString stringWithFormat:@"● NarraFork · localhost:%d", port]
		: (starting ? L(@"◐ NarraFork · starting…", @"◐ NarraFork · 启动中…")
					: L(@"○ NarraFork · stopped", @"○ NarraFork · 已停止"));

	self.openItem.enabled = running;
	self.openAppItem.enabled = running;
	self.toggleItem.title = running ? L(@"Stop server", @"停止服务") : L(@"Start server", @"启动服务");
	self.toggleItem.enabled = running ? self.ownServer : YES;
	self.toggleItem.target = self;
}

// ── Event-driven probing ─────────────────────────────────────────────────────

// One probe off the main thread; the completion runs on main only while
// `gen` is still the current probe generation.
- (void)probeInBackgroundWithGeneration:(unsigned long)gen
							 completion:(void (^)(int port))completion {
	int base = self.basePort;
	__weak AppDelegate *weak = self;
	dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
		int port = find_server_port(base, PORT_SCAN_SPAN);
		dispatch_async(dispatch_get_main_queue(), ^{
			AppDelegate *s = weak;
			if (!s || gen != s.probeGeneration) return;
			completion(port);
		});
	});
}

// NSMenuDelegate: the menu opens instantly with the last known state; a
// background probe then patches titles in place (NSMenu is live).
- (void)menuWillOpen:(NSMenu *)menu {
	[self refreshStatus];
	[self probeInBackgroundWithGeneration:self.probeGeneration
							   completion:^(int port) {
								   self.foundPort = port;
								   [self refreshStatus];
							   }];
}

- (NSString *)lockPath {
	return [self.homeDir stringByAppendingPathComponent:@LOCK_FILE_NAME];
}

// VNODE watch on the home dir: the server creates/removes narrafork.lock as
// it starts and stops, so each change is a signal to re-probe once.
- (void)watchLockDir {
	mkdir(self.homeDir.fileSystemRepresentation, 0755);
	int fd = open(self.homeDir.fileSystemRepresentation, O_EVTONLY);
	if (fd < 0) return;
	dispatch_source_t src = dispatch_source_create(
		DISPATCH_SOURCE_TYPE_VNODE,
		fd,
		DISPATCH_VNODE_WRITE | DISPATCH_VNODE_DELETE | DISPATCH_VNODE_RENAME,
		dispatch_get_main_queue());
	__weak AppDelegate *weak = self;
	dispatch_source_set_event_handler(src, ^{
		AppDelegate *s = weak;
		s.probeGeneration += 1;
		[s probeAfterLockEventWithGeneration:s.probeGeneration attempt:0];
	});
	dispatch_source_set_cancel_handler(src, ^{ close(fd); });
	dispatch_resume(src);
	self.lockSource = src;
}

// Probe once; while the lock exists but nothing answers yet (server still
// mid-startup), schedule a bounded retry. The probe itself runs off-thread so
// a stalled port can't hitch the UI; superseded generations bail out.
- (void)probeAfterLockEventWithGeneration:(unsigned long)gen attempt:(int)attempt {
	if (gen != self.probeGeneration) return;
	__weak AppDelegate *weak = self;
	[self probeInBackgroundWithGeneration:gen
							   completion:^(int port) {
								   AppDelegate *s = weak;
								   if (!s) return;
								   if (port || attempt >= STARTUP_PROBE_MAX_ATTEMPTS) {
									   s.foundPort = port;
									   [s refreshStatus];
									   return;
								   }
								   BOOL lockGone = ![[NSFileManager defaultManager]
									   fileExistsAtPath:s.lockPath];
								   if (lockGone) {
									   s.foundPort = 0;
									   [s refreshStatus];
									   return;
								   }
								   dispatch_after(
									   dispatch_time(DISPATCH_TIME_NOW,
													 (int64_t)(0.4 * NSEC_PER_SEC)),
									   dispatch_get_main_queue(),
									   ^{
										   [weak probeAfterLockEventWithGeneration:gen
																attempt:attempt + 1];
									   });
							   }];
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

- (void)startServer {
	if (self.serverTask.isRunning) return;
	mkdir(self.homeDir.fileSystemRepresentation, 0755);

	NSTask *task = [NSTask new];
	task.launchPath = self.serverPath;
	task.arguments = self.serverArgs;
	NSMutableDictionary *env = NSProcessInfo.processInfo.environment.mutableCopy;
	env[@"NARRAFORK_APP_BUNDLE"] = @"1";
	task.environment = env;

	int fd = open(self.logPath.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0644);
	if (fd >= 0) {
		NSFileHandle *log = [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES];
		task.standardOutput = log;
		task.standardError = log;
	}

	__weak AppDelegate *weak = self;
	task.terminationHandler = ^(NSTask *t) {
		dispatch_async(dispatch_get_main_queue(), ^{
			AppDelegate *s = weak;
			s.serverTask = nil;
			s.ownServer = NO;
			s.foundPort = 0;
			[s refreshStatus];
		});
	};
	@try {
		[task launch];
		self.serverTask = task;
		self.ownServer = YES;
		self.foundPort = 0;
		[self refreshStatus]; // ◐ starting until the lock event flips it
	} @catch (NSException *e) {
		NSLog(@"narrafork launcher: spawn failed: %@", e);
	}
}

- (void)applicationWillTerminate:(NSNotification *)note {
	if (self.serverTask.isRunning) {
		[self.serverTask terminate]; // SIGTERM — the server shuts down gracefully
	}
}

// ── Menu actions ─────────────────────────────────────────────────────────────

- (void)openPageAt:(int)port {
	NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://localhost:%d/", port]];
	[NSWorkspace.sharedWorkspace openURL:url];
}
- (void)openPage:(id)sender {
	if (self.foundPort) [self openPageAt:self.foundPort];
}

- (NSString *)appWindowBrowser {
	for (NSString *bid in @[ @"com.google.Chrome", @"com.microsoft.edgemac", @"org.chromium.Chromium" ]) {
		NSURL *appURL = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:bid];
		if (appURL) {
			// `open -a` accepts the app name; derive it from the bundle path.
			return appURL.path.lastPathComponent.stringByDeletingPathExtension;
		}
	}
	return nil;
}
- (void)openAppWindow:(id)sender {
	if (!self.foundPort) return;
	NSString *browser = [self appWindowBrowser];
	if (!browser) return;
	NSString *url = [NSString stringWithFormat:@"http://localhost:%d/", self.foundPort];
	[NSTask launchedTaskWithLaunchPath:@"/usr/bin/open"
							 arguments:@[
								 @"-a", browser, url, @"--args",
								 [NSString stringWithFormat:@"--app=%@", url]
							 ]];
}

- (void)showLog:(id)sender {
	[NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:self.logPath]];
}

- (void)toggleLoginItem:(id)sender {
	BOOL next = !loginItemEnabled();
	setLoginItem(next);
	self.loginItem.state = next ? NSControlStateValueOn : NSControlStateValueOff;
}

- (void)toggleServer:(id)sender {
	if (self.foundPort && self.ownServer) {
		[self.serverTask terminate];
	} else if (!self.foundPort) {
		[self startServer];
	}
}

- (void)quit:(id)sender {
	[NSApp terminate:sender];
}

/** `open` on the already-running app (double-click, Dock, `open -a`) lands
 * here — show the page instead of spawning a second agent. */
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender
						hasVisibleWindows:(BOOL)flag {
	int p = self.foundPort ?: find_server_port(self.basePort, PORT_SCAN_SPAN);
	if (p) [self openPageAt:p];
	return NO;
}

@end

// ── main ─────────────────────────────────────────────────────────────────────

int main(int argc, char **argv) {
	char home[PATH_MAX];
	narrafork_home(home, sizeof(home));

	int base = port_from_argv(argc, argv);
	if (!base) base = read_configured_port(home);
	if (!base) base = DEFAULT_PORT;

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

	@autoreleasepool {
		AppDelegate *d = [AppDelegate new];
		d.basePort = base;
		d.homeDir = [NSString stringWithUTF8String:home];
		d.logPath = [d.homeDir stringByAppendingPathComponent:@LOG_FILE_NAME];
		d.serverPath = [NSString stringWithUTF8String:server];
		NSMutableArray *args = [NSMutableArray new];
		for (int i = 1; i < argc; i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];
		d.serverArgs = args;

		NSApplication *app = NSApplication.sharedApplication;
		app.delegate = d;
		[app setActivationPolicy:NSApplicationActivationPolicyAccessory];
		[app run];
	}
	return 0;
}
