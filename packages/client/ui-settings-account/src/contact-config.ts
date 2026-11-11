/** Public contact and sign-in options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination and the sign-in choice shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
  /** Offer Add API Key beside Sign in in the sign-in dialog; false leaves account sign-in as the only way in. */
  apiKeyEntry: boolean
  /**
   * Make every user sign in: the sign-in dialogs offer no way to close them, and losing the sign-in opens the Get
   * started dialog again, in any view.
   */
  signInRequired: boolean
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'),
  contactSource: z.string().default(''),
  apiKeyEntry: z.boolean().default(true),
  signInRequired: z.boolean().default(false),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__DSH_CONTACT_CONFIG__'
