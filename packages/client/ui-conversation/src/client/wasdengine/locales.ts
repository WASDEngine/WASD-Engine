/**
 * WASD Engine copy owned by ui-conversation (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): the hero's headline, and the hero messages that name a Workspace, rewritten to
 * name a game project.
 */

/**
 * `conversation` namespace messages the fork rewrites, by language: the hero's headline, and the
 * messages that name a game project instead of a Workspace.
 */
export const WASDENGINE_CONVERSATION_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'hero.headline': 'Horizons Yet to Be',
    'placeholder.workspace': 'Choose a game project to start',
    'hero.chooseWorkspace': 'Choose game project',
  },
  zh: {
    'hero.headline': '尚待开辟的地平线',
    'placeholder.workspace': '选择一个游戏项目开始',
    'hero.chooseWorkspace': '选择游戏项目',
  },
  ja: {
    'hero.headline': 'まだ見ぬ地平線',
    'placeholder.workspace': '開始するゲームプロジェクトを選択',
    'hero.chooseWorkspace': 'ゲームプロジェクトを選択',
  },
  es: {
    'hero.headline': 'Horizontes por venir',
    'placeholder.workspace': 'Elige un proyecto de juego para empezar',
    'hero.chooseWorkspace': 'Elegir proyecto de juego',
  },
  fr: {
    'hero.headline': 'Horizons à venir',
    'placeholder.workspace': 'Choisissez un projet de jeu pour commencer',
    'hero.chooseWorkspace': 'Choisir un projet de jeu',
  },
  de: {
    'hero.headline': 'Kommende Horizonte',
    'placeholder.workspace': 'Wählen Sie ein Spielprojekt aus, um zu beginnen',
    'hero.chooseWorkspace': 'Spielprojekt auswählen',
  },
  ru: {
    'hero.headline': 'Грядущие горизонты',
    'placeholder.workspace': 'Выберите игровой проект, чтобы начать',
    'hero.chooseWorkspace': 'Выбрать игровой проект',
  },
  pt: {
    'hero.headline': 'Horizontes por vir',
    'placeholder.workspace': 'Escolha um projeto de jogo para começar',
    'hero.chooseWorkspace': 'Escolher projeto de jogo',
  },
}
