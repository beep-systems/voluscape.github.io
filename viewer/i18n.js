import en from './locales/en.js';

// Import and register additional locale modules here when translations are ready.
export const locales = Object.freeze({ en });

export function resolveLocale(language, dictionaries = locales) {
  const requested = String(language ?? '').trim().toLowerCase();
  const supported = ['en', ...Object.keys(dictionaries).filter(key => key !== 'en')];
  return supported.find(key => key.toLowerCase() === requested)
    ?? supported.find(key => key.toLowerCase() === requested.split('-')[0])
    ?? 'en';
}

// A dictionary registry can be supplied by an embedding host or a test fixture.
export function createI18n(language = 'en', dictionaries = locales) {
  const locale = resolveLocale(language, dictionaries);
  const dictionary = dictionaries[locale] ?? en;
  const ownString = (object, key) => Object.hasOwn(object, key) && typeof object[key] === 'string' ? object[key] : undefined;
  return Object.freeze({
    locale,
    t(key, params = {}) {
      const template = ownString(dictionary, key) ?? ownString(en, key) ?? key;
      return template.replace(/\{([\w]+)\}/g, (placeholder, name) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
    },
    formatNumber(value, digits = 0) {
      return new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    }
  });
}

export const english = createI18n();

// Text targets must be dedicated text elements; icon buttons use attribute keys.
export function applyTranslations(root, i18n = english) {
  const bindings = [
    ['data-i18n', null], ['data-i18n-title', 'title'],
    ['data-i18n-aria-label', 'aria-label'], ['data-i18n-placeholder', 'placeholder']
  ];
  const selector = bindings.map(([name]) => `[${name}]`).join(',');
  const elements = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
  for (const element of elements) for (const [name, attribute] of bindings) {
    const key = element.getAttribute(name);
    if (!key) continue;
    const value = i18n.t(key);
    if (attribute) element.setAttribute(attribute, value);
    else element.textContent = value;
  }
}
