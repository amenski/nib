import type { Lang } from './i18n';

export const REPO_URL = 'https://github.com/amenski/nib';
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
export const NPM_URL = 'https://www.npmjs.com/package/@amenski/nib';
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

// Every user-visible string of the home page, header, footer and 404.
// English is the source of truth for the shape; de and es must match it.
// Text between backticks is rendered as inline code. Commands in code blocks are not translated.
const en = {
  homeTitle: 'Nib: open-source coding agent for the terminal',
  description: 'Open-source, bring-your-own-key terminal coding agent. A day on DeepSeek costs a few dollars; ~190 other providers, local Ollama included. No telemetry.',
  ogDescription: 'Bring your own key. Run all day on DeepSeek for a few dollars. Explicit permissions, rewindable checkpoints, MCP, skills. No telemetry.',

  // Header and footer
  homeLabel: 'Nib, home',
  navLabel: 'Sections',
  footerNavLabel: 'Footer',
  nav: { cost: 'Cost', features: 'Features', install: 'Install', blog: 'Blog', privacy: 'Privacy', github: 'GitHub', docs: 'Docs', discussions: 'Discussions', changelog: 'Changelog' },
  footerTagline: 'Nib, Apache 2.0 license.',

  banner: 'nib 0.7.0: auto mode, where a model judge answers permission prompts.',
  hero: {
    h1: 'A coding agent you can afford to leave running.',
    lead: 'Open-source, bring-your-own-key, built for cheap models. Explicit permissions, no telemetry.',
    setup: 'Full setup',
    source: 'View source',
    alt: 'Nib running in a terminal in Code mode on DeepSeek V4 Flash',
  },
  cost: {
    h2: 'One full day on DeepSeek for under $7.',
    sub: 'Nib keeps the prompt prefix stable so provider caches hit. Measured on a real day of work, 2026-10-20, from the DeepSeek usage page for the Nib API key.',
    stats: [
      { n: '$6.89', p: 'total bill for the day' },
      { n: '1.2B', p: 'tokens in the day' },
      { n: '5,005', p: 'requests in the day' },
    ],
    caption: 'Nib /usage on 2026-10-18: 504,190,080 of 506,372,034 input tokens came from cache (99.57%).',
    usageAlt: 'The /usage panel in Nib listing tokens by model, with cached counts',
  },
  how: {
    h2: 'Three commands to a first session.',
    sub: 'Needs Node.js 20 or newer and Git. Keys are stored locally with mode 0600.',
    comments: ['install', 'add a key for DeepSeek, OpenAI, Ollama or ~190 other providers', 'interactive session in Code mode; /mode general for read-only chat'],
    brew: 'On macOS with Homebrew:',
    copy: 'Copy',
    copied: 'Copied',
  },
  modes: {
    h2: 'One agent, several ways to run it.',
    items: [
      { body: 'The interactive terminal UI, starting in Code mode: edit files, run commands, delegate work.' },
      { body: 'Prints the response and exits, for pipes and scripts; with nobody to ask, anything that would prompt is denied.' },
      { body: 'Continues the most recent session for this directory.' },
      { body: 'Cycles the permission posture: normal, auto, plan. `/mode general` switches to read-only chat.' },
    ],
  },
  features: {
    h2: 'Ten features, and how to use each.',
    sub: 'Each comes with the keys, commands or settings you need.',
    demos: {
      auto: 'Auto posture, real run on DeepSeek V4.1 Flash: nib fixes the bug and runs the tests with no permission prompt.',
      undo: '`/undo` restores the file and puts the original prompt back in the input.',
      headless: 'The same task with `nib -p`: no one to ask, so the test runs are denied and nib says so.',
    },
    rows: [
      // src: README.md §Features "Explicit permissions" + "OS sandbox for commands (macOS)"; docs/config-spec.md §2 permissions.rules; docs/permission-spec.md §6
      {
        kicker: 'Permissions and sandbox',
        title: 'Every tool call passes a rule.',
        body: [
          "Allow, ask or deny by tool and pattern. `/permissions` shows this session's decisions.",
          'On macOS, Bash, background jobs, MCP servers and hooks run under a Seatbelt profile. Writes stay in the workspace, the session temp dir and toolchain caches. Because of that boundary, ordinary sandboxed Bash runs without a prompt. Background jobs and guarded commands still ask.',
        ],
        doc: 'Permission spec',
      },
      // src: README.md §Features "Auto mode"; docs/auto-mode.md §4
      {
        kicker: 'Auto mode',
        title: 'A model judge answers the prompts.',
        body: [
          'Press `Shift+Tab` to cycle normal, auto and plan. In auto, read-only calls and ordinary edits inside the workspace run silently. A model judge allows or blocks everything else instead of asking you.',
          "The judge reads your messages and the agent's tool calls, never tool output. You are still asked about credential files such as `.env`, git config changes, anything that would run outside the sandbox, and calls matched by an `ask` rule you wrote. After 3 blocked calls in a row (20 in total), nib asks you again. Auto mode is not available with `nib -p`. Fig. 01 at the top is a real run.",
        ],
        doc: 'Auto mode guide',
      },
      // src: CHANGELOG.md [Unreleased] (language-server diagnostics, lsp tool); docs/config-spec.md §18; docs/tool-spec.md §lsp
      {
        kicker: 'Language servers',
        title: 'Errors show up in the edit result.',
        body: [
          "After each edit, nib asks the language server about the changed files and appends errors and warnings to that edit's result. The model fixes them in the next step.",
          'A read-only `lsp` tool answers definitions, references, hover, symbols, implementations and call hierarchies from the server instead of text search.',
          'Dart and TypeScript servers are built in. They start when `pubspec.yaml` or `tsconfig.json` exists, the server binary is on `PATH` and the folder is trusted. Add others under `lspServers`.',
        ],
        doc: 'Config spec',
      },
      // src: docs/cli-spec.md §7 "Mid-turn input (steering)"; src/ui/App.tsx (queue stack with HH:MM time); README.md keys table (Esc)
      {
        kicker: 'Steering',
        title: 'Talk to it while it works.',
        body: [
          'Type while a turn is running and press `Enter`. The message waits in a queue shown above the input, with the time you sent it. Nib hands it to the model before its next provider call, as a real user message, never mid-stream.',
          '`Esc` interrupts the current call and returns to the prompt. Queued input is never dropped. Slash commands typed meanwhile run when the turn ends, except `/skill <name>`, which applies to the running turn.',
        ],
        doc: 'CLI spec',
      },
      // src: README.md §Features "Recoverable edits" + "Safe file coordination"; src/tools/edit.ts FILE_MODIFIED
      {
        kicker: 'Undo and safe edits',
        title: 'Rewind the code, the chat, or both.',
        body: [
          'Edits in an interactive session are checkpointed in a shadow Git repo. `/undo` rewinds code, conversation or both.',
          'Nib tracks when it last read a file. If the file changed outside the agent since then, the edit is refused with `FILE_MODIFIED` and nib has to read it again first.',
        ],
        doc: 'Session spec',
      },
      // src: README.md §Features "Durable sessions" + "Lean long sessions"; README.md CLI flags table; docs/session-spec.md (todo snapshot restored on resume)
      {
        kicker: 'Sessions and long context',
        title: 'Pick up where you stopped.',
        body: [
          'Sessions are append-only JSONL files on your machine. `nib -c` continues the most recent one for this directory and `nib -r <id>` resumes one by ID. The todo list comes back with it.',
          'Long sessions stay lean. Nib caps oversized tool output, clears older tool results from large requests and compacts earlier conversation. The full transcript stays in the local log. `/compact` does it by hand.',
        ],
        doc: 'Sessions and context docs',
      },
      // src: docs/tool-spec.md §Background jobs + new_task async contract; docs/cli-spec.md /jobs; docs/async-subagents.md; README.md §Features "Skills, MCP, and sub-agents"
      {
        kicker: 'Background jobs and sub-agents',
        title: 'Long work runs on the side.',
        body: [
          'Builds and dev servers can run as background jobs, up to 10 at once. One `check_job` call waits for the job to finish, so the model does not poll in a loop.',
          'The model can hand bounded work to a sub-agent with `new_task`. It runs in the background, up to 3 at a time, and its summary arrives as a follow-up message. Define your own agents in `.nib/agents`.',
          '`/jobs` shows both, and `x` stops the selected one. Jobs and tasks end when you quit.',
        ],
        doc: 'Tool spec',
      },
      // src: README.md FAQ "Does it support images?"; README.md §Features "Optional web access" + "Better search"
      {
        kicker: 'Images and web',
        title: 'Show it a screenshot. Let it look things up.',
        body: [
          'Paste an image with `Ctrl+V`, or write `@path/to/shot.png` in the prompt. The model can also call `view_image` on an https URL or a local file. PNG, JPEG, GIF and WebP up to 5 MB, and the active model must accept images.',
          '`web_search` works without a key through Bing RSS. `web_fetch` gets HTTPS pages and checks arbitrary targets against SSRF. Both are permission-gated and marked as untrusted input. For richer results, point nib at a local SearXNG.',
        ],
        doc: 'Web search spec',
      },
      // src: README.md FAQ "How do I configure MCP?" + "notified" + Configuration (custom modes); docs/hooks-spec.md §1-2; docs/notify-spec.md §3; docs/mode-spec.md §7
      {
        kicker: 'Extend it',
        title: 'Wire in what you already use.',
        body: [
          'Add any stdio MCP server with `nib mcp add`, then check it with `/mcp`. Servers run inside the sandbox; browser servers need `--no-sandbox`. List Agent Skills with `/skills`.',
          'Hooks run your shell commands on events such as `PreToolUse` and `UserPromptSubmit`, and can block a tool call or a prompt. Set `notify` to a script to get pinged when a turn finishes or fails, or when a background job ends.',
          'Custom modes are YAML files in `~/.nib/modes/` with their own role, tool groups and file limits.',
        ],
        doc: 'Hooks spec',
      },
      // src: README.md CLI flags + FAQ "Thinking mode"; docs/cli-spec.md §8 + /usage; nib doctor (README Quick start)
      {
        kicker: 'Headless and visibility',
        title: 'Script it. See what it used.',
        body: [
          '`nib -p "..."` prints the response and exits, with no TUI and no TTY. Errors go to stderr, so stdout stays pipeable. With nobody to ask, anything that would prompt is denied. `--max-turns` caps the number of agent turns.',
          '`/usage` shows tokens per model and, where the provider supports it, your account balance. `nib doctor` prints config and credential sources. Thinking is on by default, and `/effort` sets the reasoning effort.',
        ],
        doc: 'CLI spec',
      },
    ],
  },
  fig: 'Fig.',
  differs: {
    h2: 'What nib does differently.',
    sub: 'Four choices that shape how it runs, each with the doc behind it.',
    items: [
      { title: 'Built for the cache.', body: 'The prompt prefix stays byte-stable and live state goes last, so provider caches hit: 99.57% of input tokens on a real day.', link: 'See the numbers' },
      { title: 'A judge, not a popup.', body: 'In the auto posture (`Shift+Tab`), read-only calls just run and risky ones go to a fast model judge. You come back to finished work, not a stalled prompt.', link: 'How auto mode works' },
      { title: 'No account, no telemetry, no server.', body: 'One local process. The only request that leaves your machine goes to the provider you chose.', link: 'Privacy policy' },
      { title: 'Every subsystem has a spec.', body: 'Permissions, compaction, sandboxing: each is written up in `docs/`, so you can read the design behind any behaviour you rely on.', link: 'Read the docs' },
    ],
  },
  providers: {
    h2: 'Your key, any model.',
    sub: 'Five providers built in, plus ~190 more OpenAI-compatible ones from the Models.dev catalog. Connect any with `nib auth`, switch mid-session with `/model`. Nothing leaves your machine except the request to the provider you chose.',
    more: 'and ~190 more',
  },
  involved: {
    h2: 'Get involved.',
    items: [
      { title: 'GitHub issues', body: 'Report a bug or ask for a feature.' },
      { title: 'Discussions', body: 'Ask a question or share how you run it.' },
      { title: 'Docs', body: 'The specs behind permissions, auto mode, modes and more.' },
      { title: 'Changelog', body: 'What changed in each release.' },
    ],
  },
  notFound: {
    title: 'Page not found | Nib',
    description: 'This page does not exist.',
    h1: 'Page not found.',
    p: 'That address does not exist. Try one of these.',
    home: 'Home',
  },
};

const de: typeof en = {
  homeTitle: 'Nib: Open-Source-Coding-Agent für das Terminal',
  description: 'Open-Source-Coding-Agent fürs Terminal, eigener Schlüssel. Ein Tag mit DeepSeek kostet ein paar Dollar; ~190 weitere Provider, auch Ollama lokal. Keine Telemetrie.',
  ogDescription: 'Eigener Schlüssel. Ein ganzer Tag mit DeepSeek für ein paar Dollar. Explizite Berechtigungen, zurückspulbare Checkpoints, MCP, Skills. Keine Telemetrie.',

  homeLabel: 'Nib, Startseite',
  navLabel: 'Abschnitte',
  footerNavLabel: 'Fußzeile',
  nav: { cost: 'Kosten', features: 'Funktionen', install: 'Installieren', blog: 'Blog', privacy: 'Datenschutz', github: 'GitHub', docs: 'Doku', discussions: 'Diskussionen', changelog: 'Changelog' },
  footerTagline: 'Nib, Apache-2.0-Lizenz.',

  banner: 'nib 0.7.0: Auto-Modus, in dem ein Modell als Richter Berechtigungsfragen beantwortet.',
  hero: {
    h1: 'Ein Coding-Agent, den du dir leisten kannst, laufen zu lassen.',
    lead: 'Open Source, eigener API-Schlüssel, für günstige Modelle gebaut. Explizite Berechtigungen, keine Telemetrie.',
    setup: 'Vollständige Einrichtung',
    source: 'Quellcode ansehen',
    alt: 'Nib im Terminal im Code-Modus mit DeepSeek V4 Flash',
  },
  cost: {
    h2: 'Ein ganzer Tag mit DeepSeek für unter 7 $.',
    sub: 'Nib hält das Prompt-Präfix stabil, damit die Provider-Caches greifen. Gemessen an einem echten Arbeitstag, 20.10.2026, auf der DeepSeek-Nutzungsseite für den Nib-API-Schlüssel.',
    stats: [
      { n: '6,89 $', p: 'Gesamtrechnung für den Tag' },
      { n: '1,2 Mrd.', p: 'Tokens an diesem Tag' },
      { n: '5.005', p: 'Anfragen an diesem Tag' },
    ],
    caption: 'Nib /usage am 18.10.2026: 504.190.080 von 506.372.034 Input-Tokens kamen aus dem Cache (99,57 %).',
    usageAlt: 'Das /usage-Panel in Nib mit Tokens pro Modell und Cache-Anzahl',
  },
  how: {
    h2: 'Drei Befehle bis zur ersten Sitzung.',
    sub: 'Benötigt Node.js 20 oder neuer und Git. Schlüssel werden lokal mit Modus 0600 gespeichert.',
    comments: ['installieren', 'Schlüssel für DeepSeek, OpenAI, Ollama oder ~190 weitere Provider hinzufügen', 'interaktive Sitzung im Code-Modus; /mode general für schreibgeschützten Chat'],
    brew: 'Auf macOS mit Homebrew:',
    copy: 'Kopieren',
    copied: 'Kopiert',
  },
  modes: {
    h2: 'Ein Agent, mehrere Wege, ihn laufen zu lassen.',
    items: [
      { body: 'Die interaktive Terminaloberfläche, startet im Code-Modus: Dateien bearbeiten, Befehle ausführen, Arbeit delegieren.' },
      { body: 'Gibt die Antwort aus und beendet sich, für Pipes und Skripte; weil niemand gefragt werden kann, wird alles abgelehnt, was sonst eine Rückfrage auslösen würde.' },
      { body: 'Setzt die letzte Sitzung für dieses Verzeichnis fort.' },
      { body: 'Wechselt die Berechtigungshaltung: normal, auto, plan. `/mode general` schaltet auf schreibgeschützten Chat.' },
    ],
  },
  features: {
    h2: 'Zehn Funktionen und wie du sie nutzt.',
    sub: 'Jeweils mit den Tasten, Befehlen oder Einstellungen, die du dafür brauchst.',
    demos: {
      auto: 'Auto-Haltung, echter Lauf mit DeepSeek V4.1 Flash: Nib behebt den Fehler und führt die Tests ohne Berechtigungsabfrage aus.',
      undo: '`/undo` stellt die Datei wieder her und setzt den ursprünglichen Prompt zurück in die Eingabe.',
      headless: 'Dieselbe Aufgabe mit `nib -p`: Niemand kann gefragt werden, also werden die Testläufe abgelehnt und Nib sagt das.',
    },
    rows: [
      {
        kicker: 'Berechtigungen und Sandbox',
        title: 'Jeder Tool-Aufruf durchläuft eine Regel.',
        body: [
          'Erlauben, fragen oder verweigern, nach Tool und Muster. `/permissions` zeigt die Entscheidungen dieser Sitzung.',
          'Unter macOS laufen Bash, Hintergrundjobs, MCP-Server und Hooks in einem Seatbelt-Profil. Schreibzugriffe bleiben im Workspace, im temporären Sitzungsordner und in den Toolchain-Caches. Wegen dieser Grenze läuft normales Bash in der Sandbox ohne Rückfrage. Hintergrundjobs und geschützte Befehle fragen weiterhin.',
        ],
        doc: 'Berechtigungsspezifikation',
      },
      {
        kicker: 'Auto-Modus',
        title: 'Ein Modell als Richter beantwortet die Rückfragen.',
        body: [
          'Mit `Shift+Tab` wechselst du zwischen normal, auto und plan. Im Auto-Modus laufen schreibgeschützte Aufrufe und gewöhnliche Änderungen im Workspace ohne Rückfrage. Ein Modell als Richter erlaubt oder blockiert alles andere, statt dich zu fragen.',
          'Der Richter liest deine Nachrichten und die Tool-Aufrufe des Agenten, nie die Tool-Ausgaben. Gefragt wirst du weiterhin bei Dateien mit Zugangsdaten wie `.env`, bei Änderungen an der Git-Konfiguration, bei allem, was außerhalb der Sandbox liefe, und bei Aufrufen, auf die eine von dir geschriebene `ask`-Regel passt. Nach 3 blockierten Aufrufen in Folge (20 insgesamt) fragt Nib wieder dich. Mit `nib -p` ist der Auto-Modus nicht verfügbar. Abb. 01 oben auf der Seite ist ein echter Lauf.',
        ],
        doc: 'Leitfaden zum Auto-Modus',
      },
      {
        kicker: 'Sprachserver',
        title: 'Fehler stehen gleich im Ergebnis der Änderung.',
        body: [
          'Nach jeder Änderung fragt Nib den Sprachserver zu den geänderten Dateien und hängt Fehler und Warnungen an das Ergebnis dieser Änderung an. Das Modell behebt sie im nächsten Schritt.',
          'Ein schreibgeschütztes `lsp`-Tool beantwortet Definitionen, Referenzen, Hover, Symbole, Implementierungen und Aufrufhierarchien über den Server statt über Textsuche.',
          'Server für Dart und TypeScript sind eingebaut. Sie starten, wenn `pubspec.yaml` oder `tsconfig.json` existiert, die Server-Binärdatei im `PATH` liegt und der Ordner als vertrauenswürdig gilt. Weitere trägst du unter `lspServers` ein.',
        ],
        doc: 'Konfigurationsspezifikation',
      },
      {
        kicker: 'Steuern',
        title: 'Sprich mit Nib, während es arbeitet.',
        body: [
          'Tippe, während ein Durchlauf läuft, und drücke `Enter`. Die Nachricht wartet in einer Warteschlange über der Eingabe, mit der Uhrzeit, zu der du sie gesendet hast. Nib gibt sie dem Modell vor dessen nächster Anfrage an den Provider als echte Nutzernachricht, nie mitten im Stream.',
          '`Esc` unterbricht den laufenden Aufruf und führt zurück zur Eingabe. Eingaben in der Warteschlange gehen nie verloren. Slash-Befehle, die du währenddessen tippst, laufen am Ende des Durchlaufs, außer `/skill <name>`: Es wirkt auf den laufenden Durchlauf.',
        ],
        doc: 'CLI-Spezifikation',
      },
      {
        kicker: 'Rückgängig und sichere Änderungen',
        title: 'Spul Code, Chat oder beides zurück.',
        body: [
          'Änderungen in einer interaktiven Sitzung werden in einem Schatten-Git-Repository gesichert. `/undo` spult Code, Unterhaltung oder beides zurück.',
          'Nib merkt sich, wann es eine Datei zuletzt gelesen hat. Wurde sie seitdem außerhalb des Agenten geändert, lehnt Nib die Änderung mit `FILE_MODIFIED` ab und liest die Datei erst neu.',
        ],
        doc: 'Sitzungsspezifikation',
      },
      {
        kicker: 'Sitzungen und langer Kontext',
        title: 'Mach dort weiter, wo du aufgehört hast.',
        body: [
          'Sitzungen sind JSONL-Dateien, an die nur angehängt wird, auf deinem Rechner. `nib -c` setzt die letzte für dieses Verzeichnis fort, `nib -r <id>` nimmt eine per ID wieder auf. Die Todo-Liste kommt mit zurück.',
          'Lange Sitzungen bleiben schlank. Nib kappt zu große Tool-Ausgaben, löscht ältere Tool-Ergebnisse aus großen Anfragen und verdichtet frühere Unterhaltung. Das vollständige Protokoll bleibt lokal erhalten. `/compact` verdichtet von Hand.',
        ],
        doc: 'Doku zu Sitzungen und Kontext',
      },
      {
        kicker: 'Hintergrundjobs und Sub-Agenten',
        title: 'Lange Arbeit läuft nebenher.',
        body: [
          'Builds und Dev-Server können als Hintergrundjobs laufen, bis zu 10 gleichzeitig. Ein einziger `check_job`-Aufruf wartet, bis der Job fertig ist, sodass das Modell nicht in einer Schleife nachfragt.',
          'Mit `new_task` kann das Modell begrenzte Arbeit an einen Sub-Agenten abgeben. Er läuft im Hintergrund, höchstens 3 gleichzeitig, und seine Zusammenfassung kommt als Folgenachricht. Eigene Agenten definierst du in `.nib/agents`.',
          '`/jobs` zeigt beides, `x` stoppt den ausgewählten Eintrag. Jobs und Aufgaben enden, wenn du Nib beendest.',
        ],
        doc: 'Tool-Spezifikation',
      },
      {
        kicker: 'Bilder und Web',
        title: 'Zeig ihm einen Screenshot. Lass es nachschlagen.',
        body: [
          'Füge ein Bild mit `Ctrl+V` ein oder schreibe `@path/to/shot.png` in den Prompt. Das Modell kann auch `view_image` auf eine https-URL oder eine lokale Datei aufrufen. PNG, JPEG, GIF und WebP bis 5 MB; das aktive Modell muss Bilder verarbeiten können.',
          '`web_search` funktioniert ohne Schlüssel über Bing RSS. `web_fetch` lädt HTTPS-Seiten und prüft beliebige Ziele auf SSRF. Beides braucht eine Freigabe und gilt als nicht vertrauenswürdige Eingabe. Für bessere Ergebnisse richtest du Nib auf eine lokale SearXNG-Instanz.',
        ],
        doc: 'Spezifikation der Websuche',
      },
      {
        kicker: 'Erweitern',
        title: 'Binde ein, was du schon nutzt.',
        body: [
          'Füge mit `nib mcp add` jeden stdio-MCP-Server hinzu und prüfe ihn mit `/mcp`. Server laufen in der Sandbox; Browser-Server brauchen `--no-sandbox`. Agent Skills listest du mit `/skills`.',
          'Hooks führen deine Shell-Befehle bei Ereignissen wie `PreToolUse` und `UserPromptSubmit` aus und können einen Tool-Aufruf oder einen Prompt blockieren. Setze `notify` auf ein Skript, um benachrichtigt zu werden, wenn ein Durchlauf endet oder fehlschlägt oder ein Hintergrundjob fertig ist.',
          'Eigene Modi sind YAML-Dateien in `~/.nib/modes/` mit eigener Rolle, eigenen Tool-Gruppen und Dateibeschränkungen.',
        ],
        doc: 'Hooks-Spezifikation',
      },
      {
        kicker: 'Headless und Einblick',
        title: 'Skripte damit. Sieh, was es verbraucht hat.',
        body: [
          '`nib -p "..."` gibt die Antwort aus und beendet sich, ohne TUI und ohne TTY. Fehler gehen nach stderr, daher bleibt stdout pipefähig. Weil niemand gefragt werden kann, wird alles abgelehnt, was sonst eine Rückfrage auslösen würde. `--max-turns` begrenzt die Runden des Agenten.',
          '`/usage` zeigt Tokens pro Modell und, wenn der Provider es unterstützt, dein Kontoguthaben. `nib doctor` gibt Konfiguration und Herkunft der Zugangsdaten aus. Thinking ist standardmäßig an, und `/effort` setzt den Reasoning-Aufwand.',
        ],
        doc: 'CLI-Spezifikation',
      },
    ],
  },
  fig: 'Abb.',
  differs: {
    h2: 'Was Nib anders macht.',
    sub: 'Vier Entscheidungen, die bestimmen, wie Nib arbeitet, jeweils mit der Doku dahinter.',
    items: [
      { title: 'Für den Cache gebaut.', body: 'Das Prompt-Präfix bleibt byte-stabil und der veränderliche Zustand kommt ans Ende, sodass die Provider-Caches greifen: 99,57 % der Input-Tokens an einem echten Tag.', link: 'Die Zahlen ansehen' },
      { title: 'Ein Richter, kein Popup.', body: 'In der Auto-Haltung (`Shift+Tab`) laufen schreibgeschützte Aufrufe einfach durch, riskante gehen an ein schnelles Modell als Richter. Du kommst zu fertiger Arbeit zurück, nicht zu einer blockierten Rückfrage.', link: 'So funktioniert der Auto-Modus' },
      { title: 'Kein Konto, keine Telemetrie, kein Server.', body: 'Ein lokaler Prozess. Die einzige Anfrage, die deinen Rechner verlässt, geht an den Provider, den du gewählt hast.', link: 'Datenschutzerklärung' },
      { title: 'Jedes Subsystem hat eine Spezifikation.', body: 'Berechtigungen, Verdichtung, Sandboxing: Alles ist in `docs/` beschrieben, sodass du das Design hinter jedem Verhalten nachlesen kannst, auf das du dich verlässt.', link: 'Doku lesen' },
    ],
  },
  providers: {
    h2: 'Dein Schlüssel, jedes Modell.',
    sub: 'Fünf Provider sind eingebaut, dazu rund 190 weitere OpenAI-kompatible aus dem Models.dev-Katalog. Verbinde jeden mit `nib auth`, wechsle mitten in der Sitzung mit `/model`. Nichts verlässt deinen Rechner außer der Anfrage an den Provider, den du gewählt hast.',
    more: 'und ~190 weitere',
  },
  involved: {
    h2: 'Mach mit.',
    items: [
      { title: 'GitHub Issues', body: 'Melde einen Fehler oder wünsch dir eine Funktion.' },
      { title: 'Diskussionen', body: 'Stell eine Frage oder erzähl, wie du Nib einsetzt.' },
      { title: 'Doku', body: 'Die Spezifikationen hinter Berechtigungen, Auto-Modus, Modi und mehr.' },
      { title: 'Changelog', body: 'Was sich in jeder Version geändert hat.' },
    ],
  },
  notFound: {
    title: 'Seite nicht gefunden | Nib',
    description: 'Diese Seite gibt es nicht.',
    h1: 'Seite nicht gefunden.',
    p: 'Diese Adresse gibt es nicht. Probier eine dieser Seiten.',
    home: 'Startseite',
  },
};

const es: typeof en = {
  homeTitle: 'Nib: agente de programación de código abierto para la terminal',
  description: 'Agente de código abierto para la terminal, con tu propia clave. Un día con DeepSeek cuesta unos dólares; ~190 proveedores más, Ollama local incluido. Sin telemetría.',
  ogDescription: 'Trae tu propia clave. Un día entero con DeepSeek por unos pocos dólares. Permisos explícitos, puntos de control reversibles, MCP, skills. Sin telemetría.',

  homeLabel: 'Nib, inicio',
  navLabel: 'Secciones',
  footerNavLabel: 'Pie de página',
  nav: { cost: 'Coste', features: 'Funciones', install: 'Instalar', blog: 'Blog', privacy: 'Privacidad', github: 'GitHub', docs: 'Documentación', discussions: 'Debates', changelog: 'Changelog' },
  footerTagline: 'Nib, licencia Apache 2.0.',

  banner: 'nib 0.7.0: modo auto, en el que un modelo juez responde a las solicitudes de permiso.',
  hero: {
    h1: 'Un agente de programación que puedes permitirte dejar en marcha.',
    lead: 'Código abierto, con tu propia clave, pensado para modelos baratos. Permisos explícitos, sin telemetría.',
    setup: 'Configuración completa',
    source: 'Ver el código',
    alt: 'Nib en una terminal en modo Code con DeepSeek V4 Flash',
  },
  cost: {
    h2: 'Un día entero con DeepSeek por menos de 7 $.',
    sub: 'Nib mantiene estable el prefijo del prompt para que las cachés del proveedor acierten. Medido en un día real de trabajo, 20-10-2026, en la página de uso de DeepSeek para la clave de API de Nib.',
    stats: [
      { n: '6,89 $', p: 'factura total del día' },
      { n: '1.200 M', p: 'tokens en el día' },
      { n: '5.005', p: 'peticiones en el día' },
    ],
    caption: 'Nib /usage el 18-10-2026: 504.190.080 de 506.372.034 tokens de entrada vinieron de la caché (99,57 %).',
    usageAlt: 'El panel /usage de Nib con los tokens por modelo y los tokens en caché',
  },
  how: {
    h2: 'Tres comandos hasta tu primera sesión.',
    sub: 'Requiere Node.js 20 o superior y Git. Las claves se guardan en local con permisos 0600.',
    comments: ['instalar', 'añade una clave de DeepSeek, OpenAI, Ollama o ~190 proveedores más', 'sesión interactiva en modo Code; /mode general para chat de solo lectura'],
    brew: 'En macOS con Homebrew:',
    copy: 'Copiar',
    copied: 'Copiado',
  },
  modes: {
    h2: 'Un agente, varias formas de ejecutarlo.',
    items: [
      { body: 'La interfaz de terminal interactiva, que arranca en modo Code: editar archivos, ejecutar comandos, delegar trabajo.' },
      { body: 'Imprime la respuesta y termina, para pipes y scripts; como no hay a quién preguntar, se deniega todo lo que pediría confirmación.' },
      { body: 'Continúa la sesión más reciente de este directorio.' },
      { body: 'Recorre la postura de permisos: normal, auto, plan. `/mode general` cambia a un chat de solo lectura.' },
    ],
  },
  features: {
    h2: 'Diez funciones y cómo usar cada una.',
    sub: 'Cada una con las teclas, comandos o ajustes que necesitas.',
    demos: {
      auto: 'Postura auto, ejecución real con DeepSeek V4.1 Flash: Nib corrige el error y ejecuta las pruebas sin pedir permiso.',
      undo: '`/undo` restaura el archivo y devuelve el prompt original a la entrada.',
      headless: 'La misma tarea con `nib -p`: no hay a quién preguntar, así que se deniegan las ejecuciones de pruebas y Nib lo indica.',
    },
    rows: [
      {
        kicker: 'Permisos y sandbox',
        title: 'Cada llamada a una herramienta pasa por una regla.',
        body: [
          'Permitir, preguntar o denegar, por herramienta y patrón. `/permissions` muestra las decisiones de esta sesión.',
          'En macOS, Bash, los trabajos en segundo plano, los servidores MCP y los hooks se ejecutan bajo un perfil Seatbelt. Las escrituras se quedan en el espacio de trabajo, el directorio temporal de la sesión y las cachés de las herramientas. Gracias a ese límite, el Bash normal dentro de la sandbox se ejecuta sin preguntar. Los trabajos en segundo plano y los comandos vigilados siguen preguntando.',
        ],
        doc: 'Especificación de permisos',
      },
      {
        kicker: 'Modo auto',
        title: 'Un modelo juez responde a las preguntas.',
        body: [
          'Con `Shift+Tab` recorres normal, auto y plan. En auto, las llamadas de solo lectura y las ediciones normales dentro del espacio de trabajo se ejecutan sin avisar. Un modelo juez permite o bloquea todo lo demás en lugar de preguntarte.',
          'El juez lee tus mensajes y las llamadas a herramientas del agente, nunca su salida. Te sigue preguntando por archivos de credenciales como `.env`, cambios en la configuración de git, todo lo que se ejecutaría fuera de la sandbox y las llamadas que coincidan con una regla `ask` que hayas escrito. Tras 3 llamadas bloqueadas seguidas (20 en total), Nib vuelve a preguntarte. El modo auto no está disponible con `nib -p`. La Fig. 01 de arriba es una ejecución real.',
        ],
        doc: 'Guía del modo auto',
      },
      {
        kicker: 'Servidores de lenguaje',
        title: 'Los errores llegan en el resultado de la edición.',
        body: [
          'Tras cada edición, Nib consulta al servidor de lenguaje por los archivos cambiados y añade los errores y avisos al resultado de esa edición. El modelo los corrige en el paso siguiente.',
          'Una herramienta `lsp` de solo lectura responde definiciones, referencias, hover, símbolos, implementaciones y jerarquías de llamadas desde el servidor, en vez de buscar texto.',
          'Los servidores de Dart y TypeScript vienen integrados. Arrancan cuando existe `pubspec.yaml` o `tsconfig.json`, el binario del servidor está en el `PATH` y la carpeta es de confianza. Añade otros en `lspServers`.',
        ],
        doc: 'Especificación de configuración',
      },
      {
        kicker: 'Dirigir',
        title: 'Háblale a Nib mientras trabaja.',
        body: [
          'Escribe mientras un turno está en marcha y pulsa `Enter`. El mensaje espera en una cola que se muestra sobre la entrada, con la hora a la que lo enviaste. Nib se lo pasa al modelo antes de su siguiente petición al proveedor, como un mensaje de usuario real, nunca a mitad de un stream.',
          '`Esc` interrumpe la llamada en curso y vuelve a la entrada. Lo que está en cola nunca se descarta. Los comandos slash que escribas mientras tanto se ejecutan al terminar el turno, salvo `/skill <name>`, que se aplica al turno en curso.',
        ],
        doc: 'Especificación de la CLI',
      },
      {
        kicker: 'Deshacer y ediciones seguras',
        title: 'Retrocede el código, el chat o ambos.',
        body: [
          'Las ediciones de una sesión interactiva se guardan en un repositorio Git paralelo. `/undo` retrocede el código, la conversación o ambos.',
          'Nib recuerda cuándo leyó un archivo por última vez. Si cambió fuera del agente desde entonces, rechaza la edición con `FILE_MODIFIED` y primero vuelve a leerlo.',
        ],
        doc: 'Especificación de sesiones',
      },
      {
        kicker: 'Sesiones y contexto largo',
        title: 'Continúa donde lo dejaste.',
        body: [
          'Las sesiones son archivos JSONL a los que solo se añade, guardados en tu equipo. `nib -c` continúa la más reciente de este directorio y `nib -r <id>` reanuda una por su ID. La lista de tareas vuelve con ella.',
          'Las sesiones largas se mantienen ligeras. Nib limita las salidas de herramientas demasiado grandes, borra los resultados antiguos de las peticiones grandes y compacta la conversación anterior. La transcripción completa se queda en el registro local. `/compact` lo hace a mano.',
        ],
        doc: 'Documentación de sesiones y contexto',
      },
      {
        kicker: 'Trabajos en segundo plano y subagentes',
        title: 'El trabajo largo corre aparte.',
        body: [
          'Las compilaciones y los servidores de desarrollo pueden ejecutarse como trabajos en segundo plano, hasta 10 a la vez. Una sola llamada a `check_job` espera a que termine el trabajo, así que el modelo no consulta en bucle.',
          'Con `new_task`, el modelo puede delegar trabajo acotado a un subagente. Se ejecuta en segundo plano, hasta 3 a la vez, y su resumen llega como un mensaje posterior. Define tus propios agentes en `.nib/agents`.',
          '`/jobs` muestra ambos y `x` detiene el elegido. Los trabajos y las tareas terminan cuando sales de Nib.',
        ],
        doc: 'Especificación de herramientas',
      },
      {
        kicker: 'Imágenes y web',
        title: 'Enséñale una captura. Deja que busque.',
        body: [
          'Pega una imagen con `Ctrl+V` o escribe `@path/to/shot.png` en el prompt. El modelo también puede llamar a `view_image` con una URL https o un archivo local. PNG, JPEG, GIF y WebP de hasta 5 MB, y el modelo activo debe aceptar imágenes.',
          '`web_search` funciona sin clave mediante Bing RSS. `web_fetch` descarga páginas HTTPS y comprueba los destinos arbitrarios contra SSRF. Ambas piden permiso y se tratan como entrada no fiable. Para obtener mejores resultados, apunta Nib a una instancia local de SearXNG.',
        ],
        doc: 'Especificación de búsqueda web',
      },
      {
        kicker: 'Ampliar',
        title: 'Conecta lo que ya usas.',
        body: [
          'Añade cualquier servidor MCP stdio con `nib mcp add` y compruébalo con `/mcp`. Los servidores se ejecutan dentro de la sandbox; los de navegador necesitan `--no-sandbox`. Lista las Agent Skills con `/skills`.',
          'Los hooks ejecutan tus comandos de shell en eventos como `PreToolUse` y `UserPromptSubmit`, y pueden bloquear una llamada a una herramienta o un prompt. Apunta `notify` a un script para recibir un aviso cuando termine o falle un turno, o cuando acabe un trabajo en segundo plano.',
          'Los modos personalizados son archivos YAML en `~/.nib/modes/` con su propio rol, grupos de herramientas y límites de archivos.',
        ],
        doc: 'Especificación de hooks',
      },
      {
        kicker: 'Sin interfaz y visibilidad',
        title: 'Automatízalo. Mira cuánto ha usado.',
        body: [
          '`nib -p "..."` imprime la respuesta y termina, sin TUI y sin TTY. Los errores van a stderr, así que stdout sigue siendo apto para pipes. Como no hay a quién preguntar, se deniega todo lo que pediría confirmación. `--max-turns` limita los turnos del agente.',
          '`/usage` muestra los tokens por modelo y, si el proveedor lo admite, el saldo de tu cuenta. `nib doctor` imprime la configuración y de dónde salen las credenciales. El thinking viene activado por defecto, y `/effort` fija el esfuerzo de razonamiento.',
        ],
        doc: 'Especificación de la CLI',
      },
    ],
  },
  fig: 'Fig.',
  differs: {
    h2: 'Lo que Nib hace de forma distinta.',
    sub: 'Cuatro decisiones que marcan cómo funciona, cada una con la documentación que la respalda.',
    items: [
      { title: 'Hecho para la caché.', body: 'El prefijo del prompt se mantiene idéntico byte a byte y el estado cambiante va al final, así que las cachés del proveedor aciertan: el 99,57 % de los tokens de entrada en un día real.', link: 'Ver las cifras' },
      { title: 'Un juez, no un aviso emergente.', body: 'En la postura auto (`Shift+Tab`), las llamadas de solo lectura se ejecutan sin más y las arriesgadas pasan a un modelo rápido que actúa de juez. Vuelves a un trabajo terminado, no a un aviso detenido.', link: 'Cómo funciona el modo auto' },
      { title: 'Sin cuenta, sin telemetría, sin servidor.', body: 'Un único proceso local. La única petición que sale de tu equipo va al proveedor que elegiste.', link: 'Política de privacidad' },
      { title: 'Cada subsistema tiene su especificación.', body: 'Permisos, compactación, sandboxing: cada uno está documentado en `docs/`, así puedes leer el diseño detrás de cualquier comportamiento en el que confíes.', link: 'Leer la documentación' },
    ],
  },
  providers: {
    h2: 'Tu clave, cualquier modelo.',
    sub: 'Cinco proveedores integrados, más unos 190 compatibles con OpenAI del catálogo de Models.dev. Conecta cualquiera con `nib auth` y cambia a mitad de sesión con `/model`. Nada sale de tu equipo salvo la petición al proveedor que elegiste.',
    more: 'y ~190 más',
  },
  involved: {
    h2: 'Participa.',
    items: [
      { title: 'Issues de GitHub', body: 'Informa de un fallo o pide una función.' },
      { title: 'Debates', body: 'Haz una pregunta o cuenta cómo usas Nib.' },
      { title: 'Documentación', body: 'Las especificaciones detrás de los permisos, el modo auto, los modos y más.' },
      { title: 'Changelog', body: 'Qué cambió en cada versión.' },
    ],
  },
  notFound: {
    title: 'Página no encontrada | Nib',
    description: 'Esta página no existe.',
    h1: 'Página no encontrada.',
    p: 'Esa dirección no existe. Prueba con una de estas.',
    home: 'Inicio',
  },
};

export const strings: Record<Lang, typeof en> = { en, de, es };

// Commands are not translated.
export const BANNER_CMD = 'npm i -g @amenski/nib';
export const MODE_CMDS = ['nib', 'nib -p "..."', 'nib -c', 'Shift+Tab'];
export const PROVIDERS = ['DeepSeek', 'OpenAI', 'OpenRouter', 'Groq', 'Ollama (local)'];
