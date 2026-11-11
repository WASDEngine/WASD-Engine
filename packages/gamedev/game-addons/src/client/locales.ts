/** Copy of the Add-ons button and dialog, owned by the locale dictionaries. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace of the game add-ons' browser half. */
export const NS = 'gameAddons'

/** English copy; its keys define {@link GameAddonsUiKey}. */
export const en = {
  'addons.button': 'Add-ons',
  'addons.tooltip': 'Add Godot and Blender add-ons to this game',
  'addons.title': 'Add-ons',
  'addons.description': 'Godot and Blender add-ons tested with WASD Engine. Installing one adds it to this game, and the agent learns how to use it.',
  'addons.godot': 'Godot add-ons',
  'addons.blender': 'Blender add-ons',
  'addons.install': 'Install',
  'addons.remove': 'Remove',
  'addons.cancel': 'Cancel',
  'addons.close': 'Close',
  'addons.installed': 'Installed',
  'addons.found': 'In this project',
  'addons.useWhen': 'Use it when: {text}',
  'addons.shipsWithBlender': 'Ships with Blender',
  'addons.withAssets': 'with {license} assets',
  'addons.credit': 'Its license requires this credit in the game: {credit}',
  'addons.removeQuestion': 'Remove {title}? Scenes and scripts that use it stop working.',
  'addons.installedNotice': 'Installed {title}. The agent now has its guide.',
  'addons.removedNotice': 'Removed {title}.',
  'addons.references': 'These files still use it: {files}',
  'addons.loadFailed': 'Could not read this project\'s add-ons. {message}',
  'addons.failed': 'Could not change {title}. {message}',
  'addons.working': 'Working…',
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
  'addons.tooltip': '为这个游戏添加 Godot 和 Blender 扩展',
  'addons.title': '扩展',
  'addons.description': '经过 WASD Engine 测试的 Godot 和 Blender 扩展。安装后，它会加入这个游戏，智能体也会学会如何使用它。',
  'addons.godot': 'Godot 扩展',
  'addons.blender': 'Blender 扩展',
  'addons.install': '安装',
  'addons.remove': '移除',
  'addons.cancel': '取消',
  'addons.close': '关闭',
  'addons.installed': '已安装',
  'addons.found': '已在项目中',
  'addons.useWhen': '适用场景：{text}',
  'addons.shipsWithBlender': 'Blender 自带',
  'addons.withAssets': '含 {license} 素材',
  'addons.credit': '其许可证要求在游戏中注明：{credit}',
  'addons.removeQuestion': '要移除 {title} 吗？使用它的场景和脚本将无法正常工作。',
  'addons.installedNotice': '已安装 {title}。智能体现在有了它的使用指南。',
  'addons.removedNotice': '已移除 {title}。',
  'addons.references': '这些文件仍在使用它：{files}',
  'addons.loadFailed': '无法读取这个项目的扩展。{message}',
  'addons.failed': '无法更改 {title}。{message}',
  'addons.working': '处理中…',
} satisfies Record<GameAddonsUiKey, string>

/** Japanese copy. */
export const ja = {
  'addons.button': 'アドオン',
  'addons.tooltip': 'このゲームに Godot と Blender のアドオンを追加します',
  'addons.title': 'アドオン',
  'addons.description': 'WASD Engine で動作を確認した Godot と Blender のアドオンです。インストールするとこのゲームに追加され、エージェントが使い方を覚えます。',
  'addons.godot': 'Godot アドオン',
  'addons.blender': 'Blender アドオン',
  'addons.install': 'インストール',
  'addons.remove': '削除',
  'addons.cancel': 'キャンセル',
  'addons.close': '閉じる',
  'addons.installed': 'インストール済み',
  'addons.found': 'プロジェクト内にあり',
  'addons.useWhen': '使いどころ：{text}',
  'addons.shipsWithBlender': 'Blender に付属',
  'addons.withAssets': '{license} の素材付き',
  'addons.credit': 'ライセンスにより、ゲーム内に次のクレジットが必要です：{credit}',
  'addons.removeQuestion': '{title} を削除しますか？これを使うシーンやスクリプトは動かなくなります。',
  'addons.installedNotice': '{title} をインストールしました。エージェントが使い方のガイドを使えるようになりました。',
  'addons.removedNotice': '{title} を削除しました。',
  'addons.references': 'これらのファイルがまだ使っています：{files}',
  'addons.loadFailed': 'このプロジェクトのアドオンを読み込めませんでした。{message}',
  'addons.failed': '{title} を変更できませんでした。{message}',
  'addons.working': '処理中…',
} satisfies Record<GameAddonsUiKey, string>

/** Spanish copy; "Complementos" names the Plugins page, so the add-ons are "extensiones". */
export const es = {
  'addons.button': 'Extensiones',
  'addons.tooltip': 'Añada extensiones de Godot y Blender a este juego',
  'addons.title': 'Extensiones',
  'addons.description': 'Extensiones de Godot y Blender probadas con WASD Engine. Al instalar una, se añade a este juego y el agente aprende a usarla.',
  'addons.godot': 'Extensiones de Godot',
  'addons.blender': 'Extensiones de Blender',
  'addons.install': 'Instalar',
  'addons.remove': 'Quitar',
  'addons.cancel': 'Cancelar',
  'addons.close': 'Cerrar',
  'addons.installed': 'Instalada',
  'addons.found': 'En este proyecto',
  'addons.useWhen': 'Úsela cuando: {text}',
  'addons.shipsWithBlender': 'Incluida en Blender',
  'addons.withAssets': 'con recursos {license}',
  'addons.credit': 'Su licencia exige este crédito en el juego: {credit}',
  'addons.removeQuestion': '¿Quitar {title}? Las escenas y los scripts que la usan dejarán de funcionar.',
  'addons.installedNotice': 'Se instaló {title}. El agente ya tiene su guía.',
  'addons.removedNotice': 'Se quitó {title}.',
  'addons.references': 'Estos archivos todavía la usan: {files}',
  'addons.loadFailed': 'No se pudieron leer las extensiones de este proyecto. {message}',
  'addons.failed': 'No se pudo cambiar {title}. {message}',
  'addons.working': 'Procesando…',
} satisfies Record<GameAddonsUiKey, string>

/** French copy. */
export const fr = {
  'addons.button': 'Modules',
  'addons.tooltip': 'Ajouter des modules Godot et Blender à ce jeu',
  'addons.title': 'Modules',
  'addons.description': 'Des modules Godot et Blender testés avec WASD Engine. En installer un l\'ajoute à ce jeu, et l\'agent apprend à s\'en servir.',
  'addons.godot': 'Modules Godot',
  'addons.blender': 'Modules Blender',
  'addons.install': 'Installer',
  'addons.remove': 'Retirer',
  'addons.cancel': 'Annuler',
  'addons.close': 'Fermer',
  'addons.installed': 'Installé',
  'addons.found': 'Dans ce projet',
  'addons.useWhen': 'À utiliser quand : {text}',
  'addons.shipsWithBlender': 'Fourni avec Blender',
  'addons.withAssets': 'avec des ressources {license}',
  'addons.credit': 'Sa licence exige cette mention dans le jeu : {credit}',
  'addons.removeQuestion': 'Retirer {title} ? Les scènes et les scripts qui l\'utilisent cesseront de fonctionner.',
  'addons.installedNotice': '{title} est installé. L\'agent dispose maintenant de son guide.',
  'addons.removedNotice': '{title} a été retiré.',
  'addons.references': 'Ces fichiers l\'utilisent encore : {files}',
  'addons.loadFailed': 'Impossible de lire les modules de ce projet. {message}',
  'addons.failed': 'Impossible de modifier {title}. {message}',
  'addons.working': 'En cours…',
} satisfies Record<GameAddonsUiKey, string>

/** German copy. */
export const de = {
  'addons.button': 'Add-ons',
  'addons.tooltip': 'Godot- und Blender-Add-ons zu diesem Spiel hinzufügen',
  'addons.title': 'Add-ons',
  'addons.description': 'Mit WASD Engine getestete Add-ons für Godot und Blender. Wenn Sie eines installieren, kommt es in dieses Spiel, und der Agent lernt, es zu benutzen.',
  'addons.godot': 'Godot-Add-ons',
  'addons.blender': 'Blender-Add-ons',
  'addons.install': 'Installieren',
  'addons.remove': 'Entfernen',
  'addons.cancel': 'Abbrechen',
  'addons.close': 'Schließen',
  'addons.installed': 'Installiert',
  'addons.found': 'Im Projekt',
  'addons.useWhen': 'Sinnvoll, wenn: {text}',
  'addons.shipsWithBlender': 'In Blender enthalten',
  'addons.withAssets': 'mit {license}-Assets',
  'addons.credit': 'Die Lizenz verlangt diesen Hinweis im Spiel: {credit}',
  'addons.removeQuestion': '{title} entfernen? Szenen und Skripte, die es verwenden, funktionieren dann nicht mehr.',
  'addons.installedNotice': '{title} ist installiert. Der Agent hat jetzt seine Anleitung.',
  'addons.removedNotice': '{title} wurde entfernt.',
  'addons.references': 'Diese Dateien verwenden es noch: {files}',
  'addons.loadFailed': 'Die Add-ons dieses Projekts konnten nicht gelesen werden. {message}',
  'addons.failed': '{title} konnte nicht geändert werden. {message}',
  'addons.working': 'Wird ausgeführt …',
} satisfies Record<GameAddonsUiKey, string>

/** Russian copy. */
export const ru = {
  'addons.button': 'Дополнения',
  'addons.tooltip': 'Добавить в эту игру дополнения для Godot и Blender',
  'addons.title': 'Дополнения',
  'addons.description': 'Дополнения для Godot и Blender, проверенные в WASD Engine. Установленное дополнение появляется в этой игре, а агент узнаёт, как им пользоваться.',
  'addons.godot': 'Дополнения Godot',
  'addons.blender': 'Дополнения Blender',
  'addons.install': 'Установить',
  'addons.remove': 'Удалить',
  'addons.cancel': 'Отмена',
  'addons.close': 'Закрыть',
  'addons.installed': 'Установлено',
  'addons.found': 'Есть в проекте',
  'addons.useWhen': 'Когда пригодится: {text}',
  'addons.shipsWithBlender': 'Входит в Blender',
  'addons.withAssets': 'с ресурсами {license}',
  'addons.credit': 'Лицензия требует указать в игре: {credit}',
  'addons.removeQuestion': 'Удалить {title}? Сцены и скрипты, которые его используют, перестанут работать.',
  'addons.installedNotice': '{title} установлено. Теперь у агента есть руководство по нему.',
  'addons.removedNotice': '{title} удалено.',
  'addons.references': 'Эти файлы всё ещё его используют: {files}',
  'addons.loadFailed': 'Не удалось прочитать дополнения этого проекта. {message}',
  'addons.failed': 'Не удалось изменить {title}. {message}',
  'addons.working': 'Выполняется…',
} satisfies Record<GameAddonsUiKey, string>

/** Portuguese copy. */
export const pt = {
  'addons.button': 'Complementos',
  'addons.tooltip': 'Adicione complementos do Godot e do Blender a este jogo',
  'addons.title': 'Complementos',
  'addons.description': 'Complementos do Godot e do Blender testados com o WASD Engine. Ao instalar um, ele é adicionado a este jogo e o agente aprende a usá-lo.',
  'addons.godot': 'Complementos do Godot',
  'addons.blender': 'Complementos do Blender',
  'addons.install': 'Instalar',
  'addons.remove': 'Remover',
  'addons.cancel': 'Cancelar',
  'addons.close': 'Fechar',
  'addons.installed': 'Instalado',
  'addons.found': 'Neste projeto',
  'addons.useWhen': 'Use quando: {text}',
  'addons.shipsWithBlender': 'Vem com o Blender',
  'addons.withAssets': 'com recursos {license}',
  'addons.credit': 'A licença exige este crédito no jogo: {credit}',
  'addons.removeQuestion': 'Remover {title}? As cenas e os scripts que o usam deixarão de funcionar.',
  'addons.installedNotice': '{title} foi instalado. O agente agora tem o guia dele.',
  'addons.removedNotice': '{title} foi removido.',
  'addons.references': 'Estes arquivos ainda o usam: {files}',
  'addons.loadFailed': 'Não foi possível ler os complementos deste projeto. {message}',
  'addons.failed': 'Não foi possível alterar {title}. {message}',
  'addons.working': 'Processando…',
} satisfies Record<GameAddonsUiKey, string>
