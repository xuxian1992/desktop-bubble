# 桌面气泡助手

常驻 Windows 桌面的**可缩放气泡窗口**，复用本机已装的 dsh / Hermes 作为可切换内核。

> 设计文档：`方案-v1.0.md` · 评审记录：`设计评审-v0.1.md` · 灵魂：`soul/SOUL.md`

---

## 当前进度

| 阶段 | 状态 |
|---|---|
| M0 协议探针 | ✅ 通过（见方案 §13） |
| **M1 骨架 + 气泡窗口** | ✅ **完成** |
| **M2 dsh 托管 + 聊天** | ✅ **完成** |
| **M3 灵魂注入 + MCP** | ✅ **完成** |
| **M4 热键 + 截图** | ✅ **完成** |
| **M5 安装包 + 卸载 + 首次运行向导** | ✅ **完成** |
| **M6 屏幕感知**（三档 / L0-L1 / 本地日记） | ✅ **完成** |
| M7 Hermes 适配器 | ⏳ |
| M8 透明圆角 + 打磨 + 代码签名 | ⏳ |

### M1 已实现

- 无边框 / 置顶 / 不占任务栏的常驻窗口
- **三形态**：胶囊 96×96 · 气泡 380×560 · 面板 720×640
- **8 向自绘缩放手柄**（主进程算 bounds，渲染进程只报屏幕坐标）
- 位置 / 尺寸 / 形态**持久化**，首次运行落位主屏右下角
- 托盘图标 + 菜单（显示隐藏 / 切形态 / 打开配置目录 / 退出）
- 全局热键 `Ctrl+Alt+Space` 唤起/隐藏
- 单实例锁：重复启动会把已有气泡叫出来

窗口拖窄到 220px 以下会**自动切成胶囊视图**（不只是点按钮）。

---

## 开发

```bash
npm install
npm run dev        # 开发模式（HMR）
npm run typecheck  # 类型检查
npm run build      # 构建到 out/
npm start          # 跑构建产物
npm run dist       # 打 NSIS 安装包 → release/桌面气泡助手-<版本>-安装包.exe
```

### ⚠️ 两个环境坑

**0. 两个下载源都在 GitHub，都必须走镜像（否则会 `read ECONNRESET`）：**

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
# 打包时 electron-builder 还会再下一次 electron，这个也要设
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
```

**1. Electron 二进制默认从 GitHub 下载，很慢。走国内镜像：**

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

**2. npm 11 默认拦截依赖的 install 脚本**，会导致 electron 二进制不下载、esbuild 装不全。装完依赖后补一句：

```bash
npm approve-scripts electron esbuild
```

---

## 目录

```
src/
  main/            主进程：窗口、缩放、配置、托盘、IPC
    index.ts       生命周期 / 单实例锁 / 托盘 / 热键 / IPC 注册
    window.ts      气泡窗口、三形态、8 向缩放、bounds 持久化
    config.ts      原子落盘的配置读写
  preload/         contextBridge 类型化桥
  renderer/        React UI（气泡 / 胶囊 / 缩放手柄）
  shared/          主进程与渲染进程共用的类型与常量

soul/SOUL.md      灵魂：定义「身体」，不定义人格（见方案 §7）
probe/            M0 协议探针脚本（可复跑）
proto/            原型图与可重渲的 HTML
scripts/          CDP 验证脚本
resources/        图标
```

## 配置位置

```
%APPDATA%/desktop-bubble/config.json   窗口位置/尺寸/形态
```

## 快捷键

| 键 | 作用 |
|---|---|
| `Ctrl+Alt+Space` | 显示 / 隐藏气泡 |
| 点托盘图标 | 同上 |

---

## 调试

带远程调试端口启动后，可用 `scripts/cdp-check.cjs` 驱动渲染进程验证：

```bash
npx electron . --remote-debugging-port=9222
node scripts/cdp-check.cjs      # 跑一遍形态切换 + 缩放
node scripts/cdp-one.cjs panel  # 切到指定形态
```
