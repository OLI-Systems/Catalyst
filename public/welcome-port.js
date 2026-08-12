// ═════════════════════════════════════════════════════════════════
// Catalyst — Welcome Port (welcome-port.js)
// Enhances the existing welcome screen with the refined design.
// Loads AFTER app.js. Uses MutationObservers — no app.js changes.
// ═════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const RECENT_KEY = 'catalyst-recent-repos-v1';
  const RECENT_MAX = 4;

  // Slugify a tech label for the data-tech attribute (matches CSS rules).
  function techSlug(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function initials(name) {
    const clean = String(name || '').replace(/[^a-zA-Z0-9]/g, ' ').trim();
    const parts = clean.split(/\s+|(?=[A-Z])/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase();
  }

  function svg(name) {
    const s = (path) => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    switch (name) {
      case 'search': return s('<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>');
      case 'clock':  return s('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');
      case 'folder': return s('<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>');
    }
    return '';
  }

  // ─── Recent repos ────────────────────────────────────────────
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }
  function pushRecent(repo, cli) {
    const list = getRecent().filter(r => r.path !== repo.path);
    list.unshift({ name: repo.name, path: repo.path, cli: cli || null, at: Date.now() });
    while (list.length > RECENT_MAX) list.pop();
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }
  window._catalystPushRecent = pushRecent;
  window._catalystRenderRecent = function() { renderRecent(); };
  function relTime(ts) {
    const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60)   return sec + 's ago';
    if (sec < 3600) return Math.floor(sec/60)  + 'm ago';
    if (sec < 86400)return Math.floor(sec/3600)+ 'h ago';
    return Math.floor(sec/86400) + 'd ago';
  }

  var CLI_LOGOS = {
    claude: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757"/></svg>',
    codex: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M13.796 23.785a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" fill="#10a37f"/></svg>',
    gemini: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#4285F4"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    copilot: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 0C5.373 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297 24 5.373 18.627 0 12 0" fill="currentColor"/></svg>'
  };

  function renderRecent() {
    const wrap = document.getElementById('portRecent');
    if (!wrap) return;
    const list = getRecent();
    if (!list.length) {
      wrap.classList.remove('has-items');
      wrap.querySelector('.port-recent-row').innerHTML = '<span class="port-recent-empty">Recently opened repos will appear here</span>';
      return;
    }
    wrap.classList.add('has-items');
    wrap.querySelector('.port-recent-row').innerHTML = list.map(r => {
      const logo = r.cli && CLI_LOGOS[r.cli] ? CLI_LOGOS[r.cli] : svg('clock');
      return `<button class="port-recent-chip" data-path="${escapeHtml(r.path)}" data-cli="${escapeHtml(r.cli)}" type="button">
        ${logo}
        <span>${escapeHtml(r.name)}</span>
        <span class="when">· ${relTime(r.at)}</span>
        <span class="port-recent-remove" title="Remove">&times;</span>
      </button>`;
    }).join('');
    wrap.querySelectorAll('.port-recent-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const repoPath = chip.dataset.path;
        const repoName = chip.querySelector('span')?.textContent?.trim() || '';
        const cli = chip.dataset.cli || 'claude';
        if (window._catalystOpenSession) {
          window._catalystOpenSession(repoPath, repoName, cli);
        } else if (repoPath && window._catalystWs && window._catalystWs.readyState === WebSocket.OPEN) {
          window._catalystWs.send(JSON.stringify({
            type: 'create-session',
            cli: cli,
            repo: repoName,
            repoPath: repoPath,
            useWorktree: false
          }));
        }
      });
    });
    wrap.querySelectorAll('.port-recent-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = btn.closest('.port-recent-chip');
        const path = chip?.dataset.path;
        if (path) {
          const list = getRecent().filter(r => r.path !== path);
          localStorage.setItem(RECENT_KEY, JSON.stringify(list));
          renderRecent();
        }
      });
    });
  }

  // Must escape quotes too — these values are interpolated into quoted
  // attributes (data-path="…"), which textContent/innerHTML does not cover.
  const _HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => _HTML_ESC[c]);
  }

  // ─── Inject hero + filter + footer into welcome ──────────────
  function buildWelcomeChrome() {
    const welcome = document.getElementById('welcomeScreen');
    if (!welcome || welcome.dataset.port === 'v1') return;
    welcome.dataset.port = 'v1';

    // Wrap children in a max-width container if not already.
    let inner = welcome.querySelector('.welcome-card');
    if (!inner) return;
    inner.classList.add('welcome-inner');

    // Replace original .welcome-glow / .welcome-logo-icon / .welcome-title / .welcome-sub / .welcome-desc
    const existingGlow = inner.querySelector('.welcome-glow'); existingGlow?.remove();
    const existingLogo = inner.querySelector('.welcome-logo-icon'); existingLogo?.remove();
    const existingTitle = inner.querySelector('.welcome-title'); existingTitle?.remove();
    const existingSub = inner.querySelector('.welcome-sub'); existingSub?.remove();
    const existingDesc = inner.querySelector('.welcome-desc'); existingDesc?.remove();

    const hero = document.createElement('div');
    hero.className = 'port-hero';
    hero.innerHTML = `
      <div class="port-mark"><svg viewBox="0 0 32 32" width="40" height="40"><g fill="none" stroke="var(--catalyst-logo)" stroke-width="2.2" stroke-linejoin="round"><path d="M16 6 L24.66 11 L24.66 21 L16 26 L7.34 21 L7.34 11 Z"/><line x1="16" y1="6" x2="16" y2="3.4"/></g><circle cx="16" cy="16" r="1.5" fill="var(--catalyst-logo)" opacity="0.4"/><circle cx="16" cy="2.4" r="2" fill="var(--catalyst-logo)"/></svg></div>
      <div class="port-title">CATALYST</div>
      <div class="port-sub">Many minds · one workspace · you're in command</div>
    `;
    inner.insertBefore(hero, inner.firstChild);

    // Recent placeholder (after folder-input-group, inside welcome-inner)
    const folderGroup2 = inner.querySelector('.folder-input-group');
    const repoSection = document.getElementById('repoSection');

    if (folderGroup2 && !document.getElementById('portRecent')) {
      const recent = document.createElement('div');
      recent.id = 'portRecent';
      recent.className = 'port-recent';
      recent.innerHTML = `
        <div class="eyebrow">Recent</div>
        <div class="port-recent-row"></div>
      `;
      folderGroup2.parentNode.insertBefore(recent, folderGroup2.nextSibling);
    }
    if (repoSection && !repoSection.querySelector('.port-section-head')) {
      const head = document.createElement('div');
      head.className = 'port-section-head';
      head.innerHTML = `
        <div class="eyebrow">Git Repositories</div>
        <label class="port-filter">
          ${svg('search')}
          <input id="portFilter" type="text" placeholder="Filter…" autocomplete="off" spellcheck="false" />
          <span class="count" id="portFilterCount"></span>
        </label>
      `;
      repoSection.insertBefore(head, repoSection.firstChild);
      let _portFilterTimer = null;
      head.querySelector('#portFilter').addEventListener('input', (e) => {
        clearTimeout(_portFilterTimer);
        _portFilterTimer = setTimeout(() => applyFilter(e.target.value.trim().toLowerCase()), 80);
      });
    }

    // Footer status replacement
    const footer = inner.querySelector('.welcome-footer');
    if (footer) {
      footer.innerHTML = `
        <span>© ${new Date().getFullYear()} OLI Systems · Catalyst v1.0.0</span>
        <span class="port-status" id="portStatus"></span>
      `;
    }

    renderRecent();
  }

  function applyFilter(q) {
    const grid = document.getElementById('repoGrid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.repo-card');
    let visible = 0;
    cards.forEach(c => {
      const name = (c.querySelector('.repo-card-name')?.textContent || '').toLowerCase();
      const tech = (c.querySelector('.repo-card-tech')?.textContent || '').toLowerCase();
      const match = !q || name.includes(q) || tech.includes(q);
      if (match) { c.style.removeProperty('display'); c.classList.remove('port-hidden'); }
      else { c.style.setProperty('display', 'none', 'important'); c.classList.add('port-hidden'); }
      if (match) visible++;
    });
    const countEl = document.getElementById('portFilterCount');
    if (countEl) countEl.textContent = `${visible}/${cards.length}`;
    // Say so when nothing matched. Without this the grid just collapsed to a few
    // blank pixels and only the counter hinted at what had happened.
    let emptyEl = document.getElementById('portFilterEmpty');
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.id = 'portFilterEmpty';
      emptyEl.className = 'no-repos';
      grid.parentNode.insertBefore(emptyEl, grid.nextSibling);
    }
    emptyEl.textContent = q ? `No repositories match "${q}".` : '';
    emptyEl.style.display = (q && visible === 0) ? '' : 'none';
    const statusEl = document.getElementById('portStatus');
    if (statusEl) statusEl.textContent = `${cards.length} repos · click to launch`;
  }

  // ─── Enhance repo cards (split tech list into colored chips) ─
  function enhanceCard(card) {
    if (!card || card.dataset.portEnhanced) return;
    card.dataset.portEnhanced = '1';

    const techSpan = card.querySelector('.repo-card-tech');
    if (techSpan) {
      const raw = (techSpan.textContent || '').trim();
      if (raw) {
        const parts = raw.split(/\s*·\s*/).filter(Boolean);
        techSpan.innerHTML = parts.map((t, i) => {
          const slug = techSlug(t);
          const sep = i > 0 ? '<span class="sep">·</span>' : '';
          return `${sep}<span data-tech-chip="${slug}">${escapeHtml(t)}</span>`;
        }).join('');
      }
    }

    // Recent tracking moved to session-created handler in app.js
  }

  function enhanceAllCards() {
    const grid = document.getElementById('repoGrid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.repo-card');
    cards.forEach(enhanceCard);
    const filterInput = document.getElementById('portFilter');
    const filterVal = filterInput ? filterInput.value.trim().toLowerCase() : '';
    if (filterVal) {
      applyFilter(filterVal);
    } else {
      const total = cards.length;
      const countEl = document.getElementById('portFilterCount');
      if (countEl) countEl.textContent = `${total}/${total}`;
      const statusEl = document.getElementById('portStatus');
      if (statusEl) statusEl.textContent = total ? `${total} repos · click to launch` : '—';
    }
  }

  // ─── Sparkline rendering ──────────────────────────────────────
  function renderSparkline(name) {
    const el = document.getElementById('portSparkline');
    if (!el) return;
    const seed = [...(name || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0);
    const data = Array.from({length: 14}, (_, i) => {
      const v = Math.sin(seed + i * 1.7) * 0.5 + 0.5;
      return Math.max(0, Math.round(v * 12 + (i === 13 ? 4 : 0)));
    });
    const total = data.reduce((a, b) => a + b, 0);
    const max = Math.max(...data, 1);
    const w = 120, h = 32, barW = w / data.length;
    const bars = data.map((v, i) => {
      const bh = (v / max) * (h - 4);
      const color = v === 0 ? 'var(--port-text-dim)' : i === data.length - 1 ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 60%, transparent)';
      const op = v === 0 ? 0.3 : (0.4 + 0.6 * (i / data.length));
      return `<rect x="${i * barW + 1}" y="${h - bh - 1}" width="${barW - 2}" height="${Math.max(bh, 1)}" rx="1" fill="${color}" opacity="${op}"/>`;
    }).join('');
    el.innerHTML = `
      <div class="sparkline-row">
        <svg class="sparkline-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:${w}px;height:${h}px">${bars}</svg>
        <div class="sparkline-meta">
          <span class="sparkline-num">${total}</span>
          <span class="sparkline-lbl">Commits · last 7 days</span>
        </div>
      </div>
    `;
  }

  // ─── Snapshot rendering for the right pane ────────────────────
  function renderSnapshot(info) {
    const el = document.getElementById('portSnapshot');
    if (!el || !info) return;
    const branch = info.branch || 'main';
    const changes = info.changes || 0;
    const branches = info.branches || 1;
    const behind = info.behind || 0;
    const ahead = info.ahead || 0;
    const lastCommit = info.lastCommit || '—';

    let syncText = 'up to date';
    if (ahead > 0 && behind > 0) syncText = `${ahead}↑ ${behind}↓`;
    else if (ahead > 0) syncText = `${ahead} ahead`;
    else if (behind > 0) syncText = `${behind} behind`;

    el.innerHTML = `
      <div class="snap-label">Snapshot</div>
      <div class="snap-card">
        <div class="snap-row">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
          <span class="snap-key">${escapeHtml(branch)}</span>
          <span class="snap-sync ${behind > 0 ? 'warn' : ''}">${syncText}</span>
        </div>
        <div class="snap-divider"></div>
        <div class="snap-row">
          <span class="snap-dot ${changes > 0 ? 'has-changes' : ''}"></span>
          <span class="snap-key">${changes > 0 ? changes + ' uncommitted changes' : 'Working tree clean'}</span>
        </div>
        <div class="snap-stats">
          <div class="snap-stat"><span class="num">${branches}</span><span class="lbl">Branches</span></div>
          <div class="snap-stat"><span class="num">0</span><span class="lbl">Open PRs</span></div>
          <div class="snap-stat"><span class="num">${escapeHtml(lastCommit)}</span><span class="lbl">Last Open</span></div>
        </div>
      </div>
    `;
  }

  // ─── Enhance the CLI picker info panel ───────────────────────
  function enhanceInfoPanel() {
    const panel = document.getElementById('repoInfoPanel');
    if (!panel) return;

    const nameEl = document.getElementById('repoInfoName');
    if (!nameEl) return;

    const name = (nameEl.textContent || '').trim();
    if (!name) return;

    // Re-decorate only when the name changes.
    if (panel.dataset.portFor === name) return;
    panel.dataset.portFor = name;

    // Clean up any previous port decorations
    panel.querySelectorAll('.port-id-row, .port-path').forEach(n => {
      // unwrap the name back to its original parent first if needed
      const inside = n.querySelector('#repoInfoName');
      if (inside) panel.insertBefore(inside, n);
      n.remove();
    });

    // Build the new id row (monogram + name slot) and move the existing
    // #repoInfoName INTO the slot so app.js can still update it.
    const idRow = document.createElement('div');
    idRow.className = 'port-id-row';
    idRow.innerHTML = `
      <div class="port-monogram">${escapeHtml(initials(name))}<span class="glint"></span></div>
      <div class="port-name-slot" style="flex:1; min-width:0;"></div>
    `;

    // Build the breadcrumb path
    const pathEl = document.createElement('div');
    pathEl.className = 'port-path';
    pathEl.innerHTML = `
      ${svg('folder')}
      <span>~</span><span class="sep">/</span>
      <span>source</span><span class="sep">/</span>
      <span>repos</span><span class="sep">/</span>
      <span class="cwd">${escapeHtml(name)}</span>
    `;

    // Insert idRow before the name, then move the name inside the slot,
    // then insert the path right after the idRow.
    nameEl.parentNode.insertBefore(idRow, nameEl);
    idRow.querySelector('.port-name-slot').appendChild(nameEl);
    idRow.parentNode.insertBefore(pathEl, idRow.nextSibling);
  }

  // Re-apply when name changes (i.e. user clicks a different repo)
  function watchInfoPanel() {
    const panel = document.getElementById('repoInfoPanel');
    if (!panel) return;

    let _infoPanelTimer = null;
    const obs = new MutationObserver(() => {
      if (_infoPanelTimer) return;
      _infoPanelTimer = requestAnimationFrame(() => {
        _infoPanelTimer = null;
        enhanceInfoPanel(); // idempotent — uses panel.dataset.portFor to dedupe

        // Tag info chips with data-tech (idempotent)
        panel.querySelectorAll('.repo-info-tag').forEach(t => {
          if (!t.dataset.tech) t.dataset.tech = techSlug(t.textContent);
        });
      });
    });

    obs.observe(panel, { childList: true, subtree: true, characterData: true });
  }

  function watchRepoGrid() {
    const grid = document.getElementById('repoGrid');
    if (!grid) return;
    let _enhanceTimer = null;
    const obs = new MutationObserver(() => {
      if (_enhanceTimer) return;
      _enhanceTimer = requestAnimationFrame(() => {
        _enhanceTimer = null;
        enhanceAllCards();
      });
    });
    obs.observe(grid, { childList: true });
  }

  function init() {
    buildWelcomeChrome();
    enhanceAllCards();
    enhanceInfoPanel();
    watchRepoGrid();
    watchInfoPanel();

    // Hook into populateRepoInfoPanel to render snapshot
    const tagsEl = document.getElementById('repoInfoTags');
    if (tagsEl) {
      new MutationObserver(() => {
        if (window.__lastRepoInfo) {
          renderSnapshot(window.__lastRepoInfo);
        }
        const nameEl = document.getElementById('repoInfoName');
        if (nameEl) renderSparkline(nameEl.textContent);
      }).observe(tagsEl, { childList: true });
    }

  }

  // Expose renderSnapshot globally so app.js or other scripts can call it directly
  window.__portRenderSnapshot = renderSnapshot;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
