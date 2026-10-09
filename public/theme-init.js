// Public appearance preference only. Run before rendering to avoid a light flash.
(() => {
  const key = 'hearth-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => value === 'light' || value === 'dark' ? value : 'system';
  const read = () => { try { return normalize(localStorage.getItem(key)); } catch { return 'system'; } };
  let preference = read();
  const listeners = new Set();
  function apply() {
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17211d' : '#315343');
    listeners.forEach(listener => listener());
  }
  window.__hearthTheme = {
    getPreference: () => preference,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setPreference(value) {
      preference = normalize(value);
      try {
        if (preference === 'system') localStorage.removeItem(key);
        else localStorage.setItem(key, preference);
      } catch { /* Keep the selection in memory when storage is unavailable. */ }
      apply();
    },
  };
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    preference = read();
    apply();
  });
  apply();
})();
