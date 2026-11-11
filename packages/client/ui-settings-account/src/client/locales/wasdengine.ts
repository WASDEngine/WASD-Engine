/**
 * WASD Engine's own `settings.account` messages (fork-owned; `wasdengine/FORK.md` lists the fork changes), which
 * upstream's dictionaries do not have: the AI usage row of Settings › Account, which shows how much of the plan's
 * monthly AI usage is left as a percent and the day it refreshes, or that the account is Unlimited, the auto recharge
 * credits left, and the auto recharge switch. `{percent}` is a formatted percent, `{date}` a formatted month and day,
 * `{amount}` a formatted amount of US dollars, and `{reason}` the account service's English sentence on why a charge
 * failed.
 */

/** English messages; every language has the same keys. */
const en = {
  allowanceUnderOnePercent: 'Less than {percent}',
  allowanceRefreshes: 'Refreshes {date}',
  allowanceUnlimited: 'Unlimited',
  allowanceNoLimit: 'No monthly limit on AI usage',
  allowanceCredits: 'Recharge credits: {percent} left',
  allowanceCreditsUnderOnePercent: 'Recharge credits: less than {percent} left',
  autoRecharge: 'Auto recharge credits when you run out, {amount} at a time.',
  autoRechargeFailed: 'Auto recharge turned off because its last charge failed: {reason} Turn it on again to save another card.',
  autoRechargeCard: 'Save a card in your browser to turn on auto recharge.',
  autoRechargeCardOpen: 'Open again',
  autoRechargeError: 'Auto recharge could not be changed. Try again.',
} as const

/** Keys of WASD Engine's own account messages. */
export type WasdengineAccountKey = keyof typeof en
type Messages = Readonly<Record<WasdengineAccountKey, string>>

/** WASD Engine's own account messages, by language; English covers a language without its own. */
export const WASDENGINE_ACCOUNT_MESSAGES: { readonly en: Messages; readonly [language: string]: Messages | undefined } = {
  en,
  zh: {
    allowanceUnderOnePercent: '不到 {percent}',
    allowanceRefreshes: '将于{date}刷新',
    allowanceUnlimited: '无限制',
    allowanceNoLimit: 'AI 用量没有每月上限',
    allowanceCredits: '充值额度：剩余 {percent}',
    allowanceCreditsUnderOnePercent: '充值额度：剩余不到 {percent}',
    autoRecharge: '额度用完时自动充值，每次 {amount}。',
    autoRechargeFailed: '上次扣款失败，自动充值已关闭：{reason} 再次开启即可保存另一张卡。',
    autoRechargeCard: '请在浏览器中保存一张卡，以开启自动充值。',
    autoRechargeCardOpen: '再次打开',
    autoRechargeError: '无法更改自动充值，请重试。',
  },
  ja: {
    allowanceUnderOnePercent: '{percent}未満',
    allowanceRefreshes: '{date}にリセット',
    allowanceUnlimited: '無制限',
    allowanceNoLimit: 'AI 使用量に月間の上限はありません',
    allowanceCredits: 'チャージクレジット: 残り {percent}',
    allowanceCreditsUnderOnePercent: 'チャージクレジット: 残り {percent}未満',
    autoRecharge: 'クレジットを使い切ったら自動でチャージします（1 回 {amount}）。',
    autoRechargeFailed: '前回の請求に失敗したため、自動チャージはオフになりました: {reason} 別のカードを保存するには、もう一度オンにしてください。',
    autoRechargeCard: '自動チャージをオンにするには、ブラウザーでカードを保存してください。',
    autoRechargeCardOpen: 'もう一度開く',
    autoRechargeError: '自動チャージを変更できませんでした。もう一度お試しください。',
  },
  es: {
    allowanceUnderOnePercent: 'Menos del {percent}',
    allowanceRefreshes: 'Se renueva el {date}',
    allowanceUnlimited: 'Ilimitado',
    allowanceNoLimit: 'Sin límite mensual de uso de IA',
    allowanceCredits: 'Créditos de recarga: queda el {percent}',
    allowanceCreditsUnderOnePercent: 'Créditos de recarga: queda menos del {percent}',
    autoRecharge: 'Recargar créditos automáticamente cuando se acaben, {amount} cada vez.',
    autoRechargeFailed: 'La recarga automática se desactivó porque falló su último cobro: {reason} Actívela de nuevo para guardar otra tarjeta.',
    autoRechargeCard: 'Guarde una tarjeta en su navegador para activar la recarga automática.',
    autoRechargeCardOpen: 'Abrir de nuevo',
    autoRechargeError: 'No se pudo cambiar la recarga automática. Inténtelo de nuevo.',
  },
  fr: {
    allowanceUnderOnePercent: 'Moins de {percent}',
    allowanceRefreshes: 'Se renouvelle le {date}',
    allowanceUnlimited: 'Illimité',
    allowanceNoLimit: "Aucune limite mensuelle d'utilisation de l'IA",
    allowanceCredits: 'Crédits de recharge : {percent} restants',
    allowanceCreditsUnderOnePercent: 'Crédits de recharge : moins de {percent} restant',
    autoRecharge: "Recharger automatiquement des crédits quand vous n'en avez plus, {amount} à la fois.",
    autoRechargeFailed: "La recharge automatique s'est désactivée, car son dernier prélèvement a échoué : {reason} Réactivez-la pour enregistrer une autre carte.",
    autoRechargeCard: 'Enregistrez une carte dans votre navigateur pour activer la recharge automatique.',
    autoRechargeCardOpen: 'Rouvrir',
    autoRechargeError: 'Impossible de modifier la recharge automatique. Réessayez.',
  },
  de: {
    allowanceUnderOnePercent: 'Weniger als {percent}',
    allowanceRefreshes: 'Wird am {date} erneuert',
    allowanceUnlimited: 'Unbegrenzt',
    allowanceNoLimit: 'Kein monatliches Limit für die KI-Nutzung',
    allowanceCredits: 'Aufladeguthaben: {percent} übrig',
    allowanceCreditsUnderOnePercent: 'Aufladeguthaben: weniger als {percent} übrig',
    autoRecharge: 'Guthaben automatisch aufladen, wenn es aufgebraucht ist, {amount} pro Aufladung.',
    autoRechargeFailed: 'Die automatische Aufladung wurde deaktiviert, weil die letzte Abbuchung fehlgeschlagen ist: {reason} Aktivieren Sie sie erneut, um eine andere Karte zu speichern.',
    autoRechargeCard: 'Speichern Sie in Ihrem Browser eine Karte, um die automatische Aufladung zu aktivieren.',
    autoRechargeCardOpen: 'Erneut öffnen',
    autoRechargeError: 'Die automatische Aufladung konnte nicht geändert werden. Versuchen Sie es erneut.',
  },
  ru: {
    allowanceUnderOnePercent: 'Менее {percent}',
    allowanceRefreshes: 'Обновится {date}',
    allowanceUnlimited: 'Без ограничений',
    allowanceNoLimit: 'Нет месячного лимита на использование ИИ',
    allowanceCredits: 'Кредиты пополнения: осталось {percent}',
    allowanceCreditsUnderOnePercent: 'Кредиты пополнения: осталось менее {percent}',
    autoRecharge: 'Автоматически пополнять кредиты, когда они закончатся, по {amount} за раз.',
    autoRechargeFailed: 'Автопополнение отключено, потому что последнее списание не прошло: {reason} Включите его снова, чтобы сохранить другую карту.',
    autoRechargeCard: 'Сохраните карту в браузере, чтобы включить автопополнение.',
    autoRechargeCardOpen: 'Открыть снова',
    autoRechargeError: 'Не удалось изменить автопополнение. Попробуйте еще раз.',
  },
  pt: {
    allowanceUnderOnePercent: 'Menos de {percent}',
    allowanceRefreshes: 'Renova em {date}',
    allowanceUnlimited: 'Ilimitado',
    allowanceNoLimit: 'Sem limite mensal de uso de IA',
    allowanceCredits: 'Créditos de recarga: resta {percent}',
    allowanceCreditsUnderOnePercent: 'Créditos de recarga: resta menos de {percent}',
    autoRecharge: 'Recarregar créditos automaticamente quando acabarem, {amount} por vez.',
    autoRechargeFailed: 'A recarga automática foi desativada porque a última cobrança falhou: {reason} Ative-a novamente para salvar outro cartão.',
    autoRechargeCard: 'Salve um cartão no navegador para ativar a recarga automática.',
    autoRechargeCardOpen: 'Abrir novamente',
    autoRechargeError: 'Não foi possível alterar a recarga automática. Tente novamente.',
  },
}
