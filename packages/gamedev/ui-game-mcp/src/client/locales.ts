/** Copy of the setup for another agent, in the Desktop introduction and in Settings, owned by the locale dictionaries. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace of the setup panel. */
export const NS = 'gameMcp'

/** English copy; its keys define {@link GameMcpUiKey}. */
export const en = {
  'nav': 'Other agents',
  'title': 'Set up with another agent',
  'description': 'Bring your own AI: paste this prompt into Claude Code, Codex, or another agent on this computer. It connects the agent to the Godot, Blender, GIMP, and SuperCollider tools of WASD Engine, and the games it runs play here.',
  'logos.label': 'AI agents that connect to WASD Engine',
  'prompt.label': 'Setup prompt',
  'copy': 'Copy prompt',
  'copied': 'Copied',
  'copyFailed': 'Prompt selected; copy it with the keyboard',
  'continue': 'Continue',
  'status.starting': 'Starting the MCP server…',
  'status.waiting': 'Waiting for an agent to connect…',
  'status.connected': '{name} is connected.',
  'status.failed': 'The MCP server is not running. {message}',
  'status.disconnected': 'Reconnecting to WASD Engine…',
} satisfies Record<string, string>

/** Keys of the setup panel copy. */
export type GameMcpUiKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The setup for another agent, in the Desktop introduction and in Settings. */
    gameMcp: GameMcpUiKey
  }
}

/** Chinese copy. */
export const zh = {
  'nav': '其他智能体',
  'title': '使用其他智能体设置',
  'description': '使用你自己的 AI：将这段提示词粘贴到这台电脑上的 Claude Code、Codex 或其他智能体中。它会让该智能体连接 WASD Engine 的 Godot、Blender、GIMP 和 SuperCollider 工具，智能体运行的游戏会在这里播放。',
  'logos.label': '可以连接 WASD Engine 的 AI 智能体',
  'prompt.label': '设置提示词',
  'copy': '复制提示词',
  'copied': '已复制',
  'copyFailed': '已选中提示词；请用键盘复制',
  'continue': '继续',
  'status.starting': '正在启动 MCP 服务器…',
  'status.waiting': '正在等待智能体连接…',
  'status.connected': '{name} 已连接。',
  'status.failed': 'MCP 服务器未运行。{message}',
  'status.disconnected': '正在重新连接 WASD Engine…',
} satisfies Record<GameMcpUiKey, string>

/** Japanese copy. */
export const ja = {
  'nav': 'ほかのエージェント',
  'title': '別のエージェントでセットアップ',
  'description': 'お使いの AI をそのまま使えます。このプロンプトを、このコンピューター上の Claude Code、Codex、または別のエージェントに貼り付けてください。エージェントが WASD Engine の Godot、Blender、GIMP、SuperCollider ツールに接続し、実行したゲームはここでプレイされます。',
  'logos.label': 'WASD Engine に接続できる AI エージェント',
  'prompt.label': 'セットアッププロンプト',
  'copy': 'プロンプトをコピー',
  'copied': 'コピーしました',
  'copyFailed': 'プロンプトを選択しました。キーボードでコピーしてください',
  'continue': '続ける',
  'status.starting': 'MCP サーバーを起動しています…',
  'status.waiting': 'エージェントの接続を待っています…',
  'status.connected': '{name} が接続されています。',
  'status.failed': 'MCP サーバーが実行されていません。{message}',
  'status.disconnected': 'WASD Engine に再接続しています…',
} satisfies Record<GameMcpUiKey, string>

/** Spanish copy. */
export const es = {
  'nav': 'Otros agentes',
  'title': 'Configurar con otro agente',
  'description': 'Usa tu propia IA: pega este prompt en Claude Code, Codex u otro agente de este ordenador. Conecta el agente con las herramientas de Godot, Blender, GIMP y SuperCollider de WASD Engine, y los juegos que ejecute se juegan aquí.',
  'logos.label': 'Agentes de IA que se conectan a WASD Engine',
  'prompt.label': 'Prompt de configuración',
  'copy': 'Copiar prompt',
  'copied': 'Copiado',
  'copyFailed': 'Prompt seleccionado; cópialo con el teclado',
  'continue': 'Continuar',
  'status.starting': 'Iniciando el servidor MCP…',
  'status.waiting': 'Esperando a que se conecte un agente…',
  'status.connected': '{name} está conectado.',
  'status.failed': 'El servidor MCP no está en marcha. {message}',
  'status.disconnected': 'Reconectando con WASD Engine…',
} satisfies Record<GameMcpUiKey, string>

/** French copy. */
export const fr = {
  'nav': 'Autres agents',
  'title': 'Configurer avec un autre agent',
  'description': 'Utilisez votre propre IA : collez ce prompt dans Claude Code, Codex ou un autre agent de cet ordinateur. Il connecte l’agent aux outils Godot, Blender, GIMP et SuperCollider de WASD Engine, et les jeux qu’il lance se jouent ici.',
  'logos.label': 'Agents d’IA qui se connectent à WASD Engine',
  'prompt.label': 'Prompt de configuration',
  'copy': 'Copier le prompt',
  'copied': 'Copié',
  'copyFailed': 'Prompt sélectionné ; copiez-le au clavier',
  'continue': 'Continuer',
  'status.starting': 'Démarrage du serveur MCP…',
  'status.waiting': 'En attente de la connexion d’un agent…',
  'status.connected': '{name} est connecté.',
  'status.failed': 'Le serveur MCP ne fonctionne pas. {message}',
  'status.disconnected': 'Reconnexion à WASD Engine…',
} satisfies Record<GameMcpUiKey, string>

/** German copy. */
export const de = {
  'nav': 'Andere Agenten',
  'title': 'Mit einem anderen Agenten einrichten',
  'description': 'Nutze deine eigene KI: Füge diesen Prompt in Claude Code, Codex oder einen anderen Agenten auf diesem Computer ein. Er verbindet den Agenten mit den Godot-, Blender-, GIMP- und SuperCollider-Werkzeugen von WASD Engine, und die Spiele, die er startet, laufen hier.',
  'logos.label': 'KI-Agenten, die sich mit WASD Engine verbinden',
  'prompt.label': 'Einrichtungs-Prompt',
  'copy': 'Prompt kopieren',
  'copied': 'Kopiert',
  'copyFailed': 'Prompt markiert; kopiere ihn mit der Tastatur',
  'continue': 'Weiter',
  'status.starting': 'MCP-Server wird gestartet…',
  'status.waiting': 'Warte auf die Verbindung eines Agenten…',
  'status.connected': '{name} ist verbunden.',
  'status.failed': 'Der MCP-Server läuft nicht. {message}',
  'status.disconnected': 'Verbindung zu WASD Engine wird wiederhergestellt…',
} satisfies Record<GameMcpUiKey, string>

/** Russian copy. */
export const ru = {
  'nav': 'Другие агенты',
  'title': 'Настроить с другим агентом',
  'description': 'Используйте свой ИИ: вставьте этот промпт в Claude Code, Codex или другого агента на этом компьютере. Он подключит агента к инструментам Godot, Blender, GIMP и SuperCollider в WASD Engine, а запущенные им игры будут идти здесь.',
  'logos.label': 'ИИ-агенты, которые подключаются к WASD Engine',
  'prompt.label': 'Промпт настройки',
  'copy': 'Скопировать промпт',
  'copied': 'Скопировано',
  'copyFailed': 'Промпт выделен; скопируйте его с клавиатуры',
  'continue': 'Продолжить',
  'status.starting': 'Запуск MCP-сервера…',
  'status.waiting': 'Ожидание подключения агента…',
  'status.connected': '{name} подключён.',
  'status.failed': 'MCP-сервер не работает. {message}',
  'status.disconnected': 'Повторное подключение к WASD Engine…',
} satisfies Record<GameMcpUiKey, string>

/** Portuguese copy. */
export const pt = {
  'nav': 'Outros agentes',
  'title': 'Configurar com outro agente',
  'description': 'Use sua própria IA: cole este prompt no Claude Code, no Codex ou em outro agente deste computador. Ele conecta o agente às ferramentas de Godot, Blender, GIMP e SuperCollider do WASD Engine, e os jogos que ele executar rodam aqui.',
  'logos.label': 'Agentes de IA que se conectam ao WASD Engine',
  'prompt.label': 'Prompt de configuração',
  'copy': 'Copiar prompt',
  'copied': 'Copiado',
  'copyFailed': 'Prompt selecionado; copie-o pelo teclado',
  'continue': 'Continuar',
  'status.starting': 'Iniciando o servidor MCP…',
  'status.waiting': 'Aguardando a conexão de um agente…',
  'status.connected': '{name} está conectado.',
  'status.failed': 'O servidor MCP não está em execução. {message}',
  'status.disconnected': 'Reconectando ao WASD Engine…',
} satisfies Record<GameMcpUiKey, string>
