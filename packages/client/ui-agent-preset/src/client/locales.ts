/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideJa, guideEs, guideFr, guideDe, guideRu, guidePt, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'view'
  | 'presetGamedevName'
  | 'presetGamedevDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'close'
  | 'creatorDraft'
  | 'createPlugin'
  | 'createPluginDescription'
  | 'createPluginChecking'
  | 'createPluginUnavailable'
  | 'createPluginMissing'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro:
    'Choose the agent’s tools and how it works. Use Game developer to build your games, or Customize mode to add capabilities to WASD Engine.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',
  view: 'View configuration',

  presetGamedevName: 'Game developer',
  presetGamedevDescription: 'Designs, builds, runs, and debugs games with bundled Godot and game-design skills.',
  presetCordisName: 'Customize mode',
  presetCordisDescription:
    'Customize WASD Engine through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',
  createPlugin: 'Let the agent create a plugin',
  createPluginDescription: 'Enter Customize mode and make your own WASD Engine plugin',
  createPluginChecking: 'Checking whether Customize mode is available',
  createPluginUnavailable: 'Temporarily unavailable. Reopen this menu to retry',
  createPluginMissing: 'Customize mode is not included in this configuration',

}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 Agent 的工具和工作方式。制作游戏用「游戏开发者」，扩展 WASD Engine 的能力用「自定义模式」。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',
  view: '查看配置',

  presetGamedevName: '游戏开发者',
  presetGamedevDescription: '借助内置的 Godot 和游戏设计技能，设计、构建、运行和调试游戏。',
  presetCordisName: '自定义模式',
  presetCordisDescription: '用对话定制 WASD Engine：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',
  createPlugin: '让 Agent 创建插件',
  createPluginDescription: '进入自定义模式，制作属于你的 WASD Engine 插件',
  createPluginChecking: '正在确认自定义模式是否可用',
  createPluginUnavailable: '暂时不可用，请重新打开菜单重试',
  createPluginMissing: '当前配置未提供自定义模式',

}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...guideJa,
  'builtInGroup': '組み込み',
  'customGroup': 'カスタム',
  'sectionIntro': 'エージェントのツールと動作を選択します。ゲーム制作にはゲーム開発者を、WASD Engine に機能を追加するにはカスタマイズモードを使用してください。',
  'seatHint': '新しいタスクで使用するエージェントプリセットを選択',
  'headerHint': 'このタスクの開始時に選択されたエージェントプリセット',
  'nav': 'エージェントプリセット',
  'setDefault': '新しいタスクの既定に設定',
  'view': '設定を表示',
  'presetGamedevName': 'ゲーム開発者',
  'presetGamedevDescription': '同梱の Godot とゲームデザインのスキルで、ゲームを設計、構築、実行、デバッグします。',
  'presetCordisName': 'カスタマイズモード',
  'presetCordisDescription': '会話を通じて WASD Engine をカスタマイズします。機能や UI を追加するプラグインをエージェントに書かせたり、ツールとプロンプトを組み合わせて独自のモードを作成したりできます。',
  'inUse': '新しいタスクの既定',
  'noDescription': '説明はありません。',
  'brokenBadge': '読み込みに失敗',
  'switchRefused': '{name} に切り替えられませんでした: {reason}',
  'close': '閉じる',
  'creatorDraft': 'エージェントにプリセット作成を手伝ってもらう',
  'createPlugin': 'エージェントにプラグインを作成してもらう',
  'createPluginDescription': 'カスタマイズモードに入り、独自の WASD Engine プラグインを作成',
  'createPluginChecking': 'カスタマイズモードが利用可能か確認中',
  'createPluginUnavailable': '一時的に利用できません。このメニューを開き直して再試行してください',
  'createPluginMissing': 'この構成にはカスタマイズモードが含まれていません',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  ...guideEs,
  builtInGroup: 'Incorporado', customGroup: 'personalizado',
  sectionIntro:
    'Elija las herramientas del agente y cómo funciona. Utilice Desarrollador de juegos para crear sus juegos o el modo de personalización para agregar capacidades a WASD Engine.',

  seatHint: 'Elija el agente preestablecido para su nueva tarea',
  headerHint: 'El agente preestablecido elegido cuando comenzó esta tarea',
  nav: 'Ajustes preestablecidos del agente',

  setDefault: 'Establecer como nueva tarea predeterminada',
  view: 'Ver configuración',

  presetGamedevName: 'Desarrollador de juegos',
  presetGamedevDescription: 'Diseña, construye, ejecuta y depura juegos con las habilidades incluidas de Godot y diseño de juegos.',
  presetCordisName: 'Modo de personalización',
  presetCordisDescription:
    'Personaliza WASD Engine a través de la conversación. Deje que el agente escriba complementos que agreguen funciones o interfaz de usuario, o combine herramientas e indicaciones para crear su propio modo.',

  inUse: 'Nueva tarea predeterminada',

  noDescription: 'Sin descripción.',
  brokenBadge: 'No se pudo cargar',

  switchRefused: 'No se pudo cambiar a {name}: {reason}',

  close: 'Cerrar',

  creatorDraft: 'Deja que el agente me ayude a crear un preset',
  createPlugin: 'Deje que el agente cree un complemento',
  createPluginDescription: 'Ingrese al modo de personalización y cree su propio complemento de WASD Engine',
  createPluginChecking: 'Comprobando si el modo de personalización está disponible',
  createPluginUnavailable: 'Temporalmente no disponible. Vuelve a abrir este menú para volver a intentarlo.',
  createPluginMissing: 'El modo de personalización no está incluido en esta configuración.',

} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  ...guideFr,
  builtInGroup: 'Intégré', customGroup: 'Personnalisé',
  sectionIntro:
    'Choisissez les outils de l’agent et son fonctionnement. Utilisez Développeur de jeux pour créer vos jeux ou le mode Personnalisation pour ajouter des fonctionnalités à WASD Engine.',

  seatHint: "Choisissez le préréglage d'agent pour votre nouvelle tâche",
  headerHint: "Le préréglage d'agent choisi au démarrage de cette tâche",
  nav: "Préréglages d'agent",

  setDefault: 'Définir comme nouvelle tâche par défaut',
  view: 'Afficher la configuration',

  presetGamedevName: 'Développeur de jeux',
  presetGamedevDescription:
    'Conçoit, crée, exécute et débogue des jeux avec les compétences intégrées pour Godot et la conception de jeux.',
  presetCordisName: 'Mode Personnalisation',
  presetCordisDescription:
    "Personnalisez WASD Engine via la conversation. Laissez l'agent écrire des plugins qui ajoutent des fonctionnalités ou une interface utilisateur, ou combinez des outils et des invites pour créer votre propre mode.",

  inUse: 'Nouvelle tâche par défaut',

  noDescription: 'Aucune description.',
  brokenBadge: 'Échec du chargement',

  switchRefused: 'Impossible de passer à {name} : {reason}',

  close: 'Fermer',

  creatorDraft: "Laissez l'agent m'aider à créer un préréglage",
  createPlugin: "Laissez l'agent créer un plugin",
  createPluginDescription: 'Entrez en mode Personnalisation et créez votre propre plugin WASD Engine',
  createPluginChecking: 'Vérifier si le mode Personnalisation est disponible',
  createPluginUnavailable: 'Temporairement indisponible. Rouvrez ce menu pour réessayer',
  createPluginMissing: "Le mode Personnalisation n'est pas inclus dans cette configuration",

} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  ...guideDe,
  builtInGroup: 'Eingebaut', customGroup: 'Benutzerdefiniert',
  sectionIntro:
    'Wählen Sie die Tools des Agenten und deren Funktionsweise aus. Verwenden Sie Spieleentwickler für Ihre Spiele oder den Anpassungsmodus, um WASD Engine Funktionen hinzuzufügen.',

  seatHint: 'Wählen Sie die Agentenvoreinstellung für Ihre neue Aufgabe',
  headerHint: 'Die Agentenvoreinstellung, die beim Start dieser Aufgabe ausgewählt wurde',
  nav: 'Agentenvoreinstellungen',

  setDefault: 'Als Standard für neue Aufgabe festlegen',
  view: 'Konfiguration anzeigen',

  presetGamedevName: 'Spieleentwickler',
  presetGamedevDescription: 'Entwirft, baut, startet und debuggt Spiele mit den mitgelieferten Skills für Godot und Spieldesign.',
  presetCordisName: 'Anpassungsmodus',
  presetCordisDescription:
    'Passen Sie WASD Engine durch Gespräche an. Lassen Sie den Agenten Plugins schreiben, die Funktionen oder Benutzeroberflächen hinzufügen, oder kombinieren Sie Tools und Eingabeaufforderungen, um Ihren eigenen Modus zu erstellen.',

  inUse: 'Neuer Aufgabenstandard',

  noDescription: 'Keine Beschreibung.',
  brokenBadge: 'Laden fehlgeschlagen',

  switchRefused: 'Konnte nicht zu {name} wechseln: {reason}',

  close: 'Schließen',

  creatorDraft: 'Lassen Sie sich vom Agenten beim Erstellen einer Voreinstellung helfen',
  createPlugin: 'Lassen Sie den Agenten ein Plugin erstellen',
  createPluginDescription: 'Wechseln Sie in den Anpassungsmodus und erstellen Sie Ihr eigenes Plugin für WASD Engine',
  createPluginChecking: 'Prüfen, ob der Anpassungsmodus verfügbar ist',
  createPluginUnavailable: 'Vorübergehend nicht verfügbar. Öffnen Sie dieses Menü erneut, um es erneut zu versuchen',
  createPluginMissing: 'Der Anpassungsmodus ist in dieser Konfiguration nicht enthalten',

} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  ...guideRu,
  builtInGroup: 'Встроенный', customGroup: 'Пользовательский',
  sectionIntro:
    'Выбирайте инструменты агента и то, как они работают. Используйте «Разработчик игр» для создания игр или режим настройки, чтобы расширить возможности WASD Engine.',

  seatHint: 'Выберите предустановку агента для вашей новой задачи',
  headerHint: 'Предварительная настройка агента, выбранная при запуске этой задачи',
  nav: 'Настройки агента',

  setDefault: 'Установить в качестве новой задачи по умолчанию',
  view: 'Посмотреть конфигурацию',

  presetGamedevName: 'Разработчик игр',
  presetGamedevDescription:
    'Проектирует, собирает, запускает и отлаживает игры с помощью встроенных навыков для Godot и геймдизайна.',
  presetCordisName: 'Режим настройки',
  presetCordisDescription:
    'Настройте WASD Engine через разговор. Позвольте агенту писать плагины, которые добавляют функции или пользовательский интерфейс, или комбинируйте инструменты и подсказки для создания собственного режима.',

  inUse: 'Новая задача по умолчанию',

  noDescription: 'Нет описания.',
  brokenBadge: 'Не удалось загрузить',

  switchRefused: 'Не удалось переключиться на {name}: {reason}',

  close: 'Закрыть',

  creatorDraft: 'Позвольте агенту помочь мне создать пресет',
  createPlugin: 'Позвольте агенту создать плагин',
  createPluginDescription: 'Войдите в режим настройки и создайте свой собственный плагин для WASD Engine.',
  createPluginChecking: 'Проверка доступности режима настройки',
  createPluginUnavailable: 'Временно недоступен. Откройте это меню еще раз, чтобы повторить попытку.',
  createPluginMissing: 'Режим настройки не включен в эту конфигурацию.',

} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  ...guidePt,
  builtInGroup: 'Integrado', customGroup: 'Personalizado',
  sectionIntro:
    'Escolha as ferramentas do agente e como funciona. Use Desenvolvedor de jogos para criar seus jogos ou o modo de personalização para adicionar recursos ao WASD Engine.',

  seatHint: 'Escolha a predefinição de agente para sua nova tarefa',
  headerHint: 'A predefinição do agente escolhida quando esta tarefa foi iniciada',
  nav: 'Predefinições de agente',

  setDefault: 'Definir como nova tarefa padrão',
  view: 'Ver configuração',

  presetGamedevName: 'Desenvolvedor de jogos',
  presetGamedevDescription: 'Projeta, cria, executa e depura jogos com as habilidades incluídas de Godot e design de jogos.',
  presetCordisName: 'Modo de personalização',
  presetCordisDescription:
    'Personalize o WASD Engine por meio de conversa. Deixe o agente escrever plug-ins que adicionem recursos ou UI, ou combine ferramentas e prompts para criar seu próprio modo.',

  inUse: 'Novo padrão de tarefa',

  noDescription: 'Nenhuma descrição.',
  brokenBadge: 'Falha ao carregar',

  switchRefused: 'Não foi possível mudar para {name}: {reason}',

  close: 'Fechar',

  creatorDraft: 'Deixe o agente me ajudar a criar uma predefinição',
  createPlugin: 'Deixe o agente criar um plugin',
  createPluginDescription: 'Entre no modo de personalização e crie seu próprio plug-in para o WASD Engine',
  createPluginChecking: 'Verificando se o modo de personalização está disponível',
  createPluginUnavailable: 'Temporariamente indisponível. Reabra este menu para tentar novamente',
  createPluginMissing: 'O modo de personalização não está incluído nesta configuração',

} satisfies Record<keyof typeof en, string>
