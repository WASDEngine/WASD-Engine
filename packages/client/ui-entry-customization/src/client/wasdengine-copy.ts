/**
 * WASD Engine copy for the More menu rows (fork-owned; `wasdengine/FORK.md` lists the fork changes): the Customize
 * mode drafts that Create your plugin starts ask for a WASD Engine plugin instead of a DSH plugin.
 */

/** Messages of the `entryCustomization` namespace that WASD Engine rewrites, by language. */
export const WASDENGINE_ENTRY_CUSTOMIZATION_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'createPrompt.sidebar': 'Create a WASD Engine plugin with a left sidebar entry.',
    'createPrompt.conversation': 'Create a WASD Engine conversation view plugin.',
    'createPrompt.rightbar': 'Create a WASD Engine plugin with a right sidebar entry.',
  },
  zh: {
    'createPrompt.sidebar': '创建一个带左侧栏入口的 WASD Engine 插件。',
    'createPrompt.conversation': '创建一个 WASD Engine 会话视图插件。',
    'createPrompt.rightbar': '创建一个带右侧栏入口的 WASD Engine 插件。',
  },
  ja: {
    'createPrompt.sidebar': '左サイドバーにエントリを持つ WASD Engine プラグインを作成します。',
    'createPrompt.conversation': 'WASD Engine 会話ビュープラグインを作成します。',
    'createPrompt.rightbar': '右サイドバーにエントリを持つ WASD Engine プラグインを作成します。',
  },
  es: {
    'createPrompt.sidebar': 'Cree un complemento de WASD Engine con una entrada en la barra lateral izquierda.',
    'createPrompt.conversation': 'Cree un complemento de vista de conversación de WASD Engine.',
    'createPrompt.rightbar': 'Cree un complemento de WASD Engine con una entrada en la barra lateral derecha.',
  },
  fr: {
    'createPrompt.sidebar': 'Créez un plugin WASD Engine avec une entrée dans la barre latérale gauche.',
    'createPrompt.conversation': "Créez un plugin d'affichage de conversation pour WASD Engine.",
    'createPrompt.rightbar': 'Créez un plugin WASD Engine avec une entrée dans la barre latérale droite.',
  },
  de: {
    'createPrompt.sidebar': 'Erstellen Sie ein Plugin für WASD Engine mit einem Eintrag in der linken Seitenleiste.',
    'createPrompt.conversation': 'Erstellen Sie für WASD Engine ein Plugin für die Konversationsansicht.',
    'createPrompt.rightbar': 'Erstellen Sie ein Plugin für WASD Engine mit einem Eintrag in der rechten Seitenleiste.',
  },
  ru: {
    'createPrompt.sidebar': 'Создайте плагин для WASD Engine с записью на левой боковой панели.',
    'createPrompt.conversation': 'Создайте плагин просмотра диалога для WASD Engine.',
    'createPrompt.rightbar': 'Создайте плагин для WASD Engine с записью на правой боковой панели.',
  },
  pt: {
    'createPrompt.sidebar': 'Crie um plug-in para o WASD Engine com uma entrada na barra lateral esquerda.',
    'createPrompt.conversation': 'Crie um plug-in de visualização de conversa para o WASD Engine.',
    'createPrompt.rightbar': 'Crie um plug-in para o WASD Engine com uma entrada na barra lateral direita.',
  },
}

/**
 * Brand the More menu dictionaries for registration. The inputs stay unchanged, so code that imports the upstream
 * dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `entryCustomization` dictionary, keyed by language.
 * @returns copies whose Create your plugin drafts ask for a WASD Engine plugin.
 * @throws when a language has no WASD Engine copy, or the copy names a message its dictionary lacks.
 */
export function brandEntryCustomizationDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const overrides = WASDENGINE_ENTRY_CUSTOMIZATION_COPY[language]
    if (overrides === undefined) throw new Error(`WASD Engine entry copy: ${language} has no WASD Engine copy`)
    const copy: Record<string, string> = { ...messages }
    for (const [key, message] of Object.entries(overrides)) {
      if (!(key in copy)) throw new Error(`WASD Engine entry copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
