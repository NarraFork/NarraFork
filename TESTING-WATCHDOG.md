# 看门狗功能手动测试指南

## 前置条件
- NarraFork 已启动（`bun run dev` + `bun run dev:frontend`）
- 已创建项目和章节，叙述者可正常对话

---

## 测试 1：正常命令不触发看门狗

**操作：** 让叙述者执行一个快速命令

**提示词：**
```
运行 echo "hello world" 命令
```

**预期：**
- 命令正常执行，输出 "hello world"
- ToolCallCard 不显示"终止进程"按钮
- 无看门狗相关日志

---

## 测试 2：长时间运行命令触发 UI 终止按钮

**操作：** 让叙述者执行一个超过 60 秒的命令

**提示词：**
```
运行 sleep 120 命令，我需要测试长时间运行的进程处理
```

**预期：**
- 命令开始执行，ToolCallCard 显示 "running" 状态
- 约 60 秒后（第 4 个看门狗 tick），ToolCallCard 出现红色"终止进程"按钮
- 点击"终止进程"按钮后，叙述者被中断，命令终止
- 后端日志无异常

**验证点：**
- [ ] 60 秒前无终止按钮
- [ ] 60 秒后终止按钮出现
- [ ] 点击终止按钮后命令被中断
- [ ] 无定时器泄漏（后续命令正常执行）

---

## 测试 3：Windows 管道缓冲区压力测试

**操作：** 让叙述者执行大量输出的命令（在 Windows 上尤其重要）

**提示词（Linux/macOS）：**
```
运行这个命令：for i in $(seq 1 10000); do echo "line-$i-padding-data"; echo "err-$i" >&2; done
```

**提示词（Windows）：**
```
运行这个命令：for /L %i in (1,1,10000) do @echo line-%i-padding-data
```

**预期：**
- 命令正常完成，不会挂起
- 输出被正确截断（超过 2000 行或 50KB）
- 进程正常退出，exit code 为 0

---

## 测试 4：看门狗清理僵尸进程

**操作：** 模拟进程异常退出的场景

**提示词：**
```
运行 bash -c "sleep 1 & echo started; wait" 命令
```

**预期：**
- 命令正常完成
- 后台 sleep 进程不会泄漏
- 看门狗定时器在命令结束后被正确清理

---

## 测试 5：abort 与看门狗协同

**操作：** 在命令执行中手动中断叙述者

**提示词：**
```
运行 sleep 30 命令
```

然后在命令执行期间点击叙述者面板的"中断"按钮。

**预期：**
- 命令被立即终止
- 输出包含 "aborted by user" 元数据
- 看门狗定时器被正确清理
- 叙述者可以继续接受新消息

---

## 测试 6：超时与看门狗协同

**操作：** 让叙述者执行一个会超时的命令

**提示词：**
```
运行 sleep 300 命令，设置 timeout 为 5000 毫秒
```

**预期：**
- 命令在约 5 秒后被超时终止
- 输出包含 "timed out" 元数据
- 看门狗定时器被正确清理

---

## 自动化测试

```bash
# 运行 safeSpawn 单元测试（14 个测试，约 20 秒）
bun test server/lib/__tests__/spawn.test.ts

# 运行 bash 看门狗集成测试（6 个测试，约 2 秒）
bun test server/lib/agent/tools/__tests__/bash-watchdog.test.ts

# 运行所有工具测试（确保无回归）
bun test server/lib/agent/tools/__tests__/tools.test.ts
```

## 关键日志检查

后端日志中应能看到以下看门狗相关日志（仅在异常情况下）：

```
safeSpawn: hard timeout, killing     — 硬超时触发
safeSpawn: watchdog killed process   — 看门狗检测到僵尸进程
```

正常运行时不应有看门狗日志输出。
