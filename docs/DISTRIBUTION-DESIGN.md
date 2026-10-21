# 安装分发与更新设计：从单文件到按平台安装

> 状态：讨论稿。本文只做设计，不含实现。
> 现行构建、发布与更新见 [BUILD.md](BUILD.md)、[RELEASE.md](RELEASE.md)；本文落地后应同步改写这两份文档和 README 的「直接运行预构建包」一节。

## 1. 现状

### 1.1 现在怎么分发

- 每个版本发布 8 个平台的单文件可执行程序（`bun build --compile`），文件名带版本号，例如 `narrafork-0.9.7-linux-x64`、`narrafork-0.9.7-windows-x64.exe`。每个平台还配有 `.metadata.json` sidecar、zstd patch 对，另有两份聚合 checksum，全部放在同一个 GitHub Release 里。
- README 让用户自己挑文件：Windows 直接运行；Linux/macOS 先 `chmod +x` 再运行；老 CPU 选 `baseline`；macOS 被拦截时运行 `xattr -d com.apple.quarantine`（`docs/BUILD.md:123-131`）。
- **Windows：** 编译产物双击后进入 Win32 管理面板（托盘、单实例互斥，`server/manager/`），由面板以 `--serve` 子进程启动服务。
- **Linux/macOS：** 编译产物直接在前台跑服务，打印地址并打开浏览器（`server/main.ts:1423-1438`）。
- 数据统一放在 `~/.narrafork`（`NARRAFORK_HOME` 可覆盖）。可执行文件所在目录只放更新下来的新版本程序。

### 1.2 现在怎么更新

更新链路本身已经很完整：GitHub 是权威来源，有 update-index 和 patch 链，用 SHA512 校验，有排水调度、交接和恢复清单，还有可选镜像。问题出在最后一步，即新版本程序**落在哪里、怎么启动**：

1. 新版本先下载到 `~/.narrafork/updates`，校验后用 `COPYFILE_EXCL` 复制到**当前 exe 旁边**。文件名沿用发布资产名 `narrafork-<新版本>-<平台>`，从不覆盖任何文件（`server/services/update-service.ts:408-419, 810-830`）。
2. 排水完成后，用新文件名启动替换进程：Unix 用 detached spawn，Windows 用 `cmd /c start`。旧进程交出端口（`update-service.ts:1884-1911`）。
3. 旧版本文件**永远不会被删除**。`cleanupOldUpdates()` 只扫 `~/.narrafork/updates`（`:1165-1191`），而且前端 `useUpdateCleanup` 没有任何组件调用。
4. Windows 面板模式下，老面板继续从旧 exe 运行，靠健康探测"收养"新的 `--serve` 进程（`server/manager/main.ts:539-558`）。

### 1.3 新用户遇到的问题

| # | 问题 | 根源 |
|---|------|------|
| 1 | **选文件难。** Release 里 8 个程序文件和一堆 sidecar、patch、checksum 混在一起，用户还要理解 `baseline` 和 arm64/x64 | 没有面向用户的"下载入口"，发布资产即分发物 |
| 2 | **第一次运行就被系统拦。** macOS 只做了 ad-hoc 签名、没有公证，Gatekeeper 报"无法验证开发者/已损坏"；Windows 没有 Authenticode，SmartScreen 拦截；exe 没有图标和版本信息（图标生成脚本 `scripts/generate-windows-icon.ts` 不存在） | 未签名，缺少 Windows 资源 |
| 3 | **没有"安装"这个概念。** 文件留在"下载"目录；没有开始菜单、启动台或 `narrafork` 命令；Linux/macOS 关掉终端服务就停；不能开机自启。面板的 `autoStartBackend` 只表示"打开面板时启动服务"，而且没有接到任何逻辑上 | 只有单文件，没有安装布局 |
| 4 | **每次更新文件名都变。** exe 旁边越堆越多；用户自建的快捷方式、脚本、systemd unit 仍指向旧文件，重启电脑后**又跑回旧版本**，去打开一个已被新版本迁移过的数据库；`narrafork://` 协议注册的路径、Windows 防火墙规则也都绑在旧路径上 | 用"带版本号的新文件 + 启动新路径"来更新 |
| 5 | **安装目录不可写时更新失败。** 程序放在 `/usr/local/bin` 或 `Program Files` 时，下载完成后复制抛错，界面只显示原始错误串，没有任何手动指引 | 没有可写性预检，没有安装方式识别 |
| 6 | **缺基本命令行能力。** 没有 `--version`/`--help`，没有卸载方式，协议注册也从不清理 | 没有 CLI 子命令 |
| 7 | **国内首装慢。** 镜像只镜像 metadata 和 patch，主程序全量包仍只从 GitHub 取，而首装下载的恰恰就是全量包 | 镜像只覆盖增量路径 |

## 2. 目标与非目标

**目标**

- 每个平台给出一个显而易见的入口：一个安装包或一行命令，自动识别架构，用户不再接触 `baseline`、sidecar、patch 这些概念。
- 程序有**稳定的安装位置和稳定的文件名**；更新后快捷方式、命令、服务配置、协议注册都不用改。
- 更新方式由"谁拥有安装目录"决定：自管安装由应用自己更新；包管理器安装交给包管理器，应用只负责提示和给出命令。
- 复用现有链路：GitHub 权威发布、update-index、patch 链、排水、交接、恢复清单都不变。不新增第二套权威，也不为不同渠道构建不同字节的程序。
- 现有单文件用户不受影响，并提供一条主动迁移的路径。

**非目标**

- 不迁移数据目录。`~/.narrafork` 的位置和内容不变，VS Code 插件靠它发现服务（`vscode-extension/src/discovery.ts`），也不受影响。
- 不做 Linux 桌面 GUI；不做 Flatpak、Snap、AppImage（理由见 §4.3）。
- 首期不做按机器安装（Program Files、多用户共享），也不做 MSI 或企业批量部署。
- 不改 Android/Termux 的运行方式；安装脚本识别出 Termux 时给出提示并退出。

## 3. 核心模型

### 3.1 一个二进制，多种外壳

每个平台**只有一份规范二进制**，也就是现在的发布资产。它既是更新载荷（patch 的基线和目标），也是所有安装包里装进去的那份文件。安装包、DMG、包管理器清单都只是把这份字节送到位的"外壳"。

因此有一条硬约束：**签名必须在构建阶段、生成 sidecar 之前完成**。如果安装包里的程序和规范资产字节不同，patch 基线校验就会失败，用户每次更新都会退化成下载全量包。现在 CI 已经在构建步骤里做 ad-hoc 签名（`scripts/lib/ci-build-strict.ts:51-61`），换成正式签名后位置不变。

### 3.2 安装方式与安装回执

二进制在运行时需要知道"我是怎么被装上的"，以决定更新策略。方式信息不能编进二进制（否则同一平台会分叉出多份字节），所以放在二进制**旁边**的回执文件里：

```jsonc
// <安装目录>/install.json
{
  "schemaVersion": 1,
  "method": "windows-user" | "macos-app" | "script" | "homebrew" | "scoop" | "deb" | "rpm" | "container",
  "updatePolicy": "self" | "external",
  "updateCommand": "brew upgrade narrafork",  // 仅 external
  "installedAt": "2026-10-21T00:00:00Z",
  "installer": "install.sh 1" // 写入方及其版本，便于诊断
}
```

识别顺序如下：

1. **回执优先。** 有 `install.json` 就以它为准。
2. **macOS `.app`。** 签名 bundle 里不能写文件，所以按路径识别：可执行文件位于 `*.app/Contents/MacOS/` 且 `Info.plist` 的 bundle id 匹配。
3. **启发式。** 路径落在 Homebrew Cellar、`scoop\apps`、`/usr/lib`，或存在 `/.dockerenv` 等迹象时，按 `external` 处理。
4. **其余视为 `portable`**，即现在的单文件用法。

无论哪种方式，**下载前都先检查安装目录是否可写**。不可写就不下载，直接给出包管理器命令或手动步骤，取代现在"下载完才报错"的行为。

### 3.3 CLI 子命令

`server/index.ts` 现在只按若干 flag 分流，未知参数一律忽略。新增的子命令放在 worker flag 判断之后、面板/服务分流之前，不影响现有的 `--port`、`--host`、`--serve`、`--manager`、`--no-auto-resume` 和内部 worker flag：

| 命令 | 作用 |
|------|------|
| `narrafork --version` / `--help` | 补齐基本能力，安装脚本和包管理器的测试都依赖它 |
| `narrafork install [--service] [--path] [--shortcut]` | 把当前文件装进标准布局，并写回执、建链接/快捷方式、注册协议和卸载入口。安装脚本、Windows 安装包、便携迁移**共用这一份逻辑** |
| `narrafork uninstall [--purge-data]` | 撤销 `install` 做的一切；默认保留 `~/.narrafork`，删除数据需要二次确认 |
| `narrafork service install\|uninstall\|start\|stop\|status` | 生成或移除 systemd 用户单元 / launchd LaunchAgent / Windows 登录启动项 |
| `narrafork open` | 服务已在跑就打开浏览器；没在跑就先启动（有服务单元就交给它）再打开浏览器。用于桌面快捷方式和 `.app` 双击 |
| `narrafork doctor` | 报告安装方式、目录可写性、git、端口占用、服务状态，降低排障成本 |

**系统集成逻辑放在二进制里，不放在外壳里。** 这些逻辑包括写注册表、建快捷方式、生成服务单元、注册协议和卸载入口。外壳（NSIS、install.sh、Homebrew）只负责把文件放到位，再调用 `install`。这样只有一份可测试的 TypeScript 实现；Windows 部分沿用 `server/manager/win32.ts` 和 `reveal-protocol-registration.ts` 已有的 FFI 方式。

### 3.4 自管安装的更新：稳定路径原地替换

`updatePolicy: "self"` 时，把现在"带版本号的新文件 + 启动新路径"的做法，改为**原地替换同一路径并保留一代旧版本**。下载、校验、patch 链、排水调度全部不变，变化只在最后三步：

```text
预检(目录可写) → 下载/patch 重建到 <安装目录>/.narrafork.new → SHA512 校验
  → 排水(现有协调器) → 交换文件 → 重启(按是否有监管者) → 启动确认 / 回滚
```

**交换文件**（临时文件与目标在同一目录，保证同一文件系统，rename 是原子操作）：

- **Unix：** 先把当前文件硬链接为 `narrafork.previous`（失败则复制），再 `rename(.new → narrafork)`。正在运行的进程继续持有旧 inode，不受影响。
- **Windows：** 运行中的 exe 可以改名但不能覆盖或删除。所以先 `rename(NarraFork.exe → NarraFork.previous.exe)`，再 `rename(.new → NarraFork.exe)`。两次改名之间如果崩溃，下次启动面板或安装包修复时会检测到"主文件缺失但存在 `.new`/`.previous`"，并自动恢复。
- **macOS `.app`：** 整包交换，见 §4.2。

**重启：**

- **无监管者**（手动前台运行）：仍走现有的交接流程，只是 spawn 的路径从"新文件名"改为**同一个稳定路径**。
- **有监管者**（systemd、launchd、Windows 面板）：**不再自行 spawn**。交换完成后以退出码 `75`（EX_TEMPFAIL）退出，由监管者用同一路径拉起；交接 marker 和恢复清单都在 `~/.narrafork`，照常生效。

  这一点是**必须做的**：systemd 在主进程退出后会清理整个 cgroup，自行 spawn 的 detached 替换进程会被一起杀掉；随后 `Restart=` 拉起的进程又会和它抢端口。监管者通过显式环境变量 `NARRAFORK_SUPERVISOR=systemd|launchd|manager` 告知身份，不做推测。

  约定为：管理员在界面里主动关闭服务以退出码 0 退出，监管者不重启；更新以退出码 75 退出，监管者重启。对应配置是 systemd 的 `Restart=on-failure` 和 launchd 的 `KeepAlive.SuccessfulExit=false`。

- **Windows 面板：** 面板就是 `--serve` 的监管者。服务以 75 退出后，面板用稳定路径重新拉起 `--serve`。面板随后也用稳定路径重启自己并交接托盘，避免老面板一直占着 `NarraFork.previous.exe`（这是现在"收养"模式遗留的问题）。

**启动确认与回滚：**

- 新版本通过现有的启动就绪门（`server/lib/startup-readiness.ts`）后，在 `~/.narrafork/updates` 写入启动成功记录。
- 如果新版本连续启动失败，且**还没执行数据库迁移**，就换回 `.previous`。如果已经迁移，则不自动回滚。目前没有找到旧版本遇到更新 schema 时的明确保护，这一点必须在实现前核实，必要时在迁移前做数据库快照。

**清理：** 只保留一份 `.previous`，下次成功更新时覆盖，卸载时删除。

**为什么不采用 `versions/<ver>/` + 启动器的布局：** 那样每个平台还要多一个小启动器二进制，也就多一个组件发布。原地替换不需要新组件，同样能保证路径稳定，`bun upgrade`、`deno upgrade`、rustup 都是这么做的。

### 3.5 便携单文件（兼容现有用户）

- 文件名符合发布资产格式（`narrafork-<ver>-<suffix>`）时，保持现在的并排放置行为，不改变老用户的习惯。
- 新增一次性、可关闭的横幅：「你正在以便携单文件方式运行，安装后可获得固定位置、快捷方式和自动启动」，按钮调用 `install`。Windows 面板显示同样的卡片。
- 新增「清理旧版本文件」入口：列出同目录下同平台后缀、非当前运行的旧版本文件和总大小，由**用户确认后**删除。不自动删除，因为用户可能有脚本指向这些文件。
- 用户把文件改名为不带版本号的名字（例如 `narrafork`）时，按 §3.4 原地替换。

## 4. 各平台方案

### 4.1 Windows

| 渠道 | 形态 | 更新 |
|------|------|------|
| **主推：安装包** `NarraFork-Setup-<ver>-x64.exe` / `-arm64.exe` | NSIS 按用户安装，**不需要管理员权限**；装到 `%LOCALAPPDATA%\Programs\NarraFork\NarraFork.exe` | 应用自更新（§3.4） |
| 便携 exe（现有） | 双击进入面板；面板首次运行时提供「安装到此电脑（推荐）/ 继续以便携方式运行」 | 并排放置 + 清理入口（§3.5） |
| `irm …/install.ps1 \| iex` | 面向命令行用户；下载、校验 SHA256 后调用 `install` | 应用自更新 |
| winget `NarraFork.NarraFork` | 清单指向上面的安装包（`nullsoft`，`user` scope） | 应用自更新；每次更新后同步卸载项里的 `DisplayVersion`，让 winget 看到的版本正确 |
| Scoop bucket | `~\scoop\apps\narrafork\current` | `external`：提示 `scoop update narrafork` |

**`install` 在 Windows 上做的事：**

- 建开始菜单快捷方式（可选桌面快捷方式），并设置 AppUserModelID。
- 写 HKCU 卸载项：`DisplayName`、`DisplayVersion`、`Publisher`、`DisplayIcon`、`InstallLocation`，`UninstallString = "...\NarraFork.exe" uninstall`。
- 安装时就用稳定路径注册 `narrafork://` 协议。现在是首次「在资源管理器中显示」时才懒注册，且从不清理。
- 可选登录启动：HKCU `Run` → `NarraFork.exe --background`。面板最小化到托盘并启动服务，现有的 `autoStartBackend` 偏好终于有了实际作用。
- 可选把安装目录加入用户 PATH，这样 `narrafork` 命令可用。

**NSIS 只做外壳：** 复制已签名的 exe，然后调用 `NarraFork.exe install --from-installer <选项>`。选 NSIS 是因为 `makensis` 能在 Linux 上运行，可以在现有的 ubuntu-24.04 交叉编译 job 里直接产出，签名也能在 Linux 上用 jsign/osslsigncode 完成；Windows runner 只负责安装、升级、卸载的 smoke 测试。

**构建修复：**

- 补上图标生成。
- 加 `--windows-title`、`--windows-publisher`、`--windows-version`、`--windows-description`、`--windows-copyright`。
- 补 application manifest：DPI 感知和 common-controls v6。现在面板在运行时调 `SetProcessDPIAware`，还因为没有 manifest 而改为自绘按钮。

**签名：** 需要 Authenticode，候选方案见 §7。注意：签名后 SmartScreen 信誉仍需随下载量积累，EV 证书也不再直接豁免。另外，Bun 编译产物偶尔会被杀毒软件误报，签名后再向微软提交误报申诉。

### 4.2 macOS

| 渠道 | 形态 | 更新 |
|------|------|------|
| **主推：DMG** `NarraFork-<ver>-macos-arm64.dmg` / `-x64.dmg` | 拖入"应用程序"文件夹的 `NarraFork.app`（Developer ID 签名、hardened runtime、公证并 staple） | 应用自更新（整包交换） |
| `curl -fsSL …/install.sh \| sh` | CLI 二进制装到 `~/.local/share/narrafork/`，`~/.local/bin/narrafork` 为符号链接 | 应用自更新（§3.4） |
| Homebrew cask `narrafork` | 安装上面的 `.app`，`auto_updates true` | 应用自更新；`brew upgrade` 默认跳过，不冲突 |
| Homebrew formula `narrafork` | CLI，同时支持 `brew services` | `external`：提示 `brew upgrade narrafork` |

**`.app` 的形态：**

- `Contents/MacOS/narrafork` 就是规范二进制。
- `Info.plist` 设 `LSUIElement=true`，不显示 Dock 图标。
- 双击时执行 `narrafork open` 的行为：服务没跑就启动，然后打开浏览器；已经在跑就只打开浏览器。退出服务用 Web 界面已有的「关闭服务」。
- 菜单栏图标（NSStatusItem，用 bun:ffi 调用 Objective-C runtime，思路与 `win32.ts` 相同）列为后续增强，不阻塞首版。

**`.app` 的更新——整包交换：**

- 主程序仍按现有 patch 链重建，并做 SHA512 校验。
- bundle 里的其余文件（`Info.plist`、图标、`_CodeSignature`、公证票据）总共只有几百 KB，作为独立资产 `…-macos-<arch>.app-shell.tar` 发布，其描述写进 sidecar 或 index（需要升级 schema）。
- 在同一卷上组装 staging bundle，用 `codesign --verify --deep --strict` 校验后，`rename(NarraFork.app → .NarraFork.app.previous)`，再把 staging 改名为 `NarraFork.app`，然后重新拉起。
- 应用自己用 fetch 下载的文件不会带 quarantine 属性，所以更新后不会再弹 Gatekeeper 提示。但签名必须保持连续，否则 TCC 授权（如完全磁盘访问权限）每次更新都要重新授予。

**签名要点：**

- 需要 Apple Developer Program 账号。
- 按 Bun 文档为 hardened runtime 配置 JIT 相关 entitlements。
- 运行时解压加载的原生库（如 `@parcel/watcher` 的 `.node`）也要用同一 Team ID 签名后再嵌入，否则会被库验证拦下。必须在原生 smoke 测试里覆盖。

**过渡期的价值：** `install.sh` 用 curl 下载的文件不带 quarantine 属性，**在拿到 Developer ID 之前就能绕开 Gatekeeper 的门槛**，可以作为 P0 先上线。

### 4.3 Linux

| 渠道 | 形态 | 更新 |
|------|------|------|
| **主推：`curl -fsSL …/install.sh \| sh`** | 用户级：`~/.local/share/narrafork/narrafork`，`~/.local/bin/narrafork` 为符号链接；`--system`：`/opt/narrafork/narrafork`，`/usr/local/bin/narrafork` 为符号链接，目录属主设为运行用户 | 应用自更新（§3.4） |
| `narrafork service install` | systemd 用户单元 `~/.config/systemd/user/narrafork.service`；无桌面的服务器提示执行 `loginctl enable-linger`；`--system` 生成带 `User=<当前用户>` 的系统单元 | 监管者重启（退出码 75） |
| Homebrew formula（Linuxbrew） | 同 macOS formula | `external` |
| `.deb` / `.rpm`（P2，nfpm 打包） | `/usr/lib/narrafork/narrafork`，`/usr/bin/narrafork` 为符号链接，包内带 `external` 回执 | `external`：提示 `apt`/`dnf` 命令；没有软件源时提示下载新包 |
| 容器镜像（P2） | `ghcr.io/<owner>/narrafork:<ver>`，debian-slim + git；`NARRAFORK_HOME=/data` 卷；`HOST=0.0.0.0` | `external`：提示拉取新镜像 |

**`install.sh` 的行为（macOS 共用同一脚本）：**

- **识别平台：** 用 `uname -s/-m` 识别系统和架构。识别出 musl/Alpine（当前没有 musl 构建）和 Termux 时，给出明确说明并退出，不装一个跑不起来的文件。
- **选择版本：** 从 update-index 解析目标版本，支持 `--channel beta`、`--version X`。下载规范二进制和 `SHA256SUMS`，校验通过后才放到安装位置。
- **完成安装：** 调用 `narrafork install --method=script`。`--service` 时一并安装服务。如果 `~/.local/bin` 不在 PATH 里，给出提示。
- **其他参数：** `--mirror <url>` 或环境变量 `NARRAFORK_DOWNLOAD_BASE` 指定镜像来源；`--uninstall` 转调 `narrafork uninstall`。
- **获取地址：** 脚本作为每个 Release 的资产发布，稳定地址用 `releases/latest/download/install.sh`。

**服务单元：**

- 配置 `Restart=on-failure`、`Environment=NARRAFORK_SUPERVISOR=systemd`，`ExecStart=<稳定路径> --serve`。
- 需要评估 dtach 等派生守护进程与 cgroup 清理的关系，确定合适的 `KillMode`。现有原生 smoke 测试已经专门排除 dtach，说明这里有坑。

**不做 AppImage、Flatpak、Snap：** NarraFork 是服务型程序，Agent 需要不受限地访问用户的仓库和开发工具链，沙箱会直接与之冲突。AppImage 相比静态单文件没有额外收益，反而多一个 FUSE 依赖。

**容器镜像的定位：** 面向团队服务器部署。需要在文档里写清楚：Agent 的命令在容器内执行，工具链要自己装进镜像；容器内不支持 Podman 功能。

## 5. 更新策略总表

| 安装方式 | 谁负责更新 | 应用内「检查更新」 | 应用内「应用更新」 |
|----------|-----------|--------------------|--------------------|
| Windows 安装包 / install.ps1 / winget | 应用 | ✅ | ✅ 原地替换，面板监管 |
| macOS `.app`（DMG / cask） | 应用 | ✅ | ✅ 整包交换 |
| install.sh（Linux/macOS） | 应用 | ✅ | ✅ 原地替换；有服务单元时由监管者重启 |
| 便携单文件（现有） | 应用 | ✅ | ✅ 并排放置（现行为）+ 清理入口 + 安装横幅 |
| Homebrew formula / Scoop / deb / rpm | 包管理器 | ✅ | ❌ 显示 `updateCommand` |
| 容器 | 镜像 | ✅ | ❌ 显示拉取命令 |
| 安装目录不可写（未知方式） | — | ✅ | ❌ 下载前拦截，给出手动步骤 |
| 源码运行（dev） | — | 不变 | 不变 |

前端把 `installMethod`、`updatePolicy`、`updateCommand` 加进 `GET /api/update/status`，更新模态框按策略展示。`external` 时不再提供下载按钮，改为显示可复制的命令。面板的更新客户端（`server/manager/update-client.ts`）采用同一字段。

## 6. 发布流水线的改动

1. **正式签名移到构建阶段，在生成 sidecar 之前完成**（§3.1）。macOS 在现有 macOS runner 上用 Developer ID 签名并公证（裸 Mach-O 可以公证但不能 staple，`.app` 可以 staple）；Windows 在 Linux 上做 Authenticode。签名凭据只交给构建 job，不交给 publisher。
2. 新增**分发资产 job**（在 assemble 之后）：
   - NSIS 安装包，签名；
   - DMG 和 app-shell（macOS runner，`hdiutil`，公证并 staple）；
   - `install.sh` / `install.ps1`。

   这些资产里的程序都直接取 assemble 封存的规范二进制，**不重新编译**。
3. **publisher 资产校验和 index：**
   - 发布资产白名单要增加"分发资产"类别；
   - app-shell 的描述进入 sidecar 或 index（schema 升级，旧客户端忽略未知字段）；
   - 其余分发资产不进入更新 index；
   - 注意现有的单次发布最多 200 个资产的上限。
4. **原生 smoke 测试新增安装场景：**
   - 全新安装 → 启动 → 卸载（数据保留）；
   - 用本地 fixture 更新源从 N-1 原地升级到 N：校验稳定路径、`.previous`、回执、Windows `DisplayVersion`；
   - systemd 用户单元和 launchd 场景下的监管者重启。
5. **包管理器清单：** Homebrew tap、Scoop bucket、winget-pkgs PR 由独立 workflow 在 Release 公开后生成。这一步和镜像一样，不参与主发布的成功条件。
6. **国内首装：** 见 §7 的决策项。如果镜像要承载全量包和安装包，扩展现有 v3 镜像 API 的资产类别，仍以 GitHub 为权威、按 size/SHA256 校验。

## 7. 待决策

| # | 问题 | 选项与建议 |
|---|------|-----------|
| 1 | Apple 签名 | 需要 Apple Developer Program 账号（年费），由谁持有？bundle id 用什么？**建议**：P0 先上线 install.sh，DMG 等账号到位后再做 |
| 2 | Windows 签名渠道 | SignPath Foundation（开源项目免费，需申请审核）/ Certum 开源代码签名证书（便宜，云 HSM）/ Azure Artifact Signing（地区和主体资格有限制）。**建议**：先申请 SignPath，同时备 Certum |
| 3 | 国内首装的全量包来源 | 让镜像承载全量包和安装包（存储和带宽成本）/ 沿用 123 云盘分发 / 只提供 `--mirror` 参数由用户自行指定。**建议**：镜像承载当前 stable 和 beta 两个版本的全量包，旧版本不保留 |
| 4 | 登录自启默认值 | **建议**默认关闭，安装时以复选框提供 |
| 5 | `baseline` 是否还暴露给用户 | README 已注明 Bun 现在统一了 x64 构建。**建议**：安装包和脚本默认用 x64，`baseline` 资产保留以保证已有用户的更新连续，不再出现在下载指引里 |
| 6 | 发布者名称、显示名、Homebrew/Scoop 仓库归属 | 需要确定，会写入签名证书、卸载项和清单 |

## 8. 分期

**P0：不依赖任何证书或账号，纯代码改动**

- CLI：`--version`/`--help`、`install`/`uninstall`/`service`/`open`/`doctor`。
- 安装方式识别、回执、可写性预检，并把它们暴露给更新状态 API 和界面。
- 原地替换更新、监管者重启约定（退出码 75）、`.previous` 保留与回滚、Windows 面板自重启。
- 便携用户：安装横幅、清理旧版本入口。Windows 面板首次运行时的「安装到此电脑」。
- `install.sh`（Linux/macOS）和 `install.ps1`。
- Windows 图标、版本资源、manifest。
- README 和 Release 说明改成"每个系统一个入口"。

**P1：需要签名证书或账号**

- macOS：Developer ID 签名、公证，`.app` + DMG，整包交换更新，Homebrew tap（cask + formula）。
- Windows：Authenticode 签名、NSIS 安装包、winget、Scoop。
- 安装场景的原生 smoke 测试接入 Release CI。

**P2：按需求决定**

- deb/rpm 及软件源托管、容器镜像。
- macOS 菜单栏图标。
- Windows 按机器安装和 MSI。

## 9. 风险

- **数据库回滚：** 新版本迁移数据库之后再回到旧二进制是否安全，目前没有明确保护。回滚判定必须以"迁移是否已提交"为界，实现前要核实，必要时在迁移前做快照。
- **Windows 两次改名之间的窗口：** 靠启动时和安装包修复时的自检兜底，需要有专门的故障注入测试。
- **监管者识别错误：** 只认显式的 `NARRAFORK_SUPERVISOR`，不靠 `INVOCATION_ID` 一类的环境变量推测。识别不到时按"无监管者"处理，即现有交接行为。
- **安装方式识别错误：** 识别不确定且目录不可写时一律按 `external` 处理，宁可多给一条手动指引，也不要下载到一半再失败。
- **hardened runtime 与 Bun 的原生库：** JIT entitlements、`.node` 库验证，需要 macOS 原生 smoke 测试覆盖 watcher、PTY 和插件 worker。
- **杀毒误报：** 签名后仍可能发生，需要预留申诉流程，并在文档里写明如何校验 SHA256。
