# NarraFork 差异化更新系统设计

## 概述

实现类似 Electron Builder blockmap 的差异化更新机制，只下载变更的文件块而非整个可执行文件。

## 架构总览

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  构建流程        │     │  更新服务器(Go)  │     │  NarraFork客户端 │
│  (Bun脚本)      │────▶│  cera-forge     │◀────│  (TypeScript)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   生成blockmap            存储/分发              检查/下载/应用
```

## 一、Blockmap 生成（构建端）

### 1.1 数据结构

```typescript
// server/lib/blockmap.ts
interface BlockmapFile {
  name: string;           // 文件名
  offset: number;         // 文件内偏移（通常为0）
  checksums: string[];    // 每个块的 SHA256 (base64)
  sizes: number[];        // 每个块的大小
}

interface Blockmap {
  version: "2";
  files: BlockmapFile[];
}
```

### 1.2 生成算法

- 块大小：64KB（与 electron-builder 一致）
- 哈希算法：SHA256（每块）+ SHA512（整文件）
- 输出格式：gzip 压缩的 JSON

### 1.3 构建脚本

`scripts/build-cross-platform.ts` 在编译完成后自动：
1. 生成 `.blockmap` 文件
2. 生成 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`

## 二、更新服务器 API（Go）

基于 cera-forge-update-server，NarraFork 使用相同协议。

### 2.1 API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/check/{channel}?platform={platform}` | 检查最新版本 |
| `GET` | `/{channel}/{filename}` | 下载文件（支持 Range） |
| `GET` | `/{channel}/{filename}.blockmap` | 下载 blockmap |

### 2.2 版本检查响应

```json
{
  "version": "0.1.0",
  "releaseDate": "2024-01-01T00:00:00Z",
  "path": "narrafork-0.1.0-linux-x64",
  "sha512": "<base64>",
  "files": [{
    "url": "narrafork-0.1.0-linux-x64",
    "size": 12345678,
    "sha512": "<base64>"
  }]
}
```

### 2.3 平台映射

| platform 参数 | 对应文件 |
|--------------|---------|
| `linux-x64` | `narrafork-{version}-linux-x64` |
| `linux-arm64` | `narrafork-{version}-linux-arm64` |
| `darwin-x64` | `narrafork-{version}-macos-x64` |
| `darwin-arm64` | `narrafork-{version}-macos-arm64` |
| `win-x64` | `narrafork-{version}-windows-x64.exe` |

## 三、客户端更新逻辑

### 3.1 更新检查流程

```
1. GET /api/check/{channel}?platform={platform}
2. 比较版本号
3. 如有更新，下载新版 blockmap
4. 生成本地 blockmap
5. 计算差异块
6. 返回更新信息（包含节省百分比）
```

### 3.2 差异下载流程

```
1. 计算需要下载的块列表
2. 构造 HTTP Range 请求头
3. 下载变更块
4. 从本地文件复制未变块
5. 重组完整文件
6. 验证 SHA512
7. 保存到更新目录
```

### 3.3 更新应用

由于无法替换正在运行的可执行文件，提供命令让用户手动应用：

**Linux/macOS:**
```bash
pkill -f "narrafork" && mv ~/.narrafork/updates/narrafork-new /path/to/narrafork && chmod +x /path/to/narrafork && /path/to/narrafork
```

**Windows:**
```powershell
Stop-Process -Name "narrafork" -Force; Move-Item -Force "$env:USERPROFILE\.narrafork\updates\narrafork-new.exe" "C:\path\to\narrafork.exe"; Start-Process "C:\path\to\narrafork.exe"
```

## 四、配置与设置

### 4.1 Settings 扩展

```typescript
// server/lib/settings/index.ts
interface NarraForkSettings {
  // ... 现有字段
  update?: {
    serverUrl: string;           // 更新服务器地址
    channel: "stable" | "beta";  // 更新渠道
    checkIntervalMinutes: number; // 检查间隔（0 禁用）
    autoDownload: boolean;       // 自动下载
  };
}
```

默认值：
```typescript
update: {
  serverUrl: "",
  channel: "stable",
  checkIntervalMinutes: 60,
  autoDownload: false,
}
```

### 4.2 API 路由

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/update/check` | 检查更新 |
| `GET` | `/api/update/version` | 获取当前版本 |
| `POST` | `/api/update/download` | 下载更新（SSE 流式进度） |
| `POST` | `/api/update/cleanup` | 清理旧更新文件 |
| `GET` | `/api/update/directory` | 获取更新目录 |

## 五、前端 UI

### 5.1 更新提示横幅

- 固定在页面顶部
- 显示新版本号和节省百分比
- 提供下载按钮
- 可关闭

### 5.2 下载进度弹窗

- 显示下载阶段（检查/下载/验证/完成/错误）
- 进度条和百分比
- 下载完成后显示应用命令

## 六、文件清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `server/lib/blockmap.ts` | Blockmap 生成和解析 |
| `server/services/update-service.ts` | 更新服务 |
| `server/routes/update.ts` | 更新 API |
| `frontend/hooks/useUpdateCheck.ts` | 更新检查 hook |
| `frontend/components/UpdateAvailableBanner.tsx` | 更新提示组件 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `scripts/build-cross-platform.ts` | 添加 blockmap 生成 |
| `server/lib/settings/index.ts` | 添加 update 配置 |
| `server/app.ts` | 注册更新路由 |
| `frontend/lib/api.ts` | 添加更新 API 方法 |
| `frontend/locales/*/common.json` | 添加翻译 |

## 七、安全考虑

1. **SHA512 校验** - 下载完成后验证完整文件哈希
2. **HTTPS** - 更新服务器必须使用 HTTPS
3. **版本比较** - 只允许升级，不允许降级

## 八、使用方式

1. 配置更新服务器地址：
   ```json
   // ~/.narrafork/settings.json
   {
     "update": {
       "serverUrl": "https://update.example.com",
       "channel": "stable"
     }
   }
   ```

2. 构建并上传到更新服务器：
   ```bash
   bun run build:linux-x64
   # 上传 dist/narrafork-*-linux-x64 和 dist/narrafork-*-linux-x64.blockmap 到服务器
   ```

3. 客户端自动检查更新，用户点击下载后按提示应用
