# AGENTS.md

给在这个仓库里写代码的 agent 和人看的工作约定。用法和设计决定见 [`README.md`](README.md)。

## 两个目录

| 目录 | 用途 | 规则 |
|---|---|---|
| `/opt/pi-computer-mcp-dev` | 开发（pi-web 的 cwd 设在这里） | 随便改、跑测试、另起 server 实测 |
| `/opt/pi-computer-mcp` | 运行（`~/.pi/agent/mcp.json` 指向这里） | 不要直接改，只用 `git pull --ff-only` 更新 |

每个 pi 会话启动时、`/mcp reconnect computer` 时都会从运行目录重新加载代码。在运行目录里改到一半，新会话的 computer 工具就会坏掉，所以开发只在开发目录做。两个目录都放在 `/opt`，因为 server 以 pi-desktop 身份运行，读不了 `/root`。

## 命令

```bash
npm install                          # 开发目录；运行目录只在依赖变了时 npm ci --omit=dev
npm run check                        # tsc 类型检查 + 全部测试；提交前必须通过
node --test test/logic.test.ts       # 单个测试文件
```

## 部署

```bash
# 开发目录：npm run check 通过后
git push
# 运行目录
cd /opt/pi-computer-mcp && git pull --ff-only
```

然后在会话里执行 `/mcp reconnect computer`（server 不发 list_changed，不重连就还是旧代码和旧工具清单）。回退：在运行目录 `git checkout <提交>`，再重连。

## 实测（真实桌面）

桌面和浏览器部分不在单元测试里，改了 `src/x11.ts`、`src/atspi.ts`、`src/cdp.ts`、`src/capture.ts` 或 `src/tools/` 要在显示器 :6 上实测，并在提交说明里写明测了什么、没测什么。

不要用会话里接入的那个 server 测开发中的代码：另起一个开发目录的 server，通过 stdio 直接调用：

```js
// /tmp/try.mjs，用 node /tmp/try.mjs 运行
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const p = spawn("sudo", ["-n", "-u", "pi-desktop", "/usr/local/bin/pi-desktop-session-exec", "/usr/local/bin/node", "/opt/pi-computer-mcp-dev/src/server.ts"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map(); let id = 0;
createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
const req = (method, params) => new Promise((r) => { pending.set(++id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "try", version: "1" } });
const call = async (name, args = {}) => (await req("tools/call", { name, arguments: args })).result;
console.log((await call("windows")).content[0].text);
p.stdin.end(); // 关闭 stdin 即退出：会关掉这个 server 自己开的标签页
```

实测时必须遵守（桌面和 Chromium 是共享的，可能有人正在 VNC 里看）：

- 只用 `launch` 启动程序，只操作自己启动的窗口和自己 `tabs open` 的标签页，用完关掉（`window op=close`、`tabs op=close`）。
- 不 attach、不碰 Chromium 里别人的标签页；不改 Chrome 启动参数。
- 不改屏幕分辨率（会影响正在看 VNC 的人）。屏幕尺寸会被 VNC 客户端改变，不要假定是 1920x1080。
- 不 kill 不是自己启动的进程（XFCE 面板、Thunar 守护进程、Grok Bot、别的会话的 MCP server 等）。
- 本地测试页用 `python3 -m http.server <端口> --bind 127.0.0.1`，测完停掉；测试文件放 `/tmp`，测完删掉，并确认 pi-desktop 读得到（`chmod a+rX`）。

## 代码约定

- Node 直接运行 `.ts`，没有构建：只用可擦除的 TS 语法（`erasableSyntaxOnly`），不要用参数属性、`enum`、`namespace`；import 写 `.ts` 后缀。
- ESM、tab 缩进；代码和注释用英文，文档（本文件、README）用中文。注释只写代码看不出来的"为什么"。
- 唯一的运行时依赖是 `dbus-next`。新增依赖要锁精确版本（`--save-exact`），只用纯 JS 包。
- 工具结果的契约（`structuredContent`、`outcome` delivered/refused/unknown、错误码）写在 `src/server.ts` 的 instructions 和 README 里，改行为时三处一起改。
- `refused` 只用于确定没发出的动作；读取失败、应用忙不能当作"已消失"。
- 新的非平凡逻辑要带测试（纯函数优先，CDP 可用假连接），测试里不碰真实桌面和浏览器。

## 提交

- 个人项目，直接提交到 `main` 并推送（remote 用 deploy key 别名 `git@github-pi-computer-mcp:zhudatou630/pi-computer-mcp.git`）。
- 一个提交做一件事；提交说明写清问题、做法、怎么验证的（含实测范围和没测到的部分）。
- 用法或契约变了同步 README；版本号在 `package.json` 和 `src/server.ts` 两处。
