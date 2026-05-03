import type { Lang } from '../i18n';

/**
 * Language switch indicator. Shows the **target** language code so the user
 * can read the button as "click to become this":
 *   - currentLang === 'en'  → renders `中`  (target = Chinese)
 *   - currentLang === 'zh'  → renders `EN`  (target = English)
 *
 * Sized to match a 14px Lucide icon visually so it lives inside an
 * IconButton without breaking the row's optical alignment.
 */
export function LangBadge({ currentLang, size = 14 }: { currentLang: Lang; size?: number }) {
  const target: Lang = currentLang === 'en' ? 'zh' : 'en';
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center font-bold leading-none tracking-tight"
      style={{
        // Tighter than icon size so two characters ('EN') still fit inside
        // a 14px optical box.
        fontSize: target === 'en' ? Math.round(size * 0.78) : Math.round(size * 1.0),
        minWidth: size,
        height: size,
      }}
    >
      {target === 'en' ? 'EN' : '中'}
    </span>
  );
}
