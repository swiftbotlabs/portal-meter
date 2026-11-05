// The light / dark switch for the live page (the landing page has the same code in site.js): the system's
// preference by default, the visitor's choice remembered in localStorage when storage is available.
(() => {
  'use strict';
  const root = document.documentElement;
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => (root.getAttribute('data-theme') || (mq.matches ? 'dark' : 'light')) === 'dark';
  const sync = () => {
    const d = isDark();
    btn.setAttribute('aria-pressed', String(d));
    btn.setAttribute('aria-label', d ? 'Switch to light mode' : 'Switch to dark mode');
  };
  sync();
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    const apply = () => {
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('pm-theme', next); } catch { /* this page only */ }
      sync();
    };
    apply();
  });
  mq.addEventListener?.('change', sync);
})();
