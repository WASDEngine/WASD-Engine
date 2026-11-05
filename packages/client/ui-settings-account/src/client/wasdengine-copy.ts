/**
 * WASD Engine copy for the `settings.account` namespace (fork-owned; `wasdengine/FORK.md` lists
 * the fork changes): every message names WASD Engine instead of DeepSeek Harness or a DeepSeek
 * account, and the desktop onboarding introduces game development.
 */

/** The product and account name shown in place of the upstream names. */
export const WASDENGINE_PRODUCT_NAME = 'WASD Engine'

/**
 * "DeepSeek Harness", "Harness" on its own, and "DeepSeek" naming the account or the
 * platform. Model names such as DeepSeek-V4.1-Flash keep the DeepSeek name.
 */
const UPSTREAM_NAME = /DeepSeek Harness|\bHarness\b|DeepSeek(?!-V\d)/gu

/**
 * Onboarding copy that WASD Engine writes itself, by language: the welcome introduction
 * and the two purpose choices, which keep their upstream meaning (no code view, or the
 * coding view and developer tools) in game-development terms.
 */
export const WASDENGINE_ACCOUNT_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    onboardingIntroduction: 'WASD Engine works in a local project folder and uses tools to read and write files on your computer. It can help you design and prototype games, write and debug game code, set up Godot and Phaser projects, draft design documents, and more.',
    onboardingOffice: 'Game design & writing',
    onboardingOfficeDescription: 'Write design docs, plan levels, draft story and dialogue, and more',
    onboardingDevelopment: 'Game programming',
    onboardingDevelopmentDescription: 'Write game code, debug gameplay, run builds, manage project files, and more',
  },
  zh: {
    onboardingIntroduction: 'WASD Engine 以本地项目文件夹作为工作区，通过调用各种工具读写本机文件，帮你完成游戏策划与原型制作、编写和调试游戏代码、搭建 Godot 与 Phaser 项目、撰写设计文档等各种任务。',
    onboardingOffice: '游戏策划与写作',
    onboardingOfficeDescription: '撰写设计文档、规划关卡、编写剧情和对白等',
    onboardingDevelopment: '游戏开发',
    onboardingDevelopmentDescription: '编写游戏代码、调试玩法、运行构建和管理项目文件等',
  },
  ja: {
    onboardingIntroduction: 'WASD Engine はローカルのプロジェクトフォルダーで動作し、ツールを使ってコンピューター上のファイルを読み書きします。ゲームの企画やプロトタイプ作成、ゲームコードの作成とデバッグ、Godot や Phaser のプロジェクト設定、設計ドキュメントの作成などを手伝います。',
    onboardingOffice: 'ゲームデザインと執筆',
    onboardingOfficeDescription: '設計ドキュメントの作成、レベルの計画、ストーリーやセリフの執筆など',
    onboardingDevelopment: 'ゲームプログラミング',
    onboardingDevelopmentDescription: 'ゲームコードの作成、ゲームプレイのデバッグ、ビルドの実行、プロジェクトファイルの管理など',
  },
  es: {
    onboardingIntroduction: 'WASD Engine trabaja en una carpeta de proyecto local y usa herramientas para leer y escribir archivos en tu equipo. Puede ayudarte a diseñar y prototipar juegos, escribir y depurar código de juego, configurar proyectos de Godot y Phaser, redactar documentos de diseño y más.',
    onboardingOffice: 'Diseño de juegos y escritura',
    onboardingOfficeDescription: 'Escribe documentos de diseño, planifica niveles, redacta la historia y los diálogos, y más',
    onboardingDevelopment: 'Programación de juegos',
    onboardingDevelopmentDescription: 'Escribe código de juego, depura la jugabilidad, ejecuta compilaciones, gestiona los archivos del proyecto y más',
  },
  fr: {
    onboardingIntroduction: 'WASD Engine travaille dans un dossier de projet local et utilise des outils pour lire et écrire des fichiers sur votre ordinateur. Il peut vous aider à concevoir et prototyper des jeux, écrire et déboguer du code de jeu, configurer des projets Godot et Phaser, rédiger des documents de conception, et plus encore.',
    onboardingOffice: 'Game design et écriture',
    onboardingOfficeDescription: "Rédigez des documents de conception, planifiez des niveaux, écrivez l'histoire et les dialogues, et plus encore",
    onboardingDevelopment: 'Programmation de jeux',
    onboardingDevelopmentDescription: 'Écrivez du code de jeu, déboguez le gameplay, lancez des builds, gérez les fichiers du projet, et plus encore',
  },
  de: {
    onboardingIntroduction: 'WASD Engine arbeitet in einem lokalen Projektordner und nutzt Werkzeuge, um Dateien auf Ihrem Computer zu lesen und zu schreiben. Es hilft Ihnen, Spiele zu entwerfen und Prototypen zu bauen, Spielcode zu schreiben und zu debuggen, Godot- und Phaser-Projekte einzurichten, Designdokumente zu verfassen und mehr.',
    onboardingOffice: 'Spieldesign und Schreiben',
    onboardingOfficeDescription: 'Designdokumente schreiben, Level planen, Story und Dialoge entwerfen und mehr',
    onboardingDevelopment: 'Spieleprogrammierung',
    onboardingDevelopmentDescription: 'Spielcode schreiben, Gameplay debuggen, Builds ausführen, Projektdateien verwalten und mehr',
  },
  ru: {
    onboardingIntroduction: 'WASD Engine работает в локальной папке проекта и с помощью инструментов читает и записывает файлы на вашем компьютере. Он поможет придумать и прототипировать игры, писать и отлаживать игровой код, настраивать проекты Godot и Phaser, составлять дизайн-документы и многое другое.',
    onboardingOffice: 'Геймдизайн и тексты',
    onboardingOfficeDescription: 'Пишите дизайн-документы, планируйте уровни, сочиняйте сюжет и диалоги и многое другое',
    onboardingDevelopment: 'Программирование игр',
    onboardingDevelopmentDescription: 'Пишите игровой код, отлаживайте геймплей, запускайте сборки, управляйте файлами проекта и многое другое',
  },
  pt: {
    onboardingIntroduction: 'O WASD Engine trabalha em uma pasta de projeto local e usa ferramentas para ler e gravar arquivos no seu computador. Ele pode ajudar você a projetar e prototipar jogos, escrever e depurar código de jogo, configurar projetos Godot e Phaser, redigir documentos de design e muito mais.',
    onboardingOffice: 'Design de jogos e escrita',
    onboardingOfficeDescription: 'Escreva documentos de design, planeje fases, crie a história e os diálogos e muito mais',
    onboardingDevelopment: 'Programação de jogos',
    onboardingDevelopmentDescription: 'Escreva código de jogo, depure a jogabilidade, execute builds, gerencie os arquivos do projeto e muito mais',
  },
}

/**
 * Brand the account dictionaries for registration: replace the upstream names in every
 * message, then apply {@link WASDENGINE_ACCOUNT_COPY}. The inputs stay unchanged, so code
 * that imports the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped account dictionary, keyed by language.
 * @returns branded copies with the same keys.
 * @throws when the copy names a message key that a dictionary lacks.
 */
export function brandAccountDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const copy: Record<string, string> = {}
    for (const [key, message] of Object.entries(messages)) {
      copy[key] = message.replaceAll(UPSTREAM_NAME, WASDENGINE_PRODUCT_NAME)
    }
    for (const [key, message] of Object.entries(WASDENGINE_ACCOUNT_COPY[language] ?? {})) {
      if (!(key in copy)) throw new Error(`WASD Engine account copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
