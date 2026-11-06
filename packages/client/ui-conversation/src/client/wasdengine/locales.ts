/**
 * WASD Engine copy owned by ui-conversation (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): the hero's headline, the hero messages that name a Workspace, rewritten to name a
 * game project, and the session-in-use error, which names WASD Engine instead of DSH.
 */

/**
 * `conversation` namespace messages the fork rewrites, by language: the hero's headline, the
 * messages that name a game project instead of a Workspace, and the session-in-use error.
 */
export const WASDENGINE_CONVERSATION_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'hero.headline': 'Horizons Yet to Be',
    'placeholder.workspace': 'Choose a game project to start',
    'hero.chooseWorkspace': 'Choose game project',
    'error.sessionInUse':
      'This session is already in use, possibly by another running WASD Engine instance (such as dsh web or the desktop app). Quit other running WASD Engine instances and try again.',
  },
  zh: {
    'hero.headline': '尚待开辟的地平线',
    'placeholder.workspace': '选择一个游戏项目开始',
    'hero.chooseWorkspace': '选择游戏项目',
    'error.sessionInUse':
      '当前会话已被占用，可能是其他正在运行的 WASD Engine 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 WASD Engine 后重试。',
  },
  ja: {
    'hero.headline': 'まだ見ぬ地平線',
    'placeholder.workspace': '開始するゲームプロジェクトを選択',
    'hero.chooseWorkspace': 'ゲームプロジェクトを選択',
    'error.sessionInUse':
      'このセッションはすでに使用中です。別の実行中の WASD Engine インスタンス（dsh webやデスクトップアプリなど）が使用している可能性があります。他の WASD Engine インスタンスを終了して再試行してください。',
  },
  es: {
    'hero.headline': 'Horizontes por venir',
    'placeholder.workspace': 'Elige un proyecto de juego para empezar',
    'hero.chooseWorkspace': 'Elegir proyecto de juego',
    'error.sessionInUse':
      'Esta sesión ya está en uso, posiblemente por otra instancia de WASD Engine en ejecución (como la web dsh o la aplicación de escritorio). Salga de otras instancias de WASD Engine en ejecución y vuelva a intentarlo.',
  },
  fr: {
    'hero.headline': 'Horizons à venir',
    'placeholder.workspace': 'Choisissez un projet de jeu pour commencer',
    'hero.chooseWorkspace': 'Choisir un projet de jeu',
    'error.sessionInUse':
      "Cette session est déjà utilisée, éventuellement par une autre instance WASD Engine en cours d'exécution (telle que le Web dsh ou l'application de bureau). Quittez les autres instances WASD Engine en cours d'exécution et réessayez.",
  },
  de: {
    'hero.headline': 'Kommende Horizonte',
    'placeholder.workspace': 'Wählen Sie ein Spielprojekt aus, um zu beginnen',
    'hero.chooseWorkspace': 'Spielprojekt auswählen',
    'error.sessionInUse':
      'Diese Sitzung wird bereits verwendet, möglicherweise von einer anderen laufenden Instanz von WASD Engine (z. B. dsh Web oder der Desktop-App). Beenden Sie andere laufende Instanzen von WASD Engine und versuchen Sie es erneut.',
  },
  ru: {
    'hero.headline': 'Грядущие горизонты',
    'placeholder.workspace': 'Выберите игровой проект, чтобы начать',
    'hero.chooseWorkspace': 'Выбрать игровой проект',
    'error.sessionInUse':
      'Этот сеанс уже используется, возможно, другим работающим экземпляром WASD Engine (например, веб-сайтом dsh или настольным приложением). Закройте другие работающие экземпляры WASD Engine и повторите попытку.',
  },
  pt: {
    'hero.headline': 'Horizontes por vir',
    'placeholder.workspace': 'Escolha um projeto de jogo para começar',
    'hero.chooseWorkspace': 'Escolher projeto de jogo',
    'error.sessionInUse':
      'Esta sessão já está em uso, possivelmente por outra instância do WASD Engine em execução (como dsh web ou aplicativo de desktop). Saia de outras instâncias do WASD Engine em execução e tente novamente.',
  },
}
