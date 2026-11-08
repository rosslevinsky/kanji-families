// Light, dark, or the device's setting. Loaded in <head> before the page draws, so a saved choice
// shows from the first frame. The choice belongs to this browser: it is not progress, so it is not
// synced, backed up or removed at sign-out.
(function () {
  const KEY = 'kfd-theme';
  const CHOICES = ['auto', 'light', 'dark'];
  const BARS = { light: '#f3f5f8', dark: '#11151d' };
  const root = document.documentElement;
  const dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  // Where storage is blocked, the choice lasts until the page closes.
  let unstored = null;

  function saved() {
    if (unstored) return unstored;
    try {
      const value = localStorage.getItem(KEY);
      return CHOICES.includes(value) ? value : 'auto';
    } catch (e) { return 'auto'; }
  }

  // The browser bar and the installed app's title bar follow the page.
  function paintBars(choice) {
    const shown = choice === 'auto' ? (dark && dark.matches ? 'dark' : 'light') : choice;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = BARS[shown];
  }

  function apply(choice) {
    if (choice === 'auto') delete root.dataset.theme;
    else root.dataset.theme = choice;
    paintBars(choice);
  }

  apply(saved());
  if (dark && dark.addEventListener) dark.addEventListener('change', () => apply(saved()));
  // Another tab changed the choice.
  window.addEventListener('storage', (e) => { if (e.key === KEY) { apply(saved()); mark(); } });

  function mark() {
    const current = saved();
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === current));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    mark();
    document.addEventListener('click', (e) => {
      const button = e.target.closest && e.target.closest('[data-theme-choice]');
      if (!button) return;
      const choice = button.dataset.themeChoice;
      try {
        if (choice === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
        unstored = null;
      } catch (err) { unstored = choice; }
      apply(choice);
      mark();
    });
  });
})();
