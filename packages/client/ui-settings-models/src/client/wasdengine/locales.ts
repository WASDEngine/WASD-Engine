/**
 * WASD Engine copy owned by ui-settings-models (fork-owned; `wasdengine/FORK.md` lists the fork changes): the API key
 * step of the models onboarding, which asks for an API token from the WASD Engine account page.
 */

/** Messages of the `settings.models` namespace that WASD Engine rewrites, by language. */
export const WASDENGINE_MODELS_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: { onboardingDescription: 'Paste an API token from your WASD Engine account page to start.' },
  zh: { onboardingDescription: '粘贴 WASD Engine 账号页面中的 API 令牌，即可开始使用' },
  ja: { onboardingDescription: 'WASD Engine のアカウントページで作成した API トークンを貼り付けて開始します' },
  es: { onboardingDescription: 'Pega un token de API de la página de tu cuenta de WASD Engine para empezar' },
  fr: { onboardingDescription: "Collez un jeton d'API depuis la page de votre compte WASD Engine pour commencer" },
  de: { onboardingDescription: 'Fügen Sie ein API-Token von Ihrer WASD Engine-Kontoseite ein, um loszulegen' },
  ru: { onboardingDescription: 'Вставьте API-токен со страницы вашей учётной записи WASD Engine, чтобы начать' },
  pt: { onboardingDescription: 'Cole um token de API da página da sua conta WASD Engine para começar' },
}
