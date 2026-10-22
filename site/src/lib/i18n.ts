export const LOCALES = ['en', 'de', 'es'] as const;
export type Lang = (typeof LOCALES)[number];
export const DEFAULT_LANG: Lang = 'en';

// Collection ids are '<slug>' for English and '<lang>/<slug>' for translations.
export const langOf = (id: string): Lang => {
  const prefix = id.split('/')[0] as Lang;
  return id.includes('/') && LOCALES.includes(prefix) ? prefix : DEFAULT_LANG;
};
export const slugOf = (id: string) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);

export const homePath = (lang: Lang) => (lang === 'en' ? '/' : `/${lang}`);
// Section anchor on the home page of a language: /#cost, /de#cost.
export const homeAnchor = (lang: Lang, id: string) => `${homePath(lang)}#${id}`;
export const homeHrefs = (): Record<Lang, string> => ({ en: homePath('en'), de: homePath('de'), es: homePath('es') });

export const blogPath = (lang: Lang) => (lang === 'en' ? '/blog' : `/${lang}/blog`);
export const postPath = (lang: Lang, slug: string) => `${blogPath(lang)}/${slug}`;

export const privacyPath = (lang: Lang) => (lang === 'en' ? '/privacy' : `/${lang}/privacy`);
export const privacyHrefs = (): Record<Lang, string> => ({ en: privacyPath('en'), de: privacyPath('de'), es: privacyPath('es') });

export const ogLocale: Record<Lang, string> = { en: 'en_US', de: 'de_DE', es: 'es_ES' };
const dateLocale: Record<Lang, string> = { en: 'en-US', de: 'de-DE', es: 'es-ES' };
export const formatDate = (date: Date, lang: Lang) =>
  date.toLocaleDateString(dateLocale[lang], { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

// Chrome strings used by the blog pages only. Post text lives in the markdown files.
export const ui = {
  en: {
    blog: 'Blog',
    home: 'Home',
    back: '← All posts',
    related: 'Related posts',
    latest: 'Latest posts',
    indexTitle: 'Blog | Nib',
    indexDescription: 'Notes from the team behind Nib, the open-source coding agent for the terminal: measured costs, design decisions and how-tos.',
    langLabel: 'Language',
  },
  de: {
    blog: 'Blog',
    home: 'Startseite',
    back: '← Alle Beiträge',
    related: 'Weitere Beiträge',
    latest: 'Neueste Beiträge',
    indexTitle: 'Blog | Nib',
    indexDescription: 'Notizen vom Team hinter Nib, dem Open-Source-Coding-Agenten für das Terminal: gemessene Kosten, Designentscheidungen und Anleitungen.',
    langLabel: 'Sprache',
  },
  es: {
    blog: 'Blog',
    home: 'Inicio',
    back: '← Todas las entradas',
    related: 'Entradas relacionadas',
    latest: 'Entradas recientes',
    indexTitle: 'Blog | Nib',
    indexDescription: 'Notas del equipo detrás de Nib, el agente de programación de código abierto para la terminal: costes medidos, decisiones de diseño y guías.',
    langLabel: 'Idioma',
  },
} satisfies Record<Lang, Record<string, string>>;

// Index intro with a link to the home page: text before and after the "Nib" link.
export const introParts: Record<Lang, [string, string]> = {
  en: ['Notes from the team behind ', ', an open-source, bring-your-own-key coding agent for the terminal. Measured numbers, the reasoning behind design decisions, and how to get more done for less.'],
  de: ['Notizen vom Team hinter ', ', einem Open-Source-Coding-Agenten für das Terminal mit eigenem API-Schlüssel. Gemessene Zahlen, die Gründe hinter Designentscheidungen und wie du mit weniger mehr erreichst.'],
  es: ['Notas del equipo detrás de ', ', un agente de programación de código abierto para la terminal con tu propia clave de API. Cifras medidas, el razonamiento detrás de las decisiones de diseño y cómo conseguir más gastando menos.'],
};
