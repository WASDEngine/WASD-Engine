# WASD Multiplayer

[English](README.md) | 中文

WASD Multiplayer 是把游戏接入 WASD Engine 联机功能的 Godot 4 插件：为玩家提供 WASD 登录、玩家主机大厅和 WASD 专用服务器。WASD Engine 的多人游戏设置会把此文件夹复制到游戏的 `res://addons/wasd_multiplayer/`，注册 `WasdMultiplayer` autoload（自动加载），并写入 `res://wasd_multiplayer.cfg`。插件只使用 GDScript，因此 Web 版本可以照常运行；其文件采用 CC0-1.0 许可，可以随任何游戏一起分发。

## 模式

- **玩家主机。** 一名玩家的游戏主持大厅，其他玩家通过 WebRTC 连接到它。WASD 负责牵线：大厅代码、公开大厅列表、连接提议的交换，以及为网络无法直连的玩家提供的中继。此模式免费；中继每款游戏每月有一个合理使用额度，超出后该游戏的中继停用到下个月。主机离开时本局结束；在浏览器中当主机的玩家必须让游戏标签页保持打开并位于前台；原生桌面版本需要 webrtc-native 扩展才能使用此模式。服务器版本永远不能主持大厅。
- **专用服务器。** WASD 运行游戏的服务器版本，玩家凭两分钟内有效的加入票据，通过安全 WebSocket 加入。由服务器决定游戏中发生的一切，所有人离开后世界依然保留，游戏所有者按每台服务器每月付费。

两种模式都会设置 `multiplayer.multiplayer_peer`，其余交给 Godot 自己的多人功能：`@rpc`、`MultiplayerSpawner` 和 `MultiplayerSynchronizer`，以 peer 1 为权威端。每名玩家都用 WASD Engine 账号登录。

## 使用

```gdscript
# Menu, player-hosted: call from a button press, because a browser opens the sign-in window only after a click.
var result: Dictionary = await WasdMultiplayer.host_lobby({"public": true, "max_players": 8})
if result.ok:
	show_code(result.code)  # Six characters, such as K7Q2XM.
result = await WasdMultiplayer.join_lobby("K7Q2XM")

# Menu, dedicated: the server build serves; every other build joins.
if WasdMultiplayer.is_server():
	await WasdMultiplayer.serve()
else:
	result = await WasdMultiplayer.join_server()

# World scene: spawn the players already present, then follow joins and leaves.
func _ready() -> void:
	for peer_id in WasdMultiplayer.players():
		spawn(peer_id)
	WasdMultiplayer.player_joined.connect(func(peer_id: int, _player: Dictionary) -> void: spawn(peer_id))
	WasdMultiplayer.player_left.connect(despawn)
```

请响应 `player_joined` 和 `player_left`，而不是 `multiplayer.peer_connected`：它们只报告经 WASD 登录的玩家，并附带每名玩家的 `{"id", "name"}`。在这款游戏中，同一名玩家的 `id` 跨会话、跨设备保持不变，服务器可以用它保存进度。

## API

协程的结果为 `{"ok": true, ...}`，或 `{"ok": false, "error": <code>, "message": <text>}`。

| 成员 | 作用 |
|---|---|
| `sign_in()` | 让玩家登录。在 WASD 游戏页面上由页面立即应答；在其他地方会打开 WASD 登录窗口；由 WASD Engine 启动的桌面版本则用启动时获得的令牌登录。登录随后在游戏运行期间一直有效，最长一周。 |
| `host_lobby(options)` | 主持大厅；`options` 接受 `name`、`public`、`max_players`（2 到 16）和 `data`。结果包含 `lobby` 和 `code`。 |
| `join_lobby(code)` | 按代码加入大厅，连接到主机后返回。 |
| `list_lobbies()` | 以 `lobbies` 列出本版本中仍有空位的公开大厅。 |
| `set_lobby(options)` | 修改所主持大厅的 `name`、`public`、`locked` 或 `data`。 |
| `kick(peer_id)` | 把玩家移出所主持的大厅（其账号此后无法再加入该大厅）或服务器。 |
| `join_server(server_id)` | 加入指定服务器；未指定时加入本版本中玩家最少、正在运行的服务器，没有时加入一台休眠中的服务器，连接会唤醒它：此时触发 `server_waking()`，加入会多花几秒。 |
| `list_servers()` | 以 `servers` 列出这款游戏的专用服务器；处于 `sleeping` 状态的服务器会在玩家加入时唤醒。 |
| `serve()` | 在专用服务器中监听 `WASD_PORT`，只接纳持有有效加入票据的玩家，每张票据只能用一次，同时最多接纳 `max_players` 名玩家；再次连接的玩家会取代其之前的连接。被拒绝的玩家，其加入以 `server_full` 或 `ticket_used` 结束。 |
| `leave()` | 离开大厅或服务器；主机离开时大厅对所有人关闭。 |
| `delay_stop()`, `stop_ready()` | 在专用服务器的 `server_stopping()` 处理函数中，让服务器继续运行，直到需要等待的保存完成，最长 15 秒。 |
| `is_server()`, `is_signed_in()`, `player()`, `role()`, `lobby()`, `players()`, `player_info(peer_id)` | 读取当前状态。 |
| `stats()` | 以字节和包计的流量、已连接的 peer 数，以及每帧耗时。 |

信号：`signed_in(player)`、`sign_in_failed(reason)`、`lobby_joined(lobby)`、`lobby_updated(lobby)`、`lobby_closed(reason)`、`player_joined(peer_id, player)`、`player_left(peer_id)`、`connected()`、`connection_failed(reason)`、`server_warning(seconds, reason, message)`、`server_waking()` 和 `server_stopping()`。专用服务器会在 WASD 停止它之前收到 `server_stopping()`，没有玩家而进入休眠时也会收到；请在该处理函数中保存世界。需要等待的保存（例如在线程中写入的保存）先调用 `delay_stop()`，完成后调用 `stop_ready()`；所有这样的保存都完成后，或 15 秒后，服务器退出。`server_waking()` 告诉正在加入的玩家的游戏服务器正在启动，以便游戏向玩家说明。`lobby_closed` 说明大厅结束的原因：`host_left`、`closed`、`replaced`、`kicked`（主机移出了这名玩家）、`dropped`（主机未能及时连上这名玩家；可以再次加入）、`left` 或 `signal_lost`。

主机在 30 秒内没有连上正在加入的玩家时，会放弃该玩家，该玩家可以再次加入；`kick()` 则让该玩家的账号永久无法加入这个大厅。当玩家的网络无法直连而该游戏的中继已停用时，超时的加入会在 `message` 中说明这一点。连接成功后，玩家与 WASD 大厅服务的连接断开再恢复期间仍留在游戏中：附加组件会自行重连，先在 2 秒后，之后间隔逐渐变长，主机在此期间保留该玩家。主机的连接连续四次重试失败（约 20 秒）时，会以 `signal_lost` 结束大厅，因为主机离开 30 秒后 WASD 会关闭大厅。

## 配置

`res://wasd_multiplayer.cfg` 的 `[wasd]` 段会覆盖项目设置中 `wasd_multiplayer/config/` 下的同名键：

| 键 | 默认值 | 含义 |
|---|---|---|
| `mode` | `"player_hosted"` | `"player_hosted"` 或 `"dedicated"`。 |
| `max_players` | `8` | `host_lobby()` 默认提供的大厅人数，2 到 16；在 `dedicated` 模式下，是服务器同时接纳的玩家数，2 到 500。 |
| `api_origin`, `app_origin` | `"https://app.wasdengine.com"` | WASD 联机 API，以及让玩家登录的网站。Web 版本只接受来自源为 `app_origin` 的框架页面或登录窗口的登录消息。 |
| `game_id` | `""` | 已发布游戏的 id，由发布流程写入。 |
| `version` | `0` | 发布版本；WASD 上的 Web 版本改从自身地址读取。 |
| `count_traffic` | `true` | 为 `stats()` 统计多人流量。 |
| `server_fps`, `server_idle_fps` | `0`, `10` | 专用服务器在有玩家连接时的帧率（`0` 表示使用物理帧率）和无人连接时的帧率。 |

WASD 工具和 WASD 服务器会设置环境变量，它们优先于该文件：桌面端为 `WASD_PLAY_TOKEN`（在 macOS 上为 `WASD_PLAY_TOKEN_FILE`，即存放令牌的文件，插件读取后会将其删除）、`WASD_API_ORIGIN`、`WASD_GAME_ID` 和 `WASD_GAME_VERSION`，服务器上为 `WASD_SERVER`、`WASD_SERVER_ID`、`WASD_PORT`、`WASD_TICKET_KEY`、`WASD_STATUS_FILE` 和 `WASD_CONTROL_FILE`。没有 WASD 游戏页面可以询问时，插件会在玩家令牌过期前半小时通过 WASD 联机 API 续期，自首次登录起最长一周。服务器监听所有网络接口，设置了 `WASD_BIND_ADDRESS` 时则只监听该地址；测试运行只监听 `127.0.0.1`。

## 测试运行

当 `WASD_MULTIPLAYER_TEST` 设为 `host`、`client` 或 `server` 时，插件通过 `WASD_TEST_PORT` 上的回环 WebSocket 运行，不使用 WASD 服务，会自行启动，并以 `WASD_TEST_NAME` 作为玩家名。设置了 `WASD_TICKET_KEY` 时，`server` 运行会校验票据；当模式为 `dedicated` 或 `WASD_TEST_TICKET` 含有票据时，`client` 运行会加入服务器（`WASD_TEST_URL` 可覆盖地址）。运行期间会输出 `WASD_TEST_EVENT` 行（`ready`、`connected`、`player_joined`、`player_left`、`warning`、`rejected`、`stopping`、`failed`），并在 `WASD_TEST_SECONDS`（默认 20）后输出一行 `WASD_TEST_STATS`，然后退出。每行都是前缀加一个 JSON 对象。

## 已知限制

- 原生桌面版本中的玩家主机模式需要 webrtc-native 扩展；桌面测试运行改用回环 WebSocket。
- 流量统计只包含多人数据载荷，不含 WebSocket、TLS、DTLS 或 IP 开销。
- 主机离开时，其大厅无法转交给其他玩家。
- 页面源不是 `app_origin` 的 Web 版本（例如在网站另一个主机名下打开的 WASD 游戏页面）会改用 WASD 登录窗口登录，而不经由页面。
- 桌面版本的登录在 WASD Engine 启动游戏一周后、该 WASD Engine 登录结束时，或电脑休眠超过令牌有效期时失效；请从 WASD Engine 重新启动游戏以联机游玩。
