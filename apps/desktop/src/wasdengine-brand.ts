/**
 * WASDEngine product identity for the Desktop shell and its packaging.
 *
 * WASDEngine is built on DeepSeek Harness and must not present itself as a DeepSeek Harness
 * installation or share operating-system state with one: the bundle identifier, deep-link
 * scheme, Electron data directory, and executable all differ. Packaging applies these values
 * through `scripts/wasdengine-builder-config.mjs`; the shell reads them for the macOS About
 * panel, the deep-link scheme, and the product name in its locale dictionaries. This module
 * has no imports, so the sandboxed preloads that read the dictionaries can bundle it.
 * `wasdengine/FORK.md` in the repository root lists every upstream file that reads it.
 */

/** The WASDEngine Desktop identity; icon paths are relative to `apps/desktop`. */
export const WASDENGINE_DESKTOP_BRAND = {
  /** Application, bundle, and executable name; Electron derives its data and log directories from it. */
  productName: 'WASD Engine',
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
   * HTTPS origin of the WASDEngine update feed. Unset, a build may not carry an update feed:
   * unsigned builds have none, and packaging refuses a signed build because the release
   * pipeline always embeds one.
   */
  updateOrigin: undefined as string | undefined,
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
 * WASD Engine's own welcome-window copy, by language: the tagline under the welcome title,
 * and the API-key prompt, which takes a WASD Engine API token rather than a DeepSeek key.
 */
export const WASDENGINE_DESKTOP_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    welcomeDescription: 'Build games with an agent at the keys.',
    welcomeKeyDescription: 'Paste an API token from your WASD Engine account page to start.',
  },
  zh: {
    welcomeDescription: '与智能体并肩，打造你的游戏',
    welcomeKeyDescription: '粘贴 WASD Engine 账号页面中的 API 令牌，即可开始使用',
  },
  ja: {
    welcomeDescription: 'エージェントと一緒にゲームを作ろう。',
    welcomeKeyDescription: 'WASD Engine のアカウントページで作成した API トークンを貼り付けて開始します',
  },
  es: {
    welcomeDescription: 'Crea juegos con un agente a los mandos.',
    welcomeKeyDescription: 'Pega un token de API de la página de tu cuenta de WASD Engine para empezar',
  },
  fr: {
    welcomeDescription: 'Créez des jeux avec un agent aux commandes.',
    welcomeKeyDescription: "Collez un jeton d'API depuis la page de votre compte WASD Engine pour commencer",
  },
  de: {
    welcomeDescription: 'Spiele bauen, mit einem Agenten an den Tasten.',
    welcomeKeyDescription: 'Fügen Sie ein API-Token von Ihrer WASD Engine-Kontoseite ein, um loszulegen',
  },
  ru: {
    welcomeDescription: 'Создавайте игры вместе с агентом.',
    welcomeKeyDescription: 'Вставьте API-токен со страницы вашей учётной записи WASD Engine, чтобы начать',
  },
  pt: {
    welcomeDescription: 'Crie jogos com um agente no controle.',
    welcomeKeyDescription: 'Cole um token de API da página da sua conta WASD Engine para começar',
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
