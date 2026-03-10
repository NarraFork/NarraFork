# Windows 兼容性修复 — 测试指南

## 前置条件

- Windows 10/11 环境
- 已安装 Git for Windows（Git Bash）
- 已安装 Bun
- NarraFork 服务已启动（`bun run dev` + `bun run dev:frontend`）

---

## 测试 1：叙述者 Shell 命令（MSYS2 路径转换修复）

### 目的
验证 AI 叙述者不再使用 `findstr`/`dir` 等 cmd 命令，而是使用内置工具或 Git Bash 兼容命令。

### 步骤
1. 创建一个项目，关联一个包含多种文件的 git 仓库
2. 创建章节，打开叙述者
3. 依次发送以下提示词：

**提示词 A — 搜索文件内容**
```
在项目中搜索所有包含 "import" 关键字的 .ts 文件，列出文件路径和匹配行
```

**提示词 B — 列出目录结构**
```
列出 src 目录下所有 .py 文件的完整路径
```

**提示词 C — 故意诱导 cmd 命令**
```
用 shell 命令在当前目录递归搜索包含 "TODO" 的文件
```

### 预期结果
- AI 应使用内置 Grep 工具或 `rg`（ripgrep），而不是 `findstr`
- AI 应使用内置 Glob 工具或 `ls`/`find`，而不是 `dir /s /b`
- 不应出现 `FINDSTR: Cannot open I:/` 或 `dir: cannot access '/s'` 等错误
- 在叙述者的 system prompt 中应能看到 "CRITICAL — Windows Git Bash Shell Rules" 段落

---

## 测试 2：createWorktree shallow clone 错误提示

### 目的
验证浅克隆仓库创建 worktree 失败时，给出友好的错误信息。

### 步骤
1. 准备一个浅克隆仓库：
```powershell
git clone --depth 1 https://github.com/any-public-repo.git test-shallow
```

2. 在 NarraFork 中创建项目，关联这个浅克隆仓库
3. 创建一个章节（这会触发 createWorktree）
4. 如果章节创建成功（depth=1 可能够用），尝试从一个历史 commit fork：
   - 先在仓库中多提交几次
   - 然后尝试从早期 commit 创建 fork 章节

### 预期结果
- 如果 worktree 创建失败，错误信息应包含：
  - `This repository appears to be a shallow clone`
  - `Run git fetch --unshallow`
- 而不是只显示原始的 `fatal: unable to read tree <sha>`

### 快速验证（不需要真正触发错误）
检查代码逻辑：
```typescript
// server/services/git-service.ts
// createWorktree 方法中应有 isShallowRepository 检测
// isShallowRepository 方法应存在
```

---

## 测试 3：终端进程信息（Windows wmic/PowerShell 兼容）

### 目的
验证终端的进程树查询在 Windows 下正常工作。

### 步骤
1. 在 NarraFork 中创建一个章节
2. 打开章节的终端
3. 在终端中运行一个长时间命令，例如：
```powershell
ping -t 127.0.0.1
```
4. 通过 API 查询终端进程信息：
```
GET /api/terminals/{terminalId}
```
或在前端查看终端面板中的进程信息

### 预期结果
- 应能看到终端的 shell 进程和子进程（ping）
- 不应出现 `ps: command not found` 或 `pgrep: command not found` 错误
- 进程信息应包含 PID、进程名、内存占用等字段

---

## 测试 4：Shell 回退链

### 目的
验证 shell 检测的完整回退链：Git Bash → pwsh → powershell.exe → cmd.exe

### 步骤（需要修改环境来模拟）

**4a. 正常情况（Git Bash 可用）**
1. 确保 Git for Windows 已安装
2. 启动 NarraFork，查看服务器日志
3. 创建叙述者，发送：
```
运行 echo $SHELL 或 echo hello
```
4. 确认命令通过 Git Bash 执行（输出不应有 PowerShell 特征）

**4b. 模拟无 Git Bash（可选，高级测试）**
1. 临时重命名 Git Bash 的 bash.exe
2. 重启 NarraFork
3. 叙述者应回退到 PowerShell
4. 发送同样的命令，确认通过 PowerShell 执行
5. 测试完恢复 bash.exe

---

## 测试 5：综合场景

### 提示词 — 一次性覆盖多个修复点
```
请帮我完成以下任务：
1. 搜索项目中所有包含 "function" 的 .js 文件
2. 列出 src 目录的文件结构
3. 查看 package.json 的内容
4. 运行 git status
5. 运行 git log --oneline -5
```

### 预期结果
- 任务 1：使用 Grep 工具，不使用 findstr
- 任务 2：使用 Glob 工具或 `ls`，不使用 `dir /s`
- 任务 3：使用 Read 工具，不使用 `type`
- 任务 4-5：直接通过 Shell 工具执行 git 命令（git 在 Git Bash 中正常工作）
- 所有任务均无报错

---

## 排查清单

如果测试中仍出现问题，检查以下内容：

| 检查项 | 命令/位置 |
|--------|-----------|
| Shell 类型 | 服务器日志中搜索 `detectShell` 返回值 |
| System prompt | 叙述者消息中查看 system prompt 是否包含 Windows 指引 |
| ripgrep 是否安装 | `rg --version`（在 PowerShell 中） |
| Git Bash 路径 | `where bash`（在 cmd 中） |
| 浅克隆检测 | `git rev-parse --is-shallow-repository`（在仓库中） |
| wmic 可用性 | `wmic process get ProcessId /FORMAT:CSV`（在 cmd 中） |
