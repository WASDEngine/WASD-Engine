/**
 * WASDEngine product identity for the Desktop shell and its packaging.
 *
 * WASDEngine is built on DeepSeek Harness and must not present itself as a DeepSeek Harness
 * installation or share operating-system state with one: the bundle identifier, deep-link
 * scheme, Electron data directory, executable, and packaged npm name all differ. Packaging applies these values
 * through `scripts/wasdengine-builder-config.mjs`; the shell reads them for the macOS About
 * panel, the deep-link scheme, and the product name in its locale dictionaries. This module
 * has no imports, so the sandboxed preloads that read the dictionaries can bundle it.
 * `wasdengine/FORK.md` in the repository root lists every upstream file that reads it.
 */

/** The WASDEngine Desktop identity; icon paths are relative to `apps/desktop`. */
export const WASDENGINE_DESKTOP_BRAND = {
  /** Application, bundle, and executable name; Electron derives its data and log directories from it. */
  productName: 'WASD Engine',
  /**
   * npm name of the packaged manifest. electron-builder derives the updater cache folder from it, and the Windows
   * uninstaller deletes that folder and `%APPDATA%\<name>`; upstream's `@deepseek-ai/dsh-desktop` would make both a
   * stock DeepSeek Harness install's.
   */
  packageName: 'wasdengine-desktop',
  /** Start of every packaged file name, such as `WASD-Engine-0.1.0-rc-mac-arm64.dmg`, in place of upstream's `deepseek-harness`. */
  artifactBase: 'WASD-Engine',
  /** Bundle identifier of unsigned local builds; release builds name theirs in `DSH_DESKTOP_APP_ID`. */
  appId: 'com.wasdengine.desktop',
  /** Deep-link scheme; `wasdengine://open` brings the application to the foreground. */
  urlScheme: 'wasdengine',
  /** Packaged manifest author, which Windows reports as the publisher. */
  publisher: 'WASDEngine',
  /** Title of the macOS About panel. */
  aboutName: 'WASD Engine (built on DeepSeek Harness)',
  /** Text of the macOS microphone permission prompt. */
  microphoneUsage: 'WASD Engine uses your microphone to transcribe speech into message drafts.',
  /**
   * GitHub repository whose releases carry the update feed. A build packaged with `DSH_DESKTOP_AUTO_UPDATE_ENV=github`
   * checks `https://github.com/<repository>/releases/latest/download/`, which GitHub serves from the newest release
   * that is neither a draft nor a pre-release, and `applyWasdengineBrand` refuses every other feed.
   */
  releaseRepository: 'WASDEngine/WASD-Engine',
  /**
   * Whether the shell opens its standalone welcome window to ask for an account or an API key. False opens the main
   * window at once, where the Get started dialog of ui-settings-models asks instead; `first-run.cordis.patch.yml` of
   * dsh-web-app turns that dialog on in the Desktop app with `nativeCredentialOnboarding: false`.
   */
  welcomeWindow: false as boolean,
  /** Icon files rendered by `scripts/wasdengine-render-icons.ts`. */
  icons: {
    macOS: 'wasdengine/icon-macos.png',
    windows: 'wasdengine/icon-windows.png',
    tray: 'wasdengine/tray-windows.ico',
  },
} as const

/** The upstream product name in shell copy: "DeepSeek Harness", or "Harness" on its own. */
const UPSTREAM_PRODUCT_NAME = /(?:DeepSeek )?\bHarness\b/gu

/**
 * WASD Engine's own shell copy, by language: the tagline under the welcome title; the API-key
 * prompt, which takes a WASD Engine API token rather than a DeepSeek key; and the details of the
 * update dialogs, which say that an update downloads in the background and name the sidebar's
 * Restart to Update button, worded as `desktop.update.ready` of ui-settings-general.
 */
export const WASDENGINE_DESKTOP_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    welcomeDescription: 'Build games with an agent at the keys.',
    welcomeKeyDescription: 'Paste an API token from your WASD Engine account page to start.',
    updateDetail: 'It is downloading in the background. When it is ready, choose Restart to Update in the sidebar.',
    updateDownloadDetail: 'The update is downloading in the background. When it is ready, choose Restart to Update in the sidebar.',
  },
  zh: {
    welcomeDescription: '与智能体并肩，打造你的游戏',
    welcomeKeyDescription: '粘贴 WASD Engine 账号页面中的 API 令牌，即可开始使用',
    updateDetail: '正在后台下载，准备就绪后可点击侧边栏中的“重启以更新”。',
    updateDownloadDetail: '更新正在后台下载，准备就绪后可点击侧边栏中的“重启以更新”。',
  },
  ja: {
    welcomeDescription: 'エージェントと一緒にゲームを作ろう。',
    welcomeKeyDescription: 'WASD Engine のアカウントページで作成した API トークンを貼り付けて開始します',
    updateDetail: 'バックグラウンドでダウンロードしています。準備ができたら、サイドバーの「再起動して更新」を選択してください。',
    updateDownloadDetail: 'アップデートをバックグラウンドでダウンロードしています。準備ができたら、サイドバーの「再起動して更新」を選択してください。',
  },
  es: {
    welcomeDescription: 'Crea juegos con un agente a los mandos.',
    welcomeKeyDescription: 'Pega un token de API de la página de tu cuenta de WASD Engine para empezar',
    updateDetail: 'Se está descargando en segundo plano. Cuando esté lista, seleccione Reiniciar para actualizar en la barra lateral.',
    updateDownloadDetail: 'La actualización se está descargando en segundo plano. Cuando esté lista, seleccione Reiniciar para actualizar en la barra lateral.',
  },
  fr: {
    welcomeDescription: 'Créez des jeux avec un agent aux commandes.',
    welcomeKeyDescription: "Collez un jeton d'API depuis la page de votre compte WASD Engine pour commencer",
    updateDetail: 'Elle se télécharge en arrière-plan. Une fois prête, sélectionnez Redémarrer pour mettre à jour dans la barre latérale.',
    updateDownloadDetail: 'La mise à jour se télécharge en arrière-plan. Une fois prête, sélectionnez Redémarrer pour mettre à jour dans la barre latérale.',
  },
  de: {
    welcomeDescription: 'Spiele bauen, mit einem Agenten an den Tasten.',
    welcomeKeyDescription: 'Fügen Sie ein API-Token von Ihrer WASD Engine-Kontoseite ein, um loszulegen',
    updateDetail: 'Sie wird im Hintergrund heruntergeladen. Sobald sie bereit ist, wählen Sie in der Seitenleiste „Zum Aktualisieren neu starten“.',
    updateDownloadDetail: 'Das Update wird im Hintergrund heruntergeladen. Sobald es bereit ist, wählen Sie in der Seitenleiste „Zum Aktualisieren neu starten“.',
  },
  ru: {
    welcomeDescription: 'Создавайте игры вместе с агентом.',
    welcomeKeyDescription: 'Вставьте API-токен со страницы вашей учётной записи WASD Engine, чтобы начать',
    updateDetail: 'Она загружается в фоновом режиме. Когда она будет готова, выберите «Перезапустить для обновления» на боковой панели.',
    updateDownloadDetail: 'Обновление загружается в фоновом режиме. Когда оно будет готово, выберите «Перезапустить для обновления» на боковой панели.',
  },
  pt: {
    welcomeDescription: 'Crie jogos com um agente no controle.',
    welcomeKeyDescription: 'Cole um token de API da página da sua conta WASD Engine para começar',
    updateDetail: 'Ela está sendo baixada em segundo plano. Quando estiver pronta, selecione Reiniciar para atualizar na barra lateral.',
    updateDownloadDetail: 'A atualização está sendo baixada em segundo plano. Quando estiver pronta, selecione Reiniciar para atualizar na barra lateral.',
  },
}

/**
 * Replace the upstream product name with WASD Engine in every message, then apply
 * {@link WASDENGINE_DESKTOP_COPY}, in place. The dictionaries are the objects `locale.ts`
 * exports, so a direct import and a resolved locale read the same copy. "DSH" and
 * references to DeepSeek models stay unchanged.
 * @param dictionaries - Every shipped Desktop dictionary, keyed by language.
 * @returns The same dictionaries.
 * @throws when the copy names a message key that a dictionary lacks.
 */
export function brandDesktopDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  for (const [language, messages] of Object.entries<Record<string, string>>(dictionaries)) {
    for (const [key, message] of Object.entries(messages)) {
      messages[key] = message.replaceAll(UPSTREAM_PRODUCT_NAME, WASDENGINE_DESKTOP_BRAND.productName)
    }
    for (const [key, message] of Object.entries(WASDENGINE_DESKTOP_COPY[language] ?? {})) {
      if (!(key in messages)) throw new Error(`WASD Engine desktop copy: ${language} has no message ${key}`)
      messages[key] = message
    }
  }
  return dictionaries
}
