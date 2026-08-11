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
  function pushRecent(repo) {
    const list = getRecent().filter(r => r.path !== repo.path);
    list.unshift({ name: repo.name, path: repo.path, at: Date.now() });
    while (list.length > RECENT_MAX) list.pop();
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }
  function relTime(ts) {
    const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60)   return sec + 's ago';
    if (sec < 3600) return Math.floor(sec/60)  + 'm ago';
    if (sec < 86400)return Math.floor(sec/3600)+ 'h ago';
    return Math.floor(sec/86400) + 'd ago';
  }

  function renderRecent() {
    const wrap = document.getElementById('portRecent');
    if (!wrap) return;
    const list = getRecent();
    if (!list.length) { wrap.classList.remove('has-items'); return; }
    wrap.classList.add('has-items');
    wrap.querySelector('.port-recent-row').innerHTML = list.map(r => `
      <button class="port-recent-chip" data-path="${r.path}" type="button">
        ${svg('clock')}
        <span>${escapeHtml(r.name)}</span>
        <span class="when">· ${relTime(r.at)}</span>
      </button>
    `).join('');
    wrap.querySelectorAll('.port-recent-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const card = [...document.querySelectorAll('#repoGrid .repo-card')]
          .find(c => c._repoPath === chip.dataset.path);
        if (card) card.click();
      });
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
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
      <div class="port-mark"><span>C<span class="cursor"></span></span></div>
      <div class="port-title">CATALYST</div>
      <div class="port-sub">Many minds · one workspace · you're in command</div>
    `;
    inner.insertBefore(hero, inner.firstChild);

    // Section head for the repo grid — Recent goes inside repoSection
    const repoSection = document.getElementById('repoSection');

    // Recent placeholder (inside repoSection, before the grid)
    if (repoSection && !document.getElementById('portRecent')) {
      const recent = document.createElement('div');
      recent.id = 'portRecent';
      recent.className = 'port-recent';
      recent.innerHTML = `
        <div class="eyebrow">Recent</div>
        <div class="port-recent-row"></div>
      `;
      repoSection.insertBefore(recent, repoSection.querySelector('.repo-grid'));
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
      head.querySelector('#portFilter').addEventListener('input', (e) => {
        applyFilter(e.target.value.trim().toLowerCase());
      });
    }

    // Footer status replacement
    const footer = inner.querySelector('.welcome-footer');
    if (footer) {
      footer.innerHTML = `
        <span>© 2026 OLI, Inc. · v1.2.0</span>
        <span class="port-status" id="portStatus">—</span>
      `;
    }

    renderRecent();
  }

  function applyFilter(q) {
    const cards = document.querySelectorAll('#repoGrid .repo-card');
    let visible = 0;
    cards.forEach(c => {
      const name = (c.querySelector('.repo-card-name')?.textContent || '').toLowerCase();
      const tech = (c.querySelector('.repo-card-tech')?.textContent || '').toLowerCase();
      const match = !q || name.includes(q) || tech.includes(q);
      c.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    const countEl = document.getElementById('portFilterCount');
    if (countEl) countEl.textContent = `${visible}/${cards.length}`;
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

    // Track recent on click
    card.addEventListener('click', () => {
      if (card._repoPath) {
        pushRecent({ name: card.querySelector('.repo-card-name')?.firstChild?.textContent?.trim(), path: card._repoPath });
        renderRecent();
      }
    }, { capture: true });
  }

  function enhanceAllCards() {
    document.querySelectorAll('#repoGrid .repo-card').forEach(enhanceCard);
    const countEl = document.getElementById('portFilterCount');
    if (countEl) {
      const total = document.querySelectorAll('#repoGrid .repo-card').length;
      countEl.textContent = `${total}/${total}`;
    }
    const statusEl = document.getElementById('portStatus');
    if (statusEl) {
      const total = document.querySelectorAll('#repoGrid .repo-card').length;
      statusEl.textContent = total ? `${total} repos · click to launch` : '—';
    }
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

    const obs = new MutationObserver(() => {
      enhanceInfoPanel(); // idempotent — uses panel.dataset.portFor to dedupe

      // Tag info chips with data-tech (idempotent)
      panel.querySelectorAll('.repo-info-tag').forEach(t => {
        if (!t.dataset.tech) t.dataset.tech = techSlug(t.textContent);
      });
    });

    obs.observe(panel, { childList: true, subtree: true, characterData: true });
  }

  function watchRepoGrid() {
    const grid = document.getElementById('repoGrid');
    if (!grid) return;
    const obs = new MutationObserver(() => enhanceAllCards());
    obs.observe(grid, { childList: true, subtree: true });
  }

  function init() {
    buildWelcomeChrome();
    enhanceAllCards();
    enhanceInfoPanel();
    watchRepoGrid();
    watchInfoPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
