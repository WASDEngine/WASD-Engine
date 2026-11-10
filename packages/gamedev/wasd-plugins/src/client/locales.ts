/** Copy of the Release button and Explore Games, owned by the locale dictionaries. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace of WASD Engine Plugins' browser half. */
export const NS = 'wasdPlugins'

/** English copy; its keys define {@link WasdPluginsUiKey}. */
export const en = {
  'release.button': 'Release',
  'release.tooltip': 'Publish this game on WASD Engine with a link anyone can play',
  'release.title': 'Release a new version',
  'release.description': 'The agent exports the game for the Web and publishes it on WASD Engine as the next version, at a link you can share with your friends.',
  'release.latest': 'Latest release: version {version}',
  'release.open': 'Open the game page',
  'release.notes': 'Release notes',
  'release.notesHint': 'Optional. Leave it empty and the agent writes them from what changed.',
  'release.notesPlaceholder': 'What is new in this version?',
  'release.notGodot': 'Release publishes Godot games, and this project has no project.godot yet.',
  'release.loadFailed': 'Could not read this project\'s releases. {message}',
  'release.confirm': 'Release',
  'release.cancel': 'Cancel',
  'release.close': 'Close',
  'release.failed': 'Could not start the release. {message}',
  'release.prompt': 'Release this game on WASD Engine: call wasd_release_game with short release notes about what changed since the last release, then give me the share link.',
  'release.promptWithNotes': 'Release this game on WASD Engine: call wasd_release_game with these release notes, then give me the share link.\n\nRelease notes: {notes}',
  'explore.label': 'Explore Games',
  'explore.tooltip': 'Play the games people release with WASD Engine',
} satisfies Record<string, string>

/** Keys of WASD Engine Plugins' browser copy. */
export type WasdPluginsUiKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Release button and Explore Games. */
    wasdPlugins: WasdPluginsUiKey
  }
}

/** Chinese copy. */
export const zh = {
  'release.button': '发布',
  'release.tooltip': '在 WASD Engine 上发布这个游戏，任何人都能通过链接游玩',
  'release.title': '发布新版本',
  'release.description': '智能体会把游戏导出为网页版，并作为下一个版本发布到 WASD Engine，你可以把链接分享给朋友。',
  'release.latest': '最新发布：第 {version} 版',
  'release.open': '打开游戏页面',
  'release.notes': '更新说明',
  'release.notesHint': '可选。留空时，智能体会根据改动撰写。',
  'release.notesPlaceholder': '这个版本有什么新内容？',
  'release.notGodot': '发布功能适用于 Godot 游戏，而这个项目还没有 project.godot。',
  'release.loadFailed': '无法读取这个项目的发布记录。{message}',
  'release.confirm': '发布',
  'release.cancel': '取消',
  'release.close': '关闭',
  'release.failed': '无法开始发布。{message}',
  'release.prompt': '在 WASD Engine 上发布这个游戏：调用 wasd_release_game，并附上简短的更新说明，概括自上次发布以来的改动，然后把分享链接给我。',
  'release.promptWithNotes': '在 WASD Engine 上发布这个游戏：调用 wasd_release_game 并使用下面的更新说明，然后把分享链接给我。\n\n更新说明：{notes}',
  'explore.label': '探索游戏',
  'explore.tooltip': '游玩大家用 WASD Engine 发布的游戏',
} satisfies Record<WasdPluginsUiKey, string>

/** Japanese copy. */
export const ja = {
  'release.button': 'リリース',
  'release.tooltip': 'このゲームを WASD Engine で公開し、誰でも遊べるリンクを作ります',
  'release.title': '新しいバージョンをリリース',
  'release.description': 'エージェントがゲームを Web 向けに書き出し、次のバージョンとして WASD Engine に公開します。リンクは友だちと共有できます。',
  'release.latest': '最新リリース：バージョン {version}',
  'release.open': 'ゲームページを開く',
  'release.notes': 'リリースノート',
  'release.notesHint': '任意です。空欄の場合は、変更内容からエージェントが書きます。',
  'release.notesPlaceholder': 'このバージョンの新しい点は？',
  'release.notGodot': 'リリースは Godot のゲームに対応しています。このプロジェクトにはまだ project.godot がありません。',
  'release.loadFailed': 'このプロジェクトのリリースを読み込めませんでした。{message}',
  'release.confirm': 'リリース',
  'release.cancel': 'キャンセル',
  'release.close': '閉じる',
  'release.failed': 'リリースを開始できませんでした。{message}',
  'release.prompt': 'このゲームを WASD Engine でリリースしてください。前回のリリースからの変更をまとめた短いリリースノートを付けて wasd_release_game を呼び出し、共有リンクを教えてください。',
  'release.promptWithNotes': 'このゲームを WASD Engine でリリースしてください。次のリリースノートで wasd_release_game を呼び出し、共有リンクを教えてください。\n\nリリースノート：{notes}',
  'explore.label': 'ゲームを探す',
  'explore.tooltip': 'WASD Engine でリリースされたゲームを遊ぶ',
} satisfies Record<WasdPluginsUiKey, string>

/** Spanish copy. */
export const es = {
  'release.button': 'Publicar',
  'release.tooltip': 'Publica este juego en WASD Engine con un enlace que cualquiera puede jugar',
  'release.title': 'Publicar una nueva versión',
  'release.description': 'El agente exporta el juego para la web y lo publica en WASD Engine como la siguiente versión, en un enlace que puedes compartir con tus amigos.',
  'release.latest': 'Última publicación: versión {version}',
  'release.open': 'Abrir la página del juego',
  'release.notes': 'Notas de la versión',
  'release.notesHint': 'Opcional. Si lo dejas vacío, el agente las escribe a partir de los cambios.',
  'release.notesPlaceholder': '¿Qué hay de nuevo en esta versión?',
  'release.notGodot': 'Publicar funciona con juegos de Godot, y este proyecto todavía no tiene project.godot.',
  'release.loadFailed': 'No se pudieron leer las publicaciones de este proyecto. {message}',
  'release.confirm': 'Publicar',
  'release.cancel': 'Cancelar',
  'release.close': 'Cerrar',
  'release.failed': 'No se pudo iniciar la publicación. {message}',
  'release.prompt': 'Publica este juego en WASD Engine: llama a wasd_release_game con unas notas breves sobre lo que cambió desde la última publicación y luego dame el enlace para compartir.',
  'release.promptWithNotes': 'Publica este juego en WASD Engine: llama a wasd_release_game con estas notas de la versión y luego dame el enlace para compartir.\n\nNotas de la versión: {notes}',
  'explore.label': 'Explorar juegos',
  'explore.tooltip': 'Juega a los juegos que la gente publica con WASD Engine',
} satisfies Record<WasdPluginsUiKey, string>

/** French copy. */
export const fr = {
  'release.button': 'Publier',
  'release.tooltip': 'Publier ce jeu sur WASD Engine avec un lien jouable par tous',
  'release.title': 'Publier une nouvelle version',
  'release.description': 'L’agent exporte le jeu pour le Web et le publie sur WASD Engine comme version suivante, à un lien que vous pouvez partager avec vos amis.',
  'release.latest': 'Dernière publication : version {version}',
  'release.open': 'Ouvrir la page du jeu',
  'release.notes': 'Notes de version',
  'release.notesHint': 'Facultatif. Laissez vide et l’agent les rédige à partir des changements.',
  'release.notesPlaceholder': 'Quoi de neuf dans cette version ?',
  'release.notGodot': 'La publication fonctionne avec les jeux Godot, et ce projet n’a pas encore de project.godot.',
  'release.loadFailed': 'Impossible de lire les publications de ce projet. {message}',
  'release.confirm': 'Publier',
  'release.cancel': 'Annuler',
  'release.close': 'Fermer',
  'release.failed': 'Impossible de lancer la publication. {message}',
  'release.prompt': 'Publie ce jeu sur WASD Engine : appelle wasd_release_game avec de courtes notes de version sur ce qui a changé depuis la dernière publication, puis donne-moi le lien de partage.',
  'release.promptWithNotes': 'Publie ce jeu sur WASD Engine : appelle wasd_release_game avec ces notes de version, puis donne-moi le lien de partage.\n\nNotes de version : {notes}',
  'explore.label': 'Explorer les jeux',
  'explore.tooltip': 'Jouer aux jeux publiés avec WASD Engine',
} satisfies Record<WasdPluginsUiKey, string>

/** German copy. */
export const de = {
  'release.button': 'Veröffentlichen',
  'release.tooltip': 'Dieses Spiel auf WASD Engine veröffentlichen, mit einem Link, den jeder spielen kann',
  'release.title': 'Neue Version veröffentlichen',
  'release.description': 'Der Agent exportiert das Spiel für das Web und veröffentlicht es auf WASD Engine als nächste Version, unter einem Link, den du mit Freunden teilen kannst.',
  'release.latest': 'Neueste Veröffentlichung: Version {version}',
  'release.open': 'Spielseite öffnen',
  'release.notes': 'Versionshinweise',
  'release.notesHint': 'Optional. Bleibt das Feld leer, schreibt der Agent sie anhand der Änderungen.',
  'release.notesPlaceholder': 'Was ist neu in dieser Version?',
  'release.notGodot': 'Veröffentlichen funktioniert mit Godot-Spielen, und dieses Projekt hat noch keine project.godot.',
  'release.loadFailed': 'Die Veröffentlichungen dieses Projekts konnten nicht gelesen werden. {message}',
  'release.confirm': 'Veröffentlichen',
  'release.cancel': 'Abbrechen',
  'release.close': 'Schließen',
  'release.failed': 'Die Veröffentlichung konnte nicht gestartet werden. {message}',
  'release.prompt': 'Veröffentliche dieses Spiel auf WASD Engine: Rufe wasd_release_game mit kurzen Versionshinweisen zu den Änderungen seit der letzten Veröffentlichung auf und gib mir dann den Link zum Teilen.',
  'release.promptWithNotes': 'Veröffentliche dieses Spiel auf WASD Engine: Rufe wasd_release_game mit diesen Versionshinweisen auf und gib mir dann den Link zum Teilen.\n\nVersionshinweise: {notes}',
  'explore.label': 'Spiele entdecken',
  'explore.tooltip': 'Spiele spielen, die mit WASD Engine veröffentlicht wurden',
} satisfies Record<WasdPluginsUiKey, string>

/** Russian copy. */
export const ru = {
  'release.button': 'Выпустить',
  'release.tooltip': 'Опубликовать игру в WASD Engine по ссылке, по которой в неё может сыграть любой',
  'release.title': 'Выпуск новой версии',
  'release.description': 'Агент экспортирует игру для веба и публикует её в WASD Engine как следующую версию по ссылке, которой можно поделиться с друзьями.',
  'release.latest': 'Последний выпуск: версия {version}',
  'release.open': 'Открыть страницу игры',
  'release.notes': 'Примечания к выпуску',
  'release.notesHint': 'Необязательно. Если оставить пустым, агент напишет их по изменениям.',
  'release.notesPlaceholder': 'Что нового в этой версии?',
  'release.notGodot': 'Выпуск работает с играми на Godot, а в этом проекте пока нет project.godot.',
  'release.loadFailed': 'Не удалось прочитать выпуски этого проекта. {message}',
  'release.confirm': 'Выпустить',
  'release.cancel': 'Отмена',
  'release.close': 'Закрыть',
  'release.failed': 'Не удалось начать выпуск. {message}',
  'release.prompt': 'Выпусти эту игру в WASD Engine: вызови wasd_release_game с короткими примечаниями о том, что изменилось с прошлого выпуска, а затем дай мне ссылку, чтобы поделиться.',
  'release.promptWithNotes': 'Выпусти эту игру в WASD Engine: вызови wasd_release_game с этими примечаниями к выпуску, а затем дай мне ссылку, чтобы поделиться.\n\nПримечания к выпуску: {notes}',
  'explore.label': 'Обзор игр',
  'explore.tooltip': 'Играйте в игры, выпущенные с WASD Engine',
} satisfies Record<WasdPluginsUiKey, string>

/** Portuguese copy. */
export const pt = {
  'release.button': 'Publicar',
  'release.tooltip': 'Publique este jogo no WASD Engine com um link que qualquer pessoa pode jogar',
  'release.title': 'Publicar uma nova versão',
  'release.description': 'O agente exporta o jogo para a web e o publica no WASD Engine como a próxima versão, em um link que você pode compartilhar com seus amigos.',
  'release.latest': 'Última publicação: versão {version}',
  'release.open': 'Abrir a página do jogo',
  'release.notes': 'Notas da versão',
  'release.notesHint': 'Opcional. Se ficar vazio, o agente as escreve a partir das mudanças.',
  'release.notesPlaceholder': 'O que há de novo nesta versão?',
  'release.notGodot': 'Publicar funciona com jogos Godot, e este projeto ainda não tem project.godot.',
  'release.loadFailed': 'Não foi possível ler as publicações deste projeto. {message}',
  'release.confirm': 'Publicar',
  'release.cancel': 'Cancelar',
  'release.close': 'Fechar',
  'release.failed': 'Não foi possível iniciar a publicação. {message}',
  'release.prompt': 'Publique este jogo no WASD Engine: chame wasd_release_game com notas curtas sobre o que mudou desde a última publicação e depois me dê o link para compartilhar.',
  'release.promptWithNotes': 'Publique este jogo no WASD Engine: chame wasd_release_game com estas notas da versão e depois me dê o link para compartilhar.\n\nNotas da versão: {notes}',
  'explore.label': 'Explorar jogos',
  'explore.tooltip': 'Jogue os jogos que as pessoas publicam com o WASD Engine',
} satisfies Record<WasdPluginsUiKey, string>
