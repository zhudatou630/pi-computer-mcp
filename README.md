# pi-computer-mcp

让 root 下的 pi（pi-web 里的开发 agent）操作 pi-desktop 这台 VNC 电脑的 MCP server（stdio）。

工具：

- `look`：看界面树（网页 / 桌面应用 / `screen` 截图 + 窗口列表）
- `act`：执行一个动作，返回界面变化
- `windows`：列出窗口
- `launch`：以 pi-desktop 身份启动 GUI 应用

## 为什么以 pi-desktop 身份运行

AT-SPI 走桌面用户的 D-Bus 会话总线，而这条总线只接受属主本人连接，root 也连不上。所以由 pi 通过 `sudo -u pi-desktop pi-desktop-session-exec` 启动本 server，server 继承桌面会话的 `DISPLAY` 和 D-Bus 地址。代码放在 `/opt`，是因为 pi-desktop 读不了 `/root`。

## 配置

`~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "computer": {
      "command": "sudo",
      "args": ["-n", "-u", "pi-desktop", "/usr/local/bin/pi-desktop-session-exec", "/usr/local/bin/node", "/opt/pi-computer-mcp/src/server.ts"],
      "description": "Operate the pi-desktop VNC computer: desktop apps via AT-SPI trees, the shared Chromium (own tab) via CDP, screenshots; start GUI apps with launch",
      "exposure": "codemode",
      "toolExposure": { "look": "direct" }
    }
  }
}
```

验证连接：`pi mcp list`。改了代码后，在会话里执行 `/mcp reconnect computer` 生效。

## 代码来源

`src/computer/{atspi,cdp,tree}.ts` 和 `test/tree.test.ts` 复制自 pi-bot（`/root/pi-bot`，提交 `028cac1`）。本仓库的改动：atspi 找不到应用时，错误提示改为指向 `launch` 工具。pi-bot 那边修了 bug 要手动同步过来。

## 已知局限

- 每个 pi 会话起一个 server 进程，各自开一个浏览器标签页，进程退出时关掉；只有崩溃时才会留下孤儿标签页。
- 输入锁只在单个进程内有效：不要让 pi-bot 的 Bot 或多个会话同时操作桌面。
- 只在 AT-SPI 装好之后启动的应用才看得到界面树（面板、桌面等早于它启动的进程看不到）；Electron 和 Chrome 的网页内容不在 AT-SPI 里。
- 动作只有 click / set / key / type / close，没有滚动、拖拽、右键和双击。
- Thunar 的图标视图里看不到文件项，要先用 `ctrl+2` 切到详细列表视图。

## 测试

`npm test`（协议与树格式的单元测试）。桌面和浏览器相关的部分只能在真实桌面上手动验证。
