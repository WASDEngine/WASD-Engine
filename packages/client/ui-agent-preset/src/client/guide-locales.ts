/** Curated help for shipped presets, kept separate from their short picker copy. */
export const guideEn = {
  modeExplanation: 'Mode details',
  howToUse: 'How to use',
  guideSections: 'Guide sections',
  guideExampleTask: 'Example task',
  guideCopy: 'Copy',
  guideCopied: 'Copied',
  guideFootnotes: 'Footnotes',
  guideCordisIntro: 'Choose Customize mode for a new task. Describe the capability you want, where it should appear, and how you will verify it.',
  guideCordisExplanation: [
    '### What you can create',
    'Customize mode includes the standard task tools plus runtime inspection and guidance for authoring Cordis plugins and agent presets. It can create a plugin that adds a capability or UI, or a preset that combines tools and prompts for a particular job.',
    '### Plugins and modes',
    'A plugin adds capabilities to WASD Engine, such as a tool, a service connection, or a UI entry. A mode is an agent preset that selects tools and defines how the agent works in a task. A plugin can be included in a custom preset.',
    '### How the result takes effect',
    'Ask the agent to install and verify the result, not just generate source code. A plugin may load immediately or require a restart, depending on what it changes. A newly created preset is selected when starting a new task.',
  ].join('\n\n'),
  guideCordisUsage: [
    '### Add a UI',
    '> Create a WASD Engine plugin that adds a project notes entry to the sidebar. Let me browse the Markdown files in this workspace and preview a selected note. Install it and verify that the page opens.',
    'Expected output: an installed plugin with a working entry and preview page, plus any remaining activation steps.',
    '### Add a tool',
    '> Create a plugin with a tool that reads this project’s test report and summarizes the failed tests. Register it and verify it with a sample report.',
    'Expected output: a plugin with a callable tool and a verified sample call.',
    '### Create my own mode',
    '> Create a “Code review” mode based on Game developer. Have it prioritize potential bugs and test gaps, cite file paths and lines, and ask before modifying files. Save it as a selectable preset.',
    'Expected output: a custom preset for new tasks. These review instructions guide the agent; permission settings determine which actions it can execute.',
  ].join('\n\n'),
}

/** Keys merged into the feature’s ordinary locale seat. */
export type PresetGuideKey = keyof typeof guideEn

/** Simplified Chinese help. Examples describe suggested tasks, not recorded runs. */
export const guideZh: Record<PresetGuideKey, string> = {
  modeExplanation: '模式说明',
  howToUse: '如何使用',
  guideSections: '帮助内容',
  guideExampleTask: '示例任务',
  guideCopy: '复制',
  guideCopied: '已复制',
  guideFootnotes: '脚注',
  guideCordisIntro: '新建任务时选择「自定义模式」，说明希望增加什么能力、从哪里使用，以及怎样验证效果。',
  guideCordisExplanation: [
    '### 可以创造什么',
    '自定义模式具备标准任务工具，并增加运行时检查，以及 Cordis 插件和 Agent 预设的开发指引。可以编写插件来添加功能或界面，也可以组合工具和提示词，创建适合特定任务的模式。',
    '### 插件与模式的关系',
    '插件为 WASD Engine 增加能力，例如工具、服务连接或界面入口。模式是一份 Agent 预设，用来选择任务可用的工具，并约定 Agent 的工作方式。自定义模式中也可以使用自己开发的插件。',
    '### 怎样让成果生效',
    '可以要求 Agent 完成安装并验证实际效果。插件可能即时加载，也可能需要重启，取决于修改内容；新建的模式在创建新任务时选择。',
  ].join('\n\n'),
  guideCordisUsage: [
    '### 添加一个界面',
    '> 帮我写一个 WASD Engine 插件，在侧栏增加「项目笔记」入口，列出当前工作区的 Markdown 文件，点击后能预览内容。完成安装并验证页面能打开。',
    '预期产出：带侧栏入口和预览页的插件，以及仍需完成的生效步骤。',
    '### 添加一个工具',
    '> 写一个插件，提供读取项目测试报告、汇总失败用例的工具。注册工具，并用一份示例报告验证调用结果。',
    '预期产出：可调用的新工具，以及一次示例调用的验证结果。',
    '### 创建自己的模式',
    '> 基于「游戏开发者」创建「代码审查」模式，优先检查潜在错误和测试缺口，指出文件与行号，修改文件前先询问我。保存成可选择的预设。',
    '预期产出：可在新任务中选择的自定义模式。审查要求用于指导 Agent，实际可执行的操作仍由权限设置决定。',
  ].join('\n\n'),
}

/** Japanese copy, checked against the English keys. */
export const guideJa = {
  'modeExplanation': 'モードの詳細',
  'howToUse': '使い方',
  'guideSections': 'ガイドのセクション',
  'guideExampleTask': 'タスク例',
  'guideCopy': 'コピー',
  'guideCopied': 'コピーしました',
  'guideFootnotes': '脚注',
  'guideCordisIntro': '新しいタスクにはカスタマイズモードを選びます。実現したい機能、表示される場所、確認方法を説明してください。',
  'guideCordisExplanation': '### 作成できるもの\n\nカスタマイズモードには標準的なタスクツールに加え、ランタイムの検査、Cordis プラグインやエージェントプリセットの作成ガイドが含まれます。機能や UI を追加するプラグインを作成することも、特定の作業向けにツールとプロンプトを組み合わせたプリセットを作成することもできます。\n\n### プラグインとモード\n\nプラグインはツール、サービス接続、UI エントリなど、WASD Engine に機能を追加します。モードはエージェントプリセットであり、ツールを選択し、タスク内でのエージェントの動作を定義します。プラグインはカスタムプリセットに含めることができます。\n\n### 結果を反映させる方法\n\nソースコードを生成するだけでなく、エージェントにインストールと確認を依頼してください。プラグインは変更内容によっては即座に読み込まれるか、再起動が必要になる場合があります。新しく作成したプリセットは、新しいタスクを始めるときに選択されます。',
  'guideCordisUsage': '### UI を追加する\n\n> サイドバーにプロジェクトメモのエントリを追加する WASD Engine プラグインを作成してください。このワークスペース内の Markdown ファイルを閲覧でき、選択したメモをプレビューできるようにしてください。インストールしてページが開くことを確認してください。\n\n期待される出力: 動作するエントリとプレビューページを備えた、インストール済みのプラグイン。残っている有効化手順があればそれも含みます。\n\n### ツールを追加する\n\n> このプロジェクトのテストレポートを読み、失敗したテストを要約するツールを備えたプラグインを作成してください。登録し、サンプルのレポートで確認してください。\n\n期待される出力: 呼び出し可能なツールを備えたプラグインと、確認済みのサンプル呼び出し。\n\n### 独自のモードを作成する\n\n> ゲーム開発者をベースに「コードレビュー」モードを作成してください。潜在的なバグとテストの不足を優先し、ファイルパスと行番号を示し、ファイルを変更する前に確認を求めるようにしてください。選択可能なプリセットとして保存してください。\n\n期待される出力: 新しいタスク用のカスタムプリセット。これらのレビュー指示はエージェントを導くものであり、実行できる操作は権限設定によって決まります。',
} satisfies Record<keyof typeof guideEn, string>

/** Spanish dictionary, checked against the English keys. */
export const guideEs = {
  modeExplanation: 'Detalles del modo',
  howToUse: 'como usar',
  guideSections: 'Secciones de guía',
  guideExampleTask: 'Tarea de ejemplo',
  guideCopy: 'Copiar',
  guideCopied: 'Copiado',
  guideFootnotes: 'Notas a pie de página',
  guideCordisIntro: 'Elija el modo de personalización para una nueva tarea. Describe la capacidad que deseas, dónde debería aparecer y cómo la verificarás.',
  guideCordisExplanation: [
    '### Lo que puedes crear',
    'El modo de personalización incluye las herramientas de tareas estándar además de inspección del tiempo de ejecución y orientación para crear Cordis complementos y ajustes preestablecidos de agentes. Puede crear un complemento que agregue una capacidad o interfaz de usuario, o un ajuste preestablecido que combine herramientas e indicaciones para un trabajo en particular.',
    '### Complementos y modos',
    'Un complemento agrega capacidades a WASD Engine, como una herramienta, una conexión de servicio o una entrada de UI. Un modo es un ajuste preestablecido del agente que selecciona herramientas y define cómo trabaja el agente en una tarea. Se puede incluir un complemento en un ajuste preestablecido personalizado.',
    '### Cómo surte efecto el resultado',
    'Pídale al agente que instale y verifique el resultado, no solo que genere el código fuente. Un complemento puede cargarse inmediatamente o requerir un reinicio, dependiendo de lo que cambie. Se selecciona un ajuste preestablecido recién creado al iniciar una nueva tarea.',
  ].join('\n\n\n\n'),
  guideCordisUsage: [
    '### Agregar una interfaz de usuario',
    '> Cree un complemento de WASD Engine que agregue una entrada de notas del proyecto a la barra lateral. Permítanme explorar los Markdown archivos en este espacio de trabajo y obtener una vista previa de una nota seleccionada. Instálalo y verifica que se abre la página.',
    'Resultado esperado: un complemento instalado con una entrada funcional y una página de vista previa, además de los pasos de activación restantes.',
    '### Agregar una herramienta',
    '> Cree un complemento con una herramienta que lea el informe de prueba de este proyecto y resuma las pruebas fallidas. Regístrelo y verifíquelo con un informe de muestra.',
    'Resultado esperado: un complemento con una herramienta invocable y una llamada de muestra verificada.',
    '### Crear mi propio modo',
    '> Cree un modo de “Revisión de código” basado en Desarrollador de juegos. Haga que priorice posibles errores y pruebe las lagunas, cite rutas y líneas de archivos y pregunte antes de modificar archivos. Guárdelo como un ajuste preestablecido seleccionable.',
    'Resultado esperado: un ajuste preestablecido personalizado para nuevas tareas. Estas instrucciones de revisión guían al agente; La configuración de permisos determina qué acciones puede ejecutar.',
  ].join('\n\n\n\n'),
} satisfies typeof guideEn

/** French dictionary, checked against the English keys. */
export const guideFr = {
  modeExplanation: 'Détails du mode',
  howToUse: 'Comment utiliser',
  guideSections: 'Sections du guide',
  guideExampleTask: 'Exemple de tâche',
  guideCopy: 'Copier',
  guideCopied: 'Copié',
  guideFootnotes: 'Notes de bas de page',
  guideCordisIntro: 'Choisissez le mode Personnalisation pour une nouvelle tâche. Décrivez la fonctionnalité souhaitée, où elle doit apparaître et comment vous la vérifierez.',
  guideCordisExplanation: [
    '### Ce que vous pouvez créer',
    "Le mode Personnalisation inclut les outils de tâches standard, ainsi qu'une inspection d'exécution et des conseils pour la création de Cordis plug-ins et préréglages d'agent. Il peut créer un plugin qui ajoute une fonctionnalité ou une interface utilisateur, ou un préréglage combinant des outils et des invites pour une tâche particulière.",
    '### Plugins et modes',
    "Un plug-in ajoute des fonctionnalités à WASD Engine, telles qu'un outil, une connexion à un service ou une entrée d'interface utilisateur. Un mode est un préréglage d'agent qui sélectionne les outils et définit la manière dont l'agent fonctionne dans une tâche. Un plugin peut être inclus dans un préréglage personnalisé.",
    '### Comment le résultat prend effet',
    "Demandez à l'agent d'installer et de vérifier le résultat, pas seulement de générer le code source. Un plugin peut se charger immédiatement ou nécessiter un redémarrage, en fonction de ce qu'il modifie. Un préréglage nouvellement créé est sélectionné lors du démarrage d'une nouvelle tâche.",
  ].join('\n\n\n\n'),
  guideCordisUsage: [
    '### Ajouter une interface utilisateur',
    "> Créez un plugin WASD Engine qui ajoute une entrée de notes de projet à la barre latérale. Permettez-moi de parcourir les Markdown fichiers de cet espace de travail et de prévisualiser une note sélectionnée. Installez-le et vérifiez que la page s'ouvre.",
    "Résultat attendu : un plugin installé avec une page d'entrée et d'aperçu fonctionnelle, ainsi que toutes les étapes d'activation restantes.",
    '### Ajouter un outil',
    '> Créez un plugin avec un outil qui lit le rapport de test de ce projet et résume les tests échoués. Enregistrez-le et vérifiez-le avec un exemple de rapport.',
    "Résultat attendu : un plugin avec un outil appelable et un exemple d'appel vérifié.",
    '### Créer mon propre mode',
    '> Créer un mode « Revue de code » basé sur Développeur de jeux. Demandez-lui de prioriser les bogues potentiels et de tester les lacunes, de citer les chemins et les lignes des fichiers et de demander avant de modifier les fichiers. Enregistrez-le en tant que préréglage sélectionnable.',
    "Résultat attendu : un préréglage personnalisé pour les nouvelles tâches. Ces instructions de révision guident l'agent ; les paramètres d'autorisation déterminent les actions qu'il peut exécuter.",
  ].join('\n\n\n\n'),
} satisfies typeof guideEn

/** German dictionary, checked against the English keys. */
export const guideDe = {
  modeExplanation: 'Modusdetails',
  howToUse: 'Wie zu verwenden',
  guideSections: 'Leitfadenabschnitte',
  guideExampleTask: 'Beispielaufgabe',
  guideCopy: 'Kopieren',
  guideCopied: 'Kopiert',
  guideFootnotes: 'Fußnoten',
  guideCordisIntro: 'Wählen Sie den Anpassungsmodus für eine neue Aufgabe. Beschreiben Sie die gewünschte Funktion, wo sie angezeigt werden soll und wie Sie sie überprüfen.',
  guideCordisExplanation: [
    '### Was Sie erstellen können',
    'Der Anpassungsmodus umfasst die Standardaufgabentools sowie eine Laufzeitprüfung und Anleitungen zum Erstellen von Cordis-Plugins und Agent-Voreinstellungen. Es kann ein Plugin erstellt werden, das eine Funktion oder Benutzeroberfläche hinzufügt, oder eine Voreinstellung, die Tools und Eingabeaufforderungen für einen bestimmten Job kombiniert.',
    '### Plugins und Modi',
    'Ein Plugin fügt WASD Engine Funktionen hinzu, beispielsweise ein Tool, eine Dienstverbindung oder einen UI-Eintrag. Ein Modus ist eine Agentenvoreinstellung, die Tools auswählt und definiert, wie der Agent in einer Aufgabe arbeitet. Ein Plugin kann in eine benutzerdefinierte Voreinstellung eingebunden werden.',
    '### Wie das Ergebnis wirksam wird',
    'Bitten Sie den Agenten, das Ergebnis zu installieren und zu überprüfen und nicht nur Quellcode zu generieren. Abhängig von den Änderungen kann ein Plugin sofort geladen werden oder einen Neustart erfordern. Beim Starten einer neuen Aufgabe wird eine neu erstellte Voreinstellung ausgewählt.',
  ].join('\n\n\n\n'),
  guideCordisUsage: [
    '### Fügen Sie eine Benutzeroberfläche hinzu',
    '> Erstellen Sie ein Plugin für WASD Engine, das der Seitenleiste einen Eintrag für Projektnotizen hinzufügt. Lassen Sie mich die Markdown Dateien in diesem Arbeitsbereich durchsuchen und eine Vorschau einer ausgewählten Notiz anzeigen. Installieren Sie es und stellen Sie sicher, dass die Seite geöffnet wird.',
    'Erwartete Ausgabe: ein installiertes Plugin mit einer funktionierenden Einstiegs- und Vorschauseite sowie allen verbleibenden Aktivierungsschritten.',
    '### Ein Werkzeug hinzufügen',
    '> Erstellen Sie ein Plugin mit einem Tool, das den Testbericht dieses Projekts liest und die fehlgeschlagenen Tests zusammenfasst. Registrieren Sie es und überprüfen Sie es anhand eines Beispielberichts.',
    'Erwartete Ausgabe: ein Plugin mit einem aufrufbaren Tool und einem verifizierten Beispielaufruf.',
    '### Erstelle meinen eigenen Modus',
    '> Erstellen Sie einen „Code Review“-Modus basierend auf Spieleentwickler. Lassen Sie potenzielle Fehler priorisieren und Lücken testen, geben Sie Dateipfade und -zeilen an und fragen Sie nach, bevor Sie Dateien ändern. Speichern Sie es als auswählbare Voreinstellung.',
    'Erwartete Ausgabe: eine benutzerdefinierte Voreinstellung für neue Aufgaben. Diese Überprüfungsanweisungen leiten den Agenten; Berechtigungseinstellungen bestimmen, welche Aktionen ausgeführt werden können.',
  ].join('\n\n\n\n'),
} satisfies typeof guideEn

/** Russian dictionary, checked against the English keys. */
export const guideRu = {
  modeExplanation: 'Подробности режима',
  howToUse: 'Как использовать',
  guideSections: 'Разделы руководства',
  guideExampleTask: 'Пример задачи',
  guideCopy: 'Копировать',
  guideCopied: 'Скопировано',
  guideFootnotes: 'Сноски',
  guideCordisIntro: 'Выберите режим «Создатель» для новой задачи. Опишите желаемую возможность, где она должна появиться и как вы ее проверите.',
  guideCordisExplanation: [
    '### Что вы можете создать',
    'Режим настройки включает в себя стандартные инструменты задач, а также проверку во время выполнения и рекомендации по созданию подключаемых модулей Cordis и предустановок агента. Он может создать плагин, добавляющий возможности или пользовательский интерфейс, или предустановку, объединяющую инструменты и подсказки для конкретной работы.',
    '### Плагины и режимы',
    'Плагин добавляет к WASD Engine возможности, такие как инструмент, подключение к службе или запись пользовательского интерфейса. Режим — это предустановка агента, которая выбирает инструменты и определяет, как агент работает над задачей. Плагин может быть включен в пользовательский пресет.',
    '### Как результат вступает в силу',
    'Попросите агента установить и проверить результат, а не просто генерировать исходный код. Плагин может загрузиться немедленно или потребовать перезагрузки, в зависимости от того, что он меняет. Вновь созданный пресет выбирается при запуске новой задачи.',
  ].join('\n\n\n\n'),
  guideCordisUsage: [
    '### Добавьте пользовательский интерфейс',
    '> Создайте плагин для WASD Engine, который добавляет запись примечаний к проекту на боковую панель. Позвольте мне просмотреть файлы Markdown в этом рабочем пространстве и просмотреть выбранную заметку. Установите его и убедитесь, что страница открывается.',
    'Ожидаемый результат: установленный плагин с работающей страницей входа и предварительного просмотра, а также все оставшиеся шаги активации.',
    '### Добавить инструмент',
    '> Создайте плагин с инструментом, который читает отчет об испытаниях этого проекта и суммирует неудачные тесты. Зарегистрируйте его и проверьте с помощью образца отчета.',
    'Ожидаемый результат: плагин с вызываемым инструментом и проверенным примером вызова.',
    '### Создать свой режим',
    '> Создайте режим «Проверка кода» на основе режима «Разработчик игр». Попросите его определить приоритетность потенциальных ошибок и проверить пробелы, указать пути и строки к файлам и спросить, прежде чем изменять файлы. Сохраните его как выбираемую предустановку.',
    'Ожидаемый результат: индивидуальная настройка для новых задач. Эти инструкции по проверке помогут агенту; настройки разрешений определяют, какие действия он может выполнять.',
  ].join('\n\n\n\n'),
} satisfies typeof guideEn

/** Portuguese dictionary, checked against the English keys. */
export const guidePt = {
  modeExplanation: 'Detalhes do modo',
  howToUse: 'Como usar',
  guideSections: 'Seções do guia',
  guideExampleTask: 'Tarefa de exemplo',
  guideCopy: 'Copiar',
  guideCopied: 'Copiado',
  guideFootnotes: 'Notas de rodapé',
  guideCordisIntro: 'Escolha o modo de personalização para uma nova tarefa. Descreva o recurso desejado, onde ele deve aparecer e como você o verificará.',
  guideCordisExplanation: [
    '### O que você pode criar',
    'O modo de personalização inclui ferramentas de tarefas padrão, além de inspeção de tempo de execução e orientação para criação de Cordis plug-ins e predefinições de agente. Ele pode criar um plug-in que adicione um recurso ou UI, ou uma predefinição que combine ferramentas e prompts para um trabalho específico.',
    '### Plug-ins e modos',
    'Um plug-in adiciona recursos ao WASD Engine, como uma ferramenta, uma conexão de serviço ou uma entrada de IU. Um modo é uma predefinição de agente que seleciona ferramentas e define como o agente trabalha em uma tarefa. Um plugin pode ser incluído em uma predefinição personalizada.',
    '### Como o resultado entra em vigor',
    'Peça ao agente para instalar e verificar o resultado, não apenas gerar o código-fonte. Um plug-in pode carregar imediatamente ou exigir uma reinicialização, dependendo do que for alterado. Uma predefinição recém-criada é selecionada ao iniciar uma nova tarefa.',
  ].join('\n\n\n\n'),
  guideCordisUsage: [
    '### Adicionar uma IU',
    '> Crie um plug-in para o WASD Engine que adicione uma entrada de notas do projeto à barra lateral. Deixe-me navegar pelos arquivos Markdown nesta área de trabalho e visualizar uma nota selecionada. Instale-o e verifique se a página abre.',
    'Resultado esperado: um plug-in instalado com uma entrada funcional e uma página de visualização, além de quaisquer etapas de ativação restantes.',
    '### Adicionar uma ferramenta',
    '> Crie um plugin com uma ferramenta que leia o relatório de teste deste projeto e resuma os testes que falharam. Registre-o e verifique-o com um relatório de amostra.',
    'Resultado esperado: um plugin com uma ferramenta que pode ser chamada e uma chamada de amostra verificada.',
    '### Crie meu próprio modo',
    '> Crie um modo “Revisão de código” baseado em Desenvolvedor de jogos. Faça com que ele priorize possíveis bugs e teste lacunas, cite caminhos e linhas de arquivos e pergunte antes de modificar arquivos. Salve-o como uma predefinição selecionável.',
    'Resultado esperado: uma predefinição personalizada para novas tarefas. Estas instruções de revisão orientam o agente; as configurações de permissão determinam quais ações ele pode executar.',
  ].join('\n\n\n\n'),
} satisfies typeof guideEn
