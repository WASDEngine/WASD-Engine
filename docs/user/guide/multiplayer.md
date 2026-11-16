# Online multiplayer

English | [中文](multiplayer.zh.md)

A game made with WASD Engine can go online in two ways: player-hosted, where one player's game hosts the others for free, or on a dedicated server that WASD Engine runs for a monthly price. Ask the agent, for example "make this game multiplayer for up to 8 friends", and it explains both modes and their costs before it changes anything. A game can switch modes later without rewriting its multiplayer code.

## Choose a mode

| | Player-hosted | Dedicated server |
|---|---|---|
| Cost | Free | A monthly price per server, by size |
| Where the game runs | In one player's browser tab | On a WASD Engine server in Oregon, which sleeps while nobody plays and wakes when someone joins |
| Players | 2 to 8 play well, 16 at most | From about 10 to about 100 at once, by size |
| When everyone leaves | The session ends | The world is saved and waits for the next player; with Always on, it keeps going |
| Cheating | The host can cheat | The server decides what happens |
| Players' IP addresses | Visible to the other players unless the connection is relayed | Hidden from the other players |

In both modes, every player signs in with a WASD Engine account before joining.

## Player-hosted games

One player hosts a lobby, and friends join it with a 6-letter code or pick it from the list of public lobbies. WASD Engine introduces the players to each other and relays the connection for players whose networks block a direct one, at no cost. The relay carries a fair-use amount of traffic per game each month; past it, the relay is off for that game until the next month, so players whose networks block a direct connection can't join until then, and the agent can tell you where your game stands. The host must keep the game's browser tab open and in front, because browsers pause hidden tabs, which pauses the game for everyone. When the host leaves, the session ends. A host can remove a player for good; a player the host's game could not connect to in time can simply join again.

## Dedicated servers

WASD Engine runs your game's server build, and players can join at any time. Each server size has a monthly price and fixed amounts of CPU, memory, monthly bandwidth, and storage; the WASD Engine website and the agent show the current sizes and prices. Any account with a valid payment method can buy a server, on any plan, and nothing is charged until you confirm the purchase on the website. If WASD Engine gave your account free servers, the agent and the website show servers of those sizes as free, and confirming one needs no card.

- **Bandwidth.** You get an email when a server has used 70%, 90%, and 100% of its monthly bandwidth. At 100% the server stops for the rest of its billing month and starts again when the allowance resets; nothing extra is ever charged.
- **Sleeping.** A server with no players for 15 minutes saves its world and sleeps, and it wakes in a few seconds when a player joins; the game can tell that player the server is starting. Sleeping keeps prices low. If your world has to keep going while nobody plays, turn on **Always on** for the server on the website's Game servers page; Medium and larger servers offer it.
- **Backups.** A server is backed up every hour while players are on, when it goes to sleep, and before each update, and backups are kept for 7 days.
- **Updates.** Releasing a new version of the game updates its servers, and players get a one-minute warning first. Players on an older version of the game cannot join a server that runs a newer one.
- **Stopping and deleting.** A stopped server still counts toward the bill. Deleting a server ends its billing, and its data is deleted 7 days later.

## Players sign in

Players sign in with a WASD Engine account before they can join. On the game's page on the WASD Engine website, the page signs them in; when the game is opened from its own link, a sign-in window opens. A game started from WASD Engine's game library uses the app's sign-in and stays signed in while it runs, for up to a week; signing out of WASD Engine ends it within the hour. A game sees each player's username and a player id that stays the same across devices, never an email address or account.
