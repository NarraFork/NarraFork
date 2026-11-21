# 服务端临时 CPU 采样

适用于包含在线采样接口的 NarraFork 构建（本次为 `0.9.10-alpha.10`）。用于定位切换叙述者等操作的服务端卡顿；采样结束即返回文件，服务继续运行。

## 1. 启动条件：一次设置

实例目录：`/home/project/narrafork`。

Bun 1.4.3 的启动式 `--cpu-prof` 与在线采样冲突。用户在切换到新版、正常停止旧启动脚本后，用下面的方式启动：

```bash
cd /home/project/narrafork
NARRAFORK_CPU_PROFILE=0 ./start.sh
```

注意：

- `NARRAFORK_CPU_PROFILE=0` 只阻止启动脚本自动添加采样参数。如果自行设置过 `BUN_OPTIONS`，还需从中移除 `--cpu-prof` 及其相关参数，保留其他需要的配置。
- 修改环境变量不会改变已经运行的进程。启动方式切换由用户操作；助手后续只调用采样接口，不重启实例。
- 已按此方式启动后，每次采样都不需要退出服务。

## 2. 接口

```text
POST /api/diagnostics/cpu-profile
Content-Type: application/json

{"durationMs":20000}
```

- 无需登录、Cookie 或令牌。
- `durationMs` 单位为毫秒；省略请求体或传 `{}` 时默认 15000。
- 采样间隔为 10ms。同一进程一次只采一份，重复请求返回 409。
- 请求保持连接，到时直接返回 `.cpuprofile` JSON 附件；文件由调用端保存，接口不自动写入实例目录。
- 请求取消时清理本次采样。一般选 10–30 秒，避免长时间累计掩盖具体卡顿窗口。

## 3. 抓取一次 20 秒采样

在另一个终端执行，或让助手执行。`BASE_URL` 必须改成启动日志中的实际服务地址；下面的 7778 仅为示例端口。

```bash
BASE_URL="http://127.0.0.1:7778"
OUT_DIR="/home/project/narrafork/profiles"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/online-cpu-$STAMP.cpuprofile"

date '+采样请求开始：%Y-%m-%d %H:%M:%S %z'
if curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 45 \
  -X POST "$BASE_URL/api/diagnostics/cpu-profile" \
  -H 'Content-Type: application/json' \
  --data '{"durationMs":20000}' \
  --output "$FILE.part"; then
  mv -- "$FILE.part" "$FILE"
  date '+采样请求完成：%Y-%m-%d %H:%M:%S %z'
  printf '采样文件：%s\n' "$FILE"
else
  printf '采样失败；错误响应或不完整文件保留于：%s.part\n' "$FILE" >&2
fi
```

请求发出后立即在页面切换叙述者，重复出现卡顿的操作。记录：

1. 卡顿时间及其时区，最好精确到秒。
2. 从哪个叙述者切换到哪个叙述者，以及大致等待多久。
3. 当时是否有多个 agent 输出、工具执行或后台构建。

首次抓取最好在服务启动稳定后进行；不要同时启动其他采样请求。若增加采样时长，也要相应增加 curl 的 `--max-time`，并留出生成及传输文件的时间。

## 4. 错误处理

| HTTP / code | 含义与处理 |
| --- | --- |
| 404 | 核对地址、端口及实际运行版本；仅把二进制放入目录不代表已切换运行版本。 |
| 400 | JSON 或 `durationMs` 不合法；使用示例中的正整数毫秒值。 |
| 409 / `CPU_PROFILER_BUSY` | 已有一份采样正在执行，等待其完成。 |
| 503 / `CPU_PROFILE_CONFLICT` | Bun 1.4.3 当前启用了启动式 `--cpu-prof`；按第 1 节调整下次启动方式。 |
| 503 / `CPU_PROFILER_UNAVAILABLE` | inspector 返回错误，保留响应内容进一步定位。 |
| 503 / `CPU_PROFILER_SHUTDOWN` | 服务正在关闭，待正常启动后再采集。 |

失败时不要把 `.part` 当作有效 profile；其中可能只有错误 JSON。不要自动循环重试，以免不断增加服务负载。

## 5. 分析与对比

把文件路径和操作时间交给助手，在服务器本地解析即可。重点检查：

- `nodes`、`samples`、`timeDeltas` 是否有效，能否定位到源码函数和行号。
- 对齐卡顿窗口的慢请求、事件循环停顿与相关调用链，而不是只看全文件累计排名。
- SQLite 保护维护、DB worker 的派发/结算、block-sync，以及原生 `prepare` 的具体父调用链。
- 区分叶子样本与父调用链累计值，不把父子重复相加；无 URL 的原生帧应结合调用栈归类。
- `timeDeltas` 包含样本之间的间隔，长间隔权重不能直接当作函数实际消耗的 CPU 秒数。采样很少的空闲窗口也不能证明没有问题。

比较优化前后时，尽量采用相同操作、时长和并发负载，同时比较切换等待时间。保留对应二进制版本和构建源码指纹；修改后的本地源码不一定等于 profile 采集时的源码。

## 代码入口

- [在线采样路由](../server/routes/diagnostics.ts)
- [采样生命周期与运行时兼容处理](../server/services/cpu-profiler.ts)
