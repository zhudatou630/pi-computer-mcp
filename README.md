# pi-computer-mcp

一个 stdio MCP server，让 pi agent 用 codemode 脚本操作 Linux 桌面（X11 + AT-SPI）和一个开着远程调试端口的 Chromium（CDP）。Node 直接运行 `.ts`，唯一依赖是 `dbus-next`。

## 工具

| 层 | 工具 |
|---|---|
| 窗口 | `windows` `window` `launch` |
| 界面元素（AT-SPI） | `observe` `inspect` `invoke` `set_text` |
| 像素与键鼠 | `screenshot` `click` `move` `drag` `scroll` `key` `hold` `type` |
| 浏览器页面 | `tabs` `page_observe` `page_act` `page_eval` `page_screenshot` |
| 等待 | `wait` |

结果约定（`structuredContent`、`outcome` 为 delivered / refused / unknown、错误码）写在 server 的 instructions 和各工具描述里，codemode 里用 `describeNamespace` 查看。

## 运行

server 必须以桌面用户的身份、在其会话里运行：AT-SPI 的 D-Bus 总线只接受属主连接，root 也连不上。例如 pi 的 `mcp.json`：

```json
{
  "mcpServers": {
    "computer": {
      "command": "sudo",
      "args": ["-n", "-u", "<desktop-user>", "<session-exec>", "node", "/path/to/pi-computer-mcp/src/server.ts"],
      "exposure": "codemode"
    }
  }
}
```

`<session-exec>` 指一个能带上桌面会话 `DISPLAY` 和 D-Bus 地址的启动包装。CDP 地址默认 `http://127.0.0.1:9222`，可用 `PI_COMPUTER_CDP_URL` 改。

系统依赖：`xdotool`、`scrot`、`xprop`、`xwininfo`、`wmctrl`。

## 局限

- 没有界面树的程序（Electron、早于 AT-SPI 启动的程序）只能截图加坐标。
- 输入锁只在一个 server 进程内有效，不要让多个进程或人同时操作桌面。
- `type` 只收 ASCII，其他文字用 `set_text` 或 `page_act fill`。

## 开发

`npm install`，`npm run check`（类型检查 + 单元测试）。桌面和浏览器部分只能在真实桌面上手动验证。
