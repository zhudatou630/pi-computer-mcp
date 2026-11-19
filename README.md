# pi-computer-mcp

让 root 下的 pi（pi-web 里的开发 agent）通过 codemode 操作 pi-desktop 这台 VNC 电脑的 MCP server（stdio）。无构建步骤，Node 直接运行 `.ts`；唯一的 npm 依赖是 `dbus-next`。

## 工具

| 层 | 工具 | 说明 |
|---|---|---|
| 窗口（X11/EWMH） | `windows` `window` `launch` | 窗口用 X id（`0x…`），坐标一律是客户区（不含标题栏）；`window` 做 activate/close/minimize/maximize/restore/move/resize；`launch` 以 pi-desktop 身份启动程序，并返回启动前已有的窗口（`existingWindows`） |
| 界面元素（AT-SPI） | `observe` `inspect` `invoke` `set_text` | ref 形如 `a12.k3x9`；`set_text` 直接写值，任何语言都行，默认不移动焦点（`focus: true` 才聚焦） |
| 像素 / 键鼠（xdotool、scrot） | `screenshot` `click` `move` `drag` `scroll` `key` `hold` `type` | 目标可以是 ref、截图坐标（`captureId` + 图上 x,y）或屏幕坐标；`type` 只收 ASCII，`\n` 按回车发送 |
| 页面（CDP） | `tabs` `page_observe` `page_act` `page_eval` `page_screenshot` | 只操作自己开的或被明确要求接管（attach）的标签页 |
| 通用 | `wait` | 脚本里没有定时器，等待都在这里：time / window / element / page |

使用契约写在 server 的 instructions 里（`describeNamespace("mcp__computer")` 可见）。要点：

- 数据在 `structuredContent`；失败时 `isError: true`，`structuredContent` 里有 `outcome`、`code`、`message`。参数不符合 schema（多余或缺少字段）时，pi 客户端直接让调用 throw，不会走到 server。
- `outcome`：`delivered` 已发出（不代表已生效）；`refused` 动作确定没发出（窗口检查可能已经移动了指针）；`unknown` 可能已发出，不要盲目重试。能真正核实时才给 `verified`，核实不了就不给。
- 动作不自动回读、不等效果，例外：`window` 会确认操作结果（最多 2 秒，给 `verified`）；页面的 navigate/back/forward/reload 会等到对应文档加载完（`loaded`）；页面 scroll 等滚动停下。只改 hash 的页内跳转没有新文档，`loaded` 只表示文档已完成，不核对页面是否保留了那个 hash。下一步依赖结果时接 `wait` 或 `observe`。
- `wait gone` 只认“确认不存在”：只有 D-Bus 明确回复对象或服务不存在（`UnknownObject`、`ServiceUnknown`）才算元素消失；应用忙（`APP_BUSY`）、其他读取错误、导航途中读不到页面，都不算。按 `query` 匹配时，输入框的值只看前 500 个字符。
- 0.3.0 的不兼容变化：`wait` 等元素时用 `query`（子串）/ `name`（精确），不再接受 `text`（`text` 只用于页面）；`window move` 的 x,y 改为客户区坐标；页面 `fill` 必须给 `text`；自己开的标签页不能 detach，要 close。
- 过期的 ref 一律拒绝（`STALE_REF`），不会改绑到同名的新元素；ref 和 captureId 带进程代际，server 重启后旧 id 明确失效。
- 传 `window` 时：指针动作在目标点上是别的应用窗口时拒绝（菜单和弹出层不算）（`POINTER_ELSEWHERE`），键盘动作在它不是活动窗口时拒绝（`FOCUS_CHANGED`；窗口已不存在时是 `WINDOW_GONE`），都不抢焦点。`move` 不做这项检查。
- 按键名：桌面 `key` 和页面 `press` 都接受 xdotool 写法（`Return`、`ctrl+a`、`Down`），页面另外接受 `Enter`、`Control+a`。页面 `press` 先检查所有键，再发第一个。
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
- **窗口和 AT-SPI 对应**：先按进程号，再按标题和几何，最后用工具包给活动窗口标的 `active` 状态对照 X 的活动窗口；仍分不清（同进程、同标题、同位置、都不活动）时返回 `AMBIGUOUS`，不猜，激活或移动其中一个后再试。
- **AT-SPI 的角色名**：本机 at-spi2-core 2.56 把按钮报成 `button`，不是 `push button`。
- **树没读完不等于元素不存在**：遍历截断或读取失败（包括状态、子节点读失败）时 `coverage.complete=false`，`wait gone` 不会因此判定为已消失。
- **遍历预算**：`maxNodes` 是要读的元素数，用完时保留已读的部分；不再有每个容器 400 个子节点的隐藏上限。大列表（Thunar 打开 200+ 项的目录，tree table 有上千个单元格）要调大 `maxNodes` 才读得到可见行。
- **过滤会搜所有在屏幕上的元素**：不带过滤时只列有名字或可交互的元素；带 role/name/query 等过滤时，没名字的容器（如 `tree table`）也能找到。
- **`type` 的换行**：xdotool 把 `\n` 打成 Linefeed，GTK 不认，所以按行拆开、中间发 Return。
- **Chromium 后台标签页不渲染**：滚轮、悬停、截图会卡住。所以自己开的标签页放在独立的浏览器窗口里（不抢焦点），并开启焦点模拟（`Emulation.setFocusEmulationEnabled`），窗口被最小化时也能操作。接管来的后台标签页截图会超时重试一次。
- **页面点击前做命中检测**：元素中心被别的元素盖住时拒绝（`OCCLUDED`）。用页面里的 `elementFromPoint`（视口坐标，和输入事件一致）；`DOM.getNodeForLocation` 不考虑滚动，页面一滚动就会误判。命中检测沿渲染树走：进入开放的 shadow root，以及目标自己所在的封闭 shadow root（从目标能拿到它），slot 里的元素经 slot 往上找。
- **页面滚动的回执**：滚轮会沿滚动链传给外层，所以同时观察命中点沿渲染树（shadow root、slot）的所有可滚动祖先和 document（包括自己滚动的 body），报告实际动了的那个（`scroller`）；不给目标时直接滚 document。只给坐标时看不进封闭 shadow root，那里的滚动会报 `verified:false`。
- **自己开的标签页的归属**：单独记一份 target id，CDP 断线重连后仍能操作和关闭，server 退出时关掉。Chromium 主动结束 session（如标签页崩溃）时丢弃缓存的 session，下次使用时重新附着；并行调用共用同一次附着。
- **页面截图坐标**：`captureId` 只对同一文档、同一滚动位置和视口有效，导航后拒绝（`CAPTURE_STALE`）。
- **退出时先取消正在执行的输入**：拖拽、按住等手势被取消后会松开按键，再关浏览器标签页。
- **不改 Chrome 启动参数，不碰别人的标签页**：接管只按确切的 tab id，用完只断开不关闭。

## 已知局限

- 早于 AT-SPI 启动的程序（XFCE 面板、桌面）和 Electron 程序没有界面树，只能截图加坐标。
- 输入锁只在单个 server 进程内有效：不要让 pi-bot 的 Bot、多个 pi 会话或人同时操作桌面。
- 页面 `page_act click` 会激活并抬升标签页所在的浏览器窗口（真实点击也是这样）；open、fill、hover 不会。
- 单实例程序（mousepad、thunar）第二次 `launch` 可能交给已有进程：窗口 pid 不同，或者根本不出新窗口（mousepad 开成标签页）。
- `type` 只收 ASCII；中文用 `set_text` 或 `page_act fill/type`。没有剪贴板、OCR、截图标注、表格区域读取。
- `screenshot` 拍的是屏幕上可见的像素，窗口被遮住的部分拍到的是上面的窗口。
- 未在真实桌面上测过改分辨率（会影响正在看 VNC 的人），屏幕尺寸变化的拒绝逻辑只有单元测试。

## 测试

`npm test`：协议、窗口解析、坐标换算、窗口与 AT-SPI 对应、队列取消、按键解析、树过滤。桌面和浏览器相关部分只能在真实桌面上手动验证。
