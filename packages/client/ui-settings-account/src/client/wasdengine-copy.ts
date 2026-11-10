/**
 * WASD Engine copy for the `settings.account` namespace (fork-owned; `wasdengine/FORK.md` lists
 * the fork changes): every message names WASD Engine instead of DeepSeek Harness or a DeepSeek
 * account, the sign-in dialog welcomes with the WASD Engine tagline, the desktop onboarding
 * introduces game development, and the balance, Top up and quota notice speak of the plan's
 * monthly AI usage and its upgrade, which `/top_up` offers.
 */

/** The product and account name shown in place of the upstream names. */
export const WASDENGINE_PRODUCT_NAME = 'WASD Engine'

/**
 * "DeepSeek Harness", "Harness" on its own, and "DeepSeek" naming the account or the
 * platform. Model names such as DeepSeek-V4.1-Flash keep the DeepSeek name.
 */
const UPSTREAM_NAME = /DeepSeek Harness|\bHarness\b|DeepSeek(?!-V\d)/gu

/**
 * Copy that WASD Engine writes itself, by language: the sign-in dialog's tagline, which the
 * Desktop welcome window also shows, the onboarding welcome introduction, and the two purpose
 * choices, which keep their upstream meaning (no code view, or the coding view and developer
 * tools) in game-development terms. The balance is what is left of the plan's monthly AI usage,
 * which the WASD Engine account service reports as the one wallet, and Top up and the quota
 * notice, which the gateway raises once that usage is used up, open the plans page to upgrade.
 */
export const WASDENGINE_ACCOUNT_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    loginDescription: 'Build games with an agent at the keys.',
    onboardingIntroduction: 'WASD Engine works in a local project folder and uses tools to read and write files on your computer. It can help you create game logic, 2D and 3D game assets, music, SFX, and more.',
    onboardingOffice: 'Game design & writing',
    onboardingOfficeDescription: 'Write design docs, plan levels, draft story and dialogue, and more',
    onboardingDevelopment: 'Game programming',
    onboardingDevelopmentDescription: 'Write game code, debug gameplay, run builds, manage project files, and more',
    balance: 'AI usage left this month',
    topUp: 'Upgrade',
    quotaTitle: "This month's AI usage is used up",
    quotaDescription: "WASD Engine's built-in AI can't start new tasks until your monthly usage refreshes. Upgrade your plan for more, or connect your own AI over MCP. You can also upgrade later in Settings → Account.",
    quotaTopUp: 'Upgrade',
  },
  zh: {
    loginDescription: '与智能体并肩，打造你的游戏',
    onboardingIntroduction: 'WASD Engine 以本地项目文件夹作为工作区，通过调用各种工具读写本机文件，帮你制作游戏逻辑、2D 与 3D 游戏素材、音乐、音效等。',
    onboardingOffice: '游戏策划与写作',
    onboardingOfficeDescription: '撰写设计文档、规划关卡、编写剧情和对白等',
    onboardingDevelopment: '游戏开发',
    onboardingDevelopmentDescription: '编写游戏代码、调试玩法、运行构建和管理项目文件等',
    balance: '本月剩余 AI 用量',
    topUp: '升级',
    quotaTitle: '本月 AI 用量已用完',
    quotaDescription: '在每月用量刷新之前，WASD Engine 的内置 AI 无法开始新的任务。升级套餐可获得更多用量，也可以通过 MCP 连接你自己的 AI。你也可以稍后前往 设置 → 账号与余额 进行升级。',
    quotaTopUp: '去升级',
  },
  ja: {
    loginDescription: 'エージェントと一緒にゲームを作ろう。',
    onboardingIntroduction: 'WASD Engine はローカルのプロジェクトフォルダーで動作し、ツールを使ってコンピューター上のファイルを読み書きします。ゲームロジック、2D・3D のゲームアセット、音楽、効果音などの制作を手伝います。',
    onboardingOffice: 'ゲームデザインと執筆',
    onboardingOfficeDescription: '設計ドキュメントの作成、レベルの計画、ストーリーやセリフの執筆など',
    onboardingDevelopment: 'ゲームプログラミング',
    onboardingDevelopmentDescription: 'ゲームコードの作成、ゲームプレイのデバッグ、ビルドの実行、プロジェクトファイルの管理など',
    balance: '今月の残り AI 使用量',
    topUp: 'アップグレード',
    quotaTitle: '今月の AI 使用量を使い切りました',
    quotaDescription: '毎月の使用量がリセットされるまで、WASD Engine の内蔵 AI は新しいタスクを開始できません。プランをアップグレードして使用量を増やすか、MCP で自分の AI を接続してください。後から設定 → アカウントでアップグレードすることもできます。',
    quotaTopUp: 'アップグレード',
  },
  es: {
    loginDescription: 'Crea juegos con un agente a los mandos.',
    onboardingIntroduction: 'WASD Engine trabaja en una carpeta de proyecto local y usa herramientas para leer y escribir archivos en tu equipo. Puede ayudarte a crear la lógica del juego, recursos de juego 2D y 3D, música, efectos de sonido y más.',
    onboardingOffice: 'Diseño de juegos y escritura',
    onboardingOfficeDescription: 'Escribe documentos de diseño, planifica niveles, redacta la historia y los diálogos, y más',
    onboardingDevelopment: 'Programación de juegos',
    onboardingDevelopmentDescription: 'Escribe código de juego, depura la jugabilidad, ejecuta compilaciones, gestiona los archivos del proyecto y más',
    balance: 'Uso de IA restante este mes',
    topUp: 'Mejorar plan',
    quotaTitle: 'Uso mensual de IA agotado',
    quotaDescription: 'La IA integrada de WASD Engine no puede iniciar nuevas tareas hasta que se renueve tu uso mensual. Mejora tu plan para tener más, o conecta tu propia IA mediante MCP. También puedes mejorar el plan más tarde en Configuración → Cuenta.',
    quotaTopUp: 'Mejorar plan',
  },
  fr: {
    loginDescription: 'Créez des jeux avec un agent aux commandes.',
    onboardingIntroduction: 'WASD Engine travaille dans un dossier de projet local et utilise des outils pour lire et écrire des fichiers sur votre ordinateur. Il peut vous aider à créer la logique de jeu, des ressources de jeu 2D et 3D, de la musique, des effets sonores, et plus encore.',
    onboardingOffice: 'Game design et écriture',
    onboardingOfficeDescription: "Rédigez des documents de conception, planifiez des niveaux, écrivez l'histoire et les dialogues, et plus encore",
    onboardingDevelopment: 'Programmation de jeux',
    onboardingDevelopmentDescription: 'Écrivez du code de jeu, déboguez le gameplay, lancez des builds, gérez les fichiers du projet, et plus encore',
    balance: "Utilisation d'IA restante ce mois-ci",
    topUp: 'Mettre à niveau',
    quotaTitle: "Utilisation mensuelle d'IA épuisée",
    quotaDescription: "L'IA intégrée de WASD Engine ne peut pas démarrer de nouvelles tâches tant que votre utilisation mensuelle n'est pas renouvelée. Passez à un forfait supérieur pour en avoir plus, ou connectez votre propre IA via MCP. Vous pouvez aussi le faire plus tard dans Paramètres → Compte.",
    quotaTopUp: 'Mettre à niveau',
  },
  de: {
    loginDescription: 'Spiele bauen, mit einem Agenten an den Tasten.',
    onboardingIntroduction: 'WASD Engine arbeitet in einem lokalen Projektordner und nutzt Werkzeuge, um Dateien auf Ihrem Computer zu lesen und zu schreiben. Es hilft Ihnen bei Spiellogik, 2D- und 3D-Spielassets, Musik, Soundeffekten und mehr.',
    onboardingOffice: 'Spieldesign und Schreiben',
    onboardingOfficeDescription: 'Designdokumente schreiben, Level planen, Story und Dialoge entwerfen und mehr',
    onboardingDevelopment: 'Spieleprogrammierung',
    onboardingDevelopmentDescription: 'Spielcode schreiben, Gameplay debuggen, Builds ausführen, Projektdateien verwalten und mehr',
    balance: 'Verbleibende KI-Nutzung diesen Monat',
    topUp: 'Upgraden',
    quotaTitle: 'Monatliche KI-Nutzung aufgebraucht',
    quotaDescription: 'Die integrierte KI von WASD Engine kann keine neuen Aufgaben starten, bis Ihre monatliche Nutzung erneuert wird. Upgraden Sie Ihren Tarif für mehr Nutzung oder verbinden Sie Ihre eigene KI über MCP. Sie können auch später unter Einstellungen → Konto upgraden.',
    quotaTopUp: 'Upgraden',
  },
  ru: {
    loginDescription: 'Создавайте игры вместе с агентом.',
    onboardingIntroduction: 'WASD Engine работает в локальной папке проекта и с помощью инструментов читает и записывает файлы на вашем компьютере. Он поможет создать игровую логику, 2D- и 3D-ассеты для игр, музыку, звуковые эффекты и многое другое.',
    onboardingOffice: 'Геймдизайн и тексты',
    onboardingOfficeDescription: 'Пишите дизайн-документы, планируйте уровни, сочиняйте сюжет и диалоги и многое другое',
    onboardingDevelopment: 'Программирование игр',
    onboardingDevelopmentDescription: 'Пишите игровой код, отлаживайте геймплей, запускайте сборки, управляйте файлами проекта и многое другое',
    balance: 'Остаток ИИ в этом месяце',
    topUp: 'Улучшить тариф',
    quotaTitle: 'Месячный лимит ИИ исчерпан',
    quotaDescription: 'Встроенный ИИ WASD Engine не может запускать новые задачи, пока ваш месячный лимит не обновится. Перейдите на более высокий тариф, чтобы получить больше, или подключите свой ИИ через MCP. Это также можно сделать позже в «Настройки» → «Аккаунт».',
    quotaTopUp: 'Улучшить тариф',
  },
  pt: {
    loginDescription: 'Crie jogos com um agente no controle.',
    onboardingIntroduction: 'O WASD Engine trabalha em uma pasta de projeto local e usa ferramentas para ler e gravar arquivos no seu computador. Ele pode ajudar você a criar a lógica do jogo, recursos de jogo 2D e 3D, música, efeitos sonoros e muito mais.',
    onboardingOffice: 'Design de jogos e escrita',
    onboardingOfficeDescription: 'Escreva documentos de design, planeje fases, crie a história e os diálogos e muito mais',
    onboardingDevelopment: 'Programação de jogos',
    onboardingDevelopmentDescription: 'Escreva código de jogo, depure a jogabilidade, execute builds, gerencie os arquivos do projeto e muito mais',
    balance: 'Uso de IA restante neste mês',
    topUp: 'Fazer upgrade',
    quotaTitle: 'Uso mensal de IA esgotado',
    quotaDescription: 'A IA integrada do WASD Engine não pode iniciar novas tarefas até que seu uso mensal seja renovado. Faça upgrade do plano para ter mais, ou conecte sua própria IA via MCP. Você também pode fazer upgrade mais tarde em Configurações → Conta.',
    quotaTopUp: 'Fazer upgrade',
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
