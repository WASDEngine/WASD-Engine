/**
 * WASD Engine copy owned by ui-chat (fork-owned; `wasdengine/FORK.md` lists the fork changes): the
 * failure rows of a turn that a sign-out stopped, that ran without a sign-in, or that a restart closed
 * name WASD Engine instead of DeepSeek or DSH, and the Chinese running status does not use DeepSeek's
 * Chinese company name.
 */

/**
 * `chat` namespace messages the fork rewrites, by language: the stopped row after the user signs
 * out, the stopped row of a turn that a restart closed after the process exited, and the failure row
 * of a turn whose model request found no sign-in; in Chinese also the running status of every Turn,
 * without and with its `{duration}`, which upstream words as 深度求索中.
 */
export const WASDENGINE_CHAT_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zh: {
    'chat.deepDiving': '深入思考中',
    'chat.deepDivingFor': '深入思考中，用时 {duration} ···',
    'message.failure.accountSignedOut': '任务已因退出 WASD Engine 登录而停止。',
    'message.failure.interrupted': 'WASD Engine 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。',
    'message.failure.accountSignInRequired': '请先登录 WASD Engine，并确认请求地址支持账号认证。',
  },
  en: {
    'message.failure.accountSignedOut': 'Stopped because you signed out of WASD Engine.',
    'message.failure.interrupted': 'The WASD Engine process exited before this turn finished (for example, it was killed, crashed, or timed out while shutting down), so the turn was closed when WASD Engine restarted. Unfinished tool calls have unknown outcomes.',
    'message.failure.accountSignInRequired': 'Sign in to WASD Engine and ensure the request destination supports account authentication.',
  },
  ja: {
    'message.failure.accountSignedOut': 'WASD Engine からログアウトしたため停止しました。',
    'message.failure.interrupted': 'このターンが完了する前に WASD Engine プロセスが終了したため（強制終了、クラッシュ、シャットダウン中のタイムアウトなど）、WASD Engine の再起動時にターンは閉じられました。未完了のツール呼び出しの結果は不明です。',
    'message.failure.accountSignInRequired': 'WASD Engine にログインし、リクエスト先がアカウント認証に対応していることを確認してください。',
  },
  es: {
    'message.failure.accountSignedOut': 'Se detuvo porque cerró sesión en WASD Engine.',
    'message.failure.interrupted': 'El proceso de WASD Engine salió antes de que terminara este turno (por ejemplo, se detuvo, se estrelló o se agotó el tiempo de espera mientras se apagaba), por lo que el turno se cerró cuando se reinició WASD Engine. Las llamadas a herramientas inacabadas tienen resultados desconocidos.',
    'message.failure.accountSignInRequired': 'Inicie sesión en WASD Engine y asegúrese de que el destino de la solicitud admita la autenticación de la cuenta.',
  },
  fr: {
    'message.failure.accountSignedOut': 'Arrêté car vous vous êtes déconnecté de WASD Engine.',
    'message.failure.interrupted': "Le processus de WASD Engine s'est terminé avant la fin de ce tour (par exemple, il a été arrêté, s'est écrasé ou a expiré lors de l'arrêt), de sorte que le tour a été fermé lorsque WASD Engine a redémarré. Les appels d’outils inachevés ont des résultats inconnus.",
    'message.failure.accountSignInRequired': "Connectez-vous à WASD Engine et assurez-vous que la destination de la demande prend en charge l'authentification du compte.",
  },
  de: {
    'message.failure.accountSignedOut': 'Gestoppt, weil Sie sich von WASD Engine abgemeldet haben.',
    'message.failure.interrupted': 'Der Prozess von WASD Engine wurde beendet, bevor dieser Zug beendet war (z. B. wurde er beendet, stürzte ab oder es kam zu einer Zeitüberschreitung beim Herunterfahren), sodass der Zug geschlossen wurde, als WASD Engine neu gestartet wurde. Unvollendete Werkzeugaufrufe haben unbekannte Ergebnisse.',
    'message.failure.accountSignInRequired': 'Melden Sie sich bei WASD Engine an und stellen Sie sicher, dass das Anforderungsziel die Kontoauthentifizierung unterstützt.',
  },
  ru: {
    'message.failure.accountSignedOut': 'Остановлено, поскольку вы вышли из WASD Engine.',
    'message.failure.interrupted': 'Процесс WASD Engine завершился до завершения этого хода (например, был завершен, произошел сбой или истекло время ожидания при завершении работы), поэтому ход был закрыт при перезапуске WASD Engine. Незавершенные вызовы инструментов имеют неизвестные результаты.',
    'message.failure.accountSignInRequired': 'Войдите в WASD Engine и убедитесь, что пункт назначения запроса поддерживает аутентификацию учетной записи.',
  },
  pt: {
    'message.failure.accountSignedOut': 'Interrompido porque você saiu do WASD Engine.',
    'message.failure.interrupted': 'O processo do WASD Engine foi encerrado antes do término deste turno (por exemplo, ele foi eliminado, travou ou expirou durante o desligamento), portanto, o turno foi encerrado quando o WASD Engine foi reiniciado. Chamadas de ferramentas inacabadas têm resultados desconhecidos.',
    'message.failure.accountSignInRequired': 'Faça login no WASD Engine e verifique se o destino da solicitação suporta autenticação de conta.',
  },
}
