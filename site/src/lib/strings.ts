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

  hero: {
    h1: 'A coding agent you can afford to leave running.',
    lead: 'Open-source, bring-your-own-key, built for cheap models. Explicit permissions, no telemetry.',
    install: 'Install',
    source: 'View source',
    alt: 'Nib running in a terminal in Code mode on DeepSeek V4 Flash',
    video: 'Nib launch video: one full day of a coding agent for $6.89',
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
  features: {
    h2: 'Everything a hosted agent does, inside one process you can read.',
    items: [
      { title: 'Permissions are rules, not vibes', body: 'Every tool call passes an allow / ask / deny engine before it runs. Sandbox profiles confine the shell to your workspace. Every decision is logged.', size: 'a' },
      { title: 'Rewindable checkpoints', body: 'Edits are snapshotted in a shadow Git repo, so code and conversation roll back together.', size: 'b' },
      { title: 'Resumable sessions', body: '`nib -c` picks up where you stopped. Context is compacted, never lost.', size: 'c' },
      { title: 'MCP, skills, sub-agents', body: '`nib mcp add` wires any server. Agent Skills and `.nib/agents` definitions load per project.', size: 'd' },
      { title: 'Headless for scripts', body: '`nib -p "..."` runs one shot with no TUI. Hooks and custom slash commands work the way Claude Code users expect.', size: 'e' },
    ],
  },
  providers: {
    h2: 'Your key, any model.',
    sub: 'Five providers built in, plus ~190 more OpenAI-compatible ones from the Models.dev catalog. Connect any with `nib auth`, switch mid-session with `/model`. Nothing leaves your machine except the request to the provider you chose.',
    more: 'and ~190 more',
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

  hero: {
    h1: 'Ein Coding-Agent, den du dir leisten kannst, laufen zu lassen.',
    lead: 'Open Source, eigener API-Schlüssel, für günstige Modelle gebaut. Explizite Berechtigungen, keine Telemetrie.',
    install: 'Installieren',
    source: 'Quellcode ansehen',
    alt: 'Nib im Terminal im Code-Modus mit DeepSeek V4 Flash',
    video: 'Nib-Video: ein ganzer Tag mit einem Coding-Agenten für 6,89 $',
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
  features: {
    h2: 'Alles, was ein gehosteter Agent kann, in einem Prozess, den du lesen kannst.',
    items: [
      { title: 'Berechtigungen sind Regeln, keine Stimmungen', body: 'Jeder Tool-Aufruf durchläuft vor der Ausführung eine Engine mit erlauben / fragen / verweigern. Sandbox-Profile beschränken die Shell auf deinen Workspace. Jede Entscheidung wird protokolliert.', size: 'a' },
      { title: 'Zurückspulbare Checkpoints', body: 'Änderungen werden in einem Schatten-Git-Repository gesichert, sodass Code und Unterhaltung gemeinsam zurückgerollt werden.', size: 'b' },
      { title: 'Fortsetzbare Sitzungen', body: '`nib -c` macht dort weiter, wo du aufgehört hast. Kontext wird verdichtet, nie verloren.', size: 'c' },
      { title: 'MCP, Skills, Sub-Agenten', body: '`nib mcp add` bindet jeden Server an. Agent Skills und `.nib/agents`-Definitionen werden pro Projekt geladen.', size: 'd' },
      { title: 'Headless für Skripte', body: '`nib -p "..."` läuft einmalig ohne TUI. Hooks und eigene Slash-Befehle funktionieren so, wie Claude-Code-Nutzer es erwarten.', size: 'e' },
    ],
  },
  providers: {
    h2: 'Dein Schlüssel, jedes Modell.',
    sub: 'Fünf Provider sind eingebaut, dazu rund 190 weitere OpenAI-kompatible aus dem Models.dev-Katalog. Verbinde jeden mit `nib auth`, wechsle mitten in der Sitzung mit `/model`. Nichts verlässt deinen Rechner außer der Anfrage an den Provider, den du gewählt hast.',
    more: 'und ~190 weitere',
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

  hero: {
    h1: 'Un agente de programación que puedes permitirte dejar en marcha.',
    lead: 'Código abierto, con tu propia clave, pensado para modelos baratos. Permisos explícitos, sin telemetría.',
    install: 'Instalar',
    source: 'Ver el código',
    alt: 'Nib en una terminal en modo Code con DeepSeek V4 Flash',
    video: 'Vídeo de Nib: un día entero con un agente de programación por 6,89 $',
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
  features: {
    h2: 'Todo lo que hace un agente alojado, dentro de un proceso que puedes leer.',
    items: [
      { title: 'Los permisos son reglas, no corazonadas', body: 'Cada llamada a una herramienta pasa por un motor de permitir / preguntar / denegar antes de ejecutarse. Los perfiles de sandbox confinan la shell a tu espacio de trabajo. Cada decisión queda registrada.', size: 'a' },
      { title: 'Puntos de control reversibles', body: 'Las ediciones se guardan en un repositorio Git paralelo, así que código y conversación retroceden juntos.', size: 'b' },
      { title: 'Sesiones reanudables', body: '`nib -c` continúa donde lo dejaste. El contexto se compacta, nunca se pierde.', size: 'c' },
      { title: 'MCP, skills, subagentes', body: '`nib mcp add` conecta cualquier servidor. Las Agent Skills y las definiciones de `.nib/agents` se cargan por proyecto.', size: 'd' },
      { title: 'Sin interfaz para scripts', body: '`nib -p "..."` ejecuta una sola vez sin TUI. Los hooks y los comandos slash personalizados funcionan como esperan los usuarios de Claude Code.', size: 'e' },
    ],
  },
  providers: {
    h2: 'Tu clave, cualquier modelo.',
    sub: 'Cinco proveedores integrados, más unos 190 compatibles con OpenAI del catálogo de Models.dev. Conecta cualquiera con `nib auth` y cambia a mitad de sesión con `/model`. Nada sale de tu equipo salvo la petición al proveedor que elegiste.',
    more: 'y ~190 más',
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

export const PROVIDERS = ['DeepSeek', 'OpenAI', 'OpenRouter', 'Groq', 'Ollama (local)'];
