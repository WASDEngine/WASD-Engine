/**
 * The approval prompts of the multiplayer tools in WASD Engine's languages, which the Session's approval prompt shows
 * before a server purchase, a size change, a deletion, or a restore; `en` is also the audit text. A purchase or a
 * change still needs the user's confirmation on the site afterwards; the prompt says so, with the price, or that the
 * server is free while one of the free servers of its size that WASD Engine gave the account is left when the user
 * confirms, which only the site decides then. For a free server, a change to a size without a free one left is a new
 * purchase at that size's price, and a deletion leaves the bill as it is.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-prompts
 */

/** One prompt in WASD Engine's languages; `en` is the audit text. */
export interface LocalizedPrompt {
  readonly en: string
  readonly [locale: string]: string
}

/** WASD Engine's languages. */
export type PromptLocale = 'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt'

/** A server size as a prompt names it. */
export interface PromptSize {
  /** The size's name, such as `Small`, or its id when the site no longer lists it. */
  readonly name: string
  /** The monthly price, such as `$5`; undefined when the site no longer lists the size. */
  readonly price: string | undefined
  /** Whether the server is free at this size: one of the free servers WASD Engine gave the account covers it, or one is left for it. */
  readonly free: boolean
}

/**
 * A size with its monthly price, or that it is free, as each language names it, such as `Small ($5 a month)` or
 * `Small (free)`; a size without a price is its name alone.
 * @param size - the size.
 * @returns the label in each language.
 */
export function sizeLabels(size: PromptSize): Readonly<Record<PromptLocale, string>> {
  const { name, price } = size
  if (size.free) {
    return { en: `${name} (free)`, zh: `${name}（免费）`, ja: `${name}（無料）`, es: `${name} (gratis)`, fr: `${name} (gratuit)`, de: `${name} (kostenlos)`, ru: `${name} (бесплатно)`, pt: `${name} (grátis)` }
  }
  if (price === undefined) return { en: name, zh: name, ja: name, es: name, fr: name, de: name, ru: name, pt: name }
  return {
    en: `${name} (${price} a month)`, zh: `${name}（每月 ${price}）`, ja: `${name}（月額 ${price}）`, es: `${name} (${price} al mes)`,
    fr: `${name} (${price} par mois)`, de: `${name} (${price} im Monat)`, ru: `${name} (${price} в месяц)`, pt: `${name} (${price} por mês)`,
  }
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
 * The prompt before a new server of a size with one of the account's free servers left. It is free while one is left
 * when the user confirms on the site, which shows the price instead once none is.
 * @param size - the size's name, such as `Small`.
 * @param game - the game's title.
 * @param site - the site's host, such as `app.wasdengine.com`.
 * @returns the prompt.
 */
export function createFreePrompt(size: string, game: string, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(game)
  return {
    en: `Create a free ${size} game server for ${quoted}? WASD Engine gave this account free ${size} servers, and it is free while one of them is left when you confirm. WASD Engine then opens a page on ${site} where you confirm; if none is left by then, the page shows the price instead.`,
    zh: `要为 ${quoted} 创建一台免费的 ${size} 游戏服务器吗？WASD Engine 为此账号提供了免费的 ${size} 服务器，只要你确认时还剩一台，它就是免费的。随后 WASD Engine 会打开 ${site} 上的页面，由你确认；如果到那时一台都不剩，页面会改为显示价格。`,
    ja: `${quoted} の ${size} ゲームサーバーを無料で作成しますか？WASD Engine がこのアカウントに無料の ${size} サーバーを付与しており、確認する時点で 1 台でも残っていれば無料です。このあと WASD Engine が ${site} のページを開き、そこで確認します。その時点で残っていなければ、ページには代わりに料金が表示されます。`,
    es: `¿Crear un servidor de juego ${size} gratuito para ${quoted}? WASD Engine le dio a esta cuenta servidores ${size} gratuitos, y es gratis mientras quede uno cuando confirmes. Después, WASD Engine abre una página en ${site} donde confirmas; si para entonces no queda ninguno, la página muestra el precio.`,
    fr: `Créer un serveur de jeu ${size} gratuit pour ${quoted} ? WASD Engine a offert à ce compte des serveurs ${size} gratuits, et il est gratuit tant qu’il en reste un quand vous confirmez. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez ; s’il n’en reste plus d’ici là, la page affiche le prix à la place.`,
    de: `Einen kostenlosen ${size}-Spielserver für ${quoted} erstellen? WASD Engine hat diesem Konto kostenlose ${size}-Server gegeben, und er ist kostenlos, solange beim Bestätigen noch einer übrig ist. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst; ist bis dahin keiner mehr übrig, zeigt die Seite stattdessen den Preis.`,
    ru: `Создать бесплатный игровой сервер ${size} для ${quoted}? WASD Engine выдал этому аккаунту бесплатные серверы ${size}, и он бесплатен, если при подтверждении один из них ещё остаётся. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите; если к тому времени их не останется, страница покажет цену.`,
    pt: `Criar um servidor de jogo ${size} gratuito para ${quoted}? O WASD Engine deu a esta conta servidores ${size} gratuitos, e ele é gratuito enquanto restar um quando você confirmar. Depois, o WASD Engine abre uma página em ${site} onde você confirma; se não restar nenhum até lá, a página mostra o preço.`,
  }
}

/** A size label followed by Chinese or Japanese words: a space after a bare name, none after a full-width bracket. */
function beforeCjk(label: string): string {
  return label.endsWith('）') ? label : `${label} `
}

/**
 * The prompt before a new size. A new size with one of the account's free servers left is free while one is left when
 * the user confirms; a free server moved to a size without one left is a new purchase at that size's price.
 * @param server - the server's name.
 * @param from - the current size, free when one of the account's free servers covers the server.
 * @param to - the new size with its price, free when one of the account's free servers of the size is left.
 * @param site - the site's host.
 * @returns the prompt.
 */
export function resizePrompt(server: string, from: PromptSize, to: PromptSize & { readonly price: string }, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(server)
  const f = sizeLabels(from)
  const t = sizeLabels(to)
  const [fz, tz, fj, tj] = [beforeCjk(f.zh), beforeCjk(t.zh), beforeCjk(f.ja), beforeCjk(t.ja)]
  if (to.free) {
    return {
      en: `Change the server ${quoted} from ${f.en} to ${t.en}? WASD Engine gave this account free ${to.name} servers, and the new size is free while one of them is left when you confirm. WASD Engine then opens a page on ${site} where you confirm the change; your bill changes only after that.`,
      zh: `要把服务器 ${quoted} 从 ${fz}改为 ${tz}吗？WASD Engine 为此账号提供了免费的 ${to.name} 服务器，只要你确认时还剩一台，新规格就是免费的。随后 WASD Engine 会打开 ${site} 上的页面，你在那里确认更改；之后账单才会变化。`,
      ja: `サーバー ${quoted} を ${fj}から ${tj}に変更しますか？WASD Engine がこのアカウントに無料の ${to.name} サーバーを付与しており、確認する時点で 1 台でも残っていれば新しいサイズは無料です。このあと WASD Engine が ${site} のページを開き、そこで変更を確認します。請求はそのあとで変わります。`,
      es: `¿Cambiar el servidor ${quoted} de ${f.es} a ${t.es}? WASD Engine le dio a esta cuenta servidores ${to.name} gratuitos, y el nuevo tamaño es gratis mientras quede uno cuando confirmes. Después, WASD Engine abre una página en ${site} donde confirmas el cambio; tu factura cambia solo después.`,
      fr: `Passer le serveur ${quoted} de ${f.fr} à ${t.fr} ? WASD Engine a offert à ce compte des serveurs ${to.name} gratuits, et la nouvelle taille est gratuite tant qu’il en reste un quand vous confirmez. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez le changement ; votre facture ne change qu’après.`,
      de: `Den Server ${quoted} von ${f.de} auf ${t.de} ändern? WASD Engine hat diesem Konto kostenlose ${to.name}-Server gegeben, und die neue Größe ist kostenlos, solange beim Bestätigen noch einer übrig ist. WASD Engine öffnet danach eine Seite auf ${site}, auf der du die Änderung bestätigst; erst dann ändert sich deine Rechnung.`,
      ru: `Изменить сервер ${quoted} с ${f.ru} на ${t.ru}? WASD Engine выдал этому аккаунту бесплатные серверы ${to.name}, и новый размер бесплатен, если при подтверждении один из них ещё остаётся. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите изменение; счёт изменится только после этого.`,
      pt: `Mudar o servidor ${quoted} de ${f.pt} para ${t.pt}? O WASD Engine deu a esta conta servidores ${to.name} gratuitos, e o novo tamanho é gratuito enquanto restar um quando você confirmar. Depois, o WASD Engine abre uma página em ${site} onde você confirma a mudança; sua conta só muda depois disso.`,
    }
  }
  if (from.free) {
    return {
      en: `Change the server ${quoted} from ${f.en} to ${t.en}? ${to.name} is a new purchase at ${to.price} a month, and the free ${from.name} server stays on this account for another server. WASD Engine then opens a page on ${site} where you confirm and pay; nothing is charged before that.`,
      zh: `要把服务器 ${quoted} 从 ${fz}改为 ${tz}吗？${to.name} 属于新购买，每月 ${to.price}；免费的 ${from.name} 服务器名额会留在此账号上，供另一台服务器使用。随后 WASD Engine 会打开 ${site} 上的页面，你在那里确认并付款；在此之前不会扣费。`,
      ja: `サーバー ${quoted} を ${fj}から ${tj}に変更しますか？${to.name} は月額 ${to.price} の新規購入となり、無料の ${from.name} サーバーは別のサーバー用にこのアカウントに残ります。このあと WASD Engine が ${site} のページを開き、そこで確認して支払います。それまで料金はかかりません。`,
      es: `¿Cambiar el servidor ${quoted} de ${f.es} a ${t.es}? ${to.name} es una compra nueva por ${to.price} al mes, y el servidor ${from.name} gratuito queda en esta cuenta para otro servidor. Después, WASD Engine abre una página en ${site} donde confirmas y pagas; no se cobra nada antes.`,
      fr: `Passer le serveur ${quoted} de ${f.fr} à ${t.fr} ? ${to.name} est un nouvel achat à ${to.price} par mois, et le serveur ${from.name} gratuit reste sur ce compte pour un autre serveur. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez et payez ; rien n’est facturé avant.`,
      de: `Den Server ${quoted} von ${f.de} auf ${t.de} ändern? ${to.name} ist ein neuer Kauf für ${to.price} im Monat, und der kostenlose ${from.name}-Server bleibt diesem Konto für einen anderen Server erhalten. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst und bezahlst; vorher wird nichts berechnet.`,
      ru: `Изменить сервер ${quoted} с ${f.ru} на ${t.ru}? ${to.name} — это новая покупка за ${to.price} в месяц, а бесплатный сервер ${from.name} остаётся на этом аккаунте для другого сервера. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите и оплатите; до этого ничего не списывается.`,
      pt: `Mudar o servidor ${quoted} de ${f.pt} para ${t.pt}? ${to.name} é uma nova compra por ${to.price} por mês, e o servidor ${from.name} gratuito fica nesta conta para outro servidor. Depois, o WASD Engine abre uma página em ${site} onde você confirma e paga; nada é cobrado antes disso.`,
    }
  }
  return {
    en: `Change the server ${quoted} from ${f.en} to ${t.en}? WASD Engine then opens a page on ${site} where you confirm the change; your bill changes only after that.`,
    zh: `要把服务器 ${quoted} 从 ${fz}改为 ${tz}吗？随后 WASD Engine 会打开 ${site} 上的页面，你在那里确认更改；之后账单才会变化。`,
    ja: `サーバー ${quoted} を ${fj}から ${tj}に変更しますか？このあと WASD Engine が ${site} のページを開き、そこで変更を確認します。請求はそのあとで変わります。`,
    es: `¿Cambiar el servidor ${quoted} de ${f.es} a ${t.es}? Después, WASD Engine abre una página en ${site} donde confirmas el cambio; tu factura cambia solo después.`,
    fr: `Passer le serveur ${quoted} de ${f.fr} à ${t.fr} ? WASD Engine ouvre ensuite une page sur ${site} où vous confirmez le changement ; votre facture ne change qu’après.`,
    de: `Den Server ${quoted} von ${f.de} auf ${t.de} ändern? WASD Engine öffnet danach eine Seite auf ${site}, auf der du die Änderung bestätigst; erst dann ändert sich deine Rechnung.`,
    ru: `Изменить сервер ${quoted} с ${f.ru} на ${t.ru}? Затем WASD Engine откроет страницу на ${site}, где вы подтвердите изменение; счёт изменится только после этого.`,
    pt: `Mudar o servidor ${quoted} de ${f.pt} para ${t.pt}? Depois, o WASD Engine abre uma página em ${site} onde você confirma a mudança; sua conta só muda depois disso.`,
  }
}

/**
 * What a deletion asks for: a paid server's deletion, the deletion of a server one of the account's free servers
 * covers, or, for a server still awaiting the user's confirmation of its purchase, cancelling that purchase.
 */
export type DeletedServer = 'paid' | 'free' | 'purchase'

/**
 * The prompt before a deletion. A paid server's monthly price comes off the bill unless another of the account's
 * servers keeps the unit it paid for, such as a suspended one that starts again in its place, which the site's
 * confirmation page then names; a free server's deletion changes no bill; and a purchase still awaiting confirmation
 * never ran or charged anything, so cancelling it costs nothing.
 * @param server - the server's name.
 * @param deleted - what the deletion asks for.
 * @param site - the site's host.
 * @returns the prompt.
 */
export function deletePrompt(server: string, deleted: DeletedServer, site: string): LocalizedPrompt {
  const quoted = JSON.stringify(server)
  switch (deleted) {
    case 'purchase': return {
      en: `Cancel the purchase of the server ${quoted}? It never ran and was never charged, so cancelling it costs nothing. WASD Engine then opens a page on ${site} where you confirm.`,
      zh: `要取消服务器 ${quoted} 的购买吗？它从未运行，也从未扣费，因此取消不会产生任何费用。随后 WASD Engine 会打开 ${site} 上的页面，由你确认。`,
      ja: `サーバー ${quoted} の購入を取り消しますか？一度も稼働しておらず、料金も請求されていないため、取り消しに費用はかかりません。このあと WASD Engine が ${site} のページを開き、そこで確認します。`,
      es: `¿Cancelar la compra del servidor ${quoted}? Nunca funcionó ni se cobró, así que cancelarla no cuesta nada. Después, WASD Engine abre una página en ${site} donde confirmas.`,
      fr: `Annuler l’achat du serveur ${quoted} ? Il n’a jamais fonctionné ni été facturé, donc l’annuler ne coûte rien. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez.`,
      de: `Den Kauf des Servers ${quoted} abbrechen? Er lief nie und wurde nie berechnet, daher kostet das Abbrechen nichts. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst.`,
      ru: `Отменить покупку сервера ${quoted}? Он ни разу не работал, и за него ничего не списывалось, поэтому отмена ничего не стоит. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите.`,
      pt: `Cancelar a compra do servidor ${quoted}? Ele nunca funcionou nem foi cobrado, então cancelar não custa nada. Depois, o WASD Engine abre uma página em ${site} onde você confirma.`,
    }
    case 'free': return {
      en: `Delete the free server ${quoted}? It stops for every player and its world is deleted 7 days later; your bill does not change, and the free server can cover another one. WASD Engine then opens a page on ${site} where you confirm.`,
      zh: `要删除免费服务器 ${quoted} 吗？它会对所有玩家停止，7 天后其世界数据会被删除；你的账单不会变化，这个免费名额可以留给另一台服务器。随后 WASD Engine 会打开 ${site} 上的页面，由你确认。`,
      ja: `無料サーバー ${quoted} を削除しますか？すべてのプレイヤーに対して停止し、7 日後にワールドが削除されます。請求は変わらず、この無料サーバーの枠は別のサーバーに使えます。このあと WASD Engine が ${site} のページを開き、そこで確認します。`,
      es: `¿Eliminar el servidor gratuito ${quoted}? Se detiene para todos los jugadores y su mundo se elimina 7 días después; tu factura no cambia y el servidor gratuito puede cubrir otro. Después, WASD Engine abre una página en ${site} donde confirmas.`,
      fr: `Supprimer le serveur gratuit ${quoted} ? Il s’arrête pour tous les joueurs et son monde est supprimé 7 jours plus tard ; votre facture ne change pas, et le serveur gratuit peut en couvrir un autre. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez.`,
      de: `Den kostenlosen Server ${quoted} löschen? Er stoppt für alle Spieler, und seine Welt wird 7 Tage später gelöscht; deine Rechnung ändert sich nicht, und der kostenlose Server kann einen anderen abdecken. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst.`,
      ru: `Удалить бесплатный сервер ${quoted}? Он остановится для всех игроков, а его мир будет удалён через 7 дней; счёт не изменится, и бесплатный сервер сможет покрыть другой. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите.`,
      pt: `Excluir o servidor gratuito ${quoted}? Ele para para todos os jogadores e o mundo dele é excluído 7 dias depois; sua fatura não muda, e o servidor gratuito pode cobrir outro. Depois, o WASD Engine abre uma página em ${site} onde você confirma.`,
    }
    case 'paid': return {
      en: `Delete the server ${quoted}? It stops for every player and its world is deleted 7 days later. Its monthly price comes off your bill, unless the confirmation page says another of your servers keeps it. WASD Engine then opens a page on ${site} where you confirm.`,
      zh: `要删除服务器 ${quoted} 吗？它会对所有玩家停止，7 天后其世界数据会被删除。它的月费会从账单中去掉，除非确认页面说明你的另一台服务器会接替它。随后 WASD Engine 会打开 ${site} 上的页面，由你确认。`,
      ja: `サーバー ${quoted} を削除しますか？すべてのプレイヤーに対して停止し、7 日後にワールドが削除されます。月額料金は請求から外れますが、確認ページで別のサーバーが引き継ぐと示された場合は請求は変わりません。このあと WASD Engine が ${site} のページを開き、そこで確認します。`,
      es: `¿Eliminar el servidor ${quoted}? Se detiene para todos los jugadores y su mundo se elimina 7 días después. Su precio mensual sale de tu factura, salvo que la página de confirmación diga que otro de tus servidores lo conserva. Después, WASD Engine abre una página en ${site} donde confirmas.`,
      fr: `Supprimer le serveur ${quoted} ? Il s’arrête pour tous les joueurs et son monde est supprimé 7 jours plus tard. Son prix mensuel sort de votre facture, sauf si la page de confirmation indique qu’un autre de vos serveurs le conserve. WASD Engine ouvre ensuite une page sur ${site} où vous confirmez.`,
      de: `Den Server ${quoted} löschen? Er stoppt für alle Spieler, und seine Welt wird 7 Tage später gelöscht. Sein Monatspreis fällt von deiner Rechnung weg, außer die Bestätigungsseite sagt, dass ein anderer deiner Server ihn übernimmt. WASD Engine öffnet danach eine Seite auf ${site}, auf der du bestätigst.`,
      ru: `Удалить сервер ${quoted}? Он остановится для всех игроков, а его мир будет удалён через 7 дней. Его ежемесячная плата уйдёт из счёта, если только страница подтверждения не укажет, что её берёт на себя другой ваш сервер. Затем WASD Engine откроет страницу на ${site}, где вы подтвердите.`,
      pt: `Excluir o servidor ${quoted}? Ele para para todos os jogadores e o mundo dele é excluído 7 dias depois. O preço mensal dele sai da sua fatura, a menos que a página de confirmação diga que outro dos seus servidores fica com ele. Depois, o WASD Engine abre uma página em ${site} onde você confirma.`,
    }
    default: return deleted satisfies never
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
