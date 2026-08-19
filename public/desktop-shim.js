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

    // Resolves true when the system browser was handed the URL. Callers get the
    // answer rather than a silent nothing: a refusal here used to be invisible,
    // which is exactly how an empty opener scope went unnoticed.
    openExternal: async (url) => {
      if (!/^https?:\/\//i.test(url || '')) return false;
      try {
        await window.__TAURI__.core.invoke('plugin:opener|open_url', { url });
        return true;
      } catch (e) {
        console.error('openExternal failed for', url, e);
        return false;
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

  // A plain <a> is inert inside the webview: target="_blank" asks for a new
  // window and nothing answers, so the click lands on nothing — which is why the
  // links in the PR and task dialogs worked in a browser tab and did nothing in
  // the installed app. Without a target it is worse than inert: the webview
  // navigates the workspace itself off to the site.
  //
  // Handled once here, in the capture phase, so it covers markup, the anchors
  // built on the fly inside modals, and anything added later — no call site has
  // to remember. Other listeners still run; only the navigation is taken over.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    // The property, not the attribute: it resolves a relative href the same way
    // the webview would before deciding this is an external link.
    const href = a.href || '';
    if (!/^https?:\/\//i.test(href) || href.startsWith(location.origin)) return;
    e.preventDefault();
    window.tauriDesktop.openExternal(href);
  }, true);

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

    wireQuitGuard(win);
  }

  // Ask before the window goes when sessions are still running.
  //
  // Tauri v2 hands close-requested to the page and then waits: with a listener
  // attached nothing closes until this handler calls destroy(). That is why the
  // guard covers every route out — the ✕ button above, Alt+F4, the taskbar —
  // rather than just the one button we own, and why the "yes, quit" path has to
  // destroy the window explicitly.
  function wireQuitGuard(win) {
    let asking = false;

    win.onCloseRequested(async (event) => {
      const confirmQuit = window._catalystConfirmQuit;
      // The page has not registered a guard yet (splash, or a reload in
      // progress). Nothing to ask about, so let the close proceed as before.
      if (typeof confirmQuit !== 'function') return;

      event.preventDefault();

      // A second ✕ while the dialog is up must not stack another one.
      if (asking) return;
      asking = true;
      try {
        if (await confirmQuit()) await win.destroy();
      } catch (e) {
        // A broken guard must never trap the user inside the app.
        console.error('quit guard failed, closing anyway', e);
        await win.destroy();
      } finally {
        asking = false;
      }
    }).catch((e) => console.error('quit guard not installed', e));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireWindowControls);
  } else {
    wireWindowControls();
  }
})();
