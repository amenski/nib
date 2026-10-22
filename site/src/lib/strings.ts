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
  description: 'Open-source, bring-your-own-key coding agent for the terminal. Run all day on DeepSeek for a few dollars, or use OpenAI, OpenRouter, Groq, local Ollama. Explicit permissions, no telemetry.',
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
  },
  cost: {
    h2: 'One full day on DeepSeek costs less than a coffee.',
    sub: 'Nib keeps the prompt prefix stable so provider caches hit. Measured on a real day of work, 2026-10-12, DeepSeek V4 Flash.',
    stats: [
      { n: '98.1%', p: 'cache hit rate across 270M input tokens' },
      { n: '1,834', p: 'requests in the day' },
      { n: '$4.45', p: 'total bill, including a few hours at peak pricing' },
    ],
  },
  how: {
    h2: 'Three commands to a first session.',
    sub: 'Needs Node.js 20 or newer and Git. Keys are stored locally with mode 0600.',
    comments: ['install', 'add a DeepSeek, OpenAI, OpenRouter, Groq or Ollama key', 'interactive session, read-only until you switch to /mode code'],
  },
  features: {
    h2: 'Everything a hosted agent does, inside one process you can read.',
    items: [
      { title: 'Permissions are rules, not vibes', body: 'Every tool call passes an allow / ask / deny engine before it runs. Sandbox profiles confine the shell to your workspace. Every decision is logged.', size: 'wide feature' },
      { title: 'Rewindable checkpoints', body: 'Edits are snapshotted in a shadow Git repo, so code and conversation roll back together.', size: 'narrow' },
      { title: 'Resumable sessions', body: '`nib -c` picks up where you stopped. Context is compacted, never lost.', size: 'third' },
      { title: 'MCP, skills, sub-agents', body: '`nib mcp add` wires any server. Agent Skills and `.nib/agents` definitions load per project.', size: 'third' },
      { title: 'Headless for scripts', body: '`nib -p "..."` runs one shot with no TUI. Hooks and custom slash commands work the way Claude Code users expect.', size: 'third' },
    ],
  },
  providers: {
    h2: 'Your key, your model.',
    sub: 'Switch providers mid-session with `/model`. Nothing leaves your machine except the request to the provider you chose.',
  },
  install: {
    h2: 'Install',
    sub: 'Apache 2.0. macOS and Linux.',
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
  description: 'Open-Source-Coding-Agent für das Terminal mit eigenem API-Schlüssel. Einen ganzen Tag für ein paar Dollar mit DeepSeek arbeiten oder OpenAI, OpenRouter, Groq und lokales Ollama nutzen. Explizite Berechtigungen, keine Telemetrie.',
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
  },
  cost: {
    h2: 'Ein ganzer Tag mit DeepSeek kostet weniger als ein Kaffee.',
    sub: 'Nib hält das Prompt-Präfix stabil, damit die Provider-Caches greifen. Gemessen an einem echten Arbeitstag, 12.10.2026, DeepSeek V4 Flash.',
    stats: [
      { n: '98,1 %', p: 'Cache-Trefferquote bei 270 Mio. Input-Tokens' },
      { n: '1.834', p: 'Anfragen an diesem Tag' },
      { n: '4,45 $', p: 'Gesamtrechnung, inklusive einiger Stunden zum Spitzentarif' },
    ],
  },
  how: {
    h2: 'Drei Befehle bis zur ersten Sitzung.',
    sub: 'Benötigt Node.js 20 oder neuer und Git. Schlüssel werden lokal mit Modus 0600 gespeichert.',
    comments: ['installieren', 'Schlüssel für DeepSeek, OpenAI, OpenRouter, Groq oder Ollama hinzufügen', 'interaktive Sitzung, schreibgeschützt, bis du mit /mode code wechselst'],
  },
  features: {
    h2: 'Alles, was ein gehosteter Agent kann, in einem Prozess, den du lesen kannst.',
    items: [
      { title: 'Berechtigungen sind Regeln, keine Stimmungen', body: 'Jeder Tool-Aufruf durchläuft vor der Ausführung eine Engine mit erlauben / fragen / verweigern. Sandbox-Profile beschränken die Shell auf deinen Workspace. Jede Entscheidung wird protokolliert.', size: 'wide feature' },
      { title: 'Zurückspulbare Checkpoints', body: 'Änderungen werden in einem Schatten-Git-Repository gesichert, sodass Code und Unterhaltung gemeinsam zurückgerollt werden.', size: 'narrow' },
      { title: 'Fortsetzbare Sitzungen', body: '`nib -c` macht dort weiter, wo du aufgehört hast. Kontext wird verdichtet, nie verloren.', size: 'third' },
      { title: 'MCP, Skills, Sub-Agenten', body: '`nib mcp add` bindet jeden Server an. Agent Skills und `.nib/agents`-Definitionen werden pro Projekt geladen.', size: 'third' },
      { title: 'Headless für Skripte', body: '`nib -p "..."` läuft einmalig ohne TUI. Hooks und eigene Slash-Befehle funktionieren so, wie Claude-Code-Nutzer es erwarten.', size: 'third' },
    ],
  },
  providers: {
    h2: 'Dein Schlüssel, dein Modell.',
    sub: 'Wechsle den Provider mitten in der Sitzung mit `/model`. Nichts verlässt deinen Rechner außer der Anfrage an den Provider, den du gewählt hast.',
  },
  install: {
    h2: 'Installieren',
    sub: 'Apache 2.0. macOS und Linux.',
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
  description: 'Agente de programación de código abierto para la terminal con tu propia clave de API. Trabaja todo el día con DeepSeek por unos pocos dólares, o usa OpenAI, OpenRouter, Groq y Ollama local. Permisos explícitos, sin telemetría.',
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
  },
  cost: {
    h2: 'Un día entero con DeepSeek cuesta menos que un café.',
    sub: 'Nib mantiene estable el prefijo del prompt para que las cachés del proveedor acierten. Medido en un día real de trabajo, 12-10-2026, DeepSeek V4 Flash.',
    stats: [
      { n: '98,1 %', p: 'tasa de aciertos de caché sobre 270 M de tokens de entrada' },
      { n: '1.834', p: 'peticiones en el día' },
      { n: '4,45 $', p: 'factura total, incluidas unas horas a precio de hora punta' },
    ],
  },
  how: {
    h2: 'Tres comandos hasta tu primera sesión.',
    sub: 'Requiere Node.js 20 o superior y Git. Las claves se guardan en local con permisos 0600.',
    comments: ['instalar', 'añade una clave de DeepSeek, OpenAI, OpenRouter, Groq u Ollama', 'sesión interactiva, solo lectura hasta que cambies a /mode code'],
  },
  features: {
    h2: 'Todo lo que hace un agente alojado, dentro de un proceso que puedes leer.',
    items: [
      { title: 'Los permisos son reglas, no corazonadas', body: 'Cada llamada a una herramienta pasa por un motor de permitir / preguntar / denegar antes de ejecutarse. Los perfiles de sandbox confinan la shell a tu espacio de trabajo. Cada decisión queda registrada.', size: 'wide feature' },
      { title: 'Puntos de control reversibles', body: 'Las ediciones se guardan en un repositorio Git paralelo, así que código y conversación retroceden juntos.', size: 'narrow' },
      { title: 'Sesiones reanudables', body: '`nib -c` continúa donde lo dejaste. El contexto se compacta, nunca se pierde.', size: 'third' },
      { title: 'MCP, skills, subagentes', body: '`nib mcp add` conecta cualquier servidor. Las Agent Skills y las definiciones de `.nib/agents` se cargan por proyecto.', size: 'third' },
      { title: 'Sin interfaz para scripts', body: '`nib -p "..."` ejecuta una sola vez sin TUI. Los hooks y los comandos slash personalizados funcionan como esperan los usuarios de Claude Code.', size: 'third' },
    ],
  },
  providers: {
    h2: 'Tu clave, tu modelo.',
    sub: 'Cambia de proveedor a mitad de sesión con `/model`. Nada sale de tu equipo salvo la petición al proveedor que elegiste.',
  },
  install: {
    h2: 'Instalar',
    sub: 'Apache 2.0. macOS y Linux.',
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
