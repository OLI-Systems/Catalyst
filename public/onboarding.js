(function () {
  'use strict';

  var ONBOARDED_KEY = 'catalyst-onboarded';
  if (localStorage.getItem(ONBOARDED_KEY)) {
    var el = document.getElementById('obOverlay');
    if (el) el.classList.add('hidden');
    return;
  }

  var overlay = document.getElementById('obOverlay');
  if (!overlay) return;

  var TOTAL_STEPS = 10;
  var currentStep = 0;
  var transitioning = false;

  // Steps that need work done on arrival. Named because screens get inserted
  // in the middle of the wizard, and bare indices break silently when they do.
  var STEP_TOOLS = 3;
  var STEP_DONE = TOTAL_STEPS - 1;

  var dots = overlay.querySelectorAll('.ob-dot');
  var screens = overlay.querySelectorAll('.ob-screen');
  var scroller = overlay.querySelector('.ob-screens');
  var btnBack = document.getElementById('obBack');
  var btnNext = document.getElementById('obNext');
  var stepLabel = document.getElementById('obStepLabel');

  var NEXT_LABELS = ["Let's Go", 'Next', 'Next', 'Next', 'Next', 'Next', 'Next', 'Next', 'Next', 'Launch Catalyst'];

  function updateNav() {
    btnBack.classList.toggle('hidden', currentStep === 0);
    btnNext.textContent = NEXT_LABELS[currentStep] || 'Next';
    stepLabel.textContent = (currentStep + 1) + ' of ' + TOTAL_STEPS;
    dots.forEach(function (d, i) {
      d.classList.remove('active', 'completed');
      if (i === currentStep) d.classList.add('active');
      else if (i < currentStep) d.classList.add('completed');
    });
  }

  function goTo(step, direction) {
    if (transitioning || step === currentStep || step < 0 || step >= TOTAL_STEPS) return;
    transitioning = true;

    var from = screens[currentStep];
    var to = screens[step];
    var fwd = direction === undefined ? step > currentStep : direction === 'forward';

    from.classList.add(fwd ? 'slide-out-left' : 'slide-out-right');

    setTimeout(function () {
      from.classList.remove('active', 'slide-out-left', 'slide-out-right');
      to.classList.add('active', fwd ? 'slide-in-right' : 'slide-in-left');
      currentStep = step;
      updateNav();

      // The scroller is shared by every screen, so a tall screen leaves it
      // parked halfway down and the next one opens mid-content.
      if (scroller) scroller.scrollTop = 0;

      if (currentStep === STEP_DONE) buildSummary();
      if (currentStep === STEP_TOOLS) checkCliAvailability();

      setTimeout(function () {
        to.classList.remove('slide-in-right', 'slide-in-left');
        transitioning = false;
      }, 360);
    }, 250);
  }

  var obFinished = false;

  function finishOnboarding() {
    obFinished = true;
    localStorage.setItem(ONBOARDED_KEY, Date.now().toString());
    savePilotSettings();
    saveFocusGuard();
    saveAzureIfNeeded();

    // Detach listeners so the onboarding closure/DOM can be garbage collected
    document.removeEventListener('keydown', obKeydownHandler);
    if (obWsListenerTarget) {
      obWsListenerTarget.removeEventListener('message', obWsMessageHandler);
      obWsListenerTarget = null;
    }

    overlay.classList.add('ob-exiting');
    setTimeout(function () {
      overlay.classList.add('hidden');
      overlay.remove();
    }, 550);
  }

  // Navigation events
  btnNext.addEventListener('click', function () {
    if (currentStep === TOTAL_STEPS - 1) finishOnboarding();
    else goTo(currentStep + 1);
  });
  btnBack.addEventListener('click', function () { goTo(currentStep - 1); });
  dots.forEach(function (d, i) {
    d.addEventListener('click', function () { goTo(i); });
  });

  // Keyboard
  function obKeydownHandler(e) {
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') { e.target.blur(); return; }
      return;
    }
    if (e.key === 'Enter') btnNext.click();
    else if (e.key === 'ArrowLeft' || (e.altKey && e.key === 'ArrowLeft')) goTo(currentStep - 1);
    else if (e.key === 'ArrowRight') goTo(currentStep + 1);
  }
  document.addEventListener('keydown', obKeydownHandler);

  // ─── Screen 1: Appearance ────────────────────────────────
  var activeTheme = localStorage.getItem('catalyst-theme') || 'midnight';
  var obSwatches = overlay.querySelectorAll('.ob-theme-swatch');
  obSwatches.forEach(function (sw) {
    if (sw.dataset.theme === activeTheme) sw.classList.add('active');
    sw.addEventListener('click', function () {
      obSwatches.forEach(function (s) { s.classList.remove('active'); });
      sw.classList.add('active');
      activeTheme = sw.dataset.theme;
      if (window._catalystApplyTheme) window._catalystApplyTheme(activeTheme);
    });
  });

  // Font size
  var obFontSize = parseInt(localStorage.getItem('catalyst-font-size')) || 13;
  var obFontSizeVal = document.getElementById('obFontSizeVal');
  var obPreview = document.getElementById('obFontPreview');

  function updateFontPreview() {
    if (obFontSizeVal) obFontSizeVal.textContent = obFontSize;
    if (obPreview) obPreview.style.fontSize = obFontSize + 'px';
  }

  document.getElementById('obFontSizeUp')?.addEventListener('click', function () {
    obFontSize = Math.min(24, obFontSize + 1);
    localStorage.setItem('catalyst-font-size', obFontSize);
    if (window._catalystApplyFont) { window._catalystApplyFont.setSize(obFontSize); window._catalystApplyFont.apply(); }
    updateFontPreview();
  });
  document.getElementById('obFontSizeDown')?.addEventListener('click', function () {
    obFontSize = Math.max(9, obFontSize - 1);
    localStorage.setItem('catalyst-font-size', obFontSize);
    if (window._catalystApplyFont) { window._catalystApplyFont.setSize(obFontSize); window._catalystApplyFont.apply(); }
    updateFontPreview();
  });

  // Font family
  var obFontSelect = document.getElementById('obFontFamily');
  if (obFontSelect) {
    obFontSelect.addEventListener('change', function () {
      var val = obFontSelect.value;
      var selected = obFontSelect.options[obFontSelect.selectedIndex];
      var isRetina = selected.dataset.note === 'retina';
      localStorage.setItem('catalyst-font-family', val);
      localStorage.setItem('catalyst-font-retina', isRetina ? 'true' : 'false');
      if (window._catalystApplyFont) { window._catalystApplyFont.setFamily(val); window._catalystApplyFont.apply(); }
      if (obPreview) obPreview.style.fontFamily = val;
    });
  }

  updateFontPreview();

  // ─── Screen 2: Workspace ─────────────────────────────────
  var obFolderInput = document.getElementById('obFolderInput');
  var obBrowseBtn = document.getElementById('obBrowseBtn');
  var obScanHint = document.getElementById('obScanHint');
  var obRepoChips = document.getElementById('obRepoChips');
  var obRepoCount = 0;

  // Wait for WS to be ready
  var wsCheckInterval = setInterval(function () {
    if (window._catalystWs && window._catalystWs.readyState === 1) {
      if (obBrowseBtn) obBrowseBtn.disabled = false;
      clearInterval(wsCheckInterval);
    }
  }, 200);

  if (obBrowseBtn) {
    obBrowseBtn.disabled = true;
    obBrowseBtn.addEventListener('click', function () {
      if (window.tauriDesktop && window.tauriDesktop.isDesktop) {
        window.tauriDesktop.showFolderDialog().then(function (result) {
          if (result) {
            obFolderInput.value = result;
            triggerScan(result);
          }
        });
      } else if (window._catalystWs) {
        window._catalystWs.send(JSON.stringify({ type: 'browse-folder' }));
      }
    });
  }

  if (obFolderInput) {
    obFolderInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.stopPropagation();
        var dir = obFolderInput.value.trim();
        if (dir) triggerScan(dir);
      }
    });
  }

  function triggerScan(dir) {
    if (obScanHint) { obScanHint.textContent = 'Scanning...'; obScanHint.className = 'ob-scan-hint'; }
    if (obRepoChips) obRepoChips.innerHTML = '';
    if (window._catalystWs) {
      window._catalystWs.send(JSON.stringify({ type: 'list-repos', rootDir: dir }));
    }
  }

  // ─── Screen 3: AI Tools ───────────────────────────────────
  var cliChecked = false;
  var obToolsHint = document.getElementById('obToolsHint');
  var installedCliCount = 0;

  function checkCliAvailability() {
    if (cliChecked) return;
    if (!window._catalystWs || window._catalystWs.readyState !== 1) {
      setTimeout(checkCliAvailability, 300);
      return;
    }
    window._catalystWs.send(JSON.stringify({ type: 'check-cli-availability' }));
  }

  var OB_CLIS = ['claude', 'codex', 'gemini', 'copilot'];

  // Cache tool-card and status elements to avoid repeated DOM queries
  var toolCardCache = {};
  var toolStatusCache = {};
  OB_CLIS.forEach(function (id) {
    toolCardCache[id] = overlay.querySelector('.ob-tool-card[data-cli="' + id + '"]');
    toolStatusCache[id] = document.getElementById('obStatus-' + id);
  });

  function ensureToolLog(card) {
    var log = card.querySelector('.ob-tool-log');
    if (!log) {
      log = document.createElement('pre');
      log.className = 'ob-tool-log';
      card.appendChild(log);
    }
    return log;
  }

  function setInstallButton(card, label, disabled) {
    var btn = card.querySelector('.ob-install-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'ob-install-btn';
      var header = card.querySelector('.ob-tool-header');
      (header || card).appendChild(btn);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var cliId = card.dataset.cli;
        var log = ensureToolLog(card);
        log.textContent = '';
        log.classList.add('visible');
        setInstallButton(card, 'Installing…', true);
        var statusEl = toolStatusCache[cliId];
        if (statusEl) statusEl.innerHTML = '<span class="ob-status-dot checking"></span>Installing';
        card.dataset.installing = '1';
        if (window._catalystWs && window._catalystWs.readyState === 1) {
          window._catalystWs.send(JSON.stringify({ type: 'install-cli', cli: cliId }));
        }
      });
    }
    btn.textContent = label;
    btn.disabled = !!disabled;
  }

  function handleCliAvailability(cliStatus) {
    cliChecked = true;
    installedCliCount = 0;
    OB_CLIS.forEach(function (id) {
      var statusEl = toolStatusCache[id];
      var card = toolCardCache[id];
      if (!statusEl || !card) return;
      if (card.dataset.installing === '1') return;
      var info = cliStatus[id];
      if (info && info.installed) {
        installedCliCount++;
        statusEl.innerHTML = '<span class="ob-status-dot installed"></span>Installed';
        card.classList.add('ob-tool-installed');
        card.classList.remove('ob-tool-missing');
        if (info.install) setInstallButton(card, 'Reinstall', false);
      } else {
        statusEl.innerHTML = '<span class="ob-status-dot missing"></span>Not found';
        card.classList.add('ob-tool-missing');
        card.classList.remove('ob-tool-installed');
        if (info && info.install) setInstallButton(card, 'Install', false);
      }
    });
    if (obToolsHint) {
      obToolsHint.textContent = installedCliCount + ' of ' + OB_CLIS.length + ' tools installed. You can install more anytime.';
    }
  }

  function handleInstallStarted(cli, command) {
    var card = toolCardCache[cli];
    if (!card) return;
    var log = ensureToolLog(card);
    log.classList.add('visible');
    log.textContent = '$ ' + command + '\n';
  }

  function handleInstallProgress(cli, data) {
    var card = toolCardCache[cli];
    if (!card) return;
    var log = ensureToolLog(card);
    var cleaned = (data || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    log.appendChild(document.createTextNode(cleaned));
    while (log.childNodes.length > 2000) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function handleInstallResult(cli, success, message) {
    var card = toolCardCache[cli];
    if (!card) return;
    delete card.dataset.installing;
    var statusEl = toolStatusCache[cli];
    var log = ensureToolLog(card);
    if (message) {
      log.appendChild(document.createTextNode('\n' + message + '\n'));
      while (log.childNodes.length > 2000) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    }
    if (success) {
      if (statusEl) statusEl.innerHTML = '<span class="ob-status-dot installed"></span>Installed';
      card.classList.add('ob-tool-installed');
      card.classList.remove('ob-tool-missing');
      setInstallButton(card, 'Reinstall', false);
    } else {
      if (statusEl) statusEl.innerHTML = '<span class="ob-status-dot missing"></span>Failed';
      setInstallButton(card, 'Retry', false);
    }
    // Re-verify everything so the counter and other states stay correct.
    if (window._catalystWs && window._catalystWs.readyState === 1) {
      cliChecked = false;
      window._catalystWs.send(JSON.stringify({ type: 'check-cli-availability' }));
    }
  }

  // Unified WS message listener (single parse per message)
  var obWsListenerTarget = null;

  function obWsMessageHandler(event) {
    try {
      var msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'repos':
          if (!obScanHint) break;
          var repos = msg.repos || [];
          obRepoCount = repos.length;
          if (repos.length > 0) {
            obScanHint.textContent = 'Discovered ' + repos.length + ' git repositor' + (repos.length === 1 ? 'y' : 'ies');
            obScanHint.className = 'ob-scan-hint success';
            if (obRepoChips) {
              obRepoChips.innerHTML = '';
              var frag = document.createDocumentFragment();
              var show = repos.slice(0, 8);
              show.forEach(function (r, i) {
                var chip = document.createElement('span');
                chip.className = 'ob-repo-chip';
                chip.textContent = r.name;
                chip.style.animationDelay = (i * 50) + 'ms';
                frag.appendChild(chip);
              });
              if (repos.length > 8) {
                var more = document.createElement('span');
                more.className = 'ob-repo-chip';
                more.textContent = '+' + (repos.length - 8) + ' more';
                more.style.animationDelay = '400ms';
                frag.appendChild(more);
              }
              obRepoChips.appendChild(frag);
            }
          } else {
            obScanHint.textContent = 'No git repositories found in this folder';
            obScanHint.className = 'ob-scan-hint error';
          }
          break;
        case 'folder-selected':
          if (msg.path && obFolderInput) {
            obFolderInput.value = msg.path;
            triggerScan(msg.path);
          }
          break;
        case 'cli-availability':
          handleCliAvailability(msg.cliStatus || {});
          break;
        case 'install-cli-started':
          handleInstallStarted(msg.cli, msg.command);
          break;
        case 'install-cli-progress':
          handleInstallProgress(msg.cli, msg.data);
          break;
        case 'install-cli-result':
          handleInstallResult(msg.cli, !!msg.success, msg.message);
          break;
        case 'pat-verified-inline': {
          var btn = msg.provider === 'azure' ? obVerifyAzureBtn : obVerifyGithubBtn;
          var res = msg.provider === 'azure' ? obVerifyAzureResult : obVerifyGithubResult;
          if (btn) { btn.disabled = false; btn.textContent = 'Verify Connection'; btn.classList.remove('verifying'); }
          if (res) {
            res.textContent = msg.message || (msg.success ? 'Verified' : 'Failed');
            res.className = 'ob-verify-result ' + (msg.success ? 'success' : 'error');
          }
          break;
        }
      }
    } catch (e) {}
  }

  function attachWsListener() {
    if (obFinished) return;
    if (!window._catalystWs) {
      setTimeout(attachWsListener, 300);
      return;
    }
    obWsListenerTarget = window._catalystWs;
    obWsListenerTarget.addEventListener('message', obWsMessageHandler);
  }
  attachWsListener();

  // ─── Screen 4: Pilot ─────────────────────────────────────
  var pilotToggles = overlay.querySelectorAll('.ob-pilot-toggle');

  function savePilotSettings() {
    var settings = {};
    pilotToggles.forEach(function (t) { settings[t.dataset.key] = t.checked; });
    localStorage.setItem('catalyst-pilot-settings', JSON.stringify(settings));
  }

  // ─── Screen 7: Focus Guard ───────────────────────────────
  // The number of agents the user is willing to have running at once. Asked here
  // rather than left to a default because the answer is a personal one, and the
  // moment to decide it is before the tabs are open, not after.
  var FOCUS_GUARD_KEY = 'catalyst-focus-guard';
  var FOCUS_DEFAULT = 3;
  var focusLimit = FOCUS_DEFAULT;
  var focusOpts = overlay.querySelectorAll('.ob-focus-opt');
  var focusNote = document.getElementById('obFocusNote');

  var FOCUS_NOTES = {
    1: 'Strictest setting: finish what is open before starting anything else.',
    3: 'Room to let one agent work while you review another, without losing the thread.',
    5: 'A wide desk. Worth revisiting if you notice you are only skimming the output.',
    8: 'Catalyst’s hard ceiling — effectively no guard. You can still switch it on later.'
  };

  function renderFocusChoice() {
    focusOpts.forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.limit) === focusLimit);
    });
    if (focusNote) focusNote.textContent = FOCUS_NOTES[focusLimit] || '';
  }

  focusOpts.forEach(function (btn) {
    btn.addEventListener('click', function () {
      focusLimit = Number(btn.dataset.limit) || FOCUS_DEFAULT;
      renderFocusChoice();
    });
  });
  renderFocusChoice();

  function saveFocusGuard() {
    // Picking the ceiling is not the same as asking to be unguarded, so the
    // feature stays on either way — 8 simply never bites in practice.
    localStorage.setItem(FOCUS_GUARD_KEY, JSON.stringify({ enabled: true, limit: focusLimit }));
  }

  // ─── Screen 4: Provider picker ─────────────────────────────
  var selectedProvider = 'azure';
  var providerBtns = overlay.querySelectorAll('.ob-provider-btn');
  var fieldsAzure = document.getElementById('obFieldsAzure');
  var fieldsGithub = document.getElementById('obFieldsGithub');
  var fieldsNone = document.getElementById('obFieldsNone');

  function showProviderFields(provider) {
    selectedProvider = provider;
    providerBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.provider === provider); });
    if (fieldsAzure) fieldsAzure.style.display = provider === 'azure' ? '' : 'none';
    if (fieldsGithub) fieldsGithub.style.display = provider === 'github' ? '' : 'none';
    if (fieldsNone) fieldsNone.style.display = provider === 'none' ? '' : 'none';
  }
  providerBtns.forEach(function (btn) {
    btn.addEventListener('click', function () { showProviderFields(btn.dataset.provider); });
  });

  // PAT show/hide toggles
  function setupPatToggle(toggleId, inputId) {
    var toggle = document.getElementById(toggleId);
    var input = document.getElementById(inputId);
    if (toggle && input) {
      toggle.addEventListener('click', function () {
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        toggle.textContent = showing ? 'Show' : 'Hide';
      });
    }
  }
  setupPatToggle('obPatToggle', 'obAzurePat');
  setupPatToggle('obGhPatToggle', 'obGithubPat');

  // ─── Inline PAT verification ──────────────────────────────
  function verifyInline(provider, btn, resultEl, getData) {
    if (!window._catalystWs || window._catalystWs.readyState !== 1) return;
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    btn.classList.add('verifying');
    resultEl.textContent = 'Connecting…';
    resultEl.className = 'ob-verify-result verifying';
    var payload = getData();
    payload.type = 'verify-pat-inline';
    payload.provider = provider;
    window._catalystWs.send(JSON.stringify(payload));
  }

  var obVerifyAzureBtn = document.getElementById('obVerifyAzure');
  var obVerifyAzureResult = document.getElementById('obVerifyAzureResult');
  if (obVerifyAzureBtn) {
    obVerifyAzureBtn.addEventListener('click', function () {
      verifyInline('azure', obVerifyAzureBtn, obVerifyAzureResult, function () {
        var urlVal = (document.getElementById('obAzureUrl') || {}).value || '';
        var parsed = parseAzureUrl(urlVal.trim());
        return { org: parsed ? parsed.org : '', pat: ((document.getElementById('obAzurePat') || {}).value || '').trim() };
      });
    });
  }

  var obVerifyGithubBtn = document.getElementById('obVerifyGithub');
  var obVerifyGithubResult = document.getElementById('obVerifyGithubResult');
  if (obVerifyGithubBtn) {
    obVerifyGithubBtn.addEventListener('click', function () {
      verifyInline('github', obVerifyGithubBtn, obVerifyGithubResult, function () {
        return { pat: ((document.getElementById('obGithubPat') || {}).value || '').trim() };
      });
    });
  }

  function parseAzureUrl(url) {
    var m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)/);
    if (m) return { org: m[1], project: m[2] };
    m = url.match(/([^.]+)\.visualstudio\.com\/([^/]+)/);
    if (m) return { org: m[1], project: m[2] };
    return null;
  }

  function saveAzureIfNeeded() {
    if (selectedProvider === 'azure') {
      var urlInput = document.getElementById('obAzureUrl');
      var patInput = document.getElementById('obAzurePat');
      if (!urlInput || !patInput) return;
      var url = urlInput.value.trim();
      var pat = patInput.value.trim();
      if (!url && !pat) return;
      var parsed = parseAzureUrl(url);
      if (parsed && window._catalystWs) {
        window._catalystWs.send(JSON.stringify({
          type: 'save-settings',
          settings: { azureUrl: url, azureOrg: parsed.org, azureProject: parsed.project },
          pat: pat || undefined
        }));
      }
    } else if (selectedProvider === 'github') {
      var orgInput = document.getElementById('obGithubOrg');
      var ghPat = document.getElementById('obGithubPat');
      if (!orgInput || !ghPat) return;
      var org = orgInput.value.trim();
      var pat = ghPat.value.trim();
      if (!org && !pat) return;
      if (window._catalystWs) {
        window._catalystWs.send(JSON.stringify({
          type: 'save-settings',
          settings: { githubOrg: org, provider: 'github' },
          pat: pat || undefined
        }));
      }
    }
  }

  var obAzureUrl = document.getElementById('obAzureUrl');
  var obAzureParsed = document.getElementById('obAzureParsed');
  var azureUrlDebounce = 0;
  if (obAzureUrl) {
    obAzureUrl.addEventListener('input', function () {
      clearTimeout(azureUrlDebounce);
      azureUrlDebounce = setTimeout(function () {
        var parsed = parseAzureUrl(obAzureUrl.value.trim());
        if (obAzureParsed) {
          obAzureParsed.textContent = parsed ? 'Org: ' + parsed.org + '  |  Project: ' + parsed.project : '';
        }
      }, 150);
    });
  }

  // ─── Screen 5: Summary ───────────────────────────────────
  var obSummaryContainer = document.getElementById('obSummary');
  var obGithubOrgInput = document.getElementById('obGithubOrg');

  function buildSummary() {
    var theme = localStorage.getItem('catalyst-theme') || 'midnight';
    var fontSize = localStorage.getItem('catalyst-font-size') || '13';
    var fontFam = localStorage.getItem('catalyst-font-family') || "'Fira Code', monospace";
    var fontName = fontFam.replace(/'/g, '').split(',')[0].trim();
    var folder = obFolderInput ? obFolderInput.value.trim() : '';
    var pilotCount = 0;
    pilotToggles.forEach(function (t) { if (t.checked) pilotCount++; });
    var providerLabel = 'Not configured';
    if (selectedProvider === 'azure') {
      var azureUrl = obAzureUrl ? obAzureUrl.value.trim() : '';
      providerLabel = azureUrl ? 'Azure DevOps' : 'Not configured';
    } else if (selectedProvider === 'github') {
      var ghOrg = obGithubOrgInput ? obGithubOrgInput.value.trim() : '';
      providerLabel = ghOrg ? 'GitHub (' + ghOrg + ')' : 'Not configured';
    }

    var rows = [
      { key: 'Theme', val: theme.charAt(0).toUpperCase() + theme.slice(1) },
      { key: 'Font', val: fontName + ', ' + fontSize + 'px' },
      { key: 'Workspace', val: folder ? folder + (obRepoCount ? ' (' + obRepoCount + ' repos)' : '') : 'Not set' },
      { key: 'AI Tools', val: installedCliCount + ' of ' + OB_CLIS.length + ' installed' },
      { key: 'Pilot', val: pilotCount + ' of ' + pilotToggles.length + ' active' },
      { key: 'Focus Guard', val: focusLimit === 1 ? '1 session at a time' : focusLimit + ' sessions at once' },
      { key: 'Repo Host', val: providerLabel }
    ];

    if (obSummaryContainer) {
      obSummaryContainer.innerHTML = '';
      var frag = document.createDocumentFragment();
      rows.forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'ob-summary-row';
        row.innerHTML = '<span class="ob-summary-key">' + r.key + '</span><span class="ob-summary-val">' + r.val + '</span>';
        frag.appendChild(row);
      });
      obSummaryContainer.appendChild(frag);
    }
  }

  // Init
  updateNav();
})();
