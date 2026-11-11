/**
 * The consent a user confirms before a voice is cloned. ElevenLabs makes the account holder confirm, for every clone,
 * the right and consent to clone the voice, and the WASD Engine API records the version of the statement each owner
 * confirmed. In a Session, WASD Engine's approval prompt shows the statement; an agent connected through the MCP
 * server must have its user confirm it and pass `consent: true`.
 * @module @deepseek-ai/dsh-elevenlabs/src/consent
 */

/** Version of {@link CONSENT_STATEMENT} that the API records with each clone. */
export const CONSENT_STATEMENT_VERSION = '2026-11-11'

/** The statement, word for word as the API keeps it under {@link CONSENT_STATEMENT_VERSION}. */
export const CONSENT_STATEMENT = 'These recordings are of my own voice, or of a person who gave me express permission to clone their voice for this purpose, and I will not use the cloned voice to impersonate, deceive, or harm anyone.'

/** The approval prompt of one clone in WASD Engine's languages; `en` is the audit text. */
export interface ConsentPrompt {
  readonly en: string
  readonly [locale: string]: string
}

/**
 * The approval prompt that asks the user to confirm consent for one clone.
 * @param name - the clone's name.
 * @param files - the recordings' file names.
 * @returns the prompt in each language.
 */
export function consentPrompt(name: string, files: readonly string[]): ConsentPrompt {
  const quoted = JSON.stringify(name)
  const list = files.join(', ')
  return {
    en: `Clone a voice named ${quoted} from ${list}? Approve only if this is true: ${CONSENT_STATEMENT}`,
    zh: `要用 ${list} 克隆名为 ${quoted} 的声音吗？只有在以下内容属实时才批准：这些录音是我自己的声音，或是明确允许我为此克隆其声音的人的声音，并且我不会用克隆的声音冒充、欺骗或伤害任何人。`,
    ja: `${list} から ${quoted} という名前の声をクローンしますか？次の内容が事実である場合にのみ承認してください：これらの録音は自分の声、または声のクローンをこの目的で明示的に許可した人の声であり、クローンした声を使って誰かになりすましたり、欺いたり、傷つけたりしません。`,
    es: `¿Clonar una voz llamada ${quoted} a partir de ${list}? Apruébelo solo si esto es cierto: estas grabaciones son de mi propia voz, o de una persona que me dio permiso expreso para clonar su voz con este fin, y no usaré la voz clonada para suplantar, engañar ni dañar a nadie.`,
    fr: `Cloner une voix nommée ${quoted} à partir de ${list} ? N’approuvez que si ceci est vrai : ces enregistrements sont de ma propre voix, ou de celle d’une personne qui m’a expressément autorisé à cloner sa voix à cette fin, et je n’utiliserai pas la voix clonée pour usurper l’identité de quiconque, le tromper ou lui nuire.`,
    de: `Eine Stimme namens ${quoted} aus ${list} klonen? Nur genehmigen, wenn dies zutrifft: Diese Aufnahmen sind meine eigene Stimme oder die einer Person, die mir ausdrücklich erlaubt hat, ihre Stimme zu diesem Zweck zu klonen, und ich werde die geklonte Stimme nicht verwenden, um jemanden nachzuahmen, zu täuschen oder ihm zu schaden.`,
    ru: `Клонировать голос с именем ${quoted} по записям ${list}? Подтверждайте, только если это правда: это записи моего собственного голоса или голоса человека, который явно разрешил мне клонировать его голос для этой цели, и я не буду использовать клонированный голос, чтобы выдавать себя за кого-либо, обманывать или причинять вред.`,
    pt: `Clonar uma voz chamada ${quoted} a partir de ${list}? Aprove apenas se isto for verdade: estas gravações são da minha própria voz, ou de uma pessoa que me deu permissão expressa para clonar a sua voz para este fim, e não usarei a voz clonada para me passar por alguém, enganar ou prejudicar ninguém.`,
  }
}
