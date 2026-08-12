(function () {
  let ws = null;
  let wsReconnectDelay = 500;
  const WS_MAX_DELAY = 10000;
  let wsOnMessageHandler = null;
  let wsHasConnectedBefore = false;
  let _lastCliAvailabilityCheck = 0; // throttle check-cli-availability from repo-card clicks (60s TTL)

  // Platform-aware modifier handling. On macOS app shortcuts use Cmd (metaKey),
  // which terminals don't consume; on Windows/Linux they use Ctrl (ctrlKey),
  // which IS shared with terminal control codes — so on those platforms an app
  // shortcut must yield when a terminal/input is focused (otherwise e.g. Ctrl+O
  // would both open the repo AND hit Claude Code's "expand file content").
  const IS_MAC = /Mac|iPhone|iPad/i.test((navigator.platform || navigator.userAgent || ''));
  function appMod(e) { return IS_MAC ? e.metaKey : e.ctrlKey; }
  function isTypingContext(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    if (t.closest && t.closest('.xterm')) return true; // inside a terminal
    return false;
  }
  // Format a "Ctrl+Shift+P" style label for the current platform (⌘⇧P on macOS).
  function fmtShortcut(s) {
    if (!s) return '';
    if (!IS_MAC) return s;
    return s.replace(/Ctrl/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/\s*\+\s*/g, '');
  }
  // On macOS, relabel the static cheatsheet rows that carry a data-mac value.
  function localizeMacShortcuts() {
    if (!IS_MAC) return;
    document.querySelectorAll('.shortcut-key[data-mac]').forEach(el => {
      el.textContent = el.getAttribute('data-mac');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', localizeMacShortcuts);
  else localizeMacShortcuts();

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // Dedupe + guard PTY resize messages. Forwarding intermediate or degenerate
  // sizes during layout transitions desyncs the CLI's TUI — its cursor-addressed
  // redraw (e.g. after /clear) then lands in the wrong cells and garbles. Only
  // forward a genuinely-changed, sane size.
  const _lastSentSize = {};
  function sendResize(sessionId, cols, rows) {
    if (!sessionId || !cols || !rows || cols < 2 || rows < 2) return;
    const key = cols + 'x' + rows;
    if (_lastSentSize[sessionId] === key) return;
    _lastSentSize[sessionId] = key;
    wsSend({ type: 'resize', sessionId, cols, rows });
  }
  const _lastSentInnerSize = {};
  function sendInnerResize(innerSessionId, cols, rows) {
    if (!innerSessionId || !cols || !rows || cols < 2 || rows < 2) return;
    const key = cols + 'x' + rows;
    if (_lastSentInnerSize[innerSessionId] === key) return;
    _lastSentInnerSize[innerSessionId] = key;
    wsSend({ type: 'inner-session-resize', innerSessionId, cols, rows });
  }

  function connectWebSocket() {
    const wsToken = document.querySelector('meta[name="ws-token"]')?.content || '';
    ws = new WebSocket(`ws://${location.host}/?token=${encodeURIComponent(wsToken)}`);
    window._catalystWs = ws;
    ws.onopen = () => {
      wsReconnectDelay = 500;
      const connEl = document.getElementById('sbConnection');
      if (connEl) { const dot = connEl.querySelector('.statusbar-dot'); if (dot) { dot.classList.add('connected'); dot.classList.remove('disconnected'); } connEl.lastChild.textContent = ' Connected'; }
      if (wsHasConnectedBefore) {
        Object.entries(state.terminals).forEach(([id, term]) => {
          if (term) term.write('\r\n\x1b[92mReconnected to server.\x1b[0m\r\n');
        });
        // The reconnected PTYs may be at a different size than the display, and
        // the size dedupe would suppress the corrective resize — clear it and
        // force a re-fit so the CLI repaints at the right width.
        for (const k in _lastSentSize) delete _lastSentSize[k];
        for (const k in _lastSentInnerSize) delete _lastSentInnerSize[k];
        setTimeout(() => { try { refitAllTerminals(); } catch {} }, 150);
      }
      wsHasConnectedBefore = true;
    };
    ws.onclose = () => {
      const connEl = document.getElementById('sbConnection');
      if (connEl) { const dot = connEl.querySelector('.statusbar-dot'); if (dot) { dot.classList.remove('connected'); dot.classList.add('disconnected'); } connEl.lastChild.textContent = ' Disconnected'; }
      Object.entries(state.terminals).forEach(([id, term]) => {
        if (term) term.write('\r\n\x1b[91mConnection to server lost. Reconnecting...\x1b[0m\r\n');
      });
      // Auto-reconnect with exponential backoff
      setTimeout(() => {
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_DELAY);
        connectWebSocket();
      }, wsReconnectDelay);
    };
    ws.onmessage = (event) => {
      if (wsOnMessageHandler) wsOnMessageHandler(event);
    };
  }

  const state = {
    sessions: [],
    activeSessionId: null,
    selectedRepo: null,
    allRepos: [],
    // Additional repos handed to the agent alongside the primary one.
    extraRepos: [],
    // repoPath → { claude, codex, gemini } trust state, as reported by the
    // server reading each CLI's own config. Empty until the picker asks.
    repoTrust: {},
    // Which CLIs keep an explicit trust record we insist on.
    trustEnforced: { claude: true, codex: true, gemini: true },
    chatPanels: {},
    terminals: {},
    rootDir: null,
    prSessionId: null,
    lastInputTime: {},
    sessionStatus: {},
    tabNotify: new Set()
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const sidebar = $('.sidebar');
  const sessionList = $('#sessionList');
  const mainPanel = $('#mainPanel');
  const welcomeScreen = $('#welcomeScreen');
  const folderInput = $('#folderInput');
  const browseLabel = 'Browse Folder';
  const folderError = $('#folderError');
  const repoSection = $('#repoSection');
  const repoGrid = $('#repoGrid');
  const noRepos = $('#noRepos');
  const cliSection = $('#cliSection');
  const browseBtn = $('#browseBtn');
  const settingsBtn = $('#settingsBtn');
  const settingsPanel = $('#settingsPanel');
  const settingsRootInput = $('#settingsRootInput');
  const settingsRootBrowse = $('#settingsRootBrowse');
  const settingsRootSave = $('#settingsRootSave');
  const settingsRootHint = $('#settingsRootHint');
  const prModal = $('#prModal');
  const prModalClose = $('#prModalClose');
  const prSourceBranch = $('#prSourceBranch');
  const prTargetBranch = $('#prTargetBranch');
  const prTitle = $('#prTitle');
  const prDescription = $('#prDescription');
  const prWorkItem = $('#prWorkItem');
  const prError = $('#prError');
  const prSuccess = $('#prSuccess');
  const prCancelBtn = $('#prCancelBtn');
  const prSubmitBtn = $('#prSubmitBtn');
  const togglePatVisibility = $('#togglePatVisibility');
  const azurePat = $('#azurePat');
  const saveAzureSettings = $('#saveAzureSettings');
  const azureSaveHint = $('#azureSaveHint');

  // Request notification permission on load
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  function notify(title, body) {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%2306080d"/><text x="50" y="58" font-family="monospace" font-size="40" font-weight="bold" fill="%2338bdf8" text-anchor="middle" dominant-baseline="middle">C_</text></svg>' });
    }
  }

  if (window.tauriDesktop?.isDesktop) document.body.classList.add('is-desktop');

  // Theme
  const allThemes = ['midnight', 'rose', 'ocean', 'forest', 'sunset', 'lavender', 'nord', 'monokai', 'dracula', 'ember', 'void', 'copper', 'sand', 'arctic', 'vsdark', 'vslight', 'bluepill', 'silver', 'graphite', 'newsprint'];
  const lightThemes = ['rose', 'lavender', 'sand', 'arctic', 'vslight', 'silver', 'newsprint'];
  // Fresh install, nothing saved yet: start on a random theme rather than the
  // same one for everybody. It puts the theme set in front of the user on day
  // one, and Settings → Appearance changes it in a click. applyTheme persists
  // the pick, so it only rolls once.
  const savedTheme = localStorage.getItem('catalyst-theme')
    || allThemes[Math.floor(Math.random() * allThemes.length)];
  applyTheme(savedTheme);
  window._catalystApplyTheme = applyTheme;

  function applyTheme(theme) {
    const removeList = allThemes.map(t => 'theme-' + t);
    removeList.push('dark', 'light');
    document.body.classList.remove(...removeList);
    document.body.classList.add('theme-' + theme, lightThemes.includes(theme) ? 'light' : 'dark');
    localStorage.setItem('catalyst-theme', theme);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-theme', theme }));
    $$('.theme-swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      const s = getComputedStyle(document.body);
      const bgSec = s.getPropertyValue('--bg-secondary').trim();
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta && bgSec) themeColorMeta.setAttribute('content', bgSec);

      const isLight = lightThemes.includes(theme);
      const favicon = document.querySelector('link[rel="icon"]') || document.querySelector('link[rel="shortcut icon"]');
      if (favicon) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (isLight) {
            ctx.filter = 'invert(0.9) hue-rotate(160deg) saturate(2) brightness(0.9)';
          }
          ctx.drawImage(img, 0, 0);
          favicon.href = canvas.toDataURL('image/png');
        };
        img.src = '/icons/icon-192.png';
      }

      if (window.tauriDesktop?.updateTitleBarOverlay) {
        const overlayBg = s.getPropertyValue('--bg-secondary').trim() || s.getPropertyValue('--bg').trim();
        const overlayFg = s.getPropertyValue('--text-muted').trim();
        if (overlayBg) window.tauriDesktop.updateTitleBarOverlay({ color: overlayBg, symbolColor: overlayFg || '#8b95a5' });
      }

      const xt = getXtermTheme();
      Object.values(state.terminals).forEach(t => {
        if (t) t.options.theme = xt;
      });
      if (window._monacoReady) {
        window._monacoReady.then(m => {
          defineMonacoTheme(m);
          m.editor.setTheme('catalyst-dark');
        }).catch(() => {});
      }
    }); });
  }

  $$('.theme-swatch').forEach(btn => btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));

  function getXtermTheme() {
    const style = getComputedStyle(document.body);
    return {
      background: style.getPropertyValue('--xterm-bg').trim() || '#0c1017',
      foreground: style.getPropertyValue('--xterm-fg').trim() || '#ffffff',
      cursor: style.getPropertyValue('--accent').trim() || '#38bdf8',
      selectionBackground: style.getPropertyValue('--accent-subtle').trim() || '#1e3a5f'
    };
  }

  // Font settings
  let currentFontSize = parseInt(localStorage.getItem('catalyst-font-size')) || 13;
  let currentFontFamily = localStorage.getItem('catalyst-font-family') || "'Fira Code', monospace";

  function applyFontSettings() {
    const isRetina = localStorage.getItem('catalyst-font-retina') === 'true';
    const fontWeight = isRetina ? '300' : '400';
    const scale = currentFontSize / 13;
    document.documentElement.style.setProperty('--app-font-size', currentFontSize + 'px');
    document.documentElement.style.setProperty('--ui-scale', scale);
    const appEl = document.querySelector('.app');
    if (appEl) {
      appEl.style.zoom = scale;
      appEl.style.height = (100 / scale) + 'vh';
    }
    document.body.style.fontFamily = currentFontFamily;
    document.body.style.fontWeight = fontWeight;
    Object.values(state.terminals).forEach(t => {
      if (t) {
        t.options.fontSize = currentFontSize;
        t.options.fontFamily = currentFontFamily;
        t.options.fontWeight = fontWeight;
        if (t._fitAddon) t._fitAddon.fit();
      }
    });
    const sizeEl = $('#fontSizeValue');
    if (sizeEl) sizeEl.textContent = currentFontSize;
    const famEl = $('#fontFamilySelect');
    if (famEl) {
      for (const opt of famEl.options) {
        if (opt.value === currentFontFamily && (isRetina ? opt.dataset.note === 'retina' : opt.dataset.note !== 'retina')) {
          opt.selected = true;
          break;
        }
      }
    }
  }

  applyFontSettings();
  window._catalystApplyFont = {
    apply: applyFontSettings,
    setSize: (s) => { currentFontSize = s; },
    setFamily: (f) => { currentFontFamily = f; }
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('#fontSizeUp')) {
      currentFontSize = Math.min(24, currentFontSize + 1);
      localStorage.setItem('catalyst-font-size', currentFontSize);
      applyFontSettings();
    }
    if (e.target.closest('#fontSizeDown')) {
      currentFontSize = Math.max(9, currentFontSize - 1);
      localStorage.setItem('catalyst-font-size', currentFontSize);
      applyFontSettings();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'fontFamilySelect') {
      currentFontFamily = e.target.value;
      const selected = e.target.options[e.target.selectedIndex];
      const isRetina = selected.dataset.note === 'retina';
      localStorage.setItem('catalyst-font-family', currentFontFamily);
      localStorage.setItem('catalyst-font-retina', isRetina ? 'true' : 'false');
      applyFontSettings();
    }
  });

  function updateSidebarVisibility() {
    const topbar = $('#topbar');
    const sb = $('#statusbar');
    if (topbar) {
      if (state.sessions.length > 0) {
        topbar.classList.remove('hidden');
        if (sb) sb.classList.remove('hidden');
      } else {
        topbar.classList.add('hidden');
        if (sb) sb.classList.add('hidden');
      }
    }
  }

  function hideAllPanels() {
    welcomeScreen.classList.add('hidden');
    Object.values(state.chatPanels).forEach(p => p.classList.remove('active'));
  }

  // Hand-rolled rather than textContent/innerHTML: the HTML text-node serializer
  // leaves " and ' alone, and these values land inside quoted attributes
  // (title="…", data-path="…") where a repo-controlled quote would break out.
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => HTML_ESC[c]);
  }

  function showToast(message, type) {
    const container = $('#toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'info');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function stashSelectionChanges(term) {
    term._lastSelection = '';
    try {
      term.onSelectionChange(() => {
        try {
          const s = term.getSelection ? term.getSelection() : '';
          if (s) term._lastSelection = s;
        } catch {}
      });
    } catch {}
  }

  function attachMouseSelectionStash(term, container) {
    if (!container) return;
    container.addEventListener('mouseup', () => {
      setTimeout(() => {
        try {
          const s = term.getSelection ? term.getSelection() : '';
          if (s) term._lastSelection = s;
        } catch {}
      }, 10);
    });
  }

  function readClipboardAndPaste(sendTextFn, sendImageFn) {
    // Under the desktop shell, read via Tauri's native clipboard so WebView2
    // doesn't pop its "allow clipboard access?" permission prompt on every paste.
    const T = window.__TAURI__;
    if (T && T.core && T.core.invoke) {
      T.core.invoke('plugin:clipboard-manager|read_text').then(text => {
        if (text) { sendTextFn(text); return; }
        if (sendImageFn) pasteTauriImage(sendImageFn);
      }).catch(() => {
        if (sendImageFn) pasteTauriImage(sendImageFn);
      });
      return;
    }
    // Browser fallback (the Web Clipboard API may prompt).
    if (!navigator.clipboard) return;
    navigator.clipboard.readText().then(text => {
      if (text) {
        sendTextFn(text);
      } else if (sendImageFn && navigator.clipboard.read) {
        pasteImageFromClipboard(sendImageFn);
      }
    }).catch(() => {
      if (sendImageFn && navigator.clipboard.read) {
        pasteImageFromClipboard(sendImageFn);
      }
    });
  }

  // Read an image off the clipboard through Tauri and hand it back as a PNG data
  // URL. Silently no-ops if there's no image (so no prompt, no error spam).
  function pasteTauriImage(sendImageFn) {
    const T = window.__TAURI__;
    if (!T || !T.core || !T.core.invoke) return;
    let rid;
    T.core.invoke('plugin:clipboard-manager|read_image')
      .then(r => {
        rid = r;
        return Promise.all([
          T.core.invoke('plugin:image|rgba', { rid }),
          T.core.invoke('plugin:image|size', { rid }),
        ]);
      })
      .then(([rgba, size]) => {
        const w = size && (size.width != null ? size.width : size[0]);
        const h = size && (size.height != null ? size.height : size[1]);
        if (!w || !h) return;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
        sendImageFn(canvas.toDataURL('image/png'));
      })
      .catch(() => {});
  }

  function pasteImageFromClipboard(sendImageFn) {
    navigator.clipboard.read().then(items => {
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            item.getType(type).then(blob => {
              const reader = new FileReader();
              reader.onload = () => sendImageFn(reader.result);
              reader.readAsDataURL(blob);
            });
            return;
          }
        }
      }
    }).catch(() => {});
  }

  function attachCopyPasteShortcuts(term, sendFn) {
    stashSelectionChanges(term);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // App-level chords are handled by the global keydown listener — don't let
      // them reach the PTY (e.g. avoid sending Ctrl+Z/SIGTSTP on Shift+Ctrl+Z).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey &&
          (e.code === 'KeyP' || e.code === 'KeyZ' || e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        return false;
      }
      // Copy/paste modifier is Cmd on macOS, Ctrl elsewhere. Ctrl is left to the
      // terminal for control codes (incl. Ctrl+C → SIGINT) on macOS.
      const copyMod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!copyMod) return true;

      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return false;

      if (e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        e.stopPropagation();
        const sel = getActiveSelection(term);
        if (sel) {
          copyToClipboard(sel);
          showToast('Copied ' + sel.length + ' chars', 'success');
        } else {
          showToast('Hold Shift + drag to select text first', 'info');
        }
        return false;
      }

      if (!e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        e.stopPropagation();
        const sel = getLiveSelection(term);
        if (sel) {
          copyToClipboard(sel);
          try { term.clearSelection(); } catch {}
          try { window.getSelection()?.removeAllRanges(); } catch {}
          showToast('Copied ' + sel.length + ' chars', 'success');
          return false;
        }
        // No selection: on Win/Linux Ctrl+C sends SIGINT. On macOS, SIGINT is
        // Ctrl+C (handled natively by xterm) — Cmd+C with no selection is a no-op.
        if (sendFn && !IS_MAC) sendFn('\x03');
        return false;
      }

      if (e.code === 'KeyV' && sendFn) {
        e.preventDefault();
        e.stopPropagation();
        readClipboardAndPaste(sendFn, null);
        return false;
      }

      return true;
    });
  }

  function getLiveSelection(term) {
    try {
      const s = term.getSelection ? term.getSelection() : '';
      if (s) return s;
    } catch {}
    try {
      const pos = term.getSelectionPosition ? term.getSelectionPosition() : null;
      if (pos) {
        const s = term.getSelection();
        if (s) return s;
      }
    } catch {}
    try {
      const win = window.getSelection();
      if (win && win.toString) {
        const t = win.toString();
        if (t && t.trim()) return t;
      }
    } catch {}
    return '';
  }

  function getActiveSelection(term) {
    const live = getLiveSelection(term);
    if (live) return live;
    try {
      if (term && term._lastSelection) return term._lastSelection;
    } catch {}
    return '';
  }

  function getVisibleBuffer(term) {
    try {
      const buf = term.buffer && term.buffer.active;
      if (!buf) return '';
      const lines = [];
      for (let i = buf.viewportY; i < buf.viewportY + term.rows; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n').trimEnd();
    } catch {}
    return '';
  }

  // navigator.clipboard isn't always available in PWA contexts (insecure
  // origin, locked permission). Fall back to the legacy execCommand path.
  function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => execCopyFallback(text));
        return true;
      }
    } catch {}
    return execCopyFallback(text);
  }

  function execCopyFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  // ─── Catalyst Pilot settings ─────────────────
  const PILOT_KEY = 'catalyst-pilot-settings';
  function getPilotSettings() {
    try { return JSON.parse(localStorage.getItem(PILOT_KEY)) || {}; } catch { return {}; }
  }
  const _pilotIds = ['pilotUnpushed', 'pilotStaleTests', 'pilotPrReady', 'pilotBranchDrift', 'pilotFailedBuilds', 'pilotSmartpill'];
  function savePilotSettings() {
    const s = {};
    _pilotIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) s[id] = el.checked;
    });
    localStorage.setItem(PILOT_KEY, JSON.stringify(s));
  }
  function loadPilotSettings() {
    const s = getPilotSettings();
    Object.keys(s).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = s[id];
    });
  }
  function filterPilotTips(tips) {
    const s = getPilotSettings();
    return tips.filter(t => {
      const cmd = (t.command || '').toLowerCase();
      const msg = (t.msg || '').toLowerCase();
      if ((cmd.includes('pull') || msg.includes('behind')) && s.pilotBranchDrift === false) return false;
      if ((cmd.includes('push') || msg.includes('unpushed') || msg.includes('push')) && s.pilotUnpushed === false) return false;
      if ((msg.includes('test') || cmd.includes('test')) && s.pilotStaleTests === false) return false;
      if ((msg.includes('pr') || cmd.includes('pr')) && s.pilotPrReady === false) return false;
      if ((msg.includes('build') || msg.includes('failed')) && s.pilotFailedBuilds === false) return false;
      return true;
    });
  }
  setTimeout(() => {
    loadPilotSettings();
    document.querySelectorAll('.pilot-toggle').forEach(el => {
      el.addEventListener('change', () => {
        savePilotSettings();
        if (el.id === 'pilotSmartpill' && !el.checked) {
          const pill = $('#smartpill');
          if (pill) pill.classList.remove('visible');
          if (state._smartpillTimer) { clearInterval(state._smartpillTimer); state._smartpillTimer = null; }
        }
      });
    });
  }, 100);

  function showSmartpill(tip) {
    const s = getPilotSettings();
    if (s.pilotSmartpill === false) return;
    const pill = $('#smartpill');
    if (!pill) return;
    const headerEl = $('#smartpillHeader');
    const msgEl = $('#smartpillMsg');
    const btnEl = $('#smartpillBtn');
    if (headerEl) headerEl.textContent = tip.header || 'CATALYST';
    if (msgEl) msgEl.innerHTML = tip.msg || '';
    if (btnEl) {
      btnEl.textContent = tip.btn || 'OK';
      btnEl.onclick = () => {
        if (tip.url) {
          if (window.tauriDesktop && window.tauriDesktop.openExternal) window.tauriDesktop.openExternal(tip.url);
          else window.open(tip.url, '_blank', 'noopener');
          pill.classList.remove('visible');
          return;
        }
        if (tip.command === 'info-only') {
          pill.classList.remove('visible');
          return;
        }
        ws.send(JSON.stringify({ type: 'smartpill-command', command: tip.command, repoPath: tip.repoPath, repoName: tip.repoName, repos: tip.repos }));
        pill.classList.remove('visible');
        showToast('Running...', 'info');
      };
    }
    pill.classList.remove('hidden');
    requestAnimationFrame(() => pill.classList.add('visible'));
  }

  $('#smartpillDismiss')?.addEventListener('click', () => {
    const pill = $('#smartpill');
    if (pill) pill.classList.remove('visible');
    if (state._smartpillTimer) { clearInterval(state._smartpillTimer); state._smartpillTimer = null; }
  });

  // Watch for newly-created PR URLs after the user triggers the PR button.
  // Stores a small rolling tail per session so a URL split across two output
  // chunks is still matched on the boundary.
  state.prScanBuffers = state.prScanBuffers || {};
  const PR_URL_RE = /https?:\/\/(?:dev\.azure\.com|[^./\s]+\.visualstudio\.com)\/[^\s)\]'"<>]+\/pullrequest\/\d+|https?:\/\/github\.com\/[^\s)\]'"<>]+\/pull\/\d+/i;

  function detectPrUrl(sessionId, data) {
    const watch = state.watchForPrUrl;
    if (!watch || watch.sessionId !== sessionId) return;
    const prev = state.prScanBuffers[sessionId] || '';
    // Keep the last 1KB as a sliding window so URLs split across chunks still match.
    const buf = (prev + data).slice(-2048);
    state.prScanBuffers[sessionId] = buf;
    const match = buf.match(PR_URL_RE);
    if (!match) return;
    const url = match[0].replace(/[.,;:]+$/, '');
    state.watchForPrUrl = null;
    state.prScanBuffers[sessionId] = '';
    showSmartpill({
      header: 'PR CREATED',
      msg: `<strong>${escHtml(url)}</strong>`,
      btn: 'OPEN PR',
      url
    });
  }

  function populateRepoInfoPanel(info) {
    const descEl = $('#repoInfoDesc');
    const tagsEl = $('#repoInfoTags');
    if (descEl) descEl.textContent = info.description || '';
    if (tagsEl) {
      tagsEl.innerHTML = '';
      (info.technologies || []).forEach(t => {
        const tag = document.createElement('span');
        tag.className = 'repo-info-tag tech';
        tag.textContent = t;
        tagsEl.appendChild(tag);
      });
      (info.devEnvironments || []).forEach(e => {
        const tag = document.createElement('span');
        tag.className = 'repo-info-tag env';
        tag.textContent = e;
        tagsEl.appendChild(tag);
      });
    }
  }

  // CLI icons
  const cliIcons = {
    claude: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757"/></svg>',
    codex: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M13.796 23.785a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128z" fill="#10a37f"/></svg>',
    gemini: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/></svg>'
  };

  // Status colors
  const statusColors = { working: '#f59e0b', idle: '#38bdf8', done: '#34d399', error: '#f87171' };

  let _detectStatusRenderTimer = null;
  function detectStatus(sessionId, data) {
    const prev = state.sessionStatus[sessionId];
    let newStatus = prev;
    if (/germinating|reticulating|misting|thinking|working/i.test(data)) {
      newStatus = 'working';
    } else if (/completed|done|finished/i.test(data)) {
      newStatus = 'done';
      if (prev === 'working') notify('Catalyst', `Session finished working`);
    } else if (/error|failed/i.test(data)) {
      newStatus = 'error';
    }
    if (newStatus !== prev) {
      state.sessionStatus[sessionId] = newStatus;
      if (prev === 'working' && sessionId !== state.activeSessionId) {
        state.tabNotify.add(sessionId);
      }
      if (!_detectStatusRenderTimer) {
        _detectStatusRenderTimer = setTimeout(() => {
          _detectStatusRenderTimer = null;
          renderSessions();
        }, 300);
      }
    }
  }

  // Sessions
  function getPinnedTabs() {
    try { return JSON.parse(localStorage.getItem('catalyst-pinned-tabs') || '[]'); } catch { return []; }
  }

  function savePinnedTabs(pins) {
    localStorage.setItem('catalyst-pinned-tabs', JSON.stringify(pins));
  }

  function isSessionPinned(s) {
    return getPinnedTabs().some(p => p.repoPath === s.repoPath && p.cli === s.cli);
  }

  function togglePin(s) {
    const pins = getPinnedTabs();
    const idx = pins.findIndex(p => p.repoPath === s.repoPath && p.cli === s.cli);
    if (idx >= 0) {
      pins.splice(idx, 1);
    } else {
      pins.push({ repo: s.repo, repoPath: s.repoPath, cli: s.cli });
    }
    savePinnedTabs(pins);
    renderSessions();
  }

  // ─── Multi-repo tab labels ────────────────────────────────────────────
  // A session started with extra repos is labelled "<primary> +N", and its
  // tooltip lists every repo it was initialised with. Once the user clears the
  // conversation with /clear the session reads as a fresh start, so the label
  // drops back to the plain repo name. That is a labelling change only — the
  // CLI process keeps the directories it was launched with.
  const AGENT_CLIS = ['claude', 'codex', 'gemini'];
  // The two that can actually take additional workspace directories. Codex has
  // no equivalent flag, so it plays no part in whether a repo is addable.
  const EXTRA_DIR_CLIS = ['claude', 'gemini'];
  const CLI_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

  const CLEARED_EXTRAS_KEY = 'catalyst-cleared-extras';

  function loadClearedExtras() {
    try { return new Set(JSON.parse(localStorage.getItem(CLEARED_EXTRAS_KEY) || '[]')); }
    catch { return new Set(); }
  }

  let clearedExtras = loadClearedExtras();

  function markExtrasCleared(sessionId) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session || !(session.extraDirs || []).length) return;
    if (clearedExtras.has(sessionId)) return;
    clearedExtras.add(sessionId);
    // Only keep ids that still exist, so this cannot grow without bound.
    const live = new Set(state.sessions.map(s => s.id));
    clearedExtras = new Set([...clearedExtras].filter(id => live.has(id)));
    try { localStorage.setItem(CLEARED_EXTRAS_KEY, JSON.stringify([...clearedExtras])); } catch {}
    renderSessions();
  }

  // Keystrokes are all we get — the CLIs run in a PTY and there is no event for
  // "the user ran a slash command". So mirror the line being typed and act when
  // it is submitted as exactly /clear. Only enough of a line editor to keep the
  // mirror honest: backspace rubs out, and the usual "forget that line" keys
  // (Ctrl+C, Ctrl+U, Escape) reset it.
  // This stream is not just typing: xterm also reports focus changes
  // (ESC [ I / ESC [ O) and, with mouse tracking on, every click
  // (ESC [ < 0;101;49M) down the same channel. Those have to be consumed whole —
  // dropping the ESC alone leaves "[<0;101;49M" looking like typed text — so run
  // a small escape-sequence state machine, kept per session because a chunk can
  // split in the middle of one.
  const typedLine = {};
  const escState = {};

  function watchForClear(sessionId, data) {
    let line = typedLine[sessionId] || '';
    let mode = escState[sessionId] || 'text';


    for (const ch of String(data)) {
      if (mode === 'csi') {
        // Final byte ends it (@ through ~), as does BEL for OSC. Reports like
        // these are the terminal talking, not the user, so the line stands.
        if (ch === '\x07' || (ch >= '@' && ch <= '~')) mode = 'text';
        continue;
      }
      if (mode === 'esc') {
        if (ch === '[' || ch === ']') { mode = 'csi'; continue; }
        // ESC on its own was the Escape key, which abandons the line. This
        // character belongs to whatever comes next, so fall through to it.
        mode = 'text';
        line = '';
      }
      if (ch === '\x1b') {
        mode = 'esc';
      } else if (ch === '\r' || ch === '\n') {
        if (/^\/clear$/i.test(line.trim())) markExtrasCleared(sessionId);
        line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        line = line.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {
        line = '';
      } else if (ch >= ' ') {
        // Cap it: a pasted wall of text is never the command we are looking for.
        line = line.length > 64 ? '' : line + ch;
      }
    }

    typedLine[sessionId] = line;
    escState[sessionId] = mode;
  }

  // The extras still worth showing for a session — none once /clear has run.
  function shownExtraDirs(s) {
    if (clearedExtras.has(s.id)) return [];
    return (s.extraDirs || []).filter(Boolean);
  }

  // Prefer the repo name we already know for a path; fall back to its last
  // segment, which is what the repo list uses anyway.
  function repoNameForPath(p) {
    const known = (state.allRepos || []).find(r => r.path === p);
    if (known) return known.name;
    return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  }

  function tabTooltip(s, extras) {
    const cliName = s.cli === 'claude' ? 'Claude Code' : (CLI_LABELS[s.cli] || s.cli);
    if (!extras.length) return `${s.repo} — ${cliName}`;
    const lines = [`${cliName} · ${extras.length + 1} repos`, `${s.repo} (primary)`];
    extras.forEach(p => lines.push(repoNameForPath(p)));
    return lines.join('\n');
  }

  function renderSessions() {
    const repoTabList = $('#repoTabList');
    if (!repoTabList) return;
    repoTabList.innerHTML = '';

    const sorted = [...state.sessions].sort((a, b) => {
      const ap = isSessionPinned(a) ? 0 : 1;
      const bp = isSessionPinned(b) ? 0 : 1;
      return ap - bp;
    });

    sorted.forEach(s => {
      const isActive = s.id === state.activeSessionId;
      const tab = document.createElement('div');
      tab.className = 'repo-tab' + (isActive ? ' active' : '') + (s.ended ? ' ended' : '');
      const hasNotify = state.tabNotify.has(s.id);
      const extras = shownExtraDirs(s);
      tab.title = tabTooltip(s, extras);
      tab.innerHTML = `
        <span class="tab-cli-icon">${cliIcons[s.cli] || ''}</span>
        <span class="repo-tab-name">${escHtml(s.repo)}</span>
        ${extras.length ? `<span class="repo-tab-extra">+${extras.length}</span>` : ''}
        ${hasNotify ? '<span class="tab-notify-dot"></span>' : ''}
        <span class="repo-tab-close" title="Close session">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </span>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.repo-tab-close')) return;
        switchToSession(s.id);
      });
      tab.querySelector('.repo-tab-close').addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirm('Close Session', 'This will end the CLI process.', `${s.repo} — ${s.cli}`, 'Close Session');
        if (confirmed) {
          ws.send(JSON.stringify({ type: 'kill-session', sessionId: s.id }));
          removeSessionUI(s.id);
        }
      });
      repoTabList.appendChild(tab);
    });

    // Add "+" button
    const addBtn = document.createElement('div');
    addBtn.className = 'topbar-newtab';
    addBtn.title = 'Open repo';
    addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>';
    addBtn.addEventListener('click', showWelcome);
    repoTabList.appendChild(addBtn);

    sessionList.innerHTML = '';
    updateStatusBar();
  }

  // Prompt cache timer (5 min TTL) — only update when there are active inputs
  setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    state.sessions.forEach(s => {
      const lastInput = state.lastInputTime[s.id];
      if (!lastInput) return;
      const elapsed = (now - lastInput) / 1000;
      if (elapsed > 360) return; // Well past expiry, no need to update DOM
      const el = document.getElementById('cache-' + s.id);
      if (!el) return;
      const remaining = 300 - elapsed;
      if (remaining <= 0) {
        if (el.className !== 'cache-timer expired') {
          el.textContent = 'cache expired';
          el.className = 'cache-timer expired';
        }
      } else {
        const m = Math.floor(remaining / 60);
        const sec = Math.floor(remaining % 60);
        el.textContent = `${m}:${sec.toString().padStart(2, '0')}`;
        el.className = 'cache-timer' + (remaining < 60 ? ' warning' : '');
      }
    });
  }, 1000);

  // xterm.js terminal creation
  function createTerminal(sessionId) {
    if (state.terminals[sessionId]) return state.terminals[sessionId];

    const term = new Terminal({
      fontFamily: currentFontFamily,
      fontSize: currentFontSize,
      theme: getXtermTheme(),
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
      // Align xterm's line-wrap heuristics with Windows ConPTY to reduce
      // reflow garbling of the CLI's TUI on resize.
      windowsPty: /Windows/.test(navigator.userAgent) ? { backend: 'conpty' } : undefined,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    const webLinksAddon = new WebLinksAddon.WebLinksAddon((e, uri) => {
      if (window.tauriDesktop?.openExternal) {
        window.tauriDesktop.openExternal(uri);
      } else {
        window.open(uri, '_blank', 'noopener');
      }
    });
    term.loadAddon(webLinksAddon);

    state.terminals[sessionId] = term;
    state.terminals[sessionId]._fitAddon = fitAddon;
    stashSelectionChanges(term);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // App-level chords are handled by the global keydown listener — don't let
      // them reach the PTY (e.g. avoid sending Ctrl+Z/SIGTSTP on Shift+Ctrl+Z).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey &&
          (e.code === 'KeyP' || e.code === 'KeyZ' || e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        return false;
      }
      // Copy/paste modifier: Cmd on macOS, Ctrl elsewhere.
      const copyMod = IS_MAC ? e.metaKey : e.ctrlKey;

      if (copyMod) {
        // Block modifier-only keydowns from reaching xterm (they clear selection)
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return false;

        // Cmd/Ctrl+Shift+C → copy selection
        if (e.shiftKey && e.code === 'KeyC') {
          e.preventDefault();
          e.stopPropagation();
          const sel = getActiveSelection(term);
          if (sel) {
            copyToClipboard(sel);
            showToast('Copied ' + sel.length + ' chars', 'success');
          } else {
            showToast('Hold Shift + drag to select text first', 'info');
          }
          return false;
        }

        // Cmd/Ctrl+C → copy if selection exists; else SIGINT (Win/Linux only —
        // on macOS, SIGINT is Ctrl+C, handled natively below).
        if (!e.shiftKey && e.code === 'KeyC') {
          e.preventDefault();
          e.stopPropagation();
          const sel = getLiveSelection(term);
          if (sel) {
            copyToClipboard(sel);
            try { term.clearSelection(); } catch {}
            try { window.getSelection()?.removeAllRanges(); } catch {}
            showToast('Copied ' + sel.length + ' chars', 'success');
            return false;
          }
          if (!IS_MAC) {
            ws.send(JSON.stringify({ type: 'input', sessionId, data: '\x03' }));
            state.lastInputTime[sessionId] = Date.now();
          }
          return false;
        }

        // Cmd/Ctrl+V / +Shift+V → paste from clipboard
        if (e.code === 'KeyV') {
          e.preventDefault();
          e.stopPropagation();
          readClipboardAndPaste(
            (text) => {
              ws.send(JSON.stringify({ type: 'input', sessionId, data: text }));
              state.lastInputTime[sessionId] = Date.now();
            },
            (dataUrl) => {
              ws.send(JSON.stringify({ type: 'paste-image', sessionId, data: dataUrl }));
            }
          );
          return false;
        }
      }

      // Terminal control sequences — always Ctrl (no shift/alt/meta), every OS.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const ctrlCodes = {
          'z': '\x1a',
          'l': '\x0c',
          'd': '\x04',
          'a': '\x01',
          'e': '\x05',
          'u': '\x15',
          'w': '\x17',
        };
        if (ctrlCodes[e.key]) {
          e.preventDefault();
          e.stopPropagation();
          ws.send(JSON.stringify({ type: 'input', sessionId, data: ctrlCodes[e.key] }));
          state.lastInputTime[sessionId] = Date.now();
          return false;
        }
      }

      return true;
    });

    term.onData(data => {
      ws.send(JSON.stringify({ type: 'input', sessionId, data }));
      state.lastInputTime[sessionId] = Date.now();
      watchForClear(sessionId, data);
    });

    term.onResize(({ cols, rows }) => {
      sendResize(sessionId, cols, rows);
    });

    return term;
  }

  state.innerTabs = {};
  state.innerEditors = {};
  state.innerSessions = {}; // sessionId -> [{ innerSessionId, cliId, cliName, term }]

  function ensureChatPanel(sessionId) {
    if (state.chatPanels[sessionId]) return state.chatPanels[sessionId];
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return null;

    state.innerTabs[sessionId] = [];
    state.innerSessions[sessionId] = [];

    const panel = document.createElement('div');
    panel.className = 'chat-panel';
    panel.dataset.sessionId = sessionId;
    panel.innerHTML = `
      <div class="inner-tabbar" id="inner-tabs-${sessionId}">
        <div class="inner-tabs-left">
          <div class="inner-tab active" data-view="terminal">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            <span>${escHtml(session.cli)}</span>
          </div>
        </div>
        <div class="inner-tabs-right">
          <div class="inner-add-btn" title="Add CLI or Terminal">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </div>
          <div class="inner-add-dropdown hidden"></div>
        </div>
      </div>
      <div class="inner-views">
        <div class="inner-view active" data-view="terminal">
          <div class="terminal-container" id="term-${sessionId}"></div>
        </div>
        <div class="inner-view" data-view="editor">
          <div class="inner-editor-container" id="inner-editor-${sessionId}"></div>
        </div>
      </div>
    `;

    mainPanel.appendChild(panel);
    state.chatPanels[sessionId] = panel;

    const term = createTerminal(sessionId);
    const termContainer = panel.querySelector('.terminal-container');
    term.open(termContainer);
    attachMouseSelectionStash(term, termContainer);

    // Wire up inner tab: Terminal tab click
    panel.querySelector('.inner-tab[data-view="terminal"]').addEventListener('click', () => {
      switchInnerTab(sessionId, 'terminal');
    });

    // Wire up + button
    const addBtn = panel.querySelector('.inner-add-btn');
    const dropdown = panel.querySelector('.inner-add-dropdown');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!dropdown.classList.contains('hidden')) { dropdown.classList.add('hidden'); return; }
      dropdown.innerHTML = '<div style="font-size:10px;color:var(--text-muted);padding:4px 8px">Loading...</div>';
      dropdown.classList.remove('hidden');
      ws.send(JSON.stringify({ type: 'list-available-clis', sessionId }));
    });
    // Close dropdown on outside click — use a single delegated handler below
    dropdown._panelSessionId = sessionId;

    // Image paste fallback for right-click paste or drag-drop (Ctrl+V is
    // handled in the key handler above via readClipboardAndPaste). xterm only.
    const xtermTextarea = termContainer.querySelector('.xterm-helper-textarea');
    if (xtermTextarea) {
      xtermTextarea.addEventListener('paste', (e) => {
        const cd = e.clipboardData;
        if (!cd) return;
        for (const item of cd.items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const blob = item.getAsFile();
            if (!blob) continue;
            const reader = new FileReader();
            reader.onload = () => {
              ws.send(JSON.stringify({ type: 'paste-image', sessionId, data: reader.result }));
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }, true);
    }

    // Wait for the web font to load before the first fit — fitting with the
    // fallback font miscounts columns, sizing the PTY wider than the display
    // and garbling the CLI's TUI. Re-measure once the real font is in, then do
    // a second pass after the right panel / layout settles.
    const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    fontsReady.then(() => {
      if (!termContainer.offsetParent) return;
      remeasureAndFit(term);
      sendResize(sessionId, term.cols, term.rows);
      setTimeout(() => {
        if (!termContainer.offsetParent || !term._fitAddon) return;
        try { term._fitAddon.fit(); sendResize(sessionId, term.cols, term.rows); } catch {}
      }, 400);
    });

    return panel;
  }

  // Single global handler to close all inner-add-dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.inner-add-dropdown').forEach(dd => dd.classList.add('hidden'));
  });

  function switchInnerTab(sessionId, viewKey) {
    const panel = state.chatPanels[sessionId];
    if (!panel) return;
    panel.querySelectorAll('.inner-tab').forEach(t => t.classList.toggle('active', t.dataset.view === viewKey));
    panel.querySelectorAll('.inner-view').forEach(v => v.classList.toggle('active', v.dataset.view === viewKey));
    if (viewKey === 'terminal') {
      const term = state.terminals[sessionId];
      if (term && term._fitAddon) {
        setTimeout(() => {
          try {
            term._fitAddon.fit();
            term.refresh(0, term.rows - 1);
            term.focus();
          } catch {}
        }, 50);
      }
      if (state.innerEditors[sessionId]) {
        disposeEditorWithModels(state.innerEditors[sessionId]);
        state.innerEditors[sessionId] = null;
      }
    } else if (viewKey.startsWith('inner:')) {
      const innerId = viewKey.replace('inner:', '');
      const innerList = state.innerSessions[sessionId] || [];
      const inner = innerList.find(s => s.innerSessionId === innerId);
      if (inner && inner.term && inner.term._fitAddon) {
        setTimeout(() => {
          try {
            inner.term._fitAddon.fit();
            inner.term.refresh(0, inner.term.rows - 1);
            inner.term.focus();
          } catch {}
        }, 50);
      }
    }
    renderInnerTabs(sessionId);
  }

  function openFileInInnerTab(sessionId, filePath, content, original, modified) {
    const panel = state.chatPanels[sessionId];
    if (!panel) return;
    const tabs = state.innerTabs[sessionId] || [];
    const existing = tabs.find(t => t.file === filePath);
    if (!existing) {
      tabs.push({ file: filePath, content, original, modified });
      state.innerTabs[sessionId] = tabs;
    } else {
      existing.content = content;
      existing.original = original;
      existing.modified = modified;
    }
    renderInnerTabs(sessionId);
    showInnerFile(sessionId, filePath, content, original, modified);
  }

  function renderInnerTabs(sessionId) {
    const panel = state.chatPanels[sessionId];
    if (!panel) return;
    const tabbar = panel.querySelector('.inner-tabbar');
    const session = state.sessions.find(s => s.id === sessionId);
    const cliName = session ? session.cli : 'Terminal';

    // Preserve the + button area
    const rightArea = tabbar.querySelector('.inner-tabs-right');
    const leftArea = tabbar.querySelector('.inner-tabs-left');
    if (!leftArea) return;
    leftArea.innerHTML = '';

    const activeView = panel.querySelector('.inner-view.active');
    const activeViewKey = activeView ? activeView.dataset.view : 'terminal';

    // Main terminal tab
    const termTab = document.createElement('div');
    termTab.className = 'inner-tab' + (activeViewKey === 'terminal' ? ' active' : '');
    termTab.dataset.view = 'terminal';
    termTab.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span>${escHtml(cliName)}</span>`;
    termTab.addEventListener('click', () => switchInnerTab(sessionId, 'terminal'));
    leftArea.appendChild(termTab);

    // Inner session tabs (other CLIs)
    const innerList = state.innerSessions[sessionId] || [];
    innerList.forEach(inner => {
      const tab = document.createElement('div');
      tab.className = 'inner-tab' + (activeViewKey === `inner:${inner.innerSessionId}` ? ' active' : '');
      tab.dataset.view = `inner:${inner.innerSessionId}`;
      tab.innerHTML = `<span class="inner-tab-name">${escHtml(inner.cliName)}</span>`
        + `<span class="inner-tab-close"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></span>`;
      tab.addEventListener('click', () => {
        switchInnerTab(sessionId, `inner:${inner.innerSessionId}`);
      });
      tab.querySelector('.inner-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        ws.send(JSON.stringify({ type: 'kill-inner-session', innerSessionId: inner.innerSessionId }));
        if (inner.term) inner.term.dispose();
        const view = panel.querySelector(`.inner-view[data-view="inner:${inner.innerSessionId}"]`);
        if (view) view.remove();
        const list = state.innerSessions[sessionId];
        const idx = list.indexOf(inner);
        if (idx >= 0) list.splice(idx, 1);
        switchInnerTab(sessionId, 'terminal');
        renderInnerTabs(sessionId);
      });
      leftArea.appendChild(tab);
    });

    // File tabs
    const tabs = state.innerTabs[sessionId] || [];
    const isEditorActive = activeViewKey === 'editor';
    tabs.forEach(t => {
      const shortName = t.file.replace(/\\/g, '/').split('/').pop();
      const tab = document.createElement('div');
      tab.className = 'inner-tab' + (isEditorActive && state._activeInnerFile === t.file ? ' active' : '');
      tab.dataset.view = 'file:' + t.file;
      tab.innerHTML = `<span class="inner-tab-name">${escHtml(shortName)}</span>`
        + `<span class="inner-tab-close"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></span>`;
      tab.querySelector('.inner-tab-name').addEventListener('click', () => {
        showInnerFile(sessionId, t.file, t.content, t.original, t.modified);
        renderInnerTabs(sessionId);
      });
      tab.querySelector('.inner-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeInnerFileTab(sessionId, t.file);
      });
      leftArea.appendChild(tab);
    });
  }

  if (!state._innerDiffMode) state._innerDiffMode = 'diff';
  if (state._innerDiffInline == null) state._innerDiffInline = true;

  function showInnerFile(sessionId, filePath, content, original, modified) {
    const panel = state.chatPanels[sessionId];
    if (!panel) return;
    state._activeInnerFile = filePath;

    panel.querySelectorAll('.inner-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.view === 'file:' + filePath);
    });
    panel.querySelectorAll('.inner-view').forEach(v => {
      v.classList.toggle('active', v.dataset.view === 'editor');
    });

    const editorContainer = panel.querySelector('.inner-editor-container');
    if (state.innerEditors[sessionId]) {
      disposeEditorWithModels(state.innerEditors[sessionId]);
      state.innerEditors[sessionId] = null;
    }
    editorContainer.innerHTML = '';

    const hasDiff = original != null && modified != null;

    if (hasDiff) {
      const toolbar = document.createElement('div');
      toolbar.className = 'inner-editor-toolbar';
      const diffBtn = document.createElement('button');
      diffBtn.className = 'inner-toolbar-btn' + (state._innerDiffMode === 'diff' ? ' active' : '');
      diffBtn.textContent = 'Diff';
      const viewBtn = document.createElement('button');
      viewBtn.className = 'inner-toolbar-btn' + (state._innerDiffMode === 'view' ? ' active' : '');
      viewBtn.textContent = 'View';
      const inlineBtn = document.createElement('button');
      inlineBtn.className = 'inner-toolbar-btn' + (state._innerDiffInline ? ' active' : '');
      inlineBtn.textContent = 'Inline';
      inlineBtn.style.display = state._innerDiffMode === 'diff' ? '' : 'none';
      toolbar.append(diffBtn, viewBtn, inlineBtn);
      editorContainer.appendChild(toolbar);

      const editorEl = document.createElement('div');
      editorEl.style.flex = '1';
      editorEl.style.minHeight = '0';
      editorContainer.appendChild(editorEl);

      diffBtn.addEventListener('click', () => { state._innerDiffMode = 'diff'; showInnerFile(sessionId, filePath, content, original, modified); });
      viewBtn.addEventListener('click', () => { state._innerDiffMode = 'view'; showInnerFile(sessionId, filePath, content, original, modified); });
      inlineBtn.addEventListener('click', () => { state._innerDiffInline = !state._innerDiffInline; showInnerFile(sessionId, filePath, content, original, modified); });

      if (window._monacoReady) {
        window._monacoReady.then(m => {
          defineMonacoTheme(m);
          const lang = guessLanguage(filePath);
          if (state._innerDiffMode === 'diff') {
            const editor = m.editor.createDiffEditor(editorEl, {
              theme: 'catalyst-dark',
              readOnly: true,
              automaticLayout: true,
              renderSideBySide: !state._innerDiffInline,
              fontFamily: "'Fira Code', monospace",
              fontSize: 12,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderOverviewRuler: false,
              contextmenu: false,
            });
            editor.setModel({
              original: m.editor.createModel(original, lang),
              modified: m.editor.createModel(modified, lang),
            });
            state.innerEditors[sessionId] = editor;
          } else {
            const editor = m.editor.create(editorEl, {
              value: modified,
              language: lang,
              theme: 'catalyst-dark',
              readOnly: true,
              automaticLayout: true,
              fontFamily: "'Fira Code', monospace",
              fontSize: 12,
              minimap: { enabled: true, scale: 1 },
              scrollBeyondLastLine: false,
              contextmenu: false,
              renderLineHighlight: 'all',
            });
            state.innerEditors[sessionId] = editor;
          }
        });
      }
    } else {
      if (window._monacoReady) {
        window._monacoReady.then(m => {
          defineMonacoTheme(m);
          const editor = m.editor.create(editorContainer, {
            value: content,
            language: guessLanguage(filePath),
            theme: 'catalyst-dark',
            readOnly: true,
            automaticLayout: true,
            fontFamily: "'Fira Code', monospace",
            fontSize: 12,
            minimap: { enabled: true, scale: 1 },
            scrollBeyondLastLine: false,
            contextmenu: false,
            renderLineHighlight: 'all',
          });
          state.innerEditors[sessionId] = editor;
        });
      }
    }
  }

  function closeInnerFileTab(sessionId, filePath) {
    const tabs = state.innerTabs[sessionId] || [];
    const idx = tabs.findIndex(t => t.file === filePath);
    if (idx < 0) return;
    tabs.splice(idx, 1);

    if (state._activeInnerFile === filePath) {
      if (tabs.length > 0) {
        const next = tabs[Math.min(idx, tabs.length - 1)];
        showInnerFile(sessionId, next.file, next.content, next.original, next.modified);
      } else {
        switchInnerTab(sessionId, 'terminal');
      }
    }
    renderInnerTabs(sessionId);
  }

  function showRightPanel(sessionId) {
    const rp = $('#rightPanel');
    if (rp) {
      if (rpMinimized) {
        rp.classList.add('hidden');
        $('#rpRestoreBtn').classList.remove('hidden');
      } else {
        rp.classList.remove('hidden');
        $('#rpRestoreBtn').classList.add('hidden');
      }
      syncRpWidthVar();
      const session = state.sessions.find(s => s.id === sessionId);
      if (session) ws.send(JSON.stringify({ type: 'get-repo-settings', repoPath: session.repoPath }));
      ws.send(JSON.stringify({ type: 'get-scripts', sessionId }));
      ws.send(JSON.stringify({ type: 'git-branch', sessionId }));
      ws.send(JSON.stringify({ type: 'git-changed-files', sessionId }));
      // Asked for in both modes now, because the All Files label carries its
      // total whether or not that view is showing. It is one `git ls-files`, and
      // renderAllFiles only draws when its view is the active one.
      allFilesList = [];
      allFilesFetched = false;
      ws.send(JSON.stringify({ type: 'git-all-files', sessionId }));
      selectedSubdir = '';
      const fn = $('#cmdFolderName');
      if (fn) fn.textContent = '/ (root)';
    }
  }

  function hideRightPanel() {
    const rp = $('#rightPanel');
    if (rp) rp.classList.add('hidden');
    const restoreBtn = $('#rpRestoreBtn');
    if (restoreBtn) restoreBtn.classList.add('hidden');
  }

  // Minimize / restore right panel — persisted so it stays closed across runs.
  let rpMinimized = localStorage.getItem('catalyst-right-panel-minimized') === 'true';
  $('#rpMinimizeBtn').addEventListener('click', () => {
    rpMinimized = true;
    localStorage.setItem('catalyst-right-panel-minimized', 'true');
    $('#rightPanel').classList.add('hidden');
    $('#rpRestoreBtn').classList.remove('hidden');
    syncRpWidthVar();
    refitTerminal();
  });
  $('#rpRestoreBtn').addEventListener('click', () => {
    rpMinimized = false;
    localStorage.setItem('catalyst-right-panel-minimized', 'false');
    $('#rpRestoreBtn').classList.add('hidden');
    if (state.activeSessionId) {
      $('#rightPanel').classList.remove('hidden');
      syncRpWidthVar();
      refitTerminal();
    }
  });

  function switchToSession(sessionId) {
    state.activeSessionId = sessionId;
    state.tabNotify.delete(sessionId);
    localStorage.setItem('catalyst-active-session', sessionId);
    hideAllPanels();
    const panel = ensureChatPanel(sessionId);
    if (panel) panel.classList.add('active');
    renderSessions();
    updateSidebarVisibility();
    showRightPanel(sessionId);
    restoreTaskForRepo();
    // Populate the Manage → Model dropdown with this CLI's models (dynamic).
    const _activeSess = state.sessions.find(s => s.id === sessionId);
    if (_activeSess) requestModelList(_activeSess.cli);
    // Without this the Manage panel kept showing the session you switched away
    // from — it only refreshed when its own tab was clicked.
    updateManageInfo();
    // Fit after layout has settled (right panel visible, sidebar updated).
    // Terminal may have been opened in a hidden (display:none) container,
    // so force xterm to re-measure character dimensions now that it's visible.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const term = state.terminals[sessionId];
        if (term) {
          const fs = term.options.fontSize;
          term.options.fontSize = fs + 1;
          term.options.fontSize = fs;
          if (term._fitAddon) { try { term._fitAddon.fit(); } catch {} }
          sendResize(sessionId, term.cols, term.rows);
          term.focus();
        }
      }, 50);
    });
  }

  function showWelcome() {
    state.activeSessionId = null;
    state.selectedRepo = null;
    hideAllPanels();
    hideRightPanel();
    welcomeScreen.classList.remove('hidden');
    welcomeScreen.classList.remove('has-repos');
    repoSection.classList.add('hidden');
    cliSection.classList.add('hidden');
    $('#repoCliLayout').classList.remove('has-selection');
    folderError.classList.add('hidden');
    repoGrid.innerHTML = '';
    browseBtn.textContent = browseLabel;
    browseBtn.disabled = false;
    const filterInput = document.getElementById('portFilter');
    if (filterInput) filterInput.value = '';
    if (state.rootDir) {
      folderInput.value = state.rootDir;
      browseBtn.textContent = 'Scanning…';
      browseBtn.disabled = true;
      if (!wsSend({ type: 'list-repos', rootDir: state.rootDir })) {
        browseBtn.textContent = browseLabel;
        browseBtn.disabled = false;
      }
    }
    renderSessions();
    updateSidebarVisibility();
  }

  function removeSessionUI(sessionId) {
    state.sessions = state.sessions.filter(s => s.id !== sessionId);
    const term = state.terminals[sessionId];
    if (term) { term.dispose(); delete state.terminals[sessionId]; }
    const panel = state.chatPanels[sessionId];
    if (panel) { panel.remove(); delete state.chatPanels[sessionId]; }
    delete state.sessionStatus[sessionId];
    state.tabNotify.delete(sessionId);
    delete state.lastInputTime[sessionId];
    (state.innerSessions[sessionId] || []).forEach(inner => {
      if (inner.term) { try { inner.term.dispose(); } catch {} }
    });
    delete state.innerSessions[sessionId];
    if (state.innerEditors[sessionId]) disposeEditorWithModels(state.innerEditors[sessionId]);
    delete state.innerEditors[sessionId];
    delete state.innerTabs[sessionId];
    delete state.sessionStartTime[sessionId];
    delete state.prScanBuffers[sessionId];
    if (state.activeSessionId === sessionId) {
      if (state.sessions.length > 0) switchToSession(state.sessions[0].id);
      else showWelcome();
    }
    renderSessions();
    updateSidebarVisibility();
  }

  // Resize terminals when window or layout changes
  let _refitTimer = null;
  let _refitSettleTimer = null;
  // Force xterm to recompute its cell size before fitting. Needed once the web
  // font loads: a fit done with the fallback font miscounts columns and makes
  // the PTY wider than the display, which garbles the CLI's TUI (misaligned/
  // wrapped tables). Toggling fontSize invalidates xterm's cached metrics.
  function remeasureAndFit(term) {
    if (!term || !term._fitAddon) return;
    try {
      const fs = term.options.fontSize;
      term.options.fontSize = fs + 1;
      term.options.fontSize = fs;
      term._fitAddon.fit();
    } catch {}
  }

  // Fitting a terminal whose container is not on screen is worse than not
  // fitting it: the fit addon measures a zero-sized box, proposes a minimum
  // grid, and xterm's onResize then pushes those bogus dimensions to the PTY —
  // which is what left a TUI garbled after a window nudge or a panel toggle.
  // Anything hidden is skipped and re-fitted when it becomes visible
  // (switchToSession / switchInnerTab already do that).
  function isOnScreen(term) {
    const el = term && term.element;
    if (!el || !el.isConnected) return false;
    if (!el.offsetParent) return false;
    return el.clientWidth > 0 && el.clientHeight > 0;
  }

  function fitIfVisible(term, onFitted) {
    if (!term || !term._fitAddon || !isOnScreen(term)) return;
    try {
      term._fitAddon.fit();
      onFitted(term);
    } catch {}
  }

  function refitAllTerminals() {
    const sid = state.activeSessionId;
    if (!sid) return;
    fitIfVisible(state.terminals[sid], (t) => sendResize(sid, t.cols, t.rows));
    const innerList = state.innerSessions[sid] || [];
    innerList.forEach(inner => {
      fitIfVisible(inner.term, (t) => sendInnerResize(inner.innerSessionId, t.cols, t.rows));
    });
  }
  // Debounce so we only fit/resize once the layout has settled — fitting on
  // every ResizeObserver tick during a panel/window transition sends a stream of
  // intermediate sizes to the PTY and desyncs the CLI's TUI.
  function refitTerminal() {
    clearTimeout(_refitTimer);
    clearTimeout(_refitSettleTimer);
    _refitTimer = setTimeout(refitAllTerminals, 120);
    // A confirming pass: the first fit can land while a panel is still taking its
    // final width, which measures the grid one column out. sendResize drops this
    // one when nothing actually changed, so the normal case costs nothing.
    _refitSettleTimer = setTimeout(refitAllTerminals, 400);
  }
  window.addEventListener('resize', refitTerminal);
  new ResizeObserver(refitTerminal).observe(mainPanel);

  // Settings
  function showSettings() {
    settingsPanel.classList.remove('hidden');
    settingsRootInput.value = state.rootDir || '';
    settingsRootHint.textContent = '';
    settingsRootHint.className = 'settings-hint';
    ws.send(JSON.stringify({ type: 'get-settings' }));
  }

  function hideSettings() {
    settingsPanel.classList.add('hidden');
  }

  settingsBtn.addEventListener('click', showSettings);
  const welcomeSettingsBtn = $('#welcomeSettingsBtn');
  if (welcomeSettingsBtn) welcomeSettingsBtn.addEventListener('click', showSettings);
  const topbarBrand = $('#topbarBrand');
  if (topbarBrand) topbarBrand.addEventListener('click', showWelcome);
  const searchBtn = $('#searchBtn');
  if (searchBtn) searchBtn.addEventListener('click', openPalette);

  // Run button (split): the main button runs ALL configs (each in its own
  // named terminal in the left pane); the caret opens a menu to run one. Each
  // config gets a dedicated terminal that is reused on subsequent runs.
  const runBtn = $('#runBtn');
  const runCaretBtn = $('#runCaretBtn');
  const runMenu = $('#runMenu');

  function closeRunMenu() { if (runMenu) runMenu.classList.add('hidden'); }

  // The command a config runs: build first, then run (chained with && so run
  // only proceeds if the build succeeds). Falls back to whichever is set.
  function composeRunCmd(cfg) {
    const b = (cfg.buildCmd || '').trim();
    const r = (cfg.runCmd || '').trim();
    if (b && r) return b + ' && ' + r;
    return r || b;
  }

  function findInnerSession(parentSessionId, innerId) {
    return (state.innerSessions[parentSessionId] || []).find(s => s.innerSessionId === innerId);
  }

  // Run one config in its own terminal under the active session — creating a
  // named terminal the first time, reusing (and restarting) it after that.
  function runConfigInTerminal(parentSessionId, cfg) {
    const cmd = composeRunCmd(cfg);
    if (!cmd) { showToast('"' + (cfg.name || 'Config') + '" has no command', 'info'); return; }
    state.runTerminals = state.runTerminals || {};
    const map = state.runTerminals[parentSessionId] = state.runTerminals[parentSessionId] || {};
    const existingId = map[cfg.id];
    const inner = existingId && findInnerSession(parentSessionId, existingId);
    if (inner && !inner.ended) {
      // Reuse: interrupt whatever is running, then re-run in the same terminal.
      ws.send(JSON.stringify({ type: 'inner-session-input', innerSessionId: existingId, data: '\x03' }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'inner-session-input', innerSessionId: existingId, data: cmd + '\r' })), 250);
      switchInnerTab(parentSessionId, 'inner:' + existingId);
    } else {
      // Create a new terminal named after the config, in its folder, running cmd.
      const ref = (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'ref-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      state._pendingRunConfig = state._pendingRunConfig || {};
      state._pendingRunConfig[ref] = { parentSessionId, configId: cfg.id };
      ws.send(JSON.stringify({
        type: 'create-inner-session',
        parentSessionId,
        cliId: 'terminal',
        name: cfg.name || 'Run',
        subdir: cfg.buildFolder || '',
        initialCommand: cmd,
        clientRef: ref,
      }));
    }
  }

  function runAllConfigs(parentSessionId, repoPath) {
    const configs = getRunConfigs(repoPath).filter(c => composeRunCmd(c));
    if (!configs.length) { openRunConfigModal(repoPath); return; }
    configs.forEach(cfg => runConfigInTerminal(parentSessionId, cfg));
    showToast('Running ' + configs.length + ' configuration' + (configs.length > 1 ? 's' : ''), 'success');
  }

  function buildRunMenu(repoPath, parentSessionId) {
    const configs = getRunConfigs(repoPath);
    runMenu.innerHTML = '';
    if (configs.length > 1) {
      const all = document.createElement('button');
      all.className = 'run-menu-item run-menu-all';
      all.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg><span class="rmi-name">Run all</span>`;
      all.addEventListener('click', () => { closeRunMenu(); runAllConfigs(parentSessionId, repoPath); });
      runMenu.appendChild(all);
    }
    configs.forEach(cfg => {
      const item = document.createElement('button');
      item.className = 'run-menu-item';
      item.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>` +
        `<span class="rmi-name">${escHtml(cfg.name || '(unnamed)')}</span>` +
        `<span class="rmi-cmd">${escHtml(composeRunCmd(cfg) || '—')}</span>`;
      item.addEventListener('click', () => { closeRunMenu(); runConfigInTerminal(parentSessionId, cfg); });
      runMenu.appendChild(item);
    });
    const manage = document.createElement('button');
    manage.className = 'run-menu-item run-menu-manage';
    manage.textContent = configs.length ? 'Manage configurations…' : '+ Add run configuration';
    manage.addEventListener('click', () => { closeRunMenu(); openRunConfigModal(repoPath); });
    runMenu.appendChild(manage);
  }

  if (runBtn) runBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeRunMenu();
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (!session) { showToast('Open a repo session to run', 'info'); return; }
    const configs = getRunConfigs(session.repoPath);
    if (!configs.length) { openRunConfigModal(session.repoPath); return; }
    runAllConfigs(session.id, session.repoPath);
  });

  if (runCaretBtn) runCaretBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (!session) { showToast('Open a repo session to run', 'info'); return; }
    if (!runMenu.classList.contains('hidden')) { closeRunMenu(); return; }
    buildRunMenu(session.repoPath, session.id);
    runMenu.classList.remove('hidden');
  });
  document.addEventListener('click', closeRunMenu);

  const settingsModalClose = $('#settingsModalClose');
  if (settingsModalClose) settingsModalClose.addEventListener('click', hideSettings);

  settingsPanel.addEventListener('click', (e) => {
    if (e.target === settingsPanel) hideSettings();
  });

  // Settings nav — cache the NodeLists to avoid repeated DOM queries
  const _settingsNavItems = $$('.settings-nav-item');
  const _settingsSectionPages = $$('.settings-section-page');
  _settingsNavItems.forEach(btn => {
    btn.addEventListener('click', () => {
      _settingsNavItems.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _settingsSectionPages.forEach(p => p.classList.remove('active'));
      const page = $('#settings-' + btn.dataset.section);
      if (page) page.classList.add('active');
      if (btn.dataset.section === 'aicli') {
        ws.send(JSON.stringify({ type: 'check-cli-availability' }));
      }
    });
  });

  // AI CLI install buttons
  $$('.cli-install-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.cli-install-card');
      if (!card) return;
      const cliId = card.dataset.cli;
      const statusEl = card.querySelector('[data-status]');
      const logEl = card.querySelector('[data-log]');
      if (logEl) {
        logEl.textContent = '';
        logEl.classList.remove('hidden');
      }
      if (statusEl) {
        statusEl.className = 'cli-install-status installing';
        statusEl.innerHTML = '<span class="cli-install-dot"></span>Installing';
      }
      btn.disabled = true;
      btn.textContent = 'Installing…';
      ws.send(JSON.stringify({ type: 'install-cli', cli: cliId }));
    });
  });

  // Credit year
  const creditYearEl = $('#creditYear');
  if (creditYearEl) creditYearEl.textContent = '© ' + new Date().getFullYear();
  $$('.welcome-year').forEach(el => el.textContent = new Date().getFullYear());

  // Version, from the server rather than the markup. The welcome footer, About
  // and Settings → Updates all used to carry a hardcoded literal, so each of them
  // still claimed 1.0.0 after later releases shipped.
  const appVersion = document.querySelector('meta[name="app-version"]')?.content || '';
  if (appVersion) {
    $$('.app-version').forEach(el => el.textContent = 'v' + appVersion);
    $$('.about-version').forEach(el => el.textContent = 'v' + appVersion);
    const installedEl = $('#updateCurrentVersion');
    if (installedEl) installedEl.textContent = appVersion;
  }

  settingsRootBrowse.addEventListener('click', () => {
    if (state._browsing) return;
    state._browsing = true;
    state._settingsBrowse = true;
    ws.send(JSON.stringify({ type: 'browse-folder' }));
    setTimeout(() => { state._browsing = false; }, 30000);
  });

  settingsRootSave.addEventListener('click', () => {
    const dir = settingsRootInput.value.trim();
    if (!dir) return;
    ws.send(JSON.stringify({ type: 'list-repos', rootDir: dir }));
    state.rootDir = dir;
    folderInput.value = dir;
    settingsRootHint.textContent = 'Root folder updated';
    settingsRootHint.className = 'settings-hint success';
    updateSidebarVisibility();
  });

  const resetCatalystBtn = $('#resetCatalystBtn');
  const resetHint = $('#resetHint');
  if (resetCatalystBtn) {
    resetCatalystBtn.addEventListener('click', async () => {
      const ok = await showConfirm(
        'Reset Catalyst',
        'This wipes all cached repo info, sessions, settings, and both PATs from Windows Credential Manager. Onboarding will run again on next launch.',
        'This cannot be undone.',
        'Reset everything'
      );
      if (!ok) return;
      resetCatalystBtn.disabled = true;
      resetHint.textContent = 'Resetting…';
      resetHint.className = 'settings-hint';
      try {
        localStorage.clear();
      } catch {}
      ws.send(JSON.stringify({ type: 'reset-catalyst' }));
    });
  }

  // ─── Updates (Settings → Updates) ─────────────────────────────────────
  // Only the desktop build can replace itself, so the browser gets a panel that
  // asks the desktop host to do it instead (see "Updates from a browser tab").
  const isDesktopBuild = !!window.tauriDesktop?.checkForUpdates;

  // ─── Open in a browser (Settings → General) ───────────────────────────
  // The desktop window is one view onto a local server, so the same workspace is
  // reachable from any browser on this machine. Only shown in the desktop build —
  // in a browser you are already looking at this URL.
  const openInBrowserSection = $('#openInBrowserSection');
  if (openInBrowserSection && isDesktopBuild) {
    const localUrl = window.location.origin + '/';
    openInBrowserSection.hidden = false;
    const urlInput = $('#localUrlInput');
    const urlHint = $('#localUrlHint');
    if (urlInput) urlInput.value = localUrl;

    $('#copyLocalUrl')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(localUrl);
        if (urlHint) urlHint.textContent = 'Copied.';
      } catch {
        // Clipboard access can be refused; selecting the text is the fallback.
        urlInput?.select();
        if (urlHint) urlHint.textContent = 'Press Ctrl+C to copy the selected URL.';
      }
    });

    $('#openLocalUrl')?.addEventListener('click', () => {
      window.tauriDesktop.openExternal(localUrl);
      if (urlHint) urlHint.textContent = 'Opened in your default browser.';
    });

    if (urlHint) {
      urlHint.textContent = 'The port changes between launches — Catalyst takes the first free one.';
    }
  }
  $('#updatesDesktop')?.toggleAttribute('hidden', !isDesktopBuild);
  $('#updatesBrowser')?.toggleAttribute('hidden', isDesktopBuild);

  const checkUpdatesBtn = $('#checkUpdatesBtn');
  const updateStatus = $('#updateStatus');
  const updateAvailable = $('#updateAvailable');
  const updateNavDot = $('#updateNavDot');

  function showUpdate(info) {
    if (!info) {
      updateAvailable?.classList.add('hidden');
      updateNavDot?.classList.add('hidden');
      return;
    }
    $('#updateNewVersion').textContent = info.version;
    const notes = (info.notes || '').trim();
    const notesEl = $('#updateNotes');
    notesEl.textContent = notes;
    notesEl.classList.toggle('hidden', !notes);
    updateAvailable?.classList.remove('hidden');
    updateNavDot?.classList.remove('hidden');
  }

  async function runUpdateCheck() {
    checkUpdatesBtn.disabled = true;
    updateStatus.textContent = 'Checking…';
    try {
      const info = await window.tauriDesktop.checkForUpdates();
      showUpdate(info);
      updateStatus.textContent = info ? '' : 'Catalyst is up to date.';
    } catch (e) {
      updateStatus.textContent = 'Could not reach GitHub: ' + e;
    } finally {
      checkUpdatesBtn.disabled = false;
    }
  }

  // Unattended installs are opt-in, so the box starts unchecked and only the
  // stored preference can tick it (see the 'settings' message handler). Kept in
  // the server-side store rather than localStorage because the Rust startup
  // check reads it before any page exists.
  const autoUpdateToggle = $('#autoUpdateToggle');

  if (isDesktopBuild) {
    checkUpdatesBtn?.addEventListener('click', runUpdateCheck);

    autoUpdateToggle?.addEventListener('change', () => {
      ws.send(JSON.stringify({ type: 'save-auto-update', autoUpdate: autoUpdateToggle.checked }));
    });

    $('#installUpdateBtn')?.addEventListener('click', async () => {
      const btn = $('#installUpdateBtn');
      const status = $('#installStatus');
      btn.disabled = true;
      status.textContent = 'Downloading…';
      try {
        // Succeeds by replacing this process, so nothing after this runs.
        await window.tauriDesktop.installUpdate();
      } catch (e) {
        status.textContent = 'Install failed: ' + e;
        btn.disabled = false;
      }
    });

    // Surface a pending update on the nav item without the user asking, so the
    // dot is already there when they open Settings.
    window.tauriDesktop.checkForUpdates().then(showUpdate).catch(() => {});
  }

  // ─── Updates from a browser tab ───────────────────────────────────────
  // The desktop host owns the updater because it owns the signature check. A
  // browser tab can still drive it: the server reads the same release manifest,
  // and relays the install request to the host.
  if (!isDesktopBuild) {
    const bCheck = $('#browserCheckUpdatesBtn');
    const bInstall = $('#browserInstallUpdateBtn');
    const bStatus = $('#browserUpdateStatus');
    const bNotes = $('#browserUpdateNotes');
    const bVersion = $('#browserCurrentVersion');
    if (bVersion) bVersion.textContent = document.querySelector('meta[name="app-version"]')?.content || '—';

    bCheck?.addEventListener('click', () => {
      bCheck.disabled = true;
      if (bStatus) bStatus.textContent = 'Checking…';
      wsSend({ type: 'app-update-check' });
    });

    bInstall?.addEventListener('click', () => {
      bInstall.disabled = true;
      if (bStatus) bStatus.textContent = 'Asking the desktop app to install…';
      wsSend({ type: 'app-update-install' });
    });

    // Both replies land in the message switch, which forwards to these.
    window._catalystOnUpdateInfo = (msg) => {
      if (bCheck) bCheck.disabled = false;
      if (!bStatus) return;
      if (msg.error) { bStatus.textContent = msg.error; return; }
      if (!msg.newer) {
        bStatus.textContent = `Catalyst ${msg.current} is up to date.`;
        bInstall?.classList.add('hidden');
        bNotes?.classList.add('hidden');
        return;
      }
      bStatus.textContent = `Version ${msg.latest} is available.`;
      if (bNotes) {
        bNotes.textContent = (msg.notes || '').trim();
        bNotes.classList.toggle('hidden', !bNotes.textContent);
      }
      if (bInstall) {
        // Without the desktop host there is nothing to install with — a plain
        // `node server.js` has nobody listening.
        bInstall.classList.toggle('hidden', !msg.installable);
        bInstall.disabled = false;
        if (!msg.installable) {
          bStatus.textContent += ' Start the desktop app to install it.';
        }
      }
      updateNavDot?.classList.remove('hidden');
    };

    window._catalystOnUpdateInstall = (msg) => {
      if (!bStatus) return;
      bStatus.textContent = msg.message || (msg.ok ? 'Installing…' : 'Could not start the update.');
      if (!msg.ok && bInstall) bInstall.disabled = false;
    };
  }

  togglePatVisibility.addEventListener('click', () => {
    const isPassword = azurePat.type === 'password';
    azurePat.type = isPassword ? 'text' : 'password';
    togglePatVisibility.textContent = isPassword ? 'Hide' : 'Show';
  });

  function parseAzureUrl(url) {
    const match = url.match(/dev\.azure\.com\/([^\/]+)\/([^\/\?#]+)/);
    if (match) return { org: match[1], project: match[2] };
    const vsMatch = url.match(/([^\.]+)\.visualstudio\.com\/([^\/\?#]+)/);
    if (vsMatch) return { org: vsMatch[1], project: vsMatch[2] };
    return null;
  }

  const azureUrl = $('#azureUrl');
  const azureParsedDetails = $('#azureParsedDetails');
  const githubOrg = $('#githubOrg');
  const githubPat = $('#githubPat');
  const toggleGhPatVisibility = $('#toggleGhPatVisibility');
  const ghPatStatus = $('#ghPatStatus');

  if (toggleGhPatVisibility && githubPat) {
    toggleGhPatVisibility.addEventListener('click', () => {
      const isPassword = githubPat.type === 'password';
      githubPat.type = isPassword ? 'text' : 'password';
      toggleGhPatVisibility.textContent = isPassword ? 'Hide' : 'Show';
    });
  }

  azureUrl.addEventListener('input', () => {
    const parsed = parseAzureUrl(azureUrl.value.trim());
    if (parsed) {
      azureParsedDetails.textContent = `Org: ${parsed.org} / Project: ${parsed.project}`;
      azureParsedDetails.className = 'ob-field-hint success';
    } else if (azureUrl.value.trim()) {
      azureParsedDetails.textContent = 'Could not parse URL — expected format: https://dev.azure.com/org/project';
      azureParsedDetails.className = 'ob-field-hint error';
    } else {
      azureParsedDetails.textContent = '';
    }
  });

  // Provider picker (Integrations settings)
  state.integProvider = 'azure';
  const integFieldsAzure = $('#integFieldsAzure');
  const integFieldsGithub = $('#integFieldsGithub');
  const integFieldsNone = $('#integFieldsNone');
  const integProviderBtns = $$('.integ-provider-btn');

  const integSaveRow = document.querySelector('.integ-save-row');

  function setIntegProvider(provider) {
    state.integProvider = provider;
    integProviderBtns.forEach(b => b.classList.toggle('active', b.dataset.provider === provider));
    // The save button wears the selected integration's brand colour; CSS keys off
    // this attribute so the mapping lives with the rest of the styling.
    if (integSaveRow) integSaveRow.dataset.provider = provider;
    if (integFieldsAzure) integFieldsAzure.style.display = provider === 'azure' ? '' : 'none';
    if (integFieldsGithub) integFieldsGithub.style.display = provider === 'github' ? '' : 'none';
    if (integFieldsNone) integFieldsNone.style.display = provider === 'none' ? '' : 'none';
  }
  integProviderBtns.forEach(btn => {
    btn.addEventListener('click', () => setIntegProvider(btn.dataset.provider));
  });

  // Background install + verify for the integration's CLI
  const integToolCard = $('#integToolCard');
  const integToolName = $('#integToolName');
  const integToolPkg = $('#integToolPkg');
  const integToolStatus = $('#integToolStatus');
  const integToolLog = $('#integToolLog');

  function setIntegToolStatus(state, label) {
    if (!integToolStatus) return;
    integToolStatus.className = 'cli-install-status ' + state;
    integToolStatus.innerHTML = '<span class="cli-install-dot"></span>' + label;
  }

  function startProviderCliInstall(provider) {
    if (!integToolCard) return;
    if (provider === 'azure') {
      integToolCard.dataset.cli = 'azcli';
      integToolName.textContent = 'Azure CLI + DevOps extension';
      integToolPkg.textContent = 'winget install Microsoft.AzureCLI';
    } else if (provider === 'github') {
      integToolCard.dataset.cli = 'gh';
      integToolName.textContent = 'GitHub CLI';
      integToolPkg.textContent = 'winget install GitHub.cli';
    } else {
      integToolCard.classList.add('hidden');
      return;
    }
    integToolCard.classList.remove('hidden');
    setIntegToolStatus('checking', 'Verifying');
    if (integToolLog) {
      integToolLog.textContent = '';
      integToolLog.classList.add('hidden');
    }
    ws.send(JSON.stringify({ type: 'install-cli', cli: integToolCard.dataset.cli }));
  }

  saveAzureSettings.addEventListener('click', () => {
    const provider = state.integProvider;
    if (provider === 'azure') {
      const parsed = parseAzureUrl(azureUrl.value.trim());
      const settings = {
        provider: 'azure',
        azureOrg: parsed ? parsed.org : '',
        azureProject: parsed ? parsed.project : '',
        azureUrl: azureUrl.value.trim()
      };
      const pat = azurePat.value.trim();
      ws.send(JSON.stringify({ type: 'save-settings', settings, pat: pat || undefined }));
    } else if (provider === 'github') {
      const org = githubOrg ? githubOrg.value.trim() : '';
      const pat = githubPat ? githubPat.value.trim() : '';
      const settings = { provider: 'github', githubOrg: org };
      ws.send(JSON.stringify({ type: 'save-settings', settings, pat: pat || undefined, githubPat: pat || undefined }));
    } else {
      ws.send(JSON.stringify({ type: 'save-settings', settings: { provider: 'none' } }));
      if (integToolCard) integToolCard.classList.add('hidden');
      return;
    }
    startProviderCliInstall(provider);
  });

  browseBtn.addEventListener('click', async () => {
    if (state._browsing) return;
    state._browsing = true;
    state._settingsBrowse = false;
    browseBtn.textContent = 'Scanning…';
    browseBtn.disabled = true;
    if (window.tauriDesktop?.isDesktop) {
      const result = await window.tauriDesktop.showFolderDialog();
      state._browsing = false;
      if (result) {
        folderInput.value = result;
        ws.send(JSON.stringify({ type: 'list-repos', rootDir: result }));
      } else {
        browseBtn.textContent = browseLabel;
        browseBtn.disabled = false;
      }
    } else {
      ws.send(JSON.stringify({ type: 'browse-folder' }));
      setTimeout(() => { state._browsing = false; browseBtn.textContent = browseLabel; browseBtn.disabled = false; }, 30000);
    }
  });

  folderInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const dir = folderInput.value.trim();
      if (!dir) return;
      folderError.classList.add('hidden');
      browseBtn.textContent = 'Scanning…';
      browseBtn.disabled = true;
      ws.send(JSON.stringify({ type: 'list-repos', rootDir: dir }));
    }
  });


  const MAX_TABS = 8;

  state.cliAvailability = {};
  const _cliBtns = $$('.cli-btn');

  function disableCliButtons() {
    _cliBtns.forEach(b => { b.disabled = true; b.classList.add('cli-launching'); });
    clearTimeout(state._cliLaunchTimeout);
    state._cliLaunchTimeout = setTimeout(enableCliButtons, 15000);
  }
  function enableCliButtons() {
    clearTimeout(state._cliLaunchTimeout);
    _cliBtns.forEach(b => { b.disabled = false; b.classList.remove('cli-launching'); });
    // Codex stays out of service while extra repos are selected.
    syncCodexButton();
  }

  // Used by the Recent chips on the welcome screen (public/welcome-port.js).
  window._catalystOpenSession = function(repoPath, repoName, cli) {
    cli = cli || 'claude';
    // A plain terminal has no history to offer, so it launches directly.
    if (cli === 'terminal') {
      if (state.sessions.filter(s => !s.ended).length >= MAX_TABS) {
        alert(`Maximum ${MAX_TABS} sessions allowed. Close a tab first.`);
        return;
      }
      wsSend({ type: 'create-session', cli, repo: repoName, repoPath, useWorktree: false });
      return;
    }
    beginLaunch({ cli, repo: repoName, repoPath, useWorktree: false });
  };

  // ─── Reveal in Explorer ───────────────────────────────────────────────
  // This button had markup and no handler at all, so it did nothing. Two routes:
  // the desktop build can ask the OS directly through Tauri, and the browser
  // build asks the server to do it (the page itself cannot).
  const revealBtn = $('#revealBtn');
  revealBtn?.addEventListener('click', () => {
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    const target = state.selectedRepo?.path || session?.repoPath;
    if (!target) { showToast('Select a repo first', 'info'); return; }
    if (window.tauriDesktop?.revealInExplorer) {
      window.tauriDesktop.revealInExplorer(target);
      return;
    }
    wsSend({ type: 'reveal-in-explorer', repoPath: target });
  });

  // ─── Additional repos ─────────────────────────────────────────────────
  // The selected card is the primary repo (the agent's cwd). Extras are passed
  // as additional working directories using each CLI's own flag, so which CLI
  // is chosen changes how well this is supported.
  const multiRepoModal = $('#multiRepoModal');
  const extraReposChips = $('#extraReposChips');
  const extraReposNote = $('#extraReposNote');

  function clearExtraRepos() {
    state.extraRepos = [];
    renderExtraRepos();
  }

  // Codex has no additional-workspace flag — its workspace is its cwd, full
  // stop. Launching it with extras picked would silently give the user a
  // single-repo session, so the button goes out of service while any extra is
  // selected and says why on hover.
  const CODEX_NO_MULTI_REPO =
    'Codex does not support additional repos — it has no equivalent of Claude’s --add-dir, '
    + 'so its workspace stays the primary repo. Clear the additional repos to use Codex.';

  // Deliberately not the `disabled` attribute: Chrome does not show a title
  // tooltip on a disabled control, and the whole point here is that hovering
  // explains itself. So it is disabled in every way that matters — aria, cursor,
  // styling, and a click that refuses — while staying hoverable.
  function syncCodexButton() {
    const btn = document.querySelector('.cli-btn[data-cli="codex"]');
    if (!btn) return;
    const blocked = state.extraRepos.length > 0;
    btn.classList.toggle('cli-unsupported', blocked);
    if (blocked) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = CODEX_NO_MULTI_REPO;
      return;
    }
    btn.removeAttribute('aria-disabled');
    const info = (state.cliAvailability || {}).codex;
    btn.title = info && !info.installed ? 'Not installed — click to install' : '';
  }

  function renderExtraRepos() {
    if (!extraReposChips) return;
    if (!state.extraRepos.length) {
      extraReposChips.innerHTML = '<span class="extra-repos-empty">Primary repo only</span>';
    } else {
      extraReposChips.innerHTML = state.extraRepos
        .map((r, i) => `<span class="extra-repo-chip">${escHtml(r.name)}<button type="button" data-idx="${i}" title="Remove">×</button></span>`)
        .join('');
      extraReposChips.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          state.extraRepos.splice(Number(b.dataset.idx), 1);
          renderExtraRepos();
        });
      });
    }
    updateExtraReposNote();
    syncCodexButton();
  }

  // Two things the chips would otherwise imply wrongly: that all three CLIs
  // support this equally (codex does not), and that every selected repo will be
  // accepted by whichever agent is launched (only ones that agent has already
  // been opened in are).
  function updateExtraReposNote() {
    if (!extraReposNote) return;
    const show = state.extraRepos.length > 0;
    extraReposNote.classList.toggle('hidden', !show);
    if (!show) return;

    const lines = [
      'Claude and Gemini receive these as extra workspace directories. '
      + 'Codex has no equivalent, so it is unavailable while extra repos are selected.'
    ];

    const gaps = EXTRA_DIR_CLIS
      .map(cli => ({
        cli,
        missing: state.extraRepos.filter(r => !cliAcceptsDir(cli, r.path)).map(r => r.name)
      }))
      .filter(g => g.missing.length);

    for (const g of gaps) {
      lines.push(`${CLI_LABELS[g.cli]} can’t take ${g.missing.join(', ')} yet — `
        + `open a session in ${g.missing.length === 1 ? 'it' : 'each'} with ${CLI_LABELS[g.cli]} once first.`);
    }

    extraReposNote.textContent = lines.join(' ');
  }

  // A repo can only be handed to an agent it has already been opened in. The
  // CLIs each keep their own trust record and each gate on it — an unknown
  // folder means the flag is either ignored or the tab lands on a trust prompt
  // nobody asked for. The server does the reading (lib/cli-trust.js) and the
  // final refusing; here it decides what the picker offers.
  function cliAcceptsDir(cli, repoPath) {
    const level = (state.repoTrust[repoPath] || {})[cli];
    if (!level || level === 'unknown') return false;
    return level === 'trusted' || !state.trustEnforced[cli];
  }

  // The agents that would take this repo as an extra directory.
  function agentsAccepting(repoPath) {
    return EXTRA_DIR_CLIS.filter(c => cliAcceptsDir(c, repoPath));
  }

  function requestRepoTrust() {
    const paths = (state.allRepos || []).map(r => r.path).filter(Boolean);
    if (paths.length) wsSend({ type: 'repo-trust', paths });
  }

  function renderMultiRepoList(filter) {
    const list = $('#multiRepoList');
    if (!list) return;
    const primary = state.selectedRepo;
    const q = (filter || '').trim().toLowerCase();
    const rows = (state.allRepos || []).filter(r => !q || r.name.toLowerCase().includes(q));

    if (!rows.length) {
      list.innerHTML = '<div class="multi-repo-none">No repos match that filter.</div>';
      return;
    }

    // Trust hasn't arrived yet on the very first open; say so rather than grey
    // out every row as if nothing were addable.
    const haveTrust = Object.keys(state.repoTrust).length > 0;

    list.innerHTML = rows.map(r => {
      const isPrimary = primary && r.path === primary.path;
      const accepting = agentsAccepting(r.path);
      const blocked = !isPrimary && haveTrust && accepting.length === 0;
      const checked = state.extraRepos.some(x => x.path === r.path);

      let tech;
      if (isPrimary) tech = 'primary';
      else if (!haveTrust) tech = 'checking…';
      else if (blocked) tech = 'not opened by any agent yet';
      else tech = accepting.map(c => CLI_LABELS[c]).join(' · ');

      const title = blocked
        ? 'Open a session in this repo once (and accept the agent’s trust prompt) before it can be added as an extra repo'
        : (accepting.length && haveTrust ? `Can be added for: ${accepting.map(c => CLI_LABELS[c]).join(', ')}` : '');

      return `<label class="multi-repo-row${isPrimary ? ' is-primary' : ''}${blocked ? ' is-blocked' : ''}"${title ? ` title="${escHtml(title)}"` : ''}>
        <input type="checkbox" data-path="${escHtml(r.path)}" ${checked ? 'checked' : ''} ${isPrimary || blocked ? 'disabled' : ''}>
        <span class="mr-name">${escHtml(r.name)}</span>
        <span class="mr-tech">${escHtml(tech)}</span>
      </label>`;
    }).join('');

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const repo = (state.allRepos || []).find(r => r.path === cb.dataset.path);
        if (!repo) return;
        if (cb.checked) {
          if (!state.extraRepos.some(x => x.path === repo.path)) state.extraRepos.push(repo);
        } else {
          state.extraRepos = state.extraRepos.filter(x => x.path !== repo.path);
        }
        updateMultiRepoCount();
      });
    });
    updateMultiRepoCount();
  }

  function updateMultiRepoCount() {
    const el = $('#multiRepoCount');
    if (el) {
      const n = state.extraRepos.length;
      el.textContent = n ? `${n} additional repo${n === 1 ? '' : 's'} selected` : 'None selected';
    }
  }

  function openMultiRepoModal() {
    if (!state.selectedRepo || !multiRepoModal) return;
    $('#multiRepoPrimary').innerHTML = `Primary: <b>${escHtml(state.selectedRepo.name)}</b> — the agent runs here`;
    $('#multiRepoFilter').value = '';
    // Re-read every time: the user may have accepted a trust prompt in another
    // tab since the last open.
    requestRepoTrust();
    renderMultiRepoList('');
    multiRepoModal.classList.remove('hidden');
    multiRepoModal.classList.add('flex');
    setTimeout(() => $('#multiRepoFilter')?.focus(), 30);
  }

  function closeMultiRepoModal() {
    if (!multiRepoModal) return;
    multiRepoModal.classList.add('hidden');
    multiRepoModal.classList.remove('flex');
    renderExtraRepos();
  }

  $('#addReposBtn')?.addEventListener('click', openMultiRepoModal);
  $('#multiRepoClose')?.addEventListener('click', closeMultiRepoModal);
  $('#multiRepoOverlay')?.addEventListener('click', closeMultiRepoModal);
  $('#multiRepoDone')?.addEventListener('click', closeMultiRepoModal);
  $('#multiRepoClear')?.addEventListener('click', () => {
    state.extraRepos = [];
    renderMultiRepoList($('#multiRepoFilter')?.value || '');
  });
  $('#multiRepoFilter')?.addEventListener('input', (e) => renderMultiRepoList(e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && multiRepoModal && !multiRepoModal.classList.contains('hidden')) {
      closeMultiRepoModal();
    }
  });

  renderExtraRepos();

  // Paths only — this is what the server expects and validates.
  const extraDirPaths = () => state.extraRepos.map(r => r.path);

  // Called just before launching. The extras were picked without knowing which
  // agent would run, so this is where the choice is checked against that
  // agent's trust record. Returns null to abort — a session that silently
  // dropped one of the repos the user picked is worse than one that says why it
  // did not start.
  function extraDirsForLaunch(cli) {
    if (!state.extraRepos.length) return [];
    const rejected = state.extraRepos.filter(r => !cliAcceptsDir(cli, r.path));
    if (rejected.length) {
      showToast(
        `${CLI_LABELS[cli] || cli} has not been opened in ${rejected.map(r => r.name).join(', ')} yet — `
        + 'start a session there once, then add it as an extra repo.',
        'error'
      );
      // Trust may have changed since the picker last read it; refresh so the
      // next attempt reflects reality.
      requestRepoTrust();
      return null;
    }
    return extraDirPaths();
  }

  // ─── Sessions modal ───────────────────────────────────────────────────
  // Offers what already exists for this repo+agent — sessions running now, and
  // conversations the CLI can resume — instead of silently starting another.
  const sessionsModal = $('#sessionsModal');

  function relTime(ms) {
    if (!ms) return '';
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function closeSessionsModal() {
    if (!sessionsModal) return;
    sessionsModal.classList.add('hidden');
    sessionsModal.classList.remove('flex');
    state._pendingLaunch = null;
  }

  // Path comparison for "is this the same repo?" — case-insensitive and
  // trailing-separator agnostic, because Windows treats those as the same folder
  // and the paths reach us from different places (scan, recents, session store).
  function samePathish(a, b) {
    if (!a || !b) return false;
    const norm = (p) => String(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    return norm(a) === norm(b);
  }

  // The one way to start an agent session. Every entry point goes through here so
  // they all behave alike: reuse a live session for the same repo and CLI, respect
  // the tab cap, honour the extra-repo gate, and — the part that was missing —
  // ask what already exists before launching anything. The welcome-screen buttons
  // asked; the Recent chips and the palette's Launch commands did not, so they
  // always started a new session however much history the repo had, which is what
  // made the dialog look like it had stopped working.
  function beginLaunch({ cli, repo, repoPath, useWorktree }) {
    if (!cli || !repoPath) return;

    const existing = state.sessions.find(s => !s.ended && s.cli === cli && samePathish(s.repoPath, repoPath));
    if (existing) { switchToSession(existing.id); return; }

    if (state.sessions.filter(s => !s.ended).length >= MAX_TABS) {
      alert(`Maximum ${MAX_TABS} sessions allowed. Close a tab first.`);
      return;
    }

    const extraDirs = extraDirsForLaunch(cli);
    if (extraDirs === null) return; // refused, and already explained in a toast

    state._pendingLaunch = { cli, repo, repoPath, useWorktree: !!useWorktree, extraDirs };
    wsSend({ type: 'list-sessions-for', cli, repoPath });
  }

  function launchPending(extra) {
    const p = state._pendingLaunch;
    if (!p) return;
    closeSessionsModal();
    if (state.sessions.filter(s => !s.ended).length >= MAX_TABS) {
      alert(`Maximum ${MAX_TABS} sessions allowed. Close a tab first.`);
      return;
    }
    disableCliButtons();
    wsSend(Object.assign({
      type: 'create-session',
      cli: p.cli,
      repo: p.repo,
      repoPath: p.repoPath,
      useWorktree: p.useWorktree,
      extraDirs: p.extraDirs
    }, extra || {}));
  }

  function renderSessionsModal(data) {
    const body = $('#sessionsBody');
    const cliName = (data.cli || '').replace(/^./, c => c.toUpperCase());
    $('#sessionsTitle').textContent = `${cliName} · ${state._pendingLaunch?.repo || ''}`;

    const parts = [];
    if (data.running.length) {
      parts.push(`<div class="sess-group-label">Running now (${data.running.length})</div>`);
      data.running.forEach(s => {
        const bits = [];
        if (s.startedAt) bits.push('up ' + relTime(s.startedAt).replace(' ago', ''));
        if (s.worktreeBranch) bits.push('worktree: ' + s.worktreeBranch);
        if (s.extraDirs?.length) bits.push(`+${s.extraDirs.length} repo${s.extraDirs.length === 1 ? '' : 's'}`);
        parts.push(`<div class="sess-row">
          <span class="sess-live-dot"></span>
          <div class="sess-main">
            <div class="sess-label">Open session</div>
            <div class="sess-meta">${escHtml(bits.join(' · ') || 'running')}</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-switch="${escHtml(s.id)}" type="button">Switch to</button>
        </div>`);
      });
    }

    if (data.conversations.length) {
      parts.push(`<div class="sess-group-label">Past conversations (${data.conversations.length})</div>`);
      data.conversations.slice(0, 20).forEach(c => {
        const bits = [relTime(c.updatedAt)];
        if (c.messages != null) bits.push(c.messages + ' messages');
        else if (c.bytes) bits.push(Math.round(c.bytes / 1024) + ' KB');
        const disabled = c.resumeByIndexOnly ? ' disabled title="This CLI resumes by position, not id"' : '';
        parts.push(`<div class="sess-row">
          <div class="sess-main">
            <div class="sess-label">${escHtml(c.label)}</div>
            <div class="sess-meta">${escHtml(bits.join(' · '))}</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-resume="${escHtml(c.id)}"${disabled} type="button">Resume</button>
          <button class="sess-del" data-delete="${escHtml(c.id)}" data-label="${escHtml(c.label)}" title="Delete this conversation" aria-label="Delete this conversation" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>
        </div>`);
      });
    }

    if (!parts.length) parts.push('<div class="sess-empty">Nothing to resume here yet.</div>');
    body.innerHTML = parts.join('');

    body.querySelectorAll('[data-switch]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.switch;
      closeSessionsModal();
      switchToSession(id);
    }));
    body.querySelectorAll('[data-resume]').forEach(b => b.addEventListener('click', () => {
      launchPending({ resume: b.dataset.resume });
    }));

    // Delete one conversation. Confirmed individually — it is not recoverable,
    // and the label is quoted back so it is obvious which one is going.
    body.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      const p = state._pendingLaunch;
      if (!p) return;
      const ok = await showConfirm(
        'Delete conversation',
        `Permanently delete "${b.dataset.label}" from ${p.cli}'s history for ${p.repo}?`,
        'This cannot be undone. Other conversations are left alone.',
        'Delete'
      );
      if (!ok) return;
      wsSend({ type: 'delete-conversations', cli: p.cli, repoPath: p.repoPath, ids: [b.dataset.delete] });
    }));

    $('#sessionsKillAll').classList.toggle('hidden', !data.running.length);
    $('#sessionsClearHistory').classList.toggle('hidden', !data.conversations.length);
    const note = $('#sessionsNote');
    note.classList.toggle('hidden', !data.note);
    note.textContent = data.note || '';
  }

  $('#sessionsClose')?.addEventListener('click', closeSessionsModal);
  $('#sessionsOverlay')?.addEventListener('click', closeSessionsModal);
  $('#sessionsStartFresh')?.addEventListener('click', () => launchPending());

  $('#sessionsKillAll')?.addEventListener('click', () => {
    const p = state._pendingLaunch;
    if (!p) return;
    // Killing happens server-side; the modal refreshes from the response.
    wsSend({ type: 'kill-sessions-for', cli: p.cli, repoPath: p.repoPath });
  });

  $('#sessionsClearHistory')?.addEventListener('click', async () => {
    const p = state._pendingLaunch;
    if (!p) return;
    const ok = await showConfirm(
      'Clear conversation history',
      `This permanently deletes ${p.cli}'s saved conversations for ${p.repo}. Running sessions are not affected.`,
      'This cannot be undone.',
      'Delete history'
    );
    if (!ok) return;
    wsSend({ type: 'clear-conversations-for', cli: p.cli, repoPath: p.repoPath });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sessionsModal && !sessionsModal.classList.contains('hidden')) {
      closeSessionsModal();
    }
  });

  _cliBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.selectedRepo || btn.disabled) return;
      // Codex with extra repos selected — the tooltip says why, and clicking
      // says it again for anyone who did not hover.
      if (btn.classList.contains('cli-unsupported')) {
        showToast(CODEX_NO_MULTI_REPO, 'error');
        return;
      }
      const cliId = btn.dataset.cli;
      const info = state.cliAvailability[cliId];
      if (info && !info.installed) {
        if (state.sessions.filter(s => !s.ended).length >= MAX_TABS) {
          alert(`Maximum ${MAX_TABS} sessions allowed. Close a tab first.`);
          return;
        }
        disableCliButtons();
        wsSend({
          type: 'create-session',
          cli: 'terminal',
          repo: state.selectedRepo.name,
          repoPath: state.selectedRepo.path,
          useWorktree: false
        });
        state._pendingInstallCmd = info.install;
        return;
      }
      // Ask what already exists first; the modal only appears if there is
      // something to offer, so the common path stays a single click.
      if (cliId !== 'terminal') {
        beginLaunch({
          cli: cliId,
          repo: state.selectedRepo.name,
          repoPath: state.selectedRepo.path,
          useWorktree: !!$('#useWorktree')?.checked
        });
        return;
      }
      if (state.sessions.filter(s => !s.ended).length >= MAX_TABS) {
        alert(`Maximum ${MAX_TABS} sessions allowed. Close a tab first.`);
        return;
      }
      disableCliButtons();
      const useWorktree = !!$('#useWorktree')?.checked;
      // Only the agent CLIs take extra directories — a plain terminal has no
      // notion of them, so none are sent.
      wsSend({
        type: 'create-session',
        cli: cliId,
        repo: state.selectedRepo.name,
        repoPath: state.selectedRepo.path,
        useWorktree
      });
    });
  });

  // PR Modal
  function openPrModal(sessionId) {
    state.prSessionId = sessionId;
    prError.classList.add('hidden');
    prSuccess.classList.add('hidden');
    prTitle.value = '';
    prDescription.value = '';
    prWorkItem.value = '';
    prTargetBranch.value = 'main';
    prModal.classList.remove('hidden');
    ws.send(JSON.stringify({ type: 'git-branch', sessionId }));
  }

  function closePrModal() {
    prModal.classList.add('hidden');
    state.prSessionId = null;
  }

  prModalClose.addEventListener('click', closePrModal);
  prCancelBtn.addEventListener('click', closePrModal);
  prModal.addEventListener('click', (e) => { if (e.target === prModal) closePrModal(); });

  prSubmitBtn.addEventListener('click', () => {
    if (!prTitle.value.trim()) {
      prError.textContent = 'Title is required';
      prError.classList.remove('hidden');
      return;
    }
    const sessionId = state.prSessionId || state.activeSessionId;
    if (!sessionId) return;

    const source = prSourceBranch.value.trim();
    const target = prTargetBranch.value.trim() || 'main';
    const title = prTitle.value.trim().replace(/"/g, '\\"');
    const desc = prDescription.value.trim().replace(/"/g, '\\"');
    const workItem = prWorkItem.value.trim();

    let prompt = `Build it, run all tests and then create PR using azure devops cli and give me pr link.`;
    prompt += ` Source branch: "${source}", target branch: "${target}", title: "${title}"`;
    if (desc) prompt += `, description: "${desc}"`;
    if (workItem) prompt += `, work item: ${workItem}`;
    prompt += '\r';

    sessionManager_writeToTerminal(sessionId, prompt);
    closePrModal();
  });

  function sessionManager_writeToTerminal(sessionId, text) {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: text }));
    state.lastInputTime[sessionId] = Date.now();
    const term = state.terminals[sessionId];
    if (term) term.focus();
  }

  // WebSocket messages
  function handleWsMessage(eventOrMsg) {
    const msg = eventOrMsg instanceof MessageEvent ? JSON.parse(eventOrMsg.data) : eventOrMsg;

    switch (msg.type) {
      case 'cli-availability': {
        state.cliAvailability = msg.cliStatus || {};
        _cliBtns.forEach(btn => {
          const cliId = btn.dataset.cli;
          const info = state.cliAvailability[cliId];
          if (info && !info.installed) {
            btn.classList.add('cli-not-installed');
            btn.title = `Not installed — click to install`;
          } else {
            btn.classList.remove('cli-not-installed');
            btn.title = '';
          }
        });
        // Re-apply the codex-with-extras rule, which the loop above just cleared.
        syncCodexButton();
        $$('.cli-install-card').forEach(card => {
          const cliId = card.dataset.cli;
          const info = state.cliAvailability[cliId];
          const statusEl = card.querySelector('[data-status]');
          const btn = card.querySelector('.cli-install-btn');
          if (card.dataset.installing === '1') return;
          if (info && info.installed) {
            statusEl.className = 'cli-install-status installed';
            statusEl.innerHTML = '<span class="cli-install-dot"></span>Installed';
            if (btn) { btn.disabled = false; btn.textContent = 'Reinstall'; }
          } else if (info) {
            statusEl.className = 'cli-install-status missing';
            statusEl.innerHTML = '<span class="cli-install-dot"></span>Not installed';
            if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
          }
        });
        break;
      }

      case 'install-cli-started': {
        const card = document.querySelector(`.cli-install-card[data-cli="${msg.cli}"]`);
        if (!card) break;
        card.dataset.installing = '1';
        const logEl = card.querySelector('[data-log]');
        if (logEl) {
          logEl.classList.remove('hidden');
          logEl.textContent = `$ ${msg.command}\n`;
        }
        break;
      }

      case 'install-cli-progress': {
        const card = document.querySelector(`.cli-install-card[data-cli="${msg.cli}"]`);
        if (!card) break;
        const logEl = card.querySelector('[data-log]');
        if (logEl) {
          const cleaned = (msg.data || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
          logEl.appendChild(document.createTextNode(cleaned));
          while (logEl.childNodes.length > 2000) logEl.removeChild(logEl.firstChild);
          logEl.scrollTop = logEl.scrollHeight;
        }
        break;
      }

      case 'install-cli-result': {
        const card = document.querySelector(`.cli-install-card[data-cli="${msg.cli}"]`);
        if (!card) break;
        delete card.dataset.installing;
        const statusEl = card.querySelector('[data-status]');
        const btn = card.querySelector('.cli-install-btn');
        const logEl = card.querySelector('[data-log]');
        if (msg.success) {
          if (statusEl) {
            statusEl.className = 'cli-install-status installed';
            statusEl.innerHTML = '<span class="cli-install-dot"></span>Installed';
          }
          if (btn) { btn.disabled = false; btn.textContent = 'Reinstall'; }
          showToast(`${msg.cli} installed`, 'success');
        } else {
          if (statusEl) {
            statusEl.className = 'cli-install-status failed';
            statusEl.innerHTML = '<span class="cli-install-dot"></span>Failed';
          }
          if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
          showToast(`Install failed: ${msg.message || msg.cli}`, 'error');
        }
        if (logEl && msg.message) {
          logEl.textContent += `\n${msg.message}\n`;
          logEl.scrollTop = logEl.scrollHeight;
        }
        state.cliAvailability = state.cliAvailability || {};
        state.cliAvailability[msg.cli] = { ...(state.cliAvailability[msg.cli] || {}), installed: !!msg.success };
        break;
      }

      case 'smartpill-tips': {
        state.smartpillTips = filterPilotTips(msg.tips || []);
        state.smartpillIdx = 0;
        if (state.smartpillTips.length > 0) showSmartpill(state.smartpillTips[0]);
        if (state._smartpillTimer) clearInterval(state._smartpillTimer);
        if (state.smartpillTips.length > 1) {
          state._smartpillTimer = setInterval(() => {
            state.smartpillIdx = (state.smartpillIdx + 1) % state.smartpillTips.length;
            showSmartpill(state.smartpillTips[state.smartpillIdx]);
          }, 10000);
        }
        break;
      }

      case 'smartpill-result': {
        showToast(msg.result, msg.success ? 'success' : 'error');
        break;
      }

      case 'scan-status': {
        const scanEl = document.getElementById('scanStatus');
        if (!scanEl) break;
        scanEl.classList.remove('hidden');
        const dotClass = msg.status === 'scanning' ? 'scanning' : 'done';
        const bold = msg.status === 'complete' || msg.status === 'cached';
        const line = document.createElement('div');
        line.className = 'scan-status-line';
        const dot = document.createElement('span');
        dot.className = 'scan-status-dot ' + dotClass;
        line.appendChild(dot);
        if (bold) {
          const strong = document.createElement('strong');
          strong.textContent = ' ' + msg.message;
          line.appendChild(strong);
        } else {
          line.appendChild(document.createTextNode(' ' + msg.message));
        }
        scanEl.appendChild(line);
        while (scanEl.children.length > 100) scanEl.firstChild.remove();
        scanEl.scrollTop = scanEl.scrollHeight;
        break;
      }

      case 'repo-info': {
        if (!msg.info) break;
        state.repoInfoCache = state.repoInfoCache || {};
        state.repoInfoCache[msg.repoPath] = msg.info;

        // Update repo card with tech tags -- query within repoGrid to narrow scope
        const allCards = repoGrid.querySelectorAll('.repo-card');
        allCards.forEach(card => {
          if (card._repoPath === msg.repoPath) {
            let techSpan = card.querySelector('.repo-card-tech');
            if (!techSpan) {
              techSpan = document.createElement('span');
              techSpan.className = 'repo-card-tech';
              card.appendChild(techSpan);
            }
            techSpan.textContent = (msg.info.technologies || []).join(' · ');
            const nameSpan = card.querySelector('.repo-card-name');
            if (nameSpan && !nameSpan.querySelector('.repo-card-meta-dot')) {
              const dot = document.createElement('span');
              dot.className = 'repo-card-meta-dot';
              nameSpan.appendChild(dot);
            }
          }
        });

        // Update the right info panel if this is the currently selected repo
        if (state.selectedRepo && state.selectedRepo.path === msg.repoPath) {
          populateRepoInfoPanel(msg.info);
          window.__lastRepoInfo = msg.info;
        }
        break;
      }

      // Which agents have already been let into each repo. Arrives after the
      // picker asks; re-render so rows stop saying "checking…", and drop any
      // already-picked repo that turns out to be unusable everywhere (its trust
      // could have been revoked between opens).
      case 'session-usage': {
        renderSessionUsage(msg);
        break;
      }

      case 'app-update': {
        window._catalystOnUpdateInfo?.(msg);
        break;
      }

      case 'app-update-install-result': {
        window._catalystOnUpdateInstall?.(msg);
        break;
      }

      case 'reveal-result': {
        if (!msg.ok) showToast(msg.message || 'Could not open the folder', 'error');
        break;
      }

      case 'repo-trust': {
        state.repoTrust = msg.trust || {};
        if (msg.enforced) state.trustEnforced = msg.enforced;
        const before = state.extraRepos.length;
        state.extraRepos = state.extraRepos.filter(r => agentsAccepting(r.path).length > 0);
        if (state.extraRepos.length !== before) renderExtraRepos();
        if (multiRepoModal && !multiRepoModal.classList.contains('hidden')) {
          renderMultiRepoList($('#multiRepoFilter')?.value || '');
        }
        updateExtraReposNote();
        break;
      }

      case 'repos': {
        const prevSelectedPath = state.selectedRepo ? state.selectedRepo.path : null;
        browseBtn.textContent = browseLabel;
        browseBtn.disabled = false;
        repoGrid.innerHTML = '';
        noRepos.classList.add('hidden');
        repoSection.classList.remove('hidden');
        if (!prevSelectedPath) {
          cliSection.classList.add('hidden');
          $('#repoCliLayout').classList.remove('has-selection');
          state.selectedRepo = null;
        }
        if (msg.rootDir) {
          state.rootDir = msg.rootDir;
          updateSidebarVisibility();
        }
        if (msg.repos.length === 0) {
          noRepos.classList.remove('hidden');
          welcomeScreen.classList.remove('has-repos');
          cliSection.classList.add('hidden');
          $('#repoCliLayout').classList.remove('has-selection');
          state.selectedRepo = null;
          return;
        }
        welcomeScreen.classList.add('has-repos');
        // Kept for the additional-repos picker, which needs the full list.
        state.allRepos = msg.repos;
        state.repoInfoCache = state.repoInfoCache || {};
        let metaCount = 0;
        msg.repos.forEach(r => {
          if (r.repoInfo) { state.repoInfoCache[r.path] = r.repoInfo; metaCount++; }
          const techText = r.repoInfo ? (r.repoInfo.technologies || []).join(' · ') : '';
          const hasMeta = !!r.repoInfo;
          const card = document.createElement('div');
          card.className = 'repo-card';
          card._repoPath = r.path;
          if (prevSelectedPath && r.path === prevSelectedPath) {
            card.classList.add('selected');
            state.selectedRepo = r;
          }
          const ri = r.repoInfo || {};
          const branchStr = ri.branch ? `<span class="repo-card-branch">⑂ ${escHtml(ri.branch)}</span>` : '';
          const changesStr = ri.changes ? `<span class="repo-card-changes">${Number(ri.changes) || 0} changes</span>` : '';
          const timeStr = ri.lastCommit ? `<span class="repo-card-time">${escHtml(ri.lastCommit)}</span>` : '';
          card.innerHTML = `<span class="repo-card-name">${escHtml(r.name)}${hasMeta ? ' <span class="repo-card-meta-dot"></span>' : ''}</span><span class="repo-card-tech">${escHtml(techText)}</span><div class="repo-card-footer">${branchStr}${changesStr}<span class="repo-card-spacer"></span>${timeStr}</div>`;
          card.addEventListener('click', () => {
            repoGrid.querySelectorAll('.repo-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            const changedPrimary = !state.selectedRepo || state.selectedRepo.path !== r.path;
            state.selectedRepo = r;
            // Extras belong to a particular primary; keeping them across a
            // change would silently hand the agent the wrong set.
            if (changedPrimary) clearExtraRepos();
            $('#repoCliLayout').classList.add('has-selection');
            setTimeout(() => {
              const grid = document.getElementById('repoGrid');
              const cardTop = card.offsetTop - grid.offsetTop;
              const gridHeight = grid.clientHeight;
              const cardHeight = card.offsetHeight;
              const targetScroll = cardTop - (gridHeight / 2) + (cardHeight / 2);
              grid.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
            }, 500);
            cliSection.classList.remove('hidden');
            if (Date.now() - _lastCliAvailabilityCheck > 60000) {
              _lastCliAvailabilityCheck = Date.now();
              wsSend({ type: 'check-cli-availability' });
            }
            $('#repoInfoName').textContent = r.name;
            $('#repoInfoDesc').textContent = '';
            $('#repoInfoTags').innerHTML = '';
            if (r.repoInfo) {
              populateRepoInfoPanel(r.repoInfo);
              window.__lastRepoInfo = r.repoInfo;
            }
            wsSend({ type: 'scan-repo-info', repoPath: r.path });
          });
          repoGrid.appendChild(card);
        });
        if (prevSelectedPath && !state.selectedRepo) {
          cliSection.classList.add('hidden');
          $('#repoCliLayout').classList.remove('has-selection');
        }
        console.log(`[repos] Created ${msg.repos.length} cards, ${metaCount} with metadata`);
        break;
      }

      case 'sessions-for': {
        // Only act on the answer to the launch we are actually waiting on. The
        // kill and clear handlers re-ask for their own repo, so an unmatched
        // reply could otherwise launch a pending session with no dialog at all.
        const pending = state._pendingLaunch;
        if (!pending || msg.cli !== pending.cli || !samePathish(msg.repoPath, pending.repoPath)) break;
        // Nothing worth interrupting for — launch straight away.
        if (!msg.running.length && !msg.conversations.length) {
          launchPending();
          break;
        }
        renderSessionsModal(msg);
        sessionsModal.classList.remove('hidden');
        sessionsModal.classList.add('flex');
        break;
      }

      case 'sessions-killed': {
        // Re-ask so the modal reflects what is left.
        if (state._pendingLaunch) {
          wsSend({ type: 'list-sessions-for', cli: msg.cli, repoPath: msg.repoPath });
        }
        break;
      }

      case 'conversations-cleared': {
        if (msg.errors && msg.errors.length) {
          alert('Some history could not be deleted:\n' + msg.errors.join('\n'));
        }
        if (state._pendingLaunch) {
          wsSend({ type: 'list-sessions-for', cli: msg.cli, repoPath: msg.repoPath });
        }
        break;
      }

      case 'session-created': {
        enableCliButtons();
        const session = { id: msg.id, cli: msg.cli, repo: msg.repo, repoPath: msg.repoPath, ended: false, worktreePath: msg.worktreePath || null, worktreeBranch: msg.worktreeBranch || null, extraDirs: msg.extraDirs || [] };
        state.sessions.push(session);
        state.sessionStatus[msg.id] = 'idle';
        state.sessionStartTime[msg.id] = Date.now();
        if (window._catalystPushRecent && msg.repo && msg.cli !== 'terminal') {
          window._catalystPushRecent({ name: msg.repo, path: msg.repoPath }, msg.cli);
          if (window._catalystRenderRecent) window._catalystRenderRecent();
        }
        updateSidebarVisibility();
        switchToSession(msg.id);
        ws.send(JSON.stringify({ type: 'get-repo-settings', repoPath: msg.repoPath }));
        if (state._pendingInstallCmd) {
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'input', sessionId: msg.id, data: state._pendingInstallCmd + '\r' }));
            state._pendingInstallCmd = null;
          }, 500);
        }
        break;
      }

      case 'session-list': {
        // On reconnect, remove sessions that no longer exist on server
        const serverIds = new Set(msg.sessions.map(s => s.id));
        state.sessions.filter(s => !serverIds.has(s.id)).forEach(s => removeSessionUI(s.id));

        msg.sessions.forEach(s => {
          if (!state.sessions.find(x => x.id === s.id)) {
            state.sessions.push({ ...s, ended: false });
            state.sessionStatus[s.id] = 'idle';
            // The server knows when it started; without this a session restored
            // on reconnect reported "started 0m ago" for the rest of its life.
            if (s.startedAt) state.sessionStartTime[s.id] = s.startedAt;
            ensureChatPanel(s.id);
            ws.send(JSON.stringify({ type: 'get-history', sessionId: s.id }));
          }
        });

        // Auto-launch pinned tabs that aren't already running
        if (!state._pinnedLaunched) {
          state._pinnedLaunched = true;
          const pins = getPinnedTabs();
          let running = state.sessions.filter(s => !s.ended).length;
          pins.forEach(p => {
            if (running >= MAX_TABS) return;
            const alreadyRunning = state.sessions.some(s => s.repoPath === p.repoPath && s.cli === p.cli && !s.ended);
            if (!alreadyRunning) {
              ws.send(JSON.stringify({
                type: 'create-session',
                cli: p.cli,
                repo: p.repo,
                repoPath: p.repoPath,
                useWorktree: false
              }));
              running++;
            }
          });
        }

        renderSessions();
        updateSidebarVisibility();
        if (state.sessions.length > 0 && !state.activeSessionId) {
          const saved = localStorage.getItem('catalyst-active-session');
          const target = state.sessions.find(s => s.id === saved) || state.sessions[0];
          switchToSession(target.id);
        }
        break;
      }

      case 'reconnect-buffer': {
        ensureChatPanel(msg.sessionId);
        const term = state.terminals[msg.sessionId];
        if (term && msg.data) term.write(msg.data);
        break;
      }

      case 'root-dir': {
        state.rootDir = msg.rootDir;
        folderInput.value = msg.rootDir;
        updateSidebarVisibility();
        const hasCards = repoGrid && repoGrid.children.length > 0;
        if (msg.rootDir && state.sessions.length === 0 && !hasCards) {
          browseBtn.textContent = 'Scanning…';
          browseBtn.disabled = true;
          wsSend({ type: 'list-repos', rootDir: msg.rootDir });
        }
        break;
      }

      case 'output': {
        ensureChatPanel(msg.sessionId);
        const term = state.terminals[msg.sessionId];
        if (term) term.write(msg.data);
        detectStatus(msg.sessionId, msg.data);
        detectPrUrl(msg.sessionId, msg.data);
        if (msg.sessionId === state.activeSessionId) {
          clearTimeout(state._changesRefreshTimer);
          state._changesRefreshTimer = setTimeout(() => {
            ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: state.activeSessionId }));
            if (changesViewMode === 'all') {
              ws.send(JSON.stringify({ type: 'git-all-files', sessionId: state.activeSessionId }));
            }
          }, 2000);
        }
        break;
      }

      case 'history': {
        if (msg.data) {
          const term = state.terminals[msg.sessionId];
          if (term) term.write(msg.data);
        }
        break;
      }

      case 'session-ended': {
        const s = state.sessions.find(x => x.id === msg.sessionId);
        if (s) s.ended = true;
        state.sessionStatus[msg.sessionId] = 'done';
        if (msg.sessionId !== state.activeSessionId) state.tabNotify.add(msg.sessionId);
        const term = state.terminals[msg.sessionId];
        if (term) term.write(`\r\n\x1b[90mProcess exited with code ${msg.exitCode}\x1b[0m\r\n`);
        notify('Catalyst', `${s ? s.repo : 'Session'} exited (code ${msg.exitCode})`);
        renderSessions();
        break;
      }

      case 'session-killed': {
        removeSessionUI(msg.sessionId);
        break;
      }

      case 'error': {
        folderError.textContent = msg.message;
        folderError.classList.remove('hidden');
        browseBtn.textContent = browseLabel;
        browseBtn.disabled = false;
        break;
      }

      case 'folder-selected': {
        state._browsing = false;
        if (msg.path) {
          if (state._settingsBrowse) {
            settingsRootInput.value = msg.path;
            state._settingsBrowse = false;
          } else {
            folderInput.value = msg.path;
            folderError.classList.add('hidden');
            ws.send(JSON.stringify({ type: 'list-repos', rootDir: msg.path }));
          }
        } else {
          state._settingsBrowse = false;
          browseBtn.textContent = browseLabel;
          browseBtn.disabled = false;
        }
        break;
      }

      case 'settings': {
        if (msg.settings) {
          azureUrl.value = msg.settings.azureUrl || '';
          if (azureUrl.value) azureUrl.dispatchEvent(new Event('input'));
          if (githubOrg) githubOrg.value = msg.settings.githubOrg || '';
          const savedProvider = msg.settings.provider;
          if (savedProvider === 'github' || savedProvider === 'azure' || savedProvider === 'none') {
            setIntegProvider(savedProvider);
          }
          // Strict compare so a missing or malformed value stays off.
          // On by default: only an explicit false unticks it, so a settings file
          // written before this setting existed still shows the default. Must
          // match AUTO_UPDATE_DEFAULT in src-tauri/src/lib.rs, which is what
          // actually decides whether the startup install runs.
          if (autoUpdateToggle) autoUpdateToggle.checked = msg.settings.autoUpdate !== false;
        }
        const patStatus = $('#patStatus');
        if (msg.hasPat) {
          patStatus.textContent = 'PAT is stored securely in Windows Credential Manager';
          patStatus.className = 'ob-field-hint success';
          azurePat.placeholder = 'PAT stored — enter new value to update';
        } else {
          patStatus.textContent = 'No PAT configured';
          patStatus.className = 'ob-field-hint';
        }
        if (ghPatStatus) {
          if (msg.hasGithubPat) {
            ghPatStatus.textContent = 'GitHub PAT is stored securely in Windows Credential Manager';
            ghPatStatus.className = 'ob-field-hint success';
            if (githubPat) githubPat.placeholder = 'PAT stored — enter new value to update';
          } else {
            ghPatStatus.textContent = 'Needs repo scope — used for PRs, issues, and status checks';
            ghPatStatus.className = 'ob-field-hint';
          }
        }
        break;
      }

      case 'settings-saved': {
        azureSaveHint.textContent = 'Settings saved · verifying PAT…';
        azureSaveHint.className = 'settings-hint';
        if (msg.provider === 'github') {
          if (githubPat) githubPat.value = '';
          if (msg.hasGithubPat && ghPatStatus) {
            ghPatStatus.textContent = 'GitHub PAT is stored securely in Windows Credential Manager';
            ghPatStatus.className = 'ob-field-hint success';
            if (githubPat) githubPat.placeholder = 'PAT stored — enter new value to update';
          }
        } else if (msg.provider === 'azure') {
          azurePat.value = '';
          if (msg.hasPat) {
            $('#patStatus').textContent = 'PAT is stored securely in Windows Credential Manager';
            $('#patStatus').className = 'ob-field-hint success';
            azurePat.placeholder = 'PAT stored — enter new value to update';
          }
        }
        break;
      }

      case 'reset-complete': {
        if (msg.success) {
          showToast('Catalyst reset — reloading…', 'success');
          setTimeout(() => location.reload(), 600);
        } else {
          if (resetHint) {
            resetHint.textContent = 'Reset had errors: ' + (msg.errors || []).join('; ');
            resetHint.className = 'settings-hint error';
          }
          if (resetCatalystBtn) resetCatalystBtn.disabled = false;
        }
        break;
      }

      case 'pat-verified': {
        if (msg.success) {
          azureSaveHint.textContent = msg.message || 'PAT verified';
          azureSaveHint.className = 'settings-hint success';
          const target = msg.provider === 'github' ? ghPatStatus : $('#patStatus');
          if (target) {
            target.textContent = msg.message || 'Verified';
            target.className = 'ob-field-hint success';
          }
        } else {
          azureSaveHint.textContent = 'PAT verification failed';
          azureSaveHint.className = 'settings-hint error';
          const target = msg.provider === 'github' ? ghPatStatus : $('#patStatus');
          if (target) {
            target.textContent = msg.message || 'PAT could not be verified';
            target.className = 'ob-field-hint error';
          }
          showToast(msg.message || 'PAT verification failed', 'error');
        }
        setTimeout(() => { if (azureSaveHint.textContent === (msg.message || '')) azureSaveHint.textContent = ''; }, 6000);
        break;
      }

      case 'git-pull-result':
      case 'git-push-result': {
        const action = msg.type === 'git-pull-result' ? 'Pull' : 'Push';
        const detail = (msg.data || '').trim().split('\n')[0];
        if (msg.success) {
          showToast(`${action} successful: ${detail}`, 'success');
        } else {
          showToast(`${action} failed: ${detail}`, 'error');
        }
        break;
      }

      case 'git-branch-result': {
        prSourceBranch.value = msg.branch || 'unknown';
        break;
      }

      case 'pr-result': {
        prSubmitBtn.disabled = false;
        prSubmitBtn.textContent = 'Run in Terminal';
        if (msg.success) {
          prSuccess.textContent = 'PR created: ';
          const prLink = document.createElement('a');
          if (/^https?:\/\//i.test(msg.prUrl)) prLink.href = msg.prUrl;
          prLink.target = '_blank';
          prLink.style.color = 'var(--accent)';
          prLink.textContent = '#' + msg.prId;
          prSuccess.appendChild(prLink);
          prSuccess.classList.remove('hidden');
          prError.classList.add('hidden');
        } else {
          prError.textContent = msg.error;
          prError.classList.remove('hidden');
          prSuccess.classList.add('hidden');
        }
        break;
      }

      case 'image-saved': {
        showToast('Image pasted', 'success');
        break;
      }
    }
  };

  updateSidebarVisibility();

  // Global image paste fallback
  document.addEventListener('paste', (e) => {
    if (!state.activeSessionId) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => {
          ws.send(JSON.stringify({ type: 'paste-image', sessionId: state.activeSessionId, data: reader.result }));
          const term = state.terminals[state.activeSessionId];
          if (term) term.write('\r\n\x1b[90mImage pasted — path sent to CLI\x1b[0m\r\n');
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  });

  // Right panel
  const rightPanel = $('#rightPanel');
  const scriptList = $('#scriptList');
  const branchDisplay = $('#branchDisplay');
  const customCmdInput = $('#customCmdInput');
  const customCmdRun = $('#customCmdRun');
  const cmdOutputContainer = $('#cmdOutputContainer');
  const projectTypeLabel = $('#projectTypeLabel');

  const cmdTerminals = {};
  let recentRunCount = 0;

  function updateRecentRunsCount() {
    const el = $('#recentRunsCount');
    if (el) el.textContent = String(recentRunCount);
  }

  function clearRecentRuns() {
    Object.keys(cmdTerminals).forEach(id => {
      try { cmdTerminals[id].dispose(); } catch {}
      delete cmdTerminals[id];
    });
    if (cmdOutputContainer) cmdOutputContainer.innerHTML = '';
    recentRunCount = 0;
    updateRecentRunsCount();
  }

  // Right panel tab switching — cache NodeLists
  const _rpTabs = $$('.rp-tab');
  const _rpPages = $$('.rp-page');
  _rpTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      _rpTabs.forEach(t => t.classList.remove('active'));
      _rpPages.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const page = $('#' + tab.dataset.rpTab);
      if (page) page.classList.add('active');
      if (tab.dataset.rpTab === 'rpPageManage') {
        updateManageInfo();
      }
      if (tab.dataset.rpTab === 'rpPageExplorer') {
        loadExplorerFiles();
      }
    });
  });

  // ─── Per-CLI capabilities ─────────────────────────────────────────────
  // Every Manage control used to be applied to all three CLIs, so two thirds of
  // this panel typed commands that do not exist: Codex has no /effort and no
  // /compact, Gemini has no /model and no /permissions, and a command a CLI does
  // not know is not rejected — it lands in the prompt as literal text. One table
  // drives both the gating below and the guard in sendToActiveSession, so a
  // control cannot drift out of step with what its CLI understands.
  const CLI_CAPS = {
    claude: { model: '/model', effort: '/effort', compact: '/compact', perm: '/permissions', permLabel: 'Permissions…' },
    codex: { model: '/model', effort: null, compact: null, perm: '/approvals', permLabel: 'Approvals…' },
    gemini: { model: null, effort: null, compact: '/compress', perm: null, permLabel: null }
  };

  function capsFor(cli) {
    return CLI_CAPS[cli] || CLI_CAPS.claude;
  }

  function cliDisplayName(cli) {
    const name = (cli || '').charAt(0).toUpperCase() + (cli || '').slice(1);
    return cli === 'claude' ? name + ' Code' : name;
  }

  // Controls a CLI has no command for are hidden rather than left inert. Compact
  // is the exception: it sits in a four-button grid whose layout would break if
  // one went missing, so it stays put, disabled, and says why.
  function gateManageControls(cli) {
    const caps = capsFor(cli);
    const name = cliDisplayName(cli);
    const modelField = $('#manageModelField');
    const effortField = $('#manageEffortField');
    const permField = $('#managePermField');
    if (modelField) modelField.style.display = caps.model ? '' : 'none';
    if (effortField) effortField.style.display = caps.effort ? '' : 'none';
    if (permField) permField.style.display = caps.perm ? '' : 'none';
    // Gemini supports none of the three, which would leave a section heading over
    // nothing at all.
    const section = $('#manageBehaviorSection');
    if (section) section.style.display = (caps.model || caps.effort || caps.perm) ? '' : 'none';

    const permBtn = $('#managePermBtn');
    if (permBtn && caps.perm) {
      permBtn.textContent = caps.permLabel;
      permBtn.title = `Opens ${name}'s own ${caps.perm} editor in the terminal — Catalyst cannot read back which mode you choose, so nothing here is highlighted`;
    }

    const compactBtn = $('#manageCompactBtn');
    if (compactBtn) {
      compactBtn.disabled = !caps.compact;
      compactBtn.title = caps.compact
        ? `Compact context (${caps.compact})`
        : `${name} has no compact command`;
    }

    // Only Claude Code says "saved as your default for new sessions" when you
    // change these, so only Claude Code gets warned about it.
    const hint = $('#manageDefaultsHint');
    if (hint) {
      hint.textContent = cli === 'claude'
        ? 'Model and Effort are saved as your defaults for new sessions, not just this one.'
        : '';
    }
    return caps;
  }

  function updateManageInfo() {
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (!session) return;
    const startTime = state.sessionStartTime[session.id];
    const elapsed = startTime ? Math.floor((Date.now() - startTime) / 60000) : 0;
    const nameEl = $('#manageCliName');
    const metaEl = $('#manageCliMeta');
    const iconEl = $('#manageCliIcon');
    const dotEl = $('#manageStatusDot');
    if (nameEl) nameEl.textContent = cliDisplayName(session.cli);
    if (metaEl) metaEl.textContent = `· started ${elapsed}m ago`;
    if (iconEl) iconEl.innerHTML = cliIcons[session.cli] || '';
    if (dotEl) dotEl.style.background = session.ended ? 'var(--error, #f87171)' : 'var(--success, #34d399)';
    gateManageControls(session.cli);
    requestSessionUsage();
  }

  // ─── Context & cost ───────────────────────────────────────────────────
  // These four elements existed in the markup with nothing behind them, so the
  // panel read "CONTEXT — / —" forever. The server reads the CLI's own
  // transcript (lib/session-usage.js) — its own token accounting, not a guess
  // scraped off the screen — and this renders it.
  const manageContextText = $('#manageContextText');
  const manageContextBar = $('#manageContextBar');
  const manageContextPct = $('#manageContextPct');
  const manageSessionCost = $('#manageSessionCost');
  const manageToolStats = $('#manageToolStats');
  const manageReads = $('#manageReads');
  const manageWrites = $('#manageWrites');
  const manageCommands = $('#manageCommands');

  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K';
    return String(n);
  }

  function requestSessionUsage() {
    if (!state.activeSessionId) return;
    wsSend({ type: 'session-usage', sessionId: state.activeSessionId });
  }

  // Reads / Writes / Commands. These used to be counted by matching tool names in
  // the PTY stream, which meant counting the same tool call again on every TUI
  // repaint — a fresh session showed COMMANDS 1 before anything had run, and
  // opening a modal took it to 17 — and counted nothing at all for codex and
  // gemini, whose output says none of those words. They now come from the same
  // transcript as context and cost, where each call is recorded once.
  function renderToolStats(msg) {
    if (!manageReads) return;
    const tools = msg.available && msg.tools;
    manageReads.textContent = tools ? tools.reads : '—';
    manageWrites.textContent = tools ? tools.writes : '—';
    manageCommands.textContent = tools ? tools.commands : '—';
    if (manageToolStats) {
      manageToolStats.title = tools
        ? 'Tool calls recorded in this conversation'
          + (msg.costPartial ? ' — transcript truncated, earlier calls not counted' : '')
        : (msg.reason || '');
    }
  }

  function renderSessionUsage(msg) {
    // A late reply for a session the user has already switched away from.
    if (!msg || msg.sessionId !== state.activeSessionId) return;
    if (!manageContextText) return;

    renderToolStats(msg);

    if (!msg.available) {
      manageContextText.textContent = '—';
      manageContextText.title = msg.reason || '';
      if (manageContextBar) manageContextBar.style.width = '0%';
      if (manageContextPct) { manageContextPct.textContent = msg.reason || '—'; manageContextPct.title = ''; }
      if (manageSessionCost) { manageSessionCost.textContent = '—'; manageSessionCost.title = ''; }
      return;
    }

    manageContextText.textContent = `${fmtTokens(msg.contextTokens)} / ${fmtTokens(msg.contextWindow)}`;
    manageContextText.title = `${msg.contextTokens.toLocaleString()} tokens in the prompt of the most recent turn`
      + (msg.model ? ` · ${msg.model}` : '');
    if (manageContextBar) manageContextBar.style.width = Math.max(1, Math.round(msg.percent)) + '%';
    if (manageContextPct) manageContextPct.textContent = Math.round(msg.percent) + '% used';
    if (manageSessionCost) {
      const cost = msg.costUSD;
      manageSessionCost.textContent = '~$' + (cost < 1 ? cost.toFixed(3) : cost.toFixed(2));
      // Say why it is approximate rather than presenting it as a bill.
      const notes = [`${msg.turns} model turns, priced from published rates`];
      if (msg.costPartial) notes.push('transcript truncated — earlier turns not counted');
      if (msg.pricingGuessed) notes.push(`rates for ${msg.model || 'this model'} are not known, Opus rates assumed`);
      manageSessionCost.title = notes.join(' · ');
    }

    syncManageControls(msg);
  }

  // The Model and Effort controls used to show whatever the markup defaulted to —
  // "Opus · most capable" and High — even when the CLI was running Sonnet at low
  // effort, because nothing ever read the session's real state back. The
  // transcript records both per turn, so reflect that (and keep reflecting it
  // when the user changes either inside the terminal).
  function syncManageControls(msg) {
    // A field the active CLI does not support is hidden, and populating it would
    // only re-light controls the gating just took away. Usage is claude-only
    // today, so this is belt and braces — but it is what keeps the two honest.
    const shown = (field) => {
      const el = $(field);
      return el && el.style.display !== 'none';
    };
    const sel = shown('#manageModelField') ? $('#manageModel') : null;
    if (sel && msg.modelFamily) {
      const match = [...sel.options].find(o => o.value === msg.modelFamily);
      // Assigning .value does not fire 'change', so this cannot loop back into
      // sending a /model command.
      if (match) sel.value = match.value;
      // A disabled select already carries the reason it cannot be used; don't
      // replace that with a state the user cannot act on.
      // The transcript names the model of the most recent recorded turn, which is
      // all we can honestly claim: on a resumed conversation the newest turn may
      // predate this session, and the CLI can be switched mid-session.
      if (!sel.disabled) sel.title = msg.model ? `Last turn ran on ${msg.model}` : '';
    }
    if (msg.effort && shown('#manageEffortField')) {
      const btns = $$('.manage-btn[data-effort]');
      if (btns.length) {
        const known = [...btns].some(b => b.dataset.effort === msg.effort);
        btns.forEach(b => b.classList.toggle('active', b.dataset.effort === msg.effort));
        // Same caveat as the model above — and an effort the buttons don't offer
        // (xhigh, max) would otherwise leave every button unlit with no
        // explanation at all.
        const row = btns[0].parentElement;
        if (row) row.title = `Last turn ran at ${msg.effort} effort` + (known ? '' : ' — no button for that level');
      }
    }
  }

  // Which CLIs know each slash command the panel can send. Checked here rather
  // than at each call site, because a call site is exactly the place that forgets.
  const SLASH_SUPPORT = {
    '/model': ['claude', 'codex'],
    '/effort': ['claude'],
    '/compact': ['claude'],
    '/compress': ['gemini'],
    '/permissions': ['claude'],
    '/approvals': ['codex']
  };

  // Send a live slash command to the active CLI. The terminal is always visible in
  // the center, so the effect shows there; toast confirms it fired even while the
  // Manage panel has focus. Pass the command without a trailing carriage return —
  // the Enter is a separate keystroke, see below.
  function sendToActiveSession(command, toastMsg) {
    const sessionId = state.activeSessionId;
    if (!sessionId) { showToast('No active session', 'info'); return false; }
    const session = state.sessions.find(s => s.id === sessionId);
    const slash = (command.match(/^\/[a-z-]+/i) || [])[0];
    const supported = slash && SLASH_SUPPORT[slash];
    if (session && supported && !supported.includes(session.cli)) {
      // An unknown slash command is not refused by the CLI, it is accepted as
      // prompt text — so refusing here is the only thing standing between the
      // user and a stray "/effort high" in their next message.
      showToast(`${cliDisplayName(session.cli)} has no ${slash} command`, 'info');
      return false;
    }
    // The CLI's slash-command autocomplete swallows the Enter that arrives in the
    // same PTY write as the command text, which is how one click on Compact
    // produced two /compact lines. Send the body, then Enter as a fresh key —
    // the same split sendPromptToClaude already uses for prompts.
    ws.send(JSON.stringify({ type: 'input', sessionId, data: command }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'input', sessionId, data: '\r' }));
    }, 350);
    // Goes through the same watcher as typing, so a /clear sent from the UI
    // relabels the tab exactly as a typed one does.
    watchForClear(sessionId, command);
    if (toastMsg) showToast(toastMsg, 'info');
    return true;
  }

  // Wire up Model & Behavior controls — these type the equivalent slash command
  // into the running CLI, for the CLIs that have one.
  $$('.manage-btn[data-effort]').forEach(btn => {
    btn.addEventListener('click', () => {
      const eff = btn.dataset.effort;
      if (!sendToActiveSession('/effort ' + eff, 'Sent /effort ' + eff)) return;
      $$('.manage-btn[data-effort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // /permissions and /approvals take no argument — they open the CLI's own rule
  // editor. So this is a launcher, and nothing here is marked active: the mode the
  // user picks inside that editor is never reported back, and lighting a button
  // would be asserting a state Catalyst cannot know.
  $('#managePermBtn')?.addEventListener('click', () => {
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (!session) { showToast('No active session', 'info'); return; }
    const cmd = capsFor(session.cli).perm;
    if (!cmd) { showToast(`${cliDisplayName(session.cli)} has no permission editor`, 'info'); return; }
    sendToActiveSession(cmd, 'Opened ' + cmd + ' in the terminal');
  });
  // Dynamic model list for the Manage → Model dropdown, fetched per active CLI.
  let _modelListForCli = null;
  function requestModelList(cli) {
    _modelListForCli = cli || 'claude';
    wsSend({ type: 'list-models', cli: _modelListForCli });
  }
  function populateModelDropdown(cli, models) {
    const sel = $('#manageModel');
    if (!sel) return;
    // Ignore a late response for a CLI we're no longer showing.
    if (_modelListForCli && cli !== _modelListForCli) return;
    const prev = sel.value;
    sel.innerHTML = '';
    // The first real option would otherwise sit there asserting a model: a fresh
    // session shows "Opus" while the CLI banner says Sonnet, because nothing knows
    // better yet. Claude Code's transcript fills this in on the first response
    // (syncManageControls); codex and gemini never report back, so it stays.
    const unknown = document.createElement('option');
    unknown.value = '';
    unknown.textContent = 'Current model — unknown';
    sel.appendChild(unknown);
    (models || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      sel.appendChild(opt);
    });
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    // A select with one option can never fire 'change', and an empty value is
    // never sent, so a list that thin is a control the user cannot operate. Say so
    // instead of leaving it looking live.
    const usable = [...sel.options].filter(o => o.value).length;
    sel.disabled = usable < 2;
    if (sel.disabled) {
      sel.title = `Only one model is known for ${cliDisplayName(cli)}, so there is nothing to switch to`;
    }
  }

  // Model selection — send the equivalent /model command for any non-empty value.
  $('#manageModel')?.addEventListener('change', (e) => {
    const model = e.target.value;
    if (model) {
      const label = e.target.selectedOptions[0]?.textContent || model;
      sendToActiveSession('/model ' + model, 'Switched model → ' + label);
    }
  });

  // Compact (live slash command) / Restart + Export (real server actions)
  $('#manageCompactBtn')?.addEventListener('click', () => {
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (!session) { showToast('No active session', 'info'); return; }
    const cmd = capsFor(session.cli).compact;
    if (!cmd) { showToast(`${cliDisplayName(session.cli)} has no compact command`, 'info'); return; }
    sendToActiveSession(cmd, 'Compacting context…');
  });
  $('#manageRestartBtn')?.addEventListener('click', () => {
    if (!state.activeSessionId) { showToast('No active session', 'info'); return; }
    showToast('Restarting session…', 'info');
    ws.send(JSON.stringify({ type: 'restart-session', sessionId: state.activeSessionId }));
  });
  $('#manageExportBtn')?.addEventListener('click', () => {
    if (!state.activeSessionId) { showToast('No active session', 'info'); return; }
    ws.send(JSON.stringify({ type: 'export-session', sessionId: state.activeSessionId }));
  });

  // Repo settings. The Manage panel used to carry a copy of this form; it was
  // removed from the markup, and everything that fed it — the element lookups, the
  // form population, and the two requests fired on every MANAGE tab click — went
  // on running against elements that were not there. The repo setup modal and the
  // run-config dialog are the live consumers now.
  state.repoSettings = {};

  const projectTypeDefaults = {
    'Web':              { build: 'dotnet build',   run: 'dotnet run' },
    'API':              { build: 'dotnet build',   run: 'dotnet run' },
    'Azure Functions':  { build: 'dotnet build',   run: 'func start' },
    'Console':          { build: 'dotnet build',   run: 'dotnet run' },
    'Library':          { build: 'dotnet build',   run: '' },
    'Worker Service':   { build: 'dotnet build',   run: 'dotnet run' },
    'Node':             { build: 'npm run build',  run: 'npm start' },
    'Python':           { build: '',               run: 'python main.py' },
    'Go':               { build: 'go build ./...', run: 'go run .' },
    'Rust':             { build: 'cargo build',    run: 'cargo run' },
  };

  function applyProjectTypeDefaults(typeValue, buildInput, runInput) {
    const defaults = projectTypeDefaults[typeValue];
    if (defaults) {
      buildInput.value = defaults.build;
      runInput.value = defaults.run;
    }
  }

  $('#setupProjectType').addEventListener('change', (e) => {
    applyProjectTypeDefaults(e.target.value, $('#setupBuildCmd'), $('#setupRunCmd'));
  });

  function populateFolderSelect(selectEl, folders, selected) {
    selectEl.innerHTML = '';
    (folders || ['/ (root)']).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f === '/ (root)' ? '' : f;
      opt.textContent = f;
      selectEl.appendChild(opt);
    });
    selectEl.value = selected || '';
  }

  // First-time repo setup modal
  const repoSetupModal = $('#repoSetupModal');
  const repoSetupOverlay = $('#repoSetupOverlay');
  const repoSetupSkip = $('#repoSetupSkip');
  const repoSetupSkipBtn = $('#repoSetupSkipBtn');
  const repoSetupSaveBtn = $('#repoSetupSaveBtn');
  let repoSetupTarget = null;

  function showRepoSetup(repoPath) {
    repoSetupTarget = repoPath;
    $('#setupProjectType').value = 'API';
    $('#setupBuildFolder').innerHTML = '<option value="">/ (root)</option>';
    applyProjectTypeDefaults('API', $('#setupBuildCmd'), $('#setupRunCmd'));
    repoSetupModal.classList.remove('hidden');
    repoSetupModal.classList.add('flex');
    state._setupFolderTarget = 'setup';
    ws.send(JSON.stringify({ type: 'list-repo-folders', repoPath }));
  }

  function closeRepoSetup() {
    repoSetupModal.classList.add('hidden');
    repoSetupModal.classList.remove('flex');
    repoSetupTarget = null;
  }

  repoSetupSkip.addEventListener('click', closeRepoSetup);
  repoSetupSkipBtn.addEventListener('click', () => {
    if (repoSetupTarget) {
      ws.send(JSON.stringify({ type: 'save-repo-settings', repoPath: repoSetupTarget, settings: { projectType: '', buildFolder: '', buildCmd: '', runCmd: '', _skipped: true } }));
    }
    closeRepoSetup();
  });
  repoSetupOverlay.addEventListener('click', closeRepoSetup);

  repoSetupSaveBtn.addEventListener('click', () => {
    if (!repoSetupTarget) return;
    const settings = {
      projectType: $('#setupProjectType').value,
      buildFolder: $('#setupBuildFolder').value.trim(),
      buildCmd: $('#setupBuildCmd').value.trim(),
      runCmd: $('#setupRunCmd').value.trim()
    };
    ws.send(JSON.stringify({ type: 'save-repo-settings', repoPath: repoSetupTarget, settings }));
    state.repoSettings[repoSetupTarget] = settings;
    closeRepoSetup();
  });

  // ── Run Configurations ────────────────────────────────────────────────
  // A repo can hold multiple named run configs (e.g. Frontend + Backend),
  // each with its own folder + build/run commands, stored in repo settings as
  // `runConfigs`. Designed loosely so configs are added/run independently.
  const runConfigModal = $('#runConfigModal');
  const runConfigOverlay = $('#runConfigOverlay');
  const runConfigListView = $('#runConfigListView');
  const runConfigFormView = $('#runConfigFormView');
  const runConfigList = $('#runConfigList');
  const runConfigEmpty = $('#runConfigEmpty');
  let _rcEditingId = null;

  function _genId() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'rc-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function getRunConfigs(repoPath) {
    const s = state.repoSettings[repoPath] || {};
    let configs = Array.isArray(s.runConfigs) ? s.runConfigs.slice() : [];
    // Migrate a legacy single config (old Setup Repo flow) so it isn't lost.
    if (!configs.length && (s.runCmd || s.buildCmd) && !s._skipped) {
      configs = [{ id: 'legacy', name: 'Default', projectType: s.projectType || '', buildFolder: s.buildFolder || '', buildCmd: s.buildCmd || '', runCmd: s.runCmd || '' }];
    }
    return configs;
  }

  function saveRunConfigs(repoPath, configs) {
    const s = { ...(state.repoSettings[repoPath] || {}), runConfigs: configs };
    state.repoSettings[repoPath] = s;
    ws.send(JSON.stringify({ type: 'save-repo-settings', repoPath, settings: s }));
  }

  function openRunConfigModal(repoPath) {
    state.runConfigTarget = repoPath;
    runConfigFormView.classList.add('hidden');
    runConfigListView.classList.remove('hidden');
    renderRunConfigList();
    runConfigModal.classList.remove('hidden');
    runConfigModal.classList.add('flex');
  }

  function closeRunConfigModal() {
    runConfigModal.classList.add('hidden');
    runConfigModal.classList.remove('flex');
    state.runConfigTarget = null;
  }

  function renderRunConfigList() {
    const configs = getRunConfigs(state.runConfigTarget);
    runConfigList.innerHTML = '';
    runConfigEmpty.style.display = configs.length ? 'none' : '';
    configs.forEach(cfg => {
      const row = document.createElement('div');
      row.className = 'run-config-row';
      const sub = (cfg.runCmd || cfg.buildCmd || '—') + (cfg.buildFolder ? '  ·  ' + cfg.buildFolder : '');
      row.innerHTML =
        `<div class="rc-info"><div class="rc-name">${escHtml(cfg.name || '(unnamed)')}</div>` +
        `<div class="rc-cmd">${escHtml(sub)}</div></div>` +
        `<div class="rc-actions">` +
        `<button class="rc-run" title="Run this configuration"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg> Run</button>` +
        `<button class="rc-edit" title="Edit">Edit</button></div>`;
      row.querySelector('.rc-run').addEventListener('click', () => {
        if (!cfg.runCmd) { showToast('This configuration has no run command', 'info'); return; }
        runCommand(cfg.runCmd, cfg.buildFolder || undefined);
        closeRunConfigModal();
      });
      row.querySelector('.rc-edit').addEventListener('click', () => showRunConfigForm(cfg));
      runConfigList.appendChild(row);
    });
  }

  function showRunConfigForm(config) {
    _rcEditingId = config ? config.id : null;
    const selectedFolder = config ? (config.buildFolder || '') : '';
    $('#rcName').value = config ? (config.name || '') : '';
    $('#rcProjectType').value = config ? (config.projectType || 'API') : 'API';
    $('#rcBuildCmd').value = config ? (config.buildCmd || '') : '';
    $('#rcRunCmd').value = config ? (config.runCmd || '') : '';
    if (!config) applyProjectTypeDefaults('API', $('#rcBuildCmd'), $('#rcRunCmd'));
    $('#rcDeleteBtn').style.display = config ? '' : 'none';

    // Folder picker: populate from cached repo folders now (guaranteeing the
    // saved value is selectable), then fetch a fresh list for this repo.
    state.repoFolders = state.repoFolders || {};
    const cached = state.repoFolders[state.runConfigTarget];
    const list = (cached && cached.length) ? cached.slice() : ['/ (root)'];
    if (selectedFolder && !list.includes(selectedFolder)) list.push(selectedFolder);
    populateFolderSelect($('#rcBuildFolder'), list, selectedFolder);
    state._folderTargetMode = 'runconfig';
    state._rcPendingSelected = selectedFolder;
    ws.send(JSON.stringify({ type: 'list-repo-folders', repoPath: state.runConfigTarget }));

    runConfigListView.classList.add('hidden');
    runConfigFormView.classList.remove('hidden');
    setTimeout(() => { try { $('#rcName').focus(); } catch {} }, 30);
  }

  function backToRunConfigList() {
    runConfigFormView.classList.add('hidden');
    runConfigListView.classList.remove('hidden');
    renderRunConfigList();
  }

  function saveRunConfigForm() {
    const repoPath = state.runConfigTarget;
    if (!repoPath) return;
    const configs = getRunConfigs(repoPath);
    const data = {
      name: $('#rcName').value.trim() || 'Untitled',
      projectType: $('#rcProjectType').value,
      buildFolder: $('#rcBuildFolder').value.trim(),
      buildCmd: $('#rcBuildCmd').value.trim(),
      runCmd: $('#rcRunCmd').value.trim(),
    };
    const idx = _rcEditingId ? configs.findIndex(c => c.id === _rcEditingId) : -1;
    if (idx >= 0) configs[idx] = { ...configs[idx], ...data };
    else configs.push({ id: _genId(), ...data });
    saveRunConfigs(repoPath, configs);
    backToRunConfigList();
  }

  function deleteRunConfig() {
    const repoPath = state.runConfigTarget;
    if (!repoPath || !_rcEditingId) return;
    saveRunConfigs(repoPath, getRunConfigs(repoPath).filter(c => c.id !== _rcEditingId));
    backToRunConfigList();
  }

  if (runConfigModal) {
    $('#runConfigClose').addEventListener('click', closeRunConfigModal);
    runConfigOverlay.addEventListener('click', closeRunConfigModal);
    $('#addRunConfigBtn').addEventListener('click', () => showRunConfigForm(null));
    $('#rcCancelBtn').addEventListener('click', backToRunConfigList);
    $('#rcSaveBtn').addEventListener('click', saveRunConfigForm);
    $('#rcDeleteBtn').addEventListener('click', deleteRunConfig);
    $('#rcProjectType').addEventListener('change', (e) => applyProjectTypeDefaults(e.target.value, $('#rcBuildCmd'), $('#rcRunCmd')));
  }

  // Right panel drag resize
  const rpDragHandle = $('#rpDragHandle');
  const savedRpWidth = localStorage.getItem('catalyst-rp-width');
  if (savedRpWidth && rightPanel) {
    rightPanel.style.width = savedRpWidth + 'px';
    rightPanel.style.minWidth = '200px';
    rightPanel.style.maxWidth = '600px';
  }

  // The hide button hangs off the panel's outer edge (inside the panel it sat on
  // top of the section labels), and it is fixed-positioned, so it needs to be
  // told where that edge is. Kept in sync here, on drag, and on toggle.
  function syncRpWidthVar() {
    if (!rightPanel) return;
    const w = rightPanel.classList.contains('hidden') ? 0 : rightPanel.offsetWidth;
    document.documentElement.style.setProperty('--rp-width', w + 'px');
  }
  syncRpWidthVar();

  (function initRpDrag() {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    rpDragHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = rightPanel.offsetWidth;
      rpDragHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    let rafPending = false;
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = startX - e.clientX;
      const newWidth = Math.min(600, Math.max(200, startWidth + delta));
      rightPanel.style.width = newWidth + 'px';
      syncRpWidthVar();
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          const term = state.terminals[state.activeSessionId];
          if (term && term._fitAddon) {
            try { term._fitAddon.fit(); } catch {}
          }
        });
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      rpDragHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const finalWidth = rightPanel.offsetWidth;
      localStorage.setItem('catalyst-rp-width', finalWidth);
      const term = state.terminals[state.activeSessionId];
      if (term && term._fitAddon) {
        try { term._fitAddon.fit(); } catch {}
      }
    });
  })();

  // Branch modal
  branchDisplay.addEventListener('click', () => {
    if (!state.activeSessionId) return;
    const modal = $('#branchModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    $('#newBranchInput').value = '';
    $('#branchListContainer').innerHTML = '<div class="px-5 py-3 text-xs" style="color:var(--text-muted)">Loading...</div>';
    // Fast local list first, then a background remote check that prunes deleted
    // remotes and drops branches whose upstream is gone.
    ws.send(JSON.stringify({ type: 'list-branches', sessionId: state.activeSessionId }));
    ws.send(JSON.stringify({ type: 'prune-remote-branches', sessionId: state.activeSessionId }));
  });

  function closeBranchModal() {
    const modal = $('#branchModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  $('#branchModalClose').addEventListener('click', closeBranchModal);
  $('#branchModalOverlay').addEventListener('click', closeBranchModal);

  $('#createBranchBtn').addEventListener('click', () => {
    const name = $('#newBranchInput').value.trim();
    if (!name || !state.activeSessionId) return;
    ws.send(JSON.stringify({ type: 'create-branch', sessionId: state.activeSessionId, branch: name }));
  });

  $('#newBranchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#createBranchBtn').click();
  });

  function renderBranchList(branches, pruned) {
    const container = $('#branchListContainer');
    container.innerHTML = '';
    // Hide branches whose remote tracking branch was deleted ("gone"). Local-only
    // branches (no upstream) are always kept. The local branch is not deleted.
    const visible = (branches || []).filter(b => !b.gone);
    visible.forEach(b => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 px-5 py-2.5 cursor-pointer branch-row-item transition-colors';
      row.style.cssText = 'border-bottom:1px solid var(--border);';
      if (b.current) row.classList.add('branch-row-current');
      row.innerHTML = `
        <svg class="w-3.5 h-3.5 flex-shrink-0" style="color:${b.current ? 'var(--accent)' : 'var(--text-muted)'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12M18 9a3 3 0 01-3 3H6"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/></svg>
        <span class="text-xs font-mono ${b.current ? 'font-semibold' : ''} truncate flex-1" style="color:${b.current ? 'var(--text)' : 'var(--text-muted)'}">${escHtml(b.name)}</span>
        ${b.current ? '<span class="text-[9px] uppercase tracking-wider font-semibold" style="color:var(--accent)">current</span>' : ''}
        ${b.remote && !b.current ? '<span class="text-[9px] uppercase tracking-wider" style="color:var(--text-muted)">remote</span>' : ''}
      `;
      if (!b.current) {
        row.addEventListener('click', () => {
          ws.send(JSON.stringify({ type: 'switch-branch', sessionId: state.activeSessionId, branch: b.name }));
        });
      }
      container.appendChild(row);
    });
    if (visible.length === 0) {
      container.innerHTML = '<div class="px-5 py-3 text-xs" style="color:var(--text-muted)">No branches</div>';
    }
    if (!pruned) {
      const hint = document.createElement('div');
      hint.className = 'px-5 py-2';
      hint.style.cssText = 'color:var(--text-muted);font-size:10px;border-top:1px solid var(--border)';
      hint.textContent = '↻ Checking remote for deleted branches…';
      container.appendChild(hint);
    }
  }

  function showConfirm(title, message, detail, okLabel) {
    return new Promise((resolve) => {
      const modal = $('#confirmModal');
      $('#confirmTitle').textContent = title;
      $('#confirmMessage').textContent = message;
      $('#confirmDetail').textContent = detail;
      $('#confirmOk').textContent = okLabel || 'Confirm';
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      function cleanup(result) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        $('#confirmCancel').removeEventListener('click', onCancel);
        $('#confirmOk').removeEventListener('click', onOk);
        $('#confirmOverlay').removeEventListener('click', onCancel);
        resolve(result);
      }
      function onCancel() { cleanup(false); }
      function onOk() { cleanup(true); }

      $('#confirmCancel').addEventListener('click', onCancel);
      $('#confirmOk').addEventListener('click', onOk);
      $('#confirmOverlay').addEventListener('click', onCancel);
    });
  }

  // Git action buttons in right panel
  // Folder picker for custom commands
  let selectedSubdir = '';

  $('#cmdFolderDisplay').addEventListener('click', () => {
    if (!state.activeSessionId) return;
    const modal = $('#folderPickerModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    $('#folderPickerList').innerHTML = '<div class="px-5 py-3 text-xs" style="color:var(--text-muted)">Loading...</div>';
    ws.send(JSON.stringify({ type: 'list-subdirs', sessionId: state.activeSessionId, path: '' }));
  });

  function closeFolderPicker() {
    const modal = $('#folderPickerModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  $('#folderPickerClose').addEventListener('click', closeFolderPicker);
  $('#folderPickerOverlay').addEventListener('click', closeFolderPicker);

  function renderFolderList(currentPath, dirs) {
    const container = $('#folderPickerList');
    container.innerHTML = '';

    // Select current folder option
    const selectRow = document.createElement('div');
    selectRow.className = 'flex items-center gap-2 px-5 py-2.5 cursor-pointer hover-bg-accent-subtle transition-colors';
    selectRow.style.cssText = 'border-bottom:1px solid var(--border);';
    selectRow.innerHTML = `
      <svg class="w-3.5 h-3.5" style="color:var(--accent)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      <span class="text-xs font-mono font-semibold" style="color:var(--accent)">Use this folder</span>
      <span class="text-[9px] ml-auto truncate max-w-[120px]" style="color:var(--text-muted)">${escHtml(currentPath) || '/ (root)'}</span>
    `;
    selectRow.addEventListener('click', () => {
      selectedSubdir = currentPath;
      $('#cmdFolderName').textContent = currentPath || '/ (root)';
      closeFolderPicker();
    });
    container.appendChild(selectRow);

    // Back button if not at root
    if (currentPath) {
      const backRow = document.createElement('div');
      backRow.className = 'flex items-center gap-2 px-5 py-2 cursor-pointer hover-bg-theme transition-colors';
      backRow.style.cssText = 'border-bottom:1px solid var(--border);';
      backRow.innerHTML = `
        <svg class="w-3.5 h-3.5" style="color:var(--text-muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        <span class="text-xs font-mono" style="color:var(--text-muted)">..</span>
      `;
      backRow.addEventListener('click', () => {
        const parent = currentPath.split('/').slice(0, -1).join('/');
        ws.send(JSON.stringify({ type: 'list-subdirs', sessionId: state.activeSessionId, path: parent }));
      });
      container.appendChild(backRow);
    }

    dirs.forEach(name => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 px-5 py-2 cursor-pointer hover-bg-theme transition-colors';
      row.style.cssText = 'border-bottom:1px solid var(--border);';
      row.innerHTML = `
        <svg class="w-3.5 h-3.5" style="color:var(--accent);opacity:0.7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        <span class="text-xs font-mono" style="color:var(--text)">${escHtml(name)}</span>
        <svg class="w-3 h-3 ml-auto" style="color:var(--text-muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      `;
      row.addEventListener('click', () => {
        const newPath = currentPath ? currentPath + '/' + name : name;
        ws.send(JSON.stringify({ type: 'list-subdirs', sessionId: state.activeSessionId, path: newPath }));
      });
      container.appendChild(row);
    });

    if (dirs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-5 py-3 text-xs';
      empty.style.cssText = 'color:var(--text-muted)';
      empty.textContent = 'No subdirectories';
      container.appendChild(empty);
    }
  }

  // Git action buttons
  $('#gitPullBtn').addEventListener('click', () => {
    if (!state.activeSessionId) return;
    ws.send(JSON.stringify({ type: 'git-pull', sessionId: state.activeSessionId }));
  });

  $('#gitPushBtn').addEventListener('click', () => {
    if (!state.activeSessionId) return;
    ws.send(JSON.stringify({ type: 'git-push', sessionId: state.activeSessionId }));
  });

  $('#gitPrBtn').addEventListener('click', () => {
    if (!state.activeSessionId) return;
    const sessionId = state.activeSessionId;
    state.watchForPrUrl = { sessionId, startedAt: Date.now() };
    sendPromptToClaude(sessionId, 'Build it, run all tests and then create PR using azure devops cli and give me pr link');
    const term = state.terminals[sessionId];
    if (term) term.focus();
  });

  // ─── START WITH TASK ─────────────────────
  const taskModal = $('#taskModal');
  const taskModalClose = $('#taskModalClose');
  const taskIdInput = $('#taskIdInput');
  const taskFetchBtn = $('#taskFetchBtn');
  const taskError = $('#taskError');
  const taskLoading = $('#taskLoading');
  const taskDetails = $('#taskDetails');
  const taskLfgBtn = $('#taskLfgBtn');
  let currentWorkItem = null;
  const repoTaskMap = {};

  function getActiveRepoPath() {
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    return session ? session.repoPath : null;
  }

  function saveRepoTask(repoPath, wi) {
    if (repoPath) repoTaskMap[repoPath] = wi;
  }

  function clearRepoTask(repoPath) {
    if (repoPath) delete repoTaskMap[repoPath];
  }

  function restoreTaskForRepo() {
    const repoPath = getActiveRepoPath();
    const wi = repoPath ? repoTaskMap[repoPath] : null;
    if (wi) {
      currentWorkItem = wi;
      showActiveTaskCard(wi);
    } else {
      currentWorkItem = null;
      hideActiveTaskCard();
    }
  }

  function openTaskModal() {
    taskModal.classList.remove('hidden');
    taskError.classList.add('hidden');
    taskLoading.classList.add('hidden');
    taskDetails.classList.add('hidden');
    taskIdInput.value = '';
    $('#taskExtraInfo').value = '';
    currentWorkItem = null;
    taskIdInput.focus();
  }

  function closeTaskModal() {
    taskModal.classList.add('hidden');
  }

  $('#startWithTaskBtn').addEventListener('click', openTaskModal);
  taskModalClose.addEventListener('click', closeTaskModal);
  taskModal.addEventListener('click', (e) => { if (e.target === taskModal) closeTaskModal(); });

  taskIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') taskFetchBtn.click();
  });

  taskFetchBtn.addEventListener('click', () => {
    const id = taskIdInput.value.trim();
    if (!id) return;
    taskError.classList.add('hidden');
    taskDetails.classList.add('hidden');
    taskLoading.classList.remove('hidden');
    taskFetchBtn.disabled = true;
    ws.send(JSON.stringify({ type: 'fetch-work-item', workItemId: id }));
  });

  function hideActiveTaskCard() {
    $('#startWithTaskBtn').classList.remove('hidden');
    $('#activeTaskCard').classList.add('hidden');
    const statusTask = $('#statusbarTask');
    if (statusTask) { statusTask.classList.add('hidden'); statusTask.innerHTML = ''; }
  }

  function showActiveTaskCard(wi) {
    $('#startWithTaskBtn').classList.add('hidden');
    const card = $('#activeTaskCard');
    card.classList.remove('hidden');
    $('#activeTaskCardText').textContent = `#${wi.id}: ${wi.title}`;
    $('#activeTaskCardBody').onclick = () => {
      if (wi.url && /^https?:\/\//i.test(wi.url)) {
        const a = document.createElement('a');
        a.href = wi.url;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    };
    const statusTask = $('#statusbarTask');
    if (statusTask) {
      statusTask.innerHTML = `Implementing task <span style="color:var(--accent);cursor:pointer" id="statusTaskLink">#${escHtml(wi.id)}</span>: ${escHtml(wi.title)}`;
      statusTask.classList.remove('hidden');
      const link = $('#statusTaskLink');
      if (link && wi.url && /^https?:\/\//i.test(wi.url)) {
        link.addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = wi.url;
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
      }
    }
  }

  function clearActiveTask() {
    const repoPath = getActiveRepoPath();
    clearRepoTask(repoPath);
    hideActiveTaskCard();
    currentWorkItem = null;
  }

  $('#clearTaskBtn').addEventListener('click', clearActiveTask);

  function setActiveTask(wi) {
    const repoPath = getActiveRepoPath();
    saveRepoTask(repoPath, wi);
    currentWorkItem = wi;
    showActiveTaskCard(wi);
  }

  function slugify(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 50);
  }

  function defaultBranchForWorkItem(wi) {
    if (!wi) return '';
    const isBug = (wi.type || '').toLowerCase() === 'bug';
    const prefix = isBug ? 'fix' : 'feat';
    const slug = slugify(wi.title) || String(wi.id);
    return `${prefix}/${slug}-${wi.id}`;
  }

  function isValidBranchName(name) {
    return /^[a-zA-Z0-9._\/-]+$/.test(name);
  }

  taskLfgBtn.addEventListener('click', () => {
    if (!currentWorkItem || !state.activeSessionId) return;
    const wi = currentWorkItem;
    let prompt = `I need to implement this Azure DevOps work item:\n\n`;
    prompt += `Title: ${wi.title}\n`;
    prompt += `ID: ${wi.id}\n`;
    prompt += `State: ${wi.state}\n`;
    if (wi.type) prompt += `Type: ${wi.type}\n`;
    prompt += `\nDescription:\n${wi.description || '(none)'}\n`;
    if (wi.acceptanceCriteria) prompt += `\nAcceptance Criteria:\n${wi.acceptanceCriteria}\n`;
    if (wi.comments && wi.comments.length > 0) {
      prompt += `\nComments:\n`;
      wi.comments.forEach(c => {
        prompt += `- ${c.author}: ${c.text}\n`;
      });
    }
    const extraInfo = $('#taskExtraInfo').value.trim();
    if (extraInfo) prompt += `\nAdditional context from the developer:\n${extraInfo}\n`;
    prompt += `\nResearch this codebase thoroughly. Identify what files need to change and why. Present your implementation plan before making any changes.\n`;

    setActiveTask(wi);

    if ($('#taskSetInProgress').checked) {
      ws.send(JSON.stringify({ type: 'update-work-item-state', workItemId: wi.id, newState: 'In Progress' }));
    }

    const sessionId = state.activeSessionId;
    const createBranch = $('#taskCreateBranch').checked;
    const branchName = ($('#taskBranchInput').value || '').trim();

    if (createBranch && branchName) {
      if (!isValidBranchName(branchName)) {
        taskError.textContent = 'Branch name must contain only letters, numbers, dots, underscores, slashes, and hyphens.';
        taskError.classList.remove('hidden');
        return;
      }
      // Create the branch via the same session manager git pipeline so Catalyst tracks it,
      // then send the prompt once the result lands.
      const onBranchDone = (evt) => {
        try {
          const m = JSON.parse(evt.data);
          if (m.type === 'branch-switched' && m.sessionId === sessionId) {
            ws.removeEventListener('message', onBranchDone);
            ws.removeEventListener('message', onBranchErr);
            sendPromptToClaude(sessionId, prompt);
          }
        } catch {}
      };
      const onBranchErr = (evt) => {
        try {
          const m = JSON.parse(evt.data);
          if (m.type === 'branch-error') {
            ws.removeEventListener('message', onBranchDone);
            ws.removeEventListener('message', onBranchErr);
            taskError.textContent = 'Could not create branch: ' + (m.message || 'unknown error');
            taskError.classList.remove('hidden');
          }
        } catch {}
      };
      ws.addEventListener('message', onBranchDone);
      ws.addEventListener('message', onBranchErr);
      ws.send(JSON.stringify({ type: 'create-branch', sessionId, branch: branchName }));
    } else {
      sendPromptToClaude(sessionId, prompt);
    }

    closeTaskModal();
    const term = state.terminals[sessionId];
    if (term) term.focus();
  });

  // Claude Code (and other CLIs) treat fast PTY writes as a paste — the embedded \r
  // becomes a literal newline, not a submit. Send the prompt body first, then a
  // separate \r keystroke a moment later so the CLI sees the Enter as a fresh key.
  function sendPromptToClaude(sessionId, prompt) {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: prompt }));
    state.lastInputTime[sessionId] = Date.now();
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'input', sessionId, data: '\r' }));
    }, 350);
  }

  $('#closeSessionBtn').addEventListener('click', async () => {
    if (!state.activeSessionId) return;
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    const name = session ? session.repo : 'this session';
    const cli = session ? session.cli : 'CLI';
    const confirmed = await showConfirm(
      'Close Session',
      'This will terminate the CLI process and remove the session.',
      `${name} — ${cli}`,
      'Close Session'
    );
    if (confirmed) {
      const id = state.activeSessionId;
      ws.send(JSON.stringify({ type: 'kill-session', sessionId: id }));
      removeSessionUI(id);
    }
  });

  function fitActiveTerminal() {
    setTimeout(() => {
      if (state.activeSessionId && state.terminals[state.activeSessionId]) {
        state.terminals[state.activeSessionId]._fitAddon.fit();
      }
    }, 100);
  }

  function runCommand(cmd, subdir) {
    if (!state.activeSessionId) return;
    ws.send(JSON.stringify({ type: 'run-command', sessionId: state.activeSessionId, command: cmd, subdir: subdir || selectedSubdir }));
  }

  customCmdRun.addEventListener('click', () => {
    const cmd = customCmdInput.value.trim();
    if (!cmd) return;
    runCommand(cmd);
    customCmdInput.value = '';
  });

  customCmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') customCmdRun.click();
  });

  $('#clearRunsBtn')?.addEventListener('click', clearRecentRuns);

  // Git changes panel
  const changesInlineTree = $('#changesInlineTree');
  const changesCountNum = $('#changesCountNum');
  const allFilesCountNum = $('#allFilesCountNum');
  const changesRefreshBtn = $('#changesRefreshBtn');
  const changesViewBtn = $('#changesViewBtn');
  const changesToggle = $('#changesToggle');
  const stageAllBtn = $('#stageAllBtn');
  const gitCtxMenu = $('#gitCtxMenu');
  let changedFilesList = [];
  let allFilesList = [];
  // `git ls-files` has to have come back before the All Files count means
  // anything; until then the label carries no number.
  let allFilesFetched = false;
  let changesViewMode = 'changes';

  // Monaco editor state
  let monacoInstance = null;
  let monacoMode = 'diff';
  let monacoInline = false;
  let monacoCurrentFile = null;
  let monacoOriginal = '';
  let monacoModified = '';
  const monacoOpenTabs = []; // { file, original, modified, statusCode }
  const monacoModal = $('#monacoModal');
  const monacoModalOverlay = $('#monacoModalOverlay');
  const monacoModalClose = $('#monacoModalClose');
  const monacoFileName = $('#monacoFileName');
  const monacoEditorContainer = $('#monacoEditorContainer');
  const monacoDiffTab = $('#monacoDiffTab');
  const monacoViewTab = $('#monacoViewTab');
  const monacoEditTab = $('#monacoEditTab');
  const monacoInlineDiff = $('#monacoInlineDiff');
  const monacoSaveBtn = $('#monacoSaveBtn');
  const monacoFileTree = $('#monacoFileTree');
  const monacoFileCount = $('#monacoFileCount');

  function getMonacoThemeColors() {
    const s = getComputedStyle(document.body);
    const bg = s.getPropertyValue('--bg-card').trim() || '#0f1319';
    const bgSec = s.getPropertyValue('--bg-secondary').trim() || '#0c1017';
    const text = s.getPropertyValue('--text').trim() || '#ffffff';
    const muted = s.getPropertyValue('--text-muted').trim() || '#9bafc6';
    const accent = s.getPropertyValue('--accent').trim() || '#38bdf8';
    const border = s.getPropertyValue('--surface').trim() || '#141a24';
    return { bg, bgSec, text, muted, accent, border };
  }

  function defineMonacoTheme(m) {
    const c = getMonacoThemeColors();
    const isLight = document.body.classList.contains('light');
    m.editor.defineTheme('catalyst-dark', {
      base: isLight ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: c.muted.replace('#', ''), fontStyle: 'italic' },
        { token: 'keyword', foreground: c.accent.replace('#', '') },
      ],
      colors: {
        'editor.background': c.bg,
        'editor.foreground': c.text,
        'editorLineNumber.foreground': c.muted,
        'editorLineNumber.activeForeground': c.accent,
        'editor.selectionBackground': c.accent + '33',
        'editor.lineHighlightBackground': c.border + '80',
        'editorWidget.background': c.bgSec,
        'editorWidget.border': c.border,
        'diffEditor.insertedTextBackground': '#34d39918',
        'diffEditor.removedTextBackground': '#f8717118',
        'diffEditor.insertedLineBackground': '#34d39910',
        'diffEditor.removedLineBackground': '#f8717110',
        'scrollbarSlider.background': c.accent + '20',
        'scrollbarSlider.hoverBackground': c.accent + '40',
      }
    });
  }

  function guessLanguage(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
      'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
      'ts': 'typescript', 'tsx': 'typescript',
      'py': 'python', 'pyw': 'python',
      'cs': 'csharp', 'csx': 'csharp',
      'java': 'java', 'kt': 'kotlin',
      'go': 'go', 'rs': 'rust', 'rb': 'ruby',
      'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'c': 'c', 'h': 'c',
      'html': 'html', 'htm': 'html',
      'css': 'css', 'scss': 'scss', 'less': 'less',
      'json': 'json', 'jsonc': 'json',
      'xml': 'xml', 'svg': 'xml', 'csproj': 'xml', 'sln': 'xml',
      'yaml': 'yaml', 'yml': 'yaml',
      'md': 'markdown', 'mdx': 'markdown',
      'sql': 'sql',
      'sh': 'shell', 'bash': 'shell', 'zsh': 'shell',
      'ps1': 'powershell', 'psm1': 'powershell',
      'dockerfile': 'dockerfile',
      'toml': 'ini', 'ini': 'ini', 'cfg': 'ini',
      'r': 'r',
      'swift': 'swift', 'dart': 'dart', 'php': 'php', 'lua': 'lua',
    };
    return map[ext] || 'plaintext';
  }

  function disposeEditorWithModels(editor) {
    if (!editor) return;
    try {
      if (typeof editor.getOriginalEditor === 'function') {
        // Diff editor: dispose both original and modified models
        const origModel = editor.getOriginalEditor().getModel();
        const modModel = editor.getModifiedEditor().getModel();
        editor.dispose();
        if (origModel) origModel.dispose();
        if (modModel) modModel.dispose();
      } else {
        // Regular editor: dispose its model
        const model = editor.getModel();
        editor.dispose();
        if (model) model.dispose();
      }
    } catch {
      try { editor.dispose(); } catch {}
    }
  }

  function buildFileTree(files) {
    const tree = {};
    files.forEach(f => {
      const parts = f.file.replace(/\\/g, '/').split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = {};
        node = node[parts[i]];
      }
      const fname = parts[parts.length - 1];
      node['__file__' + fname] = f;
    });
    return tree;
  }

  function countFilesInNode(node) {
    let c = 0;
    for (const key in node) {
      if (key.startsWith('__file__')) c++;
      else c += countFilesInNode(node[key]);
    }
    return c;
  }

  function collapseSingleChildFolders(name, node) {
    const keys = Object.keys(node);
    const subfolders = keys.filter(k => !k.startsWith('__file__'));
    const files = keys.filter(k => k.startsWith('__file__'));
    if (files.length === 0 && subfolders.length === 1) {
      const childName = subfolders[0];
      return collapseSingleChildFolders(name + '/' + childName, node[childName]);
    }
    return { name, node };
  }

  function renderFileTree(tree, container, depth) {
    const folders = [];
    const fileEntries = [];
    for (const key in tree) {
      if (key.startsWith('__file__')) fileEntries.push({ name: key.replace('__file__', ''), data: tree[key] });
      else {
        const collapsed = collapseSingleChildFolders(key, tree[key]);
        folders.push(collapsed);
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));

    folders.forEach(({ name, node }) => {
      const count = countFilesInNode(node);
      const folder = document.createElement('div');
      folder.className = 'mft-folder';
      const pl = 10 + depth * 16;
      const row = document.createElement('div');
      row.className = 'mft-folder-row';
      row.style.paddingLeft = pl + 'px';
      row.innerHTML = `<span class="mft-chevron"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span>`
        + `<svg class="mft-folder-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`
        + `<span class="mft-folder-name">${escHtml(name)}</span>`
        + `<span class="mft-folder-count">${count}</span>`;
      folder.appendChild(row);

      const children = document.createElement('div');
      children.className = 'mft-children';
      renderFileTree(node, children, depth + 1);
      folder.appendChild(children);

      row.addEventListener('click', () => {
        const chev = row.querySelector('.mft-chevron');
        chev.classList.toggle('collapsed');
        children.classList.toggle('collapsed');
      });

      container.appendChild(folder);
    });

    fileEntries.forEach(({ name, data }) => {
      const file = document.createElement('div');
      file.className = 'mft-file';
      file.dataset.filepath = data.file;
      const pl = 10 + depth * 16 + 14;
      file.style.paddingLeft = pl + 'px';
      const badgeCode = data.statusCode === '??' ? 'A' : data.statusCode;
      const badgeClass = data.statusCode === '??' ? 'A' : data.statusCode;
      file.innerHTML = `<span class="mft-file-name" title="${escHtml(data.file)}">${escHtml(name)}</span>`
        + `<span class="mft-file-badge ${escHtml(badgeClass)}">${escHtml(badgeCode)}</span>`;
      file.addEventListener('click', () => {
        monacoFileTree.querySelectorAll('.mft-file.active').forEach(el => el.classList.remove('active'));
        file.classList.add('active');
        ws.send(JSON.stringify({ type: 'git-file-contents', sessionId: state.activeSessionId, file: data.file }));
      });
      container.appendChild(file);
    });
  }

  const monacoSearchInput = $('#monacoSearchInput');

  function buildAndRenderTree(files) {
    monacoFileTree.innerHTML = '';
    monacoFileCount.textContent = files.length;
    if (files.length === 0) {
      monacoFileTree.innerHTML = '<div style="padding:12px 14px;font-size:10px;color:var(--text-muted)">No files match</div>';
      return;
    }
    const tree = buildFileTree(files);
    renderFileTree(tree, monacoFileTree, 0);
  }

  function filterAndRenderTree() {
    const q = (monacoSearchInput.value || '').toLowerCase().trim();
    const fileList = changesViewMode === 'all' ? allFilesList : changedFilesList;
    if (!q) {
      buildAndRenderTree(fileList);
    } else {
      const filtered = fileList.filter(f => f.file.toLowerCase().includes(q));
      buildAndRenderTree(filtered);
    }
    if (monacoCurrentFile) {
      monacoFileTree.querySelectorAll('.mft-file').forEach(el => {
        el.classList.toggle('active', el.dataset.filepath === monacoCurrentFile);
      });
    }
  }

  let _monacoSearchDebounce = null;
  monacoSearchInput.addEventListener('input', () => {
    clearTimeout(_monacoSearchDebounce);
    _monacoSearchDebounce = setTimeout(filterAndRenderTree, 100);
  });

  function openChangesModal() {
    if (!state.activeSessionId) return;
    monacoModal.classList.remove('hidden');
    monacoEditorContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:12px;letter-spacing:1px">Select a file to view diff</div>';
    monacoFileName.textContent = '';
    monacoSearchInput.value = '';
    monacoOpenTabs.length = 0;
    monacoFileTabbar.innerHTML = '';
    monacoCurrentFile = null;
    buildAndRenderTree(changedFilesList);
    if (changedFilesList.length > 0) {
      const first = changedFilesList[0];
      setTimeout(() => {
        const firstEl = monacoFileTree.querySelector('.mft-file');
        if (firstEl) firstEl.click();
      }, 100);
    }
  }

  const monacoFileTabbar = $('#monacoFileTabbar');

  function addMonacoFileTab(file, original, modified) {
    const existing = monacoOpenTabs.find(t => t.file === file);
    if (existing) {
      existing.original = original;
      existing.modified = modified;
    } else {
      const changedFile = changedFilesList.find(f => f.file === file);
      const statusCode = changedFile ? (changedFile.statusCode === '??' ? 'A' : changedFile.statusCode) : 'M';
      monacoOpenTabs.push({ file, original, modified, statusCode });
    }
    renderMonacoFileTabs();
  }

  function renderMonacoFileTabs() {
    monacoFileTabbar.innerHTML = '';
    monacoOpenTabs.forEach(tab => {
      const el = document.createElement('div');
      el.className = 'monaco-file-tab' + (tab.file === monacoCurrentFile ? ' active' : '');
      const shortName = tab.file.replace(/\\/g, '/').split('/').pop();
      el.innerHTML = `<span class="monaco-file-tab-badge ${escHtml(tab.statusCode)}">${escHtml(tab.statusCode)}</span>`
        + `<span class="monaco-file-tab-name" title="${escHtml(tab.file)}">${escHtml(shortName)}</span>`
        + `<span class="monaco-file-tab-close"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></span>`;

      el.querySelector('.monaco-file-tab-name').addEventListener('click', () => {
        showMonacoFileTab(tab.file);
      });
      el.querySelector('.monaco-file-tab-badge').addEventListener('click', () => {
        showMonacoFileTab(tab.file);
      });
      el.querySelector('.monaco-file-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeMonacoFileTab(tab.file);
      });
      monacoFileTabbar.appendChild(el);
    });
  }

  function showMonacoFileTab(file) {
    captureEditContent();
    const tab = monacoOpenTabs.find(t => t.file === file);
    if (!tab) return;
    renderEditorForFile(tab.file, tab.original, tab.modified);
    renderMonacoFileTabs();
  }

  function closeMonacoFileTab(file) {
    const idx = monacoOpenTabs.findIndex(t => t.file === file);
    if (idx === -1) return;
    monacoOpenTabs.splice(idx, 1);
    if (monacoCurrentFile === file) {
      if (monacoOpenTabs.length > 0) {
        const next = monacoOpenTabs[Math.min(idx, monacoOpenTabs.length - 1)];
        showMonacoFileTab(next.file);
      } else {
        monacoCurrentFile = null;
        monacoFileName.textContent = '';
        monacoEditorContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:12px;letter-spacing:1px">Select a file to view diff</div>';
        if (monacoInstance) { disposeEditorWithModels(monacoInstance); monacoInstance = null; }
        monacoFileTree.querySelectorAll('.mft-file.active').forEach(el => el.classList.remove('active'));
      }
    }
    renderMonacoFileTabs();
  }

  async function renderEditorForFile(file, original, modified) {
    const m = await window._monacoReady;
    defineMonacoTheme(m);
    monacoCurrentFile = file;
    monacoOriginal = original;
    monacoModified = modified;
    monacoFileName.textContent = file;
    monacoEditorContainer.innerHTML = '';

    if (monacoInstance) {
      disposeEditorWithModels(monacoInstance);
      monacoInstance = null;
    }

    const lang = guessLanguage(file);

    if (monacoMode === 'diff') {
      monacoInstance = m.editor.createDiffEditor(monacoEditorContainer, {
        theme: 'catalyst-dark',
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: !monacoInline,
        fontFamily: "'Fira Code', monospace",
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        contextmenu: false,
      });
      monacoInstance.setModel({
        original: m.editor.createModel(original, lang),
        modified: m.editor.createModel(modified, lang),
      });
    } else if (monacoMode === 'edit') {
      monacoInstance = m.editor.create(monacoEditorContainer, {
        value: modified,
        language: lang,
        theme: 'catalyst-dark',
        readOnly: false,
        automaticLayout: true,
        fontFamily: "'Fira Code', monospace",
        fontSize: 12,
        minimap: { enabled: true, scale: 1 },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
        tabSize: 2,
        wordWrap: 'on',
      });
      monacoInstance.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
        saveCurrentFile();
      });
    } else {
      monacoInstance = m.editor.create(monacoEditorContainer, {
        value: modified,
        language: lang,
        theme: 'catalyst-dark',
        readOnly: true,
        automaticLayout: true,
        fontFamily: "'Fira Code', monospace",
        fontSize: 12,
        minimap: { enabled: true, scale: 1 },
        scrollBeyondLastLine: false,
        contextmenu: false,
        renderLineHighlight: 'all',
      });
    }

    updateMonacoTabState();

    monacoFileTree.querySelectorAll('.mft-file').forEach(el => {
      el.classList.toggle('active', el.dataset.filepath === file);
    });
  }

  async function loadFileInMonaco(file, original, modified) {
    addMonacoFileTab(file, original, modified);
    await renderEditorForFile(file, original, modified);
  }

  async function openMonacoModal(file, original, modified) {
    monacoModal.classList.remove('hidden');
    // Reset the filter box: buildAndRenderTree below renders the unfiltered list,
    // so a query left over from last time would sit there contradicting the tree.
    monacoSearchInput.value = '';
    const fileList = changesViewMode === 'all' ? allFilesList : changedFilesList;
    const sidebarTitle = document.getElementById('monacoSidebarTitle');
    if (sidebarTitle) sidebarTitle.textContent = changesViewMode === 'all' ? 'All Files' : 'Changed Files';
    buildAndRenderTree(fileList);
    await loadFileInMonaco(file, original, modified);
  }

  function closeMonacoModal() {
    monacoModal.classList.add('hidden');
    if (monacoInstance) {
      disposeEditorWithModels(monacoInstance);
      monacoInstance = null;
    }
    monacoEditorContainer.innerHTML = '';
    monacoOpenTabs.length = 0;
    monacoFileTabbar.innerHTML = '';
    monacoCurrentFile = null;
  }

  function updateMonacoTabState() {
    monacoDiffTab.classList.toggle('active', monacoMode === 'diff');
    monacoViewTab.classList.toggle('active', monacoMode === 'view');
    monacoEditTab.classList.toggle('active', monacoMode === 'edit');
    monacoInlineDiff.classList.toggle('active', monacoInline);
    monacoInlineDiff.style.display = monacoMode === 'diff' ? '' : 'none';
    monacoSaveBtn.classList.toggle('hidden', monacoMode !== 'edit');
  }

  monacoModalClose.addEventListener('click', closeMonacoModal);
  monacoModalOverlay.addEventListener('click', closeMonacoModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!monacoModal.classList.contains('hidden')) closeMonacoModal();
      else if (!settingsPanel.classList.contains('hidden')) hideSettings();
    }
  });

  // Monaco sidebar drag resize
  const monacoSidebar = $('#monacoSidebar');
  const monacoSidebarDrag = $('#monacoSidebarDrag');
  const savedMsWidth = localStorage.getItem('catalyst-monaco-sidebar-width');
  if (savedMsWidth && monacoSidebar) monacoSidebar.style.width = savedMsWidth + 'px';

  (function initMonacoSidebarDrag() {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    monacoSidebarDrag.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = monacoSidebar.offsetWidth;
      monacoSidebarDrag.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = startX - e.clientX;
      const newWidth = Math.min(500, Math.max(180, startWidth + delta));
      monacoSidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      monacoSidebarDrag.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('catalyst-monaco-sidebar-width', monacoSidebar.offsetWidth);
    });
  })();

  function captureEditContent() {
    if (monacoMode === 'edit' && monacoInstance && typeof monacoInstance.getValue === 'function') {
      monacoModified = monacoInstance.getValue();
      const tab = monacoOpenTabs.find(t => t.file === monacoCurrentFile);
      if (tab) tab.modified = monacoModified;
    }
  }

  monacoDiffTab.addEventListener('click', () => {
    captureEditContent();
    monacoMode = 'diff';
    if (monacoCurrentFile) loadFileInMonaco(monacoCurrentFile, monacoOriginal, monacoModified);
  });

  monacoViewTab.addEventListener('click', () => {
    captureEditContent();
    monacoMode = 'view';
    if (monacoCurrentFile) loadFileInMonaco(monacoCurrentFile, monacoOriginal, monacoModified);
  });

  monacoEditTab.addEventListener('click', () => {
    captureEditContent();
    monacoMode = 'edit';
    if (monacoCurrentFile) loadFileInMonaco(monacoCurrentFile, monacoOriginal, monacoModified);
  });

  monacoInlineDiff.addEventListener('click', () => {
    monacoInline = !monacoInline;
    if (monacoCurrentFile && monacoMode === 'diff') loadFileInMonaco(monacoCurrentFile, monacoOriginal, monacoModified);
  });

  function saveCurrentFile() {
    if (!monacoCurrentFile || !state.activeSessionId) return;
    if (!monacoInstance || typeof monacoInstance.getValue !== 'function') return;
    const content = monacoInstance.getValue();
    monacoSaveBtn.classList.add('saving');
    monacoSaveBtn.textContent = 'Saving...';
    ws.send(JSON.stringify({ type: 'save-file', sessionId: state.activeSessionId, file: monacoCurrentFile, content }));
  }

  monacoSaveBtn.addEventListener('click', saveCurrentFile);

  function refreshChanges() {
    if (!state.activeSessionId) return;
    changesRefreshBtn.classList.add('spinning');
    ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: state.activeSessionId }));
  }

  changesRefreshBtn.addEventListener('click', () => {
    if (changesViewMode === 'all') {
      refreshAllFiles();
    } else {
      refreshChanges();
    }
  });

  // Stage all changes
  if (stageAllBtn) {
    stageAllBtn.addEventListener('click', () => {
      if (!state.activeSessionId || changedFilesList.length === 0) return;
      const files = changedFilesList.filter(f => !f.staged).map(f => f.file);
      if (files.length === 0) return;
      wsSend({ type: 'git-stage', sessionId: state.activeSessionId, files });
    });
  }

  // Context menu for changed files
  function hideGitCtxMenu() { if (gitCtxMenu) gitCtxMenu.classList.remove('visible'); }
  document.addEventListener('click', hideGitCtxMenu);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.git-ctx-menu')) hideGitCtxMenu();
  });

  function showGitCtxMenu(e, fileData) {
    e.preventDefault();
    if (!gitCtxMenu || !state.activeSessionId) return;
    const items = [];
    if (fileData.staged) {
      items.push({ label: 'Unstage', action: () => wsSend({ type: 'git-unstage', sessionId: state.activeSessionId, file: fileData.file }) });
    } else {
      items.push({ label: 'Stage', action: () => wsSend({ type: 'git-stage', sessionId: state.activeSessionId, file: fileData.file }) });
    }
    items.push({ label: 'Discard Changes', cls: 'danger', action: async () => {
      const ok = await showConfirm('Discard Changes', 'This will revert all changes to this file. This cannot be undone.', fileData.file, 'Discard');
      if (ok) wsSend({ type: 'git-discard', sessionId: state.activeSessionId, file: fileData.file });
    }});
    gitCtxMenu.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'git-ctx-item' + (item.cls ? ' ' + item.cls : '');
      row.textContent = item.label;
      row.addEventListener('click', () => { hideGitCtxMenu(); item.action(); });
      gitCtxMenu.appendChild(row);
    });
    gitCtxMenu.style.left = e.clientX + 'px';
    gitCtxMenu.style.top = e.clientY + 'px';
    gitCtxMenu.classList.add('visible');
    // Clamp to viewport
    requestAnimationFrame(() => {
      const r = gitCtxMenu.getBoundingClientRect();
      if (r.right > window.innerWidth) gitCtxMenu.style.left = (window.innerWidth - r.width - 4) + 'px';
      if (r.bottom > window.innerHeight) gitCtxMenu.style.top = (window.innerHeight - r.height - 4) + 'px';
    });
  }

  changesViewBtn.addEventListener('click', () => {
    const list = changesViewMode === 'all' ? allFilesList : changedFilesList;
    if (list.length > 0) {
      state._openChangesModal = true;
      const first = list[0];
      ws.send(JSON.stringify({ type: 'git-file-contents', sessionId: state.activeSessionId, file: first.file }));
    }
  });

  changesToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.changes-toggle-btn');
    if (!btn || btn.classList.contains('active')) return;
    changesToggle.querySelectorAll('.changes-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    changesViewMode = btn.dataset.mode;
    if (changesViewMode === 'all') {
      if (allFilesList.length > 0) renderAllFiles(allFilesList);
      refreshAllFiles();
    } else {
      renderChangedFiles(changedFilesList);
    }
  });

  function refreshAllFiles() {
    if (!state.activeSessionId) return;
    changesRefreshBtn.classList.add('spinning');
    ws.send(JSON.stringify({ type: 'git-all-files', sessionId: state.activeSessionId }));
  }

  // Signature of the last rendered inline tree (shared by both views since
  // they render into the same container). Includes view mode and session id
  // so mode/session switches always re-render.
  let lastInlineTreeSig = '';

  function inlineTreeSig(mode, files) {
    return mode + '|' + state.activeSessionId + '|' + files.map(f => f.statusCode + f.file).join('\n');
  }

  // Each view's size sits in its own label, so both numbers are visible at once
  // and neither needs a separate badge to explain which one it counts. A count
  // stays blank until its list has actually been fetched — better than "(0)",
  // which would read as "this repo has no files".
  function updateChangesCounts() {
    if (changesCountNum) {
      changesCountNum.textContent = changedFilesList ? ` (${changedFilesList.length})` : '';
    }
    if (allFilesCountNum) {
      allFilesCountNum.textContent = allFilesFetched ? ` (${allFilesList.length})` : '';
    }
  }

  function renderAllFiles(files) {
    allFilesList = files || [];
    allFilesFetched = true;
    updateChangesCounts();
    // The two views share one container, so only the active one may draw in it.
    if (changesViewMode !== 'all') return;
    const sig = inlineTreeSig('all', allFilesList);
    if (sig === lastInlineTreeSig && changesInlineTree.childElementCount > 0) return;
    lastInlineTreeSig = sig;
    changesInlineTree.innerHTML = '';
    if (!files || files.length === 0) return;
    const tree = buildFileTree(files);
    renderInlineFileTree(tree, changesInlineTree, 0);
  }

  function renderInlineFileTree(tree, container, depth) {
    const folders = [];
    const fileEntries = [];
    for (const key in tree) {
      if (key.startsWith('__file__')) fileEntries.push({ name: key.replace('__file__', ''), data: tree[key] });
      else folders.push({ name: key, node: tree[key] });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));

    folders.forEach(({ name, node }) => {
      const count = countFilesInNode(node);
      const folder = document.createElement('div');
      folder.className = 'mft-folder';
      const pl = 4 + depth * 10;
      const row = document.createElement('div');
      row.className = 'mft-folder-row';
      row.style.paddingLeft = pl + 'px';
      row.innerHTML = `<span class="mft-chevron"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span>`
        + `<svg class="mft-folder-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`
        + `<span class="mft-folder-name">${escHtml(name)}</span>`
        + `<span class="mft-folder-count">${count}</span>`;
      folder.appendChild(row);
      const children = document.createElement('div');
      children.className = 'mft-children';
      renderInlineFileTree(node, children, depth + 1);
      folder.appendChild(children);
      row.addEventListener('click', () => {
        row.querySelector('.mft-chevron').classList.toggle('collapsed');
        children.classList.toggle('collapsed');
      });
      container.appendChild(folder);
    });

    fileEntries.forEach(({ name, data }) => {
      const file = document.createElement('div');
      file.className = 'mft-file' + (data.staged ? ' staged' : '');
      file.dataset.filepath = data.file;
      const pl = 4 + depth * 10 + 12;
      file.style.paddingLeft = pl + 'px';
      const badgeCode = data.statusCode === '??' ? 'A' : data.statusCode;
      const badgeClass = data.statusCode === '??' ? 'A' : data.statusCode;
      file.innerHTML = (data.staged ? '<span class="mft-staged-icon" title="Staged">&#10003;</span>' : '')
        + `<span class="mft-file-name" title="${escHtml(data.file)}">${escHtml(name)}</span>`
        + `<span class="mft-file-badge ${escHtml(badgeClass)}">${escHtml(badgeCode)}</span>`;
      file.addEventListener('click', () => {
        if (changesViewMode === 'all') {
          state._openChangesModal = true;
        }
        ws.send(JSON.stringify({ type: 'git-file-contents', sessionId: state.activeSessionId, file: data.file }));
      });
      if (changesViewMode === 'changes') {
        file.addEventListener('contextmenu', (e) => showGitCtxMenu(e, data));
      }
      container.appendChild(file);
    });
  }

  // Highlight the selected file in the right-pane changes tree (active tracking).
  function highlightInlineFile(filepath) {
    if (!changesInlineTree || !filepath) return;
    changesInlineTree.querySelectorAll('.mft-file.active').forEach(el => el.classList.remove('active'));
    const sel = (window.CSS && CSS.escape) ? CSS.escape(filepath) : filepath.replace(/"/g, '\\"');
    const el = changesInlineTree.querySelector('.mft-file[data-filepath="' + sel + '"]');
    if (el) el.classList.add('active');
  }

  function renderChangedFiles(files) {
    changesRefreshBtn.classList.remove('spinning');
    changedFilesList = files || [];
    updateChangesCounts();

    if (changesViewMode !== 'changes') return;

    const sig = inlineTreeSig('changes', changedFilesList);
    if (sig === lastInlineTreeSig && changesInlineTree.childElementCount > 0) return;
    lastInlineTreeSig = sig;
    changesInlineTree.innerHTML = '';

    if (!files || files.length === 0) return;

    const tree = buildFileTree(files);
    renderInlineFileTree(tree, changesInlineTree, 0);
  }

  function renderDiff(diff) {
    // no-op, Monaco handles diffs now
  }

  // Handle script list and command output in WS
  // Combined handler: right-panel messages first, then main handler
  wsOnMessageHandler = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'scripts') {
      scriptList.innerHTML = '';
      const session = state.sessions.find(s => s.id === msg.sessionId);
      const rs = session ? state.repoSettings[session.repoPath] : null;
      const hasRepoSettings = rs && (rs.buildCmd || rs.runCmd) && !rs._skipped;

      if (hasRepoSettings) {
        projectTypeLabel.textContent = rs.projectType || 'Project';
        const subdir = rs.buildFolder || '';
        const folderLabel = subdir ? ` (${subdir})` : '';

        if (rs.buildCmd) {
          const btn = document.createElement('button');
          btn.className = 'script-btn';
          btn.innerHTML = `<span class="script-name">Build${escHtml(folderLabel)}</span><span class="script-cmd">${escHtml(rs.buildCmd)}</span>`;
          btn.addEventListener('click', () => runCommand(rs.buildCmd, subdir));
          scriptList.appendChild(btn);
        }
        if (rs.runCmd) {
          const btn = document.createElement('button');
          btn.className = 'script-btn';
          btn.innerHTML = `<span class="script-name">Run${escHtml(folderLabel)}</span><span class="script-cmd">${escHtml(rs.runCmd)}</span>`;
          btn.addEventListener('click', () => runCommand(rs.runCmd, subdir));
          scriptList.appendChild(btn);
        }
      } else {
        const typeNames = {
          node: 'npm', dotnet: '.NET', python: 'Python',
          go: 'Go', rust: 'Rust', maven: 'Maven', gradle: 'Gradle', unknown: 'Scripts'
        };
        projectTypeLabel.textContent = typeNames[msg.projectType] || 'Scripts';

        Object.entries(msg.scripts).forEach(([name, cmd]) => {
          const btn = document.createElement('button');
          btn.className = 'script-btn';
          btn.innerHTML = `<span class="script-name">${escHtml(name)}</span><span class="script-cmd">${escHtml(cmd)}</span>`;
          btn.addEventListener('click', () => runCommand(cmd));
          scriptList.appendChild(btn);
        });
        if (Object.keys(msg.scripts).length === 0) {
          scriptList.innerHTML = '<div class="no-scripts">No scripts detected</div>';
        }
      }
      return;
    }

    if (msg.type === 'cmd-started') {
      // Dispose any existing terminal for this cmdId (shouldn't happen, but defensive)
      if (cmdTerminals[msg.cmdId]) {
        try { cmdTerminals[msg.cmdId].dispose(); } catch {}
        delete cmdTerminals[msg.cmdId];
      }
      cmdOutputContainer.innerHTML = '';
      recentRunCount++;
      updateRecentRunsCount();
      const header = document.createElement('div');
      header.className = 'cmd-header';
      header.textContent = '$ ' + msg.command;
      cmdOutputContainer.appendChild(header);
      const termDiv = document.createElement('div');
      termDiv.className = 'cmd-term';
      termDiv.id = 'cmd-term-' + msg.cmdId;
      cmdOutputContainer.appendChild(termDiv);
      const term = new Terminal({
        fontFamily: "'Fira Code', monospace",
        fontSize: 11,
        theme: getXtermTheme(),
        cursorBlink: false,
        scrollback: 2000,
        convertEol: true,
        rows: 12,
        cols: 60
      });
      attachCopyPasteShortcuts(term, null);
      term.open(termDiv);
      cmdTerminals[msg.cmdId] = term;
      return;
    }

    if (msg.type === 'cmd-output') {
      const term = cmdTerminals[msg.cmdId];
      if (term) term.write(msg.data);
      return;
    }

    if (msg.type === 'cmd-ended') {
      const term = cmdTerminals[msg.cmdId];
      if (term) {
        const color = msg.exitCode === 0 ? '32' : '31';
        term.write(`\r\n\x1b[${color}mExited with code ${msg.exitCode}\x1b[0m\r\n`);
      }
      // Keep the output visible until the next run or the Clear button.
      return;
    }

    if (msg.type === 'session-restarted') {
      const term = state.terminals[msg.sessionId];
      if (term) { try { term.clear(); } catch {} }
      // The respawned PTY starts at its default size — force a resize re-sync
      // (clear the dedupe cache so the current dimensions are re-sent).
      delete _lastSentSize[msg.sessionId];
      if (term && term._fitAddon) {
        try { term._fitAddon.fit(); } catch {}
        sendResize(msg.sessionId, term.cols, term.rows);
      }
      showToast('Session restarted', 'success');
      return;
    }

    if (msg.type === 'session-exported') {
      if (msg.success) {
        showToast('Transcript saved', 'success');
        if (msg.path && window.tauriDesktop?.revealInExplorer) {
          window.tauriDesktop.revealInExplorer(msg.path);
        }
      } else {
        showToast('Export failed: ' + (msg.error || 'unknown'), 'error');
      }
      return;
    }

    if (msg.type === 'git-branch-result') {
      const bn = document.getElementById('branchName');
      if (bn) bn.textContent = msg.branch || '--';
      const sb = document.getElementById('sbBranchName');
      if (sb) sb.textContent = msg.branch || '--';
      return;
    }

    if (msg.type === 'models-list') {
      populateModelDropdown(msg.cli, msg.models);
      return;
    }

    if (msg.type === 'branches') {
      renderBranchList(msg.branches, msg.pruned === true);
      return;
    }

    if (msg.type === 'branch-switched') {
      closeBranchModal();
      // Update right panel branch display
      const bn = document.getElementById('branchName');
      if (bn) bn.textContent = msg.branch;
      // Update branch display widget
      const bd = document.getElementById('branchDisplay');
      if (bd) {
        const nameSpan = bd.querySelector('#branchName');
        if (nameSpan) nameSpan.textContent = msg.branch;
      }
      // Write to terminal
      const term = state.terminals[msg.sessionId];
      if (term) term.write(`\r\n\x1b[92mSwitched to branch: ${msg.branch}\x1b[0m\r\n`);
      return;
    }

    if (msg.type === 'branch-error') {
      const container = $('#branchListContainer');
      const err = document.createElement('div');
      err.className = 'px-5 py-2 text-xs';
      err.style.cssText = 'color:var(--danger)';
      err.textContent = msg.message;
      container.prepend(err);
      setTimeout(() => err.remove(), 4000);
      return;
    }

    if (msg.type === 'subdirs') {
      renderFolderList(msg.path, msg.dirs);
      return;
    }

    if (msg.type === 'git-changed-files') {
      renderChangedFiles(msg.files);
      return;
    }

    if (msg.type === 'save-file-result') {
      monacoSaveBtn.classList.remove('saving');
      if (msg.success) {
        monacoSaveBtn.classList.add('saved');
        monacoSaveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Saved';
        monacoModified = monacoInstance && typeof monacoInstance.getValue === 'function' ? monacoInstance.getValue() : monacoModified;
        const tab = monacoOpenTabs.find(t => t.file === msg.file);
        if (tab) tab.modified = monacoModified;
        setTimeout(() => {
          monacoSaveBtn.classList.remove('saved');
          monacoSaveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save';
        }, 1500);
        if (state.activeSessionId) {
          ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: state.activeSessionId }));
        }
      } else {
        monacoSaveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save';
      }
      return;
    }

    if (msg.type === 'git-all-files') {
      changesRefreshBtn.classList.remove('spinning');
      // Always handled: the count in the All Files label needs this even when the
      // Changes view is the one showing. renderAllFiles itself only draws the
      // tree when its view is active.
      renderAllFiles(msg.files);
      return;
    }

    if (msg.type === 'git-file-diff') {
      renderDiff(msg.diff);
      return;
    }

    if (msg.type === 'git-file-contents') {
      state._openChangesModal = false;
      if (changesViewMode === 'all') monacoMode = 'edit';
      if (!monacoModal.classList.contains('hidden')) {
        // Popup already open → track: swap to the newly selected file in place.
        loadFileInMonaco(msg.file, msg.original, msg.modified);
      } else {
        // Popup closed → open it on the selected file.
        openMonacoModal(msg.file, msg.original, msg.modified);
      }
      highlightInlineFile(msg.file);
      return;
    }

    if (msg.type === 'available-clis') {
      const targetSessionId = msg.sessionId || state.activeSessionId;
      if (!targetSessionId) return;
      const panel = state.chatPanels[targetSessionId];
      if (!panel) return;
      const dropdown = panel.querySelector('.inner-add-dropdown');
      if (!dropdown) return;
      dropdown.innerHTML = '';
      const existingInner = state.innerSessions[targetSessionId] || [];
      (msg.clis || []).forEach(cli => {
        const item = document.createElement('div');
        item.className = 'inner-add-item';
        item.textContent = cli.name;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.add('hidden');
          dropdown.querySelectorAll('.inner-add-item').forEach(i => { i.classList.add('inner-add-disabled'); });
          ws.send(JSON.stringify({ type: 'create-inner-session', parentSessionId: targetSessionId, cliId: cli.id }));
        });
        dropdown.appendChild(item);
      });
      return;
    }

    if (msg.type === 'inner-session-created') {
      const sessionId = msg.parentSessionId || state.activeSessionId;
      if (!sessionId) return;
      const panel = state.chatPanels[sessionId];
      if (!panel) return;
      const innerList = state.innerSessions[sessionId] || [];

      const termEl = document.createElement('div');
      termEl.className = 'terminal-container';
      termEl.id = `inner-term-${msg.innerSessionId}`;
      const view = document.createElement('div');
      view.className = 'inner-view';
      view.dataset.view = `inner:${msg.innerSessionId}`;
      view.appendChild(termEl);
      panel.querySelector('.inner-views').appendChild(view);

      const innerTerm = new Terminal({
        fontFamily: getComputedStyle(document.body).getPropertyValue('--font-terminal')?.trim() || "'Fira Code', monospace",
        fontSize: 13,
        theme: getXtermTheme(),
        cursorBlink: false,
        cursorStyle: 'bar',
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
        windowsPty: /Windows/.test(navigator.userAgent) ? { backend: 'conpty' } : undefined,
      });
      const innerFit = new FitAddon.FitAddon();
      innerTerm.loadAddon(innerFit);
      innerTerm.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => {
        if (window.tauriDesktop?.openExternal) {
          window.tauriDesktop.openExternal(uri);
        } else {
          window.open(uri, '_blank', 'noopener');
        }
      }));
      attachCopyPasteShortcuts(innerTerm, (data) => {
        ws.send(JSON.stringify({ type: 'inner-session-input', innerSessionId: msg.innerSessionId, data }));
      });
      innerTerm.open(termEl);
      innerTerm._fitAddon = innerFit;
      // Fit only after the web font loads (with a cell re-measure) so columns
      // match the display and the CLI's TUI doesn't garble.
      ((document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve()).then(() => {
        if (!termEl.offsetParent) return;
        remeasureAndFit(innerTerm);
        sendInnerResize(msg.innerSessionId, innerTerm.cols, innerTerm.rows);
      });

      innerTerm.onData(data => {
        ws.send(JSON.stringify({ type: 'inner-session-input', innerSessionId: msg.innerSessionId, data }));
      });
      innerTerm.onResize(({ cols, rows }) => {
        ws.send(JSON.stringify({ type: 'inner-session-resize', innerSessionId: msg.innerSessionId, cols, rows }));
      });

      innerList.push({ innerSessionId: msg.innerSessionId, cliId: msg.cliId, cliName: msg.cliName, term: innerTerm });
      state.innerSessions[sessionId] = innerList;

      // If this terminal was created for a run config, remember it so the next
      // Run reuses the same terminal instead of spawning a new one.
      if (msg.clientRef && state._pendingRunConfig && state._pendingRunConfig[msg.clientRef]) {
        const p = state._pendingRunConfig[msg.clientRef];
        delete state._pendingRunConfig[msg.clientRef];
        state.runTerminals = state.runTerminals || {};
        const m = state.runTerminals[p.parentSessionId] = state.runTerminals[p.parentSessionId] || {};
        m[p.configId] = msg.innerSessionId;
      }

      renderInnerTabs(sessionId);
      switchInnerTab(sessionId, `inner:${msg.innerSessionId}`);
      return;
    }

    if (msg.type === 'inner-session-output') {
      for (const sessionId in state.innerSessions) {
        const inner = (state.innerSessions[sessionId] || []).find(s => s.innerSessionId === msg.innerSessionId);
        if (inner && inner.term) { inner.term.write(msg.data); return; }
      }
      return;
    }

    if (msg.type === 'inner-session-ended') {
      for (const sessionId in state.innerSessions) {
        const list = state.innerSessions[sessionId] || [];
        const idx = list.findIndex(s => s.innerSessionId === msg.innerSessionId);
        if (idx >= 0) {
          const inner = list[idx];
          inner.ended = true; // so a re-run spawns a fresh terminal for its config
          if (inner.term) inner.term.write('\r\n\x1b[90mSession ended.\x1b[0m\r\n');
        }
      }
      return;
    }

    if (msg.type === 'repo-files') {
      renderExplorerTree(msg.files || []);
      return;
    }

    if (msg.type === 'file-content') {
      if (state.activeSessionId) {
        openFileInInnerTab(state.activeSessionId, msg.file, msg.content);
      }
      return;
    }

    if (msg.type === 'repo-folders') {
      state.repoFolders = state.repoFolders || {};
      state.repoFolders[msg.repoPath] = msg.folders;
      if (state._folderTargetMode === 'runconfig') {
        populateFolderSelect($('#rcBuildFolder'), msg.folders, state._rcPendingSelected || '');
        state._folderTargetMode = null;
      } else if (state._setupFolderTarget === 'setup') {
        populateFolderSelect($('#setupBuildFolder'), msg.folders, '');
        state._setupFolderTarget = null;
      }
      return;
    }

    if (msg.type === 'work-item-result') {
      taskLoading.classList.add('hidden');
      taskFetchBtn.disabled = false;
      if (msg.success) {
        currentWorkItem = msg.workItem;
        $('#taskDetailId').textContent = `#${msg.workItem.id}`;
        $('#taskDetailState').textContent = msg.workItem.state;
        $('#taskDetailTitle').textContent = msg.workItem.title;
        $('#taskDetailDesc').textContent = msg.workItem.description || '(none)';
        const branchInput = $('#taskBranchInput');
        if (branchInput) branchInput.value = defaultBranchForWorkItem(msg.workItem);
        const commentsEl = $('#taskDetailComments');
        const commentsSection = $('#taskCommentsSection');
        if (msg.workItem.comments && msg.workItem.comments.length > 0) {
          commentsSection.classList.remove('hidden');
          commentsEl.innerHTML = msg.workItem.comments.map(c =>
            `<div class="task-comment"><span class="task-comment-author">${escHtml(c.author)}</span> ${escHtml(c.text)}</div>`
          ).join('');
        } else {
          commentsSection.classList.add('hidden');
        }
        taskDetails.classList.remove('hidden');
      } else {
        taskError.textContent = msg.error || 'Failed to fetch work item';
        taskError.classList.remove('hidden');
      }
      return;
    }

    if (msg.type === 'repo-settings') {
      state.repoSettings[msg.repoPath] = msg.settings;
      // A repo nobody has configured yet gets the first-run setup modal.
      if (!msg.settings) showRepoSetup(msg.repoPath);
      return;
    }

    if (msg.type === 'repo-settings-saved') {
      state.repoSettings[msg.repoPath] = msg.settings;
      return;
    }

    // Forward to main handler (pass already-parsed message to avoid double JSON parse)
    handleWsMessage(msg);
  };

  // ─── COMMAND PALETTE ─────────────────────
  const cmdPalette = $('#cmdPalette');
  const cmdPaletteOverlay = $('#cmdPaletteOverlay');
  const cmdPaletteInput = $('#cmdPaletteInput');
  const cmdPaletteList = $('#cmdPaletteList');
  let cmdPaletteSelected = 0;

  const paletteCommands = [
    { label: 'Open repo…', category: 'NAVIGATE', shortcut: 'Ctrl+O', icon: '›', action: () => showWelcome() },
    { label: 'Switch branch', category: 'GIT', shortcut: 'Ctrl+B', icon: '›', action: () => { $('#branchDisplay')?.click(); }},
    { label: 'Create branch', category: 'GIT', shortcut: '', icon: '›', action: () => { if (state.activeSessionId) ws.send(JSON.stringify({ type: 'input', sessionId: state.activeSessionId, data: 'git checkout -b ' })); }},
    { label: 'Create pull request', category: 'GIT', shortcut: 'Ctrl+P', icon: '›', action: () => { if (state.activeSessionId) { state.watchForPrUrl = { sessionId: state.activeSessionId, startedAt: Date.now() }; sendPromptToClaude(state.activeSessionId, 'Build it, run all tests and then create PR using azure devops cli and give me pr link'); } }},
    { label: 'Git pull', category: 'GIT', shortcut: '', icon: '›', action: () => { if (state.activeSessionId) ws.send(JSON.stringify({ type: 'git-pull', sessionId: state.activeSessionId })); }},
    { label: 'Git push', category: 'GIT', shortcut: '', icon: '›', action: () => { if (state.activeSessionId) ws.send(JSON.stringify({ type: 'git-push', sessionId: state.activeSessionId })); }},
    { label: 'Start with Azure DevOps task…', category: 'DEVOPS', shortcut: 'Ctrl+T', icon: '›', action: () => { $('#startTaskBtn')?.click(); }},
    { label: 'New terminal', category: 'TERMINAL', shortcut: 'Ctrl+N', icon: '›', action: () => { if (state.selectedRepo) ws.send(JSON.stringify({ type: 'create-session', cli: 'terminal', repo: state.selectedRepo.name, repoPath: state.selectedRepo.path, useWorktree: false })); }},
    { label: 'Split terminal', category: 'TERMINAL', shortcut: '', icon: '›', action: () => { if (state.selectedRepo) ws.send(JSON.stringify({ type: 'create-session', cli: 'terminal', repo: state.selectedRepo.name, repoPath: state.selectedRepo.path, useWorktree: false })); }},
    { label: 'Next session', category: 'SESSION', shortcut: 'Ctrl+Shift+]', icon: '›', action: () => cycleSession(1) },
    { label: 'Previous session', category: 'SESSION', shortcut: 'Ctrl+Shift+[', icon: '›', action: () => cycleSession(-1) },
    { label: 'Launch Claude', category: 'AI', shortcut: '', icon: '›', action: () => { if (!state.selectedRepo) return; beginLaunch({ cli: 'claude', repo: state.selectedRepo.name, repoPath: state.selectedRepo.path, useWorktree: false }); }},
    { label: 'Launch Codex', category: 'AI', shortcut: '', icon: '›', action: () => { if (!state.selectedRepo) return; beginLaunch({ cli: 'codex', repo: state.selectedRepo.name, repoPath: state.selectedRepo.path, useWorktree: false }); }},
    { label: 'Launch Gemini', category: 'AI', shortcut: '', icon: '›', action: () => { if (!state.selectedRepo) return; beginLaunch({ cli: 'gemini', repo: state.selectedRepo.name, repoPath: state.selectedRepo.path, useWorktree: false }); }},
    { label: 'Change theme…', category: 'APPEARANCE', shortcut: '', icon: '›', action: () => { showSettings(); setTimeout(() => $('#themeSelect')?.focus(), 100); }},
    { label: 'Change font…', category: 'APPEARANCE', shortcut: '', icon: '›', action: () => { showSettings(); setTimeout(() => $('#fontSelect')?.focus(), 100); }},
    { label: 'Toggle zen mode', category: 'VIEW', shortcut: 'Ctrl+Shift+Z', icon: '›', action: () => toggleZenMode() },
    { label: 'Open settings', category: 'VIEW', shortcut: 'Ctrl+.', icon: '›', action: () => showSettings() },
    { label: 'Git: Refresh Changes', category: 'GIT', shortcut: '', icon: '›', action: () => { if (state.activeSessionId) ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: state.activeSessionId })); }},
    { label: 'Terminal: Clear', category: 'TERMINAL', shortcut: 'Ctrl+L', icon: '›', action: () => { if (state.activeSessionId) ws.send(JSON.stringify({ type: 'input', sessionId: state.activeSessionId, data: '\x0c' })); }},
    { label: 'Terminal: Interrupt', category: 'TERMINAL', shortcut: 'Ctrl+C', icon: '›', action: () => { if (state.activeSessionId) ws.send(JSON.stringify({ type: 'input', sessionId: state.activeSessionId, data: '\x03' })); }},
    { label: 'Session: Close', category: 'SESSION', shortcut: '', icon: '›', action: () => { $('#closeSessionBtn')?.click(); }},
  ];

  function openPalette() {
    cmdPalette.classList.remove('hidden');
    cmdPaletteInput.value = '';
    cmdPaletteSelected = 0;
    renderPaletteList('');
    setTimeout(() => cmdPaletteInput.focus(), 50);
  }

  function closePalette() {
    cmdPalette.classList.add('hidden');
  }

  function renderPaletteList(query) {
    // Trimmed: a trailing space (or a pasted query with one) matched nothing and
    // reported "No commands found".
    const q = query.trim().toLowerCase();
    const filtered = q ? paletteCommands.filter(c => c.label.toLowerCase().includes(q) || (c.category || '').toLowerCase().includes(q)) : paletteCommands;
    cmdPaletteList.innerHTML = '';
    if (filtered.length === 0) {
      cmdPaletteList.innerHTML = '<div class="cmd-palette-empty">No commands found</div>';
      return;
    }
    cmdPaletteSelected = Math.min(cmdPaletteSelected, filtered.length - 1);
    filtered.forEach((cmd, i) => {
      const el = document.createElement('div');
      el.className = 'cmd-palette-item' + (i === cmdPaletteSelected ? ' selected' : '');
      const catHtml = cmd.category ? `<span class="cmd-palette-item-cat">${escHtml(cmd.category)}</span>` : '';
      const shortcutHtml = cmd.shortcut ? `<span class="cmd-palette-item-shortcut">${escHtml(fmtShortcut(cmd.shortcut))}</span>` : '';
      el.innerHTML = `<span class="cmd-palette-item-icon">${cmd.icon}</span>`
        + `<span class="cmd-palette-item-label">${escHtml(cmd.label)}</span>`
        + `<span class="cmd-palette-item-right">${catHtml}${shortcutHtml}</span>`;
      el.addEventListener('click', () => { closePalette(); cmd.action(); });
      el.addEventListener('mouseenter', () => {
        const prevSel = cmdPaletteList.querySelector('.cmd-palette-item.selected');
        if (prevSel) prevSel.classList.remove('selected');
        cmdPaletteSelected = i;
        el.classList.add('selected');
      });
      cmdPaletteList.appendChild(el);
    });
  }

  // Rendered synchronously. This used to be debounced by 60ms, which meant Enter
  // (read from the DOM immediately) fired whatever was selected in the *previous*
  // query's list — type "zen", press Enter fast, and you got "Open repo…" and a
  // trip back to the welcome screen. Filtering a couple of dozen static commands
  // costs nothing, so there is nothing to defer.
  cmdPaletteInput.addEventListener('input', () => {
    cmdPaletteSelected = 0;
    renderPaletteList(cmdPaletteInput.value);
  });

  cmdPaletteInput.addEventListener('keydown', (e) => {
    const items = cmdPaletteList.querySelectorAll('.cmd-palette-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdPaletteSelected = Math.min(cmdPaletteSelected + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle('selected', i === cmdPaletteSelected)); items[cmdPaletteSelected]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cmdPaletteSelected = Math.max(cmdPaletteSelected - 1, 0); items.forEach((el, i) => el.classList.toggle('selected', i === cmdPaletteSelected)); items[cmdPaletteSelected]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter') { e.preventDefault(); items[cmdPaletteSelected]?.click(); }
    if (e.key === 'Escape') closePalette();
  });

  cmdPaletteOverlay.addEventListener('click', closePalette);

  // Switch to the next/previous live session tab (dir = +1 / -1).
  function cycleSession(dir) {
    const list = state.sessions.filter(s => !s.ended);
    if (list.length < 2) return;
    let idx = list.findIndex(s => s.id === state.activeSessionId);
    if (idx === -1) idx = 0;
    const next = list[(idx + dir + list.length) % list.length];
    if (next) switchToSession(next.id);
  }

  document.addEventListener('keydown', (e) => {
    // Command palette toggle — Cmd/Ctrl+Shift+P. Works everywhere.
    if (appMod(e) && e.shiftKey && e.code === 'KeyP') {
      e.preventDefault();
      if (cmdPalette.classList.contains('hidden')) openPalette();
      else closePalette();
      return;
    }
    // While the palette is open it owns the keyboard — except Escape, which has
    // to close it even before the input has focus (openPalette focuses on a
    // 50ms timer, and the input's own handler is all there was).
    if (!cmdPalette.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      return;
    }
    if (!appMod(e)) return;

    // Cmd/Ctrl+Shift chords — no terminal conflict, so allowed everywhere.
    if (e.shiftKey) {
      if (e.code === 'KeyZ') { e.preventDefault(); toggleZenMode(); return; }
      if (e.code === 'BracketRight') { e.preventDefault(); cycleSession(1); return; }
      if (e.code === 'BracketLeft') { e.preventDefault(); cycleSession(-1); return; }
      return;
    }

    // Single-modifier shortcuts. On Win/Linux these share Ctrl with the terminal,
    // so skip while a terminal/input is focused (prevents double-firing and
    // stealing keys such as Ctrl+O, which Claude Code uses to expand files). On
    // macOS the modifier is Cmd (app-level), so they work everywhere.
    if (!IS_MAC && isTypingContext(e)) return;

    switch (e.code) {
      case 'KeyO': e.preventDefault(); paletteCommands.find(c => c.label === 'Open repo…')?.action(); break;
      case 'KeyB': e.preventDefault(); paletteCommands.find(c => c.label === 'Switch branch')?.action(); break;
      case 'KeyP': e.preventDefault(); paletteCommands.find(c => c.label === 'Create pull request')?.action(); break;
      case 'KeyT': e.preventDefault(); paletteCommands.find(c => c.label.startsWith('Start with Azure'))?.action(); break;
      case 'KeyN': e.preventDefault(); paletteCommands.find(c => c.label === 'New terminal')?.action(); break;
      case 'Period': e.preventDefault(); paletteCommands.find(c => c.label === 'Open settings')?.action(); break;
    }
  });

  // ─── FILE EXPLORER ─────────────────────
  const explorerTree = $('#explorerTree');
  const explorerRefreshBtn = $('#explorerRefreshBtn');

  function switchRpTab(pageId) {
    _rpTabs.forEach(t => t.classList.remove('active'));
    _rpPages.forEach(p => p.classList.remove('active'));
    const tab = document.querySelector(`.rp-tab[data-rp-tab="${pageId}"]`);
    const page = $('#' + pageId);
    if (tab) tab.classList.add('active');
    if (page) page.classList.add('active');
  }

  function loadExplorerFiles() {
    if (!state.activeSessionId) return;
    explorerTree.innerHTML = '<div style="font-size:10px;color:var(--text-muted);padding:4px 0">Loading...</div>';
    ws.send(JSON.stringify({ type: 'list-repo-files', sessionId: state.activeSessionId }));
  }

  if (explorerRefreshBtn) explorerRefreshBtn.addEventListener('click', loadExplorerFiles);

  function renderExplorerTree(files) {
    explorerTree.innerHTML = '';
    const tree = {};
    files.forEach(f => {
      const parts = f.path.split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = { _type: 'dir', _children: {} };
        node = node[parts[i]]._children;
      }
      const name = parts[parts.length - 1];
      if (f.type === 'dir') {
        if (!node[name]) node[name] = { _type: 'dir', _children: {} };
      } else {
        node[name] = { _type: 'file', _path: f.path };
      }
    });

    function renderNode(obj, container, depth) {
      const dirs = [];
      const fileEntries = [];
      for (const key in obj) {
        if (obj[key]._type === 'dir') dirs.push({ name: key, node: obj[key] });
        else if (obj[key]._type === 'file') fileEntries.push({ name: key, data: obj[key] });
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      fileEntries.sort((a, b) => a.name.localeCompare(b.name));

      dirs.forEach(({ name, node }) => {
        const wrapper = document.createElement('div');
        const row = document.createElement('div');
        row.className = 'exp-item dir';
        row.style.paddingLeft = (6 + depth * 14) + 'px';
        row.innerHTML = `<span class="exp-chevron"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span>`
          + `<span class="exp-item-icon folder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></span>`
          + `<span class="exp-item-name">${escHtml(name)}</span>`;
        wrapper.appendChild(row);
        const children = document.createElement('div');
        children.className = 'exp-children collapsed';
        renderNode(node._children, children, depth + 1);
        wrapper.appendChild(children);
        row.addEventListener('click', () => {
          row.querySelector('.exp-chevron').classList.toggle('collapsed');
          children.classList.toggle('collapsed');
        });
        container.appendChild(wrapper);
      });

      fileEntries.forEach(({ name, data }) => {
        const row = document.createElement('div');
        row.className = 'exp-item file';
        row.style.paddingLeft = (6 + depth * 14 + 12) + 'px';
        row.innerHTML = `<span class="exp-item-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>`
          + `<span class="exp-item-name">${escHtml(name)}</span>`;
        row.addEventListener('click', () => {
          ws.send(JSON.stringify({ type: 'read-file', sessionId: state.activeSessionId, file: data._path }));
        });
        container.appendChild(row);
      });
    }

    renderNode(tree, explorerTree, 0);
  }

  // ─── STATUS BAR ─────────────────────
  const statusbar = $('#statusbar');
  const sbBranchName = $('#sbBranchName');
  const sbChanges = $('#sbChanges');
  const sbUptime = $('#sbUptime');
  const sbZenBtn = $('#sbZenBtn');
  state.sessionStartTime = {};

  function updateStatusBar() {
    if (!state.activeSessionId) return;
    const bn = document.getElementById('branchName');
    if (bn && sbBranchName) sbBranchName.textContent = bn.textContent || '--';
    if (sbChanges) sbChanges.textContent = (changedFilesList.length || 0) + ' changes';
    if (sbUptime) {
      const start = state.sessionStartTime[state.activeSessionId];
      if (start) {
        const s = Math.floor((Date.now() - start) / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        sbUptime.textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
      }
    }
  }

  // Combined status bar + git polling on a single 15s interval
  // (git-all-files is requested on-demand instead: on view switch and after terminal output)
  setInterval(() => {
    if (document.hidden) return;
    updateStatusBar();
    if (!state.activeSessionId || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'git-branch', sessionId: state.activeSessionId }));
    ws.send(JSON.stringify({ type: 'git-changed-files', sessionId: state.activeSessionId }));
    // Context and cost move with every model turn, so refresh them while the
    // Manage page is the one on screen — and only then, since it means a file read.
    if (document.querySelector('#rpPageManage.active')) {
      updateManageInfo();
      requestSessionUsage();
    }
  }, 15000);

  // ─── ZEN MODE ─────────────────────
  let zenMode = false;

  function toggleZenMode() {
    zenMode = !zenMode;
    document.body.classList.toggle('zen-mode', zenMode);
    const term = state.terminals[state.activeSessionId];
    if (term && term._fitAddon) setTimeout(() => { try { term._fitAddon.fit(); } catch {} }, 50);
  }

  sbZenBtn?.addEventListener('click', toggleZenMode);
  // (Zen toggle keyboard shortcut Cmd/Ctrl+Shift+Z is handled in the global
  // keydown handler alongside the other app shortcuts.)

  // ─── TAB DRAG-TO-REORDER ─────────────────────
  let dragSrcTab = null;

  function enableTabDrag() {
    const tabs = sessionList.querySelectorAll('.session-item');
    tabs.forEach(tab => {
      tab.setAttribute('draggable', 'true');
      tab.addEventListener('dragstart', (e) => {
        dragSrcTab = tab;
        tab.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      tab.addEventListener('dragend', () => {
        tab.style.opacity = '';
        dragSrcTab = null;
        sessionList.querySelectorAll('.session-item').forEach(t => t.classList.remove('drag-over'));
      });
      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tab.classList.add('drag-over');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        if (!dragSrcTab || dragSrcTab === tab) return;
        const allTabs = [...sessionList.querySelectorAll('.session-item')];
        const fromIdx = allTabs.indexOf(dragSrcTab);
        const toIdx = allTabs.indexOf(tab);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = state.sessions.splice(fromIdx, 1);
        state.sessions.splice(toIdx, 0, moved);
        renderSessions();
      });
    });
  }

  const origRenderSessions = renderSessions;
  // Patch renderSessions to add drag support
  const _origRenderBody = renderSessions;

  // Show/hide statusbar with topbar
  const origUpdateSidebar = updateSidebarVisibility;
  const _origUpdateSidebarVisibility = updateSidebarVisibility;

  // ─── WS HANDLERS FOR NEW FEATURES ─────────────────────

  // Start the WebSocket connection
  connectWebSocket();
})();
