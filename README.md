# pi-computer-mcp

让 root 下的 pi（pi-web 里的开发 agent）通过 codemode 操作 pi-desktop 这台 VNC 电脑的 MCP server（stdio）。无构建步骤，Node 直接运行 `.ts`；唯一的 npm 依赖是 `dbus-next`。

## 工具

| 层 | 工具 | 说明 |
|---|---|---|
| 窗口（X11/EWMH） | `windows` `window` `launch` | 窗口用 X id（`0x…`）；`window` 做 activate/close/minimize/maximize/restore/move/resize；`launch` 以 pi-desktop 身份启动程序 |
| 界面元素（AT-SPI） | `observe` `inspect` `invoke` `set_text` | ref 形如 `a12.k3x9`；`set_text` 直接写值，任何语言都行 |
| 像素 / 键鼠（xdotool、scrot） | `screenshot` `click` `move` `drag` `scroll` `key` `hold` `type` | 目标可以是 ref、截图坐标（`captureId` + 图上 x,y）或屏幕坐标；`type` 只收 ASCII |
| 页面（CDP） | `tabs` `page_observe` `page_act` `page_eval` `page_screenshot` | 只操作自己开的或被明确要求接管（attach）的标签页 |
| 通用 | `wait` | 脚本里没有定时器，等待都在这里：time / window / element / page |

使用契约写在 server 的 instructions 里（`describeNamespace("mcp__computer")` 可见）。要点：

- 数据在 `structuredContent`；失败时 `isError: true`，`structuredContent` 里有 `outcome`、`code`、`message`。
- `outcome`：`delivered` 已发出（不代表已生效）；`refused` 确定没发出；`unknown` 可能已发出，不要盲目重试。能便宜地核实时才给 `verified`。
- 动作不自动等待、不自动回读，下一步依赖结果时接 `wait` 或 `observe`。
- 过期的 ref 一律拒绝（`STALE_REF`），不会改绑到同名的新元素；ref 和 captureId 带进程代际，server 重启后旧 id 明确失效。
- 传 `window` 时：指针动作在目标点上是别的窗口时拒绝（`POINTER_ELSEWHERE`），键盘动作在它不是活动窗口时拒绝（`FOCUS_CHANGED`），都不抢焦点。
- 截图默认长边 1280，模型那边不会再缩放；分辨率或窗口几何变了，按旧截图坐标点击会被拒绝（`CAPTURE_STALE`）。
- 所有输入在进程内排队，一次一个；被取消时丢弃还在排队的动作。拖拽、按住等连续手势出错或被取消也会松开按键。

## 为什么以 pi-desktop 身份运行

AT-SPI 走桌面用户的 D-Bus 会话总线，这条总线只接受属主本人连接，root 也连不上。所以由 pi 通过 `sudo -u pi-desktop pi-desktop-session-exec` 启动本 server，继承桌面会话的 `DISPLAY` 和 D-Bus 地址。代码放在 `/opt`，因为 pi-desktop 读不了 `/root`。

## 配置

`~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "computer": {
      "command": "sudo",
      "args": ["-n", "-u", "pi-desktop", "/usr/local/bin/pi-desktop-session-exec", "/usr/local/bin/node", "/opt/pi-computer-mcp/src/server.ts"],
      "description": "Operate the pi-desktop VNC computer from codemode: X windows, AT-SPI elements, screenshots and mouse/keyboard, own Chromium tabs over CDP, waits",
      "exposure": "codemode"
    }
  }
}
```

系统依赖：`xdotool`、`scrot`、`xprop`、`xwininfo`、`wmctrl`（apt 装的，用来礼貌地关闭窗口和最大化/还原；本机的 xdotool 是 2016 版，没有 `windowquit`/`windowstate`）。

验证连接：`pi mcp list`。改了代码后，在会话里执行 `/mcp reconnect computer`；当前会话缓存的工具清单不会自动更新（server 不发 list_changed）。

## 设计决定与踩过的坑

- **不照搬 pi-bot 的 computer 扩展**：拆成按层的细粒度工具，结构化输出，动作不附带固定等待。AT-SPI 遍历和 CDP 连接代码最初来自 pi-bot（提交 `028cac1`），之后已独立演变。
- **窗口和 AT-SPI 对应**：先按进程号，再按标题和几何；分不清（同进程、同标题、同位置）时返回候选 ref，不猜。
- **AT-SPI 的角色名**：本机 at-spi2-core 2.56 把按钮报成 `button`，不是 `push button`。
- **树没读完不等于元素不存在**：遍历截断或读取失败时 `coverage.complete=false`，`wait gone` 不会因此判定为已消失。
- **Chromium 后台标签页不渲染**：滚轮、悬停、截图会卡住。所以自己开的标签页放在独立的浏览器窗口里（不抢焦点），并开启焦点模拟（`Emulation.setFocusEmulationEnabled`），窗口被最小化时也能操作。接管来的后台标签页截图会超时重试一次。
- **页面点击前做命中检测**：元素中心被别的元素盖住时拒绝（`OCCLUDED`）；命中检测会跨出 shadow DOM。
- **不改 Chrome 启动参数，不碰别人的标签页**：接管只按确切的 tab id，用完只断开不关闭。

## 已知局限

- 早于 AT-SPI 启动的程序（XFCE 面板、桌面）和 Electron 程序没有界面树，只能截图加坐标。
- 输入锁只在单个 server 进程内有效：不要让 pi-bot 的 Bot、多个 pi 会话或人同时操作桌面。
- `type` 只收 ASCII；中文用 `set_text` 或 `page_act fill/type`。没有剪贴板、OCR、截图标注、表格区域读取。
- `screenshot` 拍的是屏幕上可见的像素，窗口被遮住的部分拍到的是上面的窗口。
- 未在真实桌面上测过改分辨率（会影响正在看 VNC 的人），屏幕尺寸变化的拒绝逻辑只有单元测试。

## 测试

`npm test`：协议、窗口解析、坐标换算、窗口与 AT-SPI 对应、队列取消、按键解析、树过滤。桌面和浏览器相关部分只能在真实桌面上手动验证。
