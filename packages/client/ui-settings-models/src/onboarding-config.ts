/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
  /** Leave credential onboarding to the Desktop app's welcome window; false offers the browser step in the Desktop app too. */
  nativeCredentialOnboarding: boolean
  /** Offer API key entry: the Models settings section and the API key step; false leaves account sign-in as the only way in. */
  apiKeyEntry: boolean
  /** Show the versioned preview notice in browsers; the Desktop app never shows it. */
  welcomeNotice: boolean
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  credentialOnboarding: z.boolean().default(true),
  nativeCredentialOnboarding: z.boolean().default(true),
  apiKeyEntry: z.boolean().default(true),
  welcomeNotice: z.boolean().default(true),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'
