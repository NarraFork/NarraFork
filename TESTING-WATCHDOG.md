# 看门狗功能测试提示词

以下提示词直接发送给叙述者（AI 对话），用于触发看门狗的各个场景。
每条提示词后标注了预期行为和验证点。

---

## 测试 1：基线 — 正常命令不触发看门狗

```
帮我看一下当前目录有哪些文件
```

预期：叙述者调用 Bash/Shell 执行 `ls` 或 `dir`，秒级完成，ToolCallCard 无"终止进程"按钮。

---

## 测试 2：长时间运行 — 触发终止按钮（核心场景）

```
帮我运行一下 ping -n 200 127.0.0.1 看看网络延迟情况
```

> Linux/macOS 替代：`ping -c 200 127.0.0.1`

预期：
- 命令持续运行，ToolCallCard 显示 running 状态和实时输出
- 约 60 秒后 ToolCallCard 出现红色"终止进程"按钮
- 点击按钮后命令被中断，叙述者收到 abort 通知并继续对话

---

## 测试 3：管道缓冲区压力 — Windows 死锁防护

```
帮我生成一些测试数据，运行这个命令：for /L %i in (1,1,10000) do @echo line-%i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa && echo err-%i 1>&2
```

> Linux/macOS 替代：`for i in $(seq 1 10000); do echo "line-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; echo "err-$i" >&2; done`

预期：命令正常完成不挂起，输出被截断显示，exit code 为 0。这个测试验证 stdout+stderr 并行 drain 不会死锁。

---

## 测试 4：超时 — 命令超过默认 120 秒

```
帮我运行 sleep 300 测试一下超时机制
```

> Windows 替代：`ping -n 301 127.0.0.1 >nul`

预期：
- 命令在 120 秒（默认超时）后被终止
- 60 秒时出现"终止进程"按钮
- 叙述者输出包含 "timed out" 信息

---

## 测试 5：中断协同 — 手动中断正在运行的命令

```
运行 ping -n 100 127.0.0.1 帮我测试网络
```

> 发送后立即点击叙述者面板顶部的"中断"按钮

预期：命令被立即终止，叙述者输出包含 "aborted" 信息，可以继续正常对话。

---

## 测试 6：连续命令 — 验证定时器无泄漏

```
依次运行以下三个命令，每个运行完再运行下一个：
1. echo "第一个命令"
2. ping -n 5 127.0.0.1
3. echo "第三个命令"
```

预期：三个命令依次正常执行完成，无挂起、无异常。验证看门狗定时器在每个命令结束后被正确清理。

---

## 测试 7：大量 stderr 输出 — Windows 管道写端阻塞防护

```
帮我运行这个命令检查一下错误输出处理：for /L %i in (1,1,5000) do @echo error-line-%i 1>&2
```

> Linux/macOS 替代：`for i in $(seq 1 5000); do echo "error-line-$i" >&2; done`

预期：命令正常完成，stderr 内容被正确捕获和显示。这个测试专门验证 stderr 管道不会因缓冲区满而阻塞子进程。
