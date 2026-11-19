/** Copy of the Add-ons button and dialog, owned by the locale dictionaries. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace of the game add-ons' browser half. */
export const NS = 'gameAddons'

/** English copy; its keys define {@link GameAddonsUiKey}. */
export const en = {
  'addons.button': 'Add-ons',
  'addons.tooltip': 'Choose the Godot and Blender add-ons that agents may use',
  'addons.title': 'Add-ons',
  'addons.description': 'Godot and Blender add-ons tested with WASD Engine. Agents add the ones a game needs. Turn one off to keep agents, including those connected through MCP, from using it.',
  'addons.godot': 'Godot add-ons',
  'addons.blender': 'Blender add-ons',
  'addons.close': 'Close',
  'addons.inGame': 'In this game',
  'addons.useWhen': 'Use it when: {text}',
  'addons.shipsWithBlender': 'Ships with Blender',
  'addons.withAssets': 'with {license} assets',
  'addons.credit': 'Its license requires this credit in the game: {credit}',
  'addons.allow': 'Let agents use {title}',
  'addons.onNotice': 'Agents can use {title} again.',
  'addons.offNotice': 'Agents no longer use {title}.',
  'addons.offInGameNotice': 'Agents no longer use {title}. This game still has it; ask the agent to remove it if the game should not use it.',
  'addons.loadFailed': 'Could not read the add-ons. {message}',
  'addons.failed': 'Could not change {title}. {message}',
} satisfies Record<string, string>

/** Keys of the add-ons' browser copy. */
export type GameAddonsUiKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Add-ons button and dialog. */
    gameAddons: GameAddonsUiKey
  }
}

/** Chinese copy. */
export const zh = {
  'addons.button': '扩展',
  'addons.tooltip': '选择智能体可以使用的 Godot 和 Blender 扩展',
  'addons.title': '扩展',
  'addons.description': '经过 WASD Engine 测试的 Godot 和 Blender 扩展。智能体会添加游戏需要的扩展。关闭某个扩展后，智能体（包括通过 MCP 连接的智能体）都不会再使用它。',
  'addons.godot': 'Godot 扩展',
  'addons.blender': 'Blender 扩展',
  'addons.close': '关闭',
  'addons.inGame': '已在这个游戏中',
  'addons.useWhen': '适用场景：{text}',
  'addons.shipsWithBlender': 'Blender 自带',
  'addons.withAssets': '含 {license} 素材',
  'addons.credit': '其许可证要求在游戏中注明：{credit}',
  'addons.allow': '允许智能体使用 {title}',
  'addons.onNotice': '智能体可以再次使用 {title}。',
  'addons.offNotice': '智能体不会再使用 {title}。',
  'addons.offInGameNotice': '智能体不会再使用 {title}。这个游戏中仍有它；如果游戏不应再使用它，请让智能体将其移除。',
  'addons.loadFailed': '无法读取扩展。{message}',
  'addons.failed': '无法更改 {title}。{message}',
} satisfies Record<GameAddonsUiKey, string>

/** Japanese copy. */
export const ja = {
  'addons.button': 'アドオン',
  'addons.tooltip': 'エージェントが使える Godot と Blender のアドオンを選びます',
  'addons.title': 'アドオン',
  'addons.description': 'WASD Engine で動作を確認した Godot と Blender のアドオンです。エージェントはゲームに必要なものを追加します。オフにしたアドオンは、MCP で接続したエージェントを含め、どのエージェントも使わなくなります。',
  'addons.godot': 'Godot アドオン',
  'addons.blender': 'Blender アドオン',
  'addons.close': '閉じる',
  'addons.inGame': 'このゲームにあり',
  'addons.useWhen': '使いどころ：{text}',
  'addons.shipsWithBlender': 'Blender に付属',
  'addons.withAssets': '{license} の素材付き',
  'addons.credit': 'ライセンスにより、ゲーム内に次のクレジットが必要です：{credit}',
  'addons.allow': 'エージェントに {title} の使用を許可',
  'addons.onNotice': 'エージェントが再び {title} を使えるようになりました。',
  'addons.offNotice': 'エージェントは {title} を使わなくなりました。',
  'addons.offInGameNotice': 'エージェントは {title} を使わなくなりました。このゲームにはまだ入っています。ゲームで使わないなら、エージェントに削除を頼んでください。',
  'addons.loadFailed': 'アドオンを読み込めませんでした。{message}',
  'addons.failed': '{title} を変更できませんでした。{message}',
} satisfies Record<GameAddonsUiKey, string>

/** Spanish copy; "Complementos" names the Plugins page, so the add-ons are "extensiones". */
export const es = {
  'addons.button': 'Extensiones',
  'addons.tooltip': 'Elija qué extensiones de Godot y Blender pueden usar los agentes',
  'addons.title': 'Extensiones',
  'addons.description': 'Extensiones de Godot y Blender probadas con WASD Engine. Los agentes añaden las que un juego necesita. Desactive una para que ningún agente la use, tampoco los conectados por MCP.',
  'addons.godot': 'Extensiones de Godot',
  'addons.blender': 'Extensiones de Blender',
  'addons.close': 'Cerrar',
  'addons.inGame': 'En este juego',
  'addons.useWhen': 'Úsela cuando: {text}',
  'addons.shipsWithBlender': 'Incluida en Blender',
  'addons.withAssets': 'con recursos {license}',
  'addons.credit': 'Su licencia exige este crédito en el juego: {credit}',
  'addons.allow': 'Permitir que los agentes usen {title}',
  'addons.onNotice': 'Los agentes pueden volver a usar {title}.',
  'addons.offNotice': 'Los agentes ya no usan {title}.',
  'addons.offInGameNotice': 'Los agentes ya no usan {title}. Este juego todavía la tiene; pida al agente que la quite si el juego no debe usarla.',
  'addons.loadFailed': 'No se pudieron leer las extensiones. {message}',
  'addons.failed': 'No se pudo cambiar {title}. {message}',
} satisfies Record<GameAddonsUiKey, string>

/** French copy. */
export const fr = {
  'addons.button': 'Modules',
  'addons.tooltip': 'Choisir les modules Godot et Blender que les agents peuvent utiliser',
  'addons.title': 'Modules',
  'addons.description': 'Des modules Godot et Blender testés avec WASD Engine. Les agents ajoutent ceux dont un jeu a besoin. Désactivez-en un pour qu\'aucun agent ne s\'en serve, y compris ceux connectés par MCP.',
  'addons.godot': 'Modules Godot',
  'addons.blender': 'Modules Blender',
  'addons.close': 'Fermer',
  'addons.inGame': 'Dans ce jeu',
  'addons.useWhen': 'À utiliser quand : {text}',
  'addons.shipsWithBlender': 'Fourni avec Blender',
  'addons.withAssets': 'avec des ressources {license}',
  'addons.credit': 'Sa licence exige cette mention dans le jeu : {credit}',
  'addons.allow': 'Autoriser les agents à utiliser {title}',
  'addons.onNotice': 'Les agents peuvent de nouveau utiliser {title}.',
  'addons.offNotice': 'Les agents n\'utilisent plus {title}.',
  'addons.offInGameNotice': 'Les agents n\'utilisent plus {title}. Ce jeu le contient encore ; demandez à l\'agent de le retirer si le jeu ne doit pas s\'en servir.',
  'addons.loadFailed': 'Impossible de lire les modules. {message}',
  'addons.failed': 'Impossible de modifier {title}. {message}',
} satisfies Record<GameAddonsUiKey, string>

/** German copy. */
export const de = {
  'addons.button': 'Add-ons',
  'addons.tooltip': 'Auswählen, welche Godot- und Blender-Add-ons Agenten verwenden dürfen',
  'addons.title': 'Add-ons',
  'addons.description': 'Mit WASD Engine getestete Add-ons für Godot und Blender. Agenten fügen die hinzu, die ein Spiel braucht. Schalten Sie eines aus, damit kein Agent es verwendet, auch keiner, der über MCP verbunden ist.',
  'addons.godot': 'Godot-Add-ons',
  'addons.blender': 'Blender-Add-ons',
  'addons.close': 'Schließen',
  'addons.inGame': 'In diesem Spiel',
  'addons.useWhen': 'Sinnvoll, wenn: {text}',
  'addons.shipsWithBlender': 'In Blender enthalten',
  'addons.withAssets': 'mit {license}-Assets',
  'addons.credit': 'Die Lizenz verlangt diesen Hinweis im Spiel: {credit}',
  'addons.allow': 'Agenten dürfen {title} verwenden',
  'addons.onNotice': 'Agenten können {title} wieder verwenden.',
  'addons.offNotice': 'Agenten verwenden {title} nicht mehr.',
  'addons.offInGameNotice': 'Agenten verwenden {title} nicht mehr. Dieses Spiel enthält es noch; bitten Sie den Agenten, es zu entfernen, wenn das Spiel es nicht verwenden soll.',
  'addons.loadFailed': 'Die Add-ons konnten nicht gelesen werden. {message}',
  'addons.failed': '{title} konnte nicht geändert werden. {message}',
} satisfies Record<GameAddonsUiKey, string>

/** Russian copy. */
export const ru = {
  'addons.button': 'Дополнения',
  'addons.tooltip': 'Выбрать дополнения Godot и Blender, которыми могут пользоваться агенты',
  'addons.title': 'Дополнения',
  'addons.description': 'Дополнения для Godot и Blender, проверенные в WASD Engine. Агенты добавляют те, что нужны игре. Выключите дополнение, чтобы ни один агент, в том числе подключённый через MCP, им не пользовался.',
  'addons.godot': 'Дополнения Godot',
  'addons.blender': 'Дополнения Blender',
  'addons.close': 'Закрыть',
  'addons.inGame': 'Есть в этой игре',
  'addons.useWhen': 'Когда пригодится: {text}',
  'addons.shipsWithBlender': 'Входит в Blender',
  'addons.withAssets': 'с ресурсами {license}',
  'addons.credit': 'Лицензия требует указать в игре: {credit}',
  'addons.allow': 'Разрешить агентам использовать {title}',
  'addons.onNotice': 'Агенты снова могут использовать {title}.',
  'addons.offNotice': 'Агенты больше не используют {title}.',
  'addons.offInGameNotice': 'Агенты больше не используют {title}. В этой игре оно ещё есть; попросите агента удалить его, если игра не должна им пользоваться.',
  'addons.loadFailed': 'Не удалось прочитать дополнения. {message}',
  'addons.failed': 'Не удалось изменить {title}. {message}',
} satisfies Record<GameAddonsUiKey, string>

/** Portuguese copy. */
export const pt = {
  'addons.button': 'Complementos',
  'addons.tooltip': 'Escolha quais complementos do Godot e do Blender os agentes podem usar',
  'addons.title': 'Complementos',
  'addons.description': 'Complementos do Godot e do Blender testados com o WASD Engine. Os agentes adicionam os de que um jogo precisa. Desative um para que nenhum agente o use, nem os conectados por MCP.',
  'addons.godot': 'Complementos do Godot',
  'addons.blender': 'Complementos do Blender',
  'addons.close': 'Fechar',
  'addons.inGame': 'Neste jogo',
  'addons.useWhen': 'Use quando: {text}',
  'addons.shipsWithBlender': 'Vem com o Blender',
  'addons.withAssets': 'com recursos {license}',
  'addons.credit': 'A licença exige este crédito no jogo: {credit}',
  'addons.allow': 'Permitir que os agentes usem {title}',
  'addons.onNotice': 'Os agentes podem voltar a usar {title}.',
  'addons.offNotice': 'Os agentes não usam mais {title}.',
  'addons.offInGameNotice': 'Os agentes não usam mais {title}. Este jogo ainda o tem; peça ao agente para removê-lo se o jogo não deve usá-lo.',
  'addons.loadFailed': 'Não foi possível ler os complementos. {message}',
  'addons.failed': 'Não foi possível alterar {title}. {message}',
} satisfies Record<GameAddonsUiKey, string>
