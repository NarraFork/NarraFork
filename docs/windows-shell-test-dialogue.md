# Windows Shell 适配测试对话

在 Windows 机器上启动 NarraFork 后，创建一个叙述者会话，依次发送以下消息来测试各项 Windows 适配功能。

> 每条消息之间观察返回结果，确认预期行为后再发下一条。

---

## 0. 启动验证

启动服务器时观察日志：

```bash
# 默认模式（禁止 WSL）
bun run dev

# 显式允许 WSL
bun run dev -- --wsl=true
```

检查点：
- [ ] 服务器正常启动，无报错
- [ ] 日志中 shell 检测结果正确（Git Bash / PowerShell / cmd）

---

## 1. Shell 工具基础

### 1.1 确认 Shell 类型

```
运行 echo hello 看看输出
```

检查点：
- [ ] 工具名显示为 "Shell"（不是 "Bash"）
- [ ] 命令正常执行，输出 `hello`
- [ ] 如果是 Git Bash：通过 `--login -c` 包装执行
- [ ] 如果是 PowerShell：通过 `-NoProfile -NonInteractive -Command` 执行

### 1.2 PATH 继承

```
运行 git --version 和 node --version
```

检查点：
- [ ] git 和 node 都能找到（PATH 正确继承）
- [ ] Git Bash 模式下 MSYS2_PATH_TYPE=inherit 生效

### 1.3 workdir 参数

```
在 .. 目录下运行 ls（或 dir）
```

检查点：
- [ ] workdir 参数正确 resolve 到父目录
- [ ] 命令在正确的目录下执行

### 1.4 超时和中断

```
运行 ping -n 10 127.0.0.1，然后在执行过程中中断
```

检查点：
- [ ] 进程通过 `taskkill /T /F /PID` 正确终止
- [ ] 不会残留子进程

---

## 2. Grep 工具（ripgrep）

### 2.1 基本搜索

```
在当前项目中搜索 "IS_WINDOWS" 这个字符串
```

检查点：
- [ ] ripgrep 被正确找到并执行（不报 "rg not found"）
- [ ] 输出的文件路径使用正斜杠（`server/lib/platform.ts` 而非 `server\lib\platform.ts`）
- [ ] 行号和内容正确显示

### 2.2 带 include 过滤

```
只在 .ts 文件中搜索 "toForwardSlash"
```

检查点：
- [ ] `--glob *.ts` 参数正确传递
- [ ] 结果只包含 .ts 文件

### 2.3 指定子目录搜索

```
在 server/lib 目录下搜索 "platform"
```

检查点：
- [ ] 相对路径正确 resolve 到 `ctx.cwd/server/lib`
- [ ] 搜索范围限定在子目录内

### 2.4 无结果搜索

```
搜索一个不存在的字符串 "xyzzy_nonexistent_12345"
```

检查点：
- [ ] 返回 "No files found"，不报错

---

## 3. Glob 工具

### 3.1 基本 glob

```
找出所有 server/lib/agent/tools/*.ts 文件
```

检查点：
- [ ] 返回的路径使用正斜杠
- [ ] 文件列表正确

### 3.2 相对路径 base

```
以 server/lib 为基础目录，找 **/*.ts 文件
```

检查点：
- [ ] 相对路径 `server/lib` 正确 resolve 到绝对路径
- [ ] 不报 "directory not found" 错误

### 3.3 深层 glob

```
找出项目中所有 package.json 文件
```

检查点：
- [ ] `**/package.json` 正常工作
- [ ] 路径全部使用正斜杠

---

## 4. Read / Write / Edit 工具

### 4.1 读取文件

```
读取 server/lib/platform.ts 文件
```

检查点：
- [ ] 文件正确读取，显示行号
- [ ] 路径 resolve 正确（相对路径 → 绝对路径）

### 4.2 写入文件

```
创建一个测试文件 test-windows.txt，内容为 "Windows test OK"
```

检查点：
- [ ] 文件创建成功
- [ ] 父目录自动创建（如果需要）
- [ ] 文件内容正确（无 BOM 问题）

### 4.3 编辑文件（CRLF 处理）

```
把 test-windows.txt 中的 "OK" 改成 "PASSED"
```

检查点：
- [ ] Edit 工具正确处理 CRLF 行尾（`\r\n` → `\n` 规范化后匹配）
- [ ] 替换成功

### 4.4 清理

```
删除 test-windows.txt
```

检查点：
- [ ] Shell 工具能正确删除文件（`del` 或 `rm`）

---

## 5. WSL 禁止（--wsl=false，默认）

### 5.1 AI 不建议 WSL

```
我在 Windows 上遇到了一个 shell 脚本执行问题，有什么解决方案？
```

检查点：
- [ ] AI 不建议 "切换到 WSL" 或 "在 WSL 中运行"
- [ ] AI 给出 Windows 原生解决方案（Git Bash / PowerShell）

### 5.2 直接问 WSL

```
我能不能用 WSL 来运行这个项目？
```

检查点：
- [ ] AI 明确表示当前环境不使用 WSL
- [ ] 不提供 WSL 安装或配置指导

### 5.3 Linux 命令适配

```
帮我运行 grep -r "TODO" . 这个命令
```

检查点：
- [ ] AI 使用 Grep 工具（而非 shell grep）
- [ ] 或者使用 `rg`（ripgrep）而非 Linux grep
- [ ] 不建议 "在 WSL 中运行 grep"

---

## 6. WSL 允许（--wsl=true）

> 重启服务器：`bun run dev -- --wsl=true`

### 6.1 WSL 建议不被阻止

```
我想在 Linux 环境下运行一些脚本，有什么建议？
```

检查点：
- [ ] system prompt 中没有 WSL 禁止指令
- [ ] AI 可以自由建议 WSL（如果合适的话）

---

## 7. 路径处理

### 7.1 Windows 绝对路径

```
读取 C:\Windows\System32\drivers\etc\hosts 文件（或其他已知存在的文件）
```

检查点：
- [ ] Windows 驱动器路径（`C:\...`）正确识别为绝对路径
- [ ] 文件正确读取

### 7.2 混合斜杠路径

```
读取 server\lib\platform.ts 文件
```

检查点：
- [ ] 反斜杠路径正确 resolve
- [ ] 文件正确读取

### 7.3 Task 工具 workdir

```
启动一个子任务，在 server 目录下查找所有 .ts 文件
```

检查点：
- [ ] `resolvePath(ctx.cwd, "server")` 正确解析
- [ ] 子 agent 的 cwd 使用正斜杠

---

## 8. PowerShell 特定（仅当 Git Bash 不可用时）

> 如果系统没有 Git Bash，Shell 工具会回退到 PowerShell。

### 8.1 PowerShell 语法

```
列出当前目录下的所有文件
```

检查点：
- [ ] system prompt 包含 PowerShell 使用提示
- [ ] AI 使用 PowerShell 语法（`Get-ChildItem`）或跨平台命令（`ls`）

### 8.2 PowerShell 管道

```
统计当前目录下 .ts 文件的数量
```

检查点：
- [ ] PowerShell 管道命令正确执行
- [ ] 或者 AI 优先使用 Glob 工具而非 shell

---

## 9. 边界情况

### 9.1 长路径

```
创建一个深层嵌套目录 a/b/c/d/e/f/g/test.txt 并写入内容
```

检查点：
- [ ] Windows 长路径支持（> 260 字符限制）
- [ ] `mkdirSync({ recursive: true })` 正确创建多层目录

### 9.2 特殊字符路径

```
创建一个文件名包含空格的文件 "test file.txt"
```

检查点：
- [ ] 空格路径正确处理
- [ ] Shell 命令中路径正确引用

### 9.3 并发工具调用

```
同时搜索三个不同的关键词：IS_WINDOWS、IS_MACOS、IS_LINUX
```

检查点：
- [ ] 多个 Grep 工具并发执行不冲突
- [ ] 所有结果路径格式一致（正斜杠）

---

## 测试结果汇总

| 类别 | 测试项 | 通过 | 备注 |
|------|--------|------|------|
| Shell 基础 | 1.1 Shell 类型 | | |
| Shell 基础 | 1.2 PATH 继承 | | |
| Shell 基础 | 1.3 workdir | | |
| Shell 基础 | 1.4 超时中断 | | |
| Grep | 2.1 基本搜索 | | |
| Grep | 2.2 include 过滤 | | |
| Grep | 2.3 子目录搜索 | | |
| Grep | 2.4 无结果 | | |
| Glob | 3.1 基本 glob | | |
| Glob | 3.2 相对路径 base | | |
| Glob | 3.3 深层 glob | | |
| Read/Write/Edit | 4.1 读取 | | |
| Read/Write/Edit | 4.2 写入 | | |
| Read/Write/Edit | 4.3 CRLF 编辑 | | |
| Read/Write/Edit | 4.4 删除 | | |
| WSL 禁止 | 5.1 不建议 WSL | | |
| WSL 禁止 | 5.2 直接问 WSL | | |
| WSL 禁止 | 5.3 Linux 命令 | | |
| WSL 允许 | 6.1 不阻止 WSL | | |
| 路径处理 | 7.1 绝对路径 | | |
| 路径处理 | 7.2 混合斜杠 | | |
| 路径处理 | 7.3 Task workdir | | |
| PowerShell | 8.1 PS 语法 | | |
| PowerShell | 8.2 PS 管道 | | |
| 边界情况 | 9.1 长路径 | | |
| 边界情况 | 9.2 特殊字符 | | |
| 边界情况 | 9.3 并发调用 | | |
