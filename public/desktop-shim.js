/*
 * desktop-shim.js
 * Tauri v2 desktop API bridge. Exposes `window.tauriDesktop` for native
 * folder dialogs, file-reveal, external-URL opening, and title-bar theming.
 * Runs immediately (must execute before the inline is-desktop script in
 * index.html). If not running under Tauri, it does nothing and the page
 * behaves as a plain browser page.
 */
(function () {
  'use strict';

  if (!window.__TAURI__) {
    return;
  }

  window.tauriDesktop = {
    isDesktop: true,

    showFolderDialog: async () => {
      const sel = await window.__TAURI__.core.invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: 'Select folder' }
      });
      return (typeof sel === 'string') ? sel : '';
    },

    revealInExplorer: async (p) => {
      if (typeof p === 'string' && p) {
        try {
          await window.__TAURI__.core.invoke('plugin:opener|reveal_item_in_dir', { path: p });
        } catch (e) { console.error(e); }
      }
    },

    openExternal: async (url) => {
      if (/^https?:\/\//i.test(url || '')) {
        try {
          await window.__TAURI__.core.invoke('plugin:opener|open_url', { url });
        } catch (e) { console.error(e); }
      }
    },

    // Resolves to { version, notes } when a newer release exists, else null.
    // Pure query — nothing is downloaded until installUpdate() is called.
    checkForUpdates: async () => {
      return await window.__TAURI__.core.invoke('check_for_updates');
    },

    // Downloads, verifies and installs the pending update, then restarts. Does
    // not resolve on success: the process is replaced.
    installUpdate: async () => {
      return await window.__TAURI__.core.invoke('install_update');
    },

    updateTitleBarOverlay: ({ color, symbolColor } = {}) => {
      const r = document.documentElement.style;
      if (color) r.setProperty('--win-ctrl-bg', color);
      if (symbolColor) r.setProperty('--win-ctrl-symbol', symbolColor);
    }
  };

  // Wire up custom window-control buttons once the DOM is ready.
  function wireWindowControls() {
    const win = window.__TAURI__.window.getCurrentWindow();

    const minBtn = document.getElementById('win-min');
    const maxBtn = document.getElementById('win-max');
    const closeBtn = document.getElementById('win-close');

    if (minBtn) {
      minBtn.addEventListener('click', async () => {
        try { await win.minimize(); } catch (e) { console.error(e); }
      });
    }

    if (maxBtn) {
      maxBtn.addEventListener('click', async () => {
        try {
          await win.toggleMaximize();
          try {
            const maximized = await win.isMaximized();
            maxBtn.textContent = maximized ? '❐' : '▢';
          } catch (e) { /* static glyph is acceptable */ }
        } catch (e) { console.error(e); }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', async () => {
        try { await win.close(); } catch (e) { console.error(e); }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireWindowControls);
  } else {
    wireWindowControls();
  }
})();
