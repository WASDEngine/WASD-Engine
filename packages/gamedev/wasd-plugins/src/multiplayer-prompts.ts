/**
 * The approval prompts of the multiplayer tools in WASD Engine's languages, which the Session's approval prompt shows
 * before a server purchase, a size change, a deletion, or a restore; `en` is also the audit text. A purchase or a
 * change still needs the user's confirmation on the site afterwards; the prompt says so, with the price, or that the
 * server is free when WASD Engine gave the account free servers of its size.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-prompts
 */

/** One prompt in WASD Engine's languages; `en` is the audit text. */
export interface LocalizedPrompt {
  readonly en: string
  readonly [locale: string]: string
}

/**
 * The prompt before a new server.
 * @param size - the size's name, such as `Small`.
 * @param price - the monthly price, such as `$5`.
 * @param game - the game's title.
 * @param site - the site's host, such as `app.wasdengine.com`.
 * @returns the prompt.
 */
export function createPrompt(size: string, price: string, game: string, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(game)
  return {
    en: `Create a ${size} game server for ${quoted} at ${price} a month? WASD Engine then opens a page on ${site} where you confirm and pay; nothing is charged before that.`,
    zh: `要为 ${quoted} 创建一台 ${size} 游戏服务器，每月 ${price} 吗？随后 WASD Engine 会打开 ${site} 上的页面，你在那里确认并付款；在此之前不会扣费。`,
    ja: `${quoted} の ${size} ゲームサーバーを月額 ${price} で作成しますか？このあと WASD Engine が ${site} のページを開き、そこで確認して支払います。それまで料金はかかりません。`,
    es: `¿Crear un servidor de juego ${size} para ${quoted} por ${price} al mes? Después, WASD Engine abre una página en ${site} donde confirmas y pagas; no se cobra nada antes.`,
    fr: `Créer un serveur de jeu ${size} pour ${quoted} à ${price} par mois ? WASD Engine ouvre ensuite une page sur ${site} où vous confirmez et payez ; rien n’est facturé avant.`,
    de: `Einen ${size}-Spielserver für ${quoted} für ${price} im Monat erstellen? WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst und bezahlst; vorher wird nichts berechnet.`,
    ru: `Создать игровой сервер ${size} для ${quoted} за ${price} в месяц? Затем WASD Engine откроет страницу на ${site}, где вы подтвердите и оплатите; до этого ничего не списывается.`,
    pt: `Criar um servidor de jogo ${size} para ${quoted} por ${price} por mês? Depois, o WASD Engine abre uma página em ${site} onde você confirma e paga; nada é cobrado antes disso.`,
  }
}

/**
 * The prompt before a new server that one of the account's free servers covers.
 * @param size - the size's name, such as `Small`.
 * @param game - the game's title.
 * @param site - the site's host, such as `app.wasdengine.com`.
 * @returns the prompt.
 */
export function createFreePrompt(size: string, game: string, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(game)
  return {
    en: `Create a free ${size} game server for ${quoted}? WASD Engine gave this account free ${size} servers, so it costs nothing. WASD Engine then opens a page on ${site} where you confirm.`,
    zh: `要为 ${quoted} 创建一台免费的 ${size} 游戏服务器吗？WASD Engine 为此账号提供了免费的 ${size} 服务器，因此不收取任何费用。随后 WASD Engine 会打开 ${site} 上的页面，由你确认。`,
    ja: `${quoted} の ${size} ゲームサーバーを無料で作成しますか？WASD Engine がこのアカウントに無料の ${size} サーバーを付与しているため、料金はかかりません。このあと WASD Engine が ${site} のページを開き、そこで確認します。`,
    es: `¿Crear un servidor de juego ${size} gratuito para ${quoted}? WASD Engine le dio a esta cuenta servidores ${size} gratuitos, así que no cuesta nada. Después, WASD Engine abre una página en ${site} donde confirmas.`,
    fr: `Créer un serveur de jeu ${size} gratuit pour ${quoted} ? WASD Engine a offert à ce compte des serveurs ${size} gratuits, il ne coûte donc rien. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez.`,
    de: `Einen kostenlosen ${size}-Spielserver für ${quoted} erstellen? WASD Engine hat diesem Konto kostenlose ${size}-Server gegeben, daher kostet er nichts. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst.`,
    ru: `Создать бесплатный игровой сервер ${size} для ${quoted}? WASD Engine выдал этому аккаунту бесплатные серверы ${size}, поэтому он ничего не стоит. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите.`,
    pt: `Criar um servidor de jogo ${size} gratuito para ${quoted}? O WASD Engine deu a esta conta servidores ${size} gratuitos, então ele não custa nada. Depois, o WASD Engine abre uma página em ${site} onde você confirma.`,
  }
}

/**
 * The prompt before a new size.
 * @param server - the server's name.
 * @param from - the current size's name and price, such as `Small ($5 a month)` or `Small (free)`.
 * @param to - the new size's name and price, or `(free)`.
 * @param site - the site's host.
 * @returns the prompt.
 */
export function resizePrompt(server: string, from: string, to: string, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(server)
  return {
    en: `Change the server ${quoted} from ${from} to ${to}? WASD Engine then opens a page on ${site} where you confirm the change; your bill changes only after that.`,
    zh: `要把服务器 ${quoted} 从 ${from} 改为 ${to} 吗？随后 WASD Engine 会打开 ${site} 上的页面，你在那里确认更改；之后账单才会变化。`,
    ja: `サーバー ${quoted} を ${from} から ${to} に変更しますか？このあと WASD Engine が ${site} のページを開き、そこで変更を確認します。請求はそのあとで変わります。`,
    es: `¿Cambiar el servidor ${quoted} de ${from} a ${to}? Después, WASD Engine abre una página en ${site} donde confirmas el cambio; tu factura cambia solo después.`,
    fr: `Passer le serveur ${quoted} de ${from} à ${to} ? WASD Engine ouvre ensuite une page sur ${site} où vous confirmez le changement ; votre facture ne change qu’après.`,
    de: `Den Server ${quoted} von ${from} auf ${to} ändern? WASD Engine öffnet danach eine Seite auf ${site}, auf der du die Änderung bestätigst; erst dann ändert sich deine Rechnung.`,
    ru: `Изменить сервер ${quoted} с ${from} на ${to}? Затем WASD Engine откроет страницу на ${site}, где вы подтвердите изменение; счёт изменится только после этого.`,
    pt: `Mudar o servidor ${quoted} de ${from} para ${to}? Depois, o WASD Engine abre uma página em ${site} onde você confirma a mudança; sua conta só muda depois disso.`,
  }
}

/**
 * The prompt before a deletion.
 * @param server - the server's name.
 * @param site - the site's host.
 * @returns the prompt.
 */
export function deletePrompt(server: string, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(server)
  return {
    en: `Delete the server ${quoted}? It stops for every player, its billing ends, and its world is deleted 7 days later. WASD Engine then opens a page on ${site} where you confirm.`,
    zh: `要删除服务器 ${quoted} 吗？它会对所有玩家停止，计费结束，7 天后其世界数据会被删除。随后 WASD Engine 会打开 ${site} 上的页面，由你确认。`,
    ja: `サーバー ${quoted} を削除しますか？すべてのプレイヤーに対して停止し、課金が終わり、7 日後にワールドが削除されます。このあと WASD Engine が ${site} のページを開き、そこで確認します。`,
    es: `¿Eliminar el servidor ${quoted}? Se detiene para todos los jugadores, su facturación termina y su mundo se elimina 7 días después. Después, WASD Engine abre una página en ${site} donde confirmas.`,
    fr: `Supprimer le serveur ${quoted} ? Il s’arrête pour tous les joueurs, sa facturation prend fin et son monde est supprimé 7 jours plus tard. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez.`,
    de: `Den Server ${quoted} löschen? Er stoppt für alle Spieler, seine Abrechnung endet, und seine Welt wird 7 Tage später gelöscht. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst.`,
    ru: `Удалить сервер ${quoted}? Он остановится для всех игроков, оплата прекратится, а его мир будет удалён через 7 дней. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите.`,
    pt: `Excluir o servidor ${quoted}? Ele para para todos os jogadores, a cobrança termina e o mundo dele é excluído 7 dias depois. Depois, o WASD Engine abre uma página em ${site} onde você confirma.`,
  }
}

/**
 * The prompt before a restore.
 * @param server - the server's name.
 * @param backup - when the backup was taken, as the site reports it.
 * @returns the prompt.
 */
export function restorePrompt(server: string, backup: string): LocalizedPrompt {
  const quoted = JSON.stringify(server)
  return {
    en: `Restore the server ${quoted} from the backup of ${backup}? Its current world is replaced, and players get a warning before it restarts.`,
    zh: `要用 ${backup} 的备份恢复服务器 ${quoted} 吗？它当前的世界会被替换，重启前玩家会收到提醒。`,
    ja: `サーバー ${quoted} を ${backup} のバックアップから復元しますか？現在のワールドは置き換えられ、再起動の前にプレイヤーに警告が表示されます。`,
    es: `¿Restaurar el servidor ${quoted} desde la copia de ${backup}? Su mundo actual se reemplaza y los jugadores reciben un aviso antes de que se reinicie.`,
    fr: `Restaurer le serveur ${quoted} à partir de la sauvegarde du ${backup} ? Son monde actuel est remplacé, et les joueurs sont prévenus avant son redémarrage.`,
    de: `Den Server ${quoted} aus der Sicherung vom ${backup} wiederherstellen? Seine aktuelle Welt wird ersetzt, und die Spieler werden vor dem Neustart gewarnt.`,
    ru: `Восстановить сервер ${quoted} из резервной копии от ${backup}? Его текущий мир будет заменён, а игроки получат предупреждение перед перезапуском.`,
    pt: `Restaurar o servidor ${quoted} a partir do backup de ${backup}? O mundo atual dele é substituído, e os jogadores recebem um aviso antes de ele reiniciar.`,
  }
}
