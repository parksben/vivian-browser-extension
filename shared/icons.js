/**
 * shared/icons.js
 * Single source of truth for all Lucide SVG icons used in ClawTab.
 *
 * Injects a hidden <svg> sprite into <head> so any page that loads this
 * script can reference symbols via  <svg><use href="#icon-NAME"></use></svg>
 * or call  icon('NAME', size)  to get an HTML string.
 *
 * CSS on .icon sets the common stroke presentation so paths stay clean.
 */
(function () {

  // ── Icon path definitions ──────────────────────────────────────────────
  // Only the inner SVG paths — viewBox is always 0 0 24 24.

  const ICONS = {
    // Action / navigation
    'send':
      '<line x1="22" y1="2" x2="11" y2="13"/>' +
      '<polygon points="22 2 15 22 11 13 2 9 22 2"/>',

    'arrow-right-to-line':           // "hide/collapse right panel"
      '<path d="M17 12H3"/>' +
      '<path d="m11 18 6-6-6-6"/>' +
      '<path d="M21 5v14"/>',

    'copy':
      '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
      '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',

    // Chat / messaging
    'message-square':
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',

    // Controls
    'settings':
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06' +
      'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09' +
      'A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06' +
      'A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09' +
      'A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06' +
      'A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09' +
      'a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06' +
      'A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09' +
      'a1.65 1.65 0 0 0-1.51 1z"/>',

    'power-off':
      '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>' +
      '<line x1="12" y1="2" x2="12" y2="12"/>',

    'eye':
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
      '<circle cx="12" cy="12" r="3"/>',

    // Status / indicators
    'alert-triangle':
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>' +
      '<path d="M12 9v4"/>' +
      '<path d="M12 17h.01"/>',

    'link':
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',

    // Picker
    'mouse-pointer':
      '<path d="M12.586 12.586 19 19"/>' +
      '<path d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"/>',

    // Language / globe
    'globe':
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="2" y1="12" x2="22" y2="12"/>' +
      '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',

    // File / folder
    'download':
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/>',

    'file-up':
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
      '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
      '<path d="M12 12v6"/>' +
      '<path d="m15 15-3-3-3 3"/>',

    'file-down':
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
      '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
      '<path d="M12 10v6"/>' +
      '<path d="m9 16 3 3 3-3"/>',

    'folder-open':
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',

    // Confirm / check
    'check':
      '<polyline points="20 6 9 17 4 12"/>',

    // Destructive
    'trash-2':
      '<path d="M3 6h18"/>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      '<line x1="10" y1="11" x2="10" y2="17"/>' +
      '<line x1="14" y1="11" x2="14" y2="17"/>',

    // Locate / focus element
    'locate':
      '<line x1="2" y1="12" x2="5" y2="12"/>' +
      '<line x1="19" y1="12" x2="22" y2="12"/>' +
      '<line x1="12" y1="2" x2="12" y2="5"/>' +
      '<line x1="12" y1="19" x2="12" y2="22"/>' +
      '<circle cx="12" cy="12" r="7"/>',
  };

  // ── Inject sprite into <head> ──────────────────────────────────────────
  const NS  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'display:none;position:absolute;width:0;height:0;overflow:hidden';

  for (const [name, paths] of Object.entries(ICONS)) {
    const sym = document.createElementNS(NS, 'symbol');
    sym.setAttribute('id', 'icon-' + name);
    sym.setAttribute('viewBox', '0 0 24 24');
    sym.innerHTML = paths;
    svg.appendChild(sym);
  }

  document.head.appendChild(svg);

  // ── icon() helper for JS-generated HTML ───────────────────────────────
  /**
   * Returns an <svg> HTML string referencing the sprite symbol.
   * @param {string} name   - icon key (see ICONS above)
   * @param {number} [size] - width/height in px (default 15)
   * @param {string} [cls]  - extra CSS classes for the <svg> element
   */
  window.icon = function (name, size, cls) {
    const s = size || 15;
    const c = cls ? ' ' + cls : '';
    return '<svg class="icon' + c + '" width="' + s + '" height="' + s +
           '" aria-hidden="true"><use href="#icon-' + name + '"></use></svg>';
  };

})();
