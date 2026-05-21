const state = {
  currentPage: 'home',
  gameRunning: false,
  gameState: null,
  language: 'english',
  langData: {},
  settings: {
    csgoDir: '',
    theme: 'dark',
    launchArgs: '-novid -console -tickrate 128 -steam'
  }
};

const elements = {};

function id(name) {
  const el = document.getElementById(name);
  if (!el) console.warn('Element not found:', name);
  return el;
}

async function init() {
  try {
    console.log('[App] Initializing...');
    cacheElements();
    await loadLanguage();
    setupNavigation();
    setupTitlebar();
    setupSettings();
    setupGameLaunch();
    setupInventory();
    setupAuth();
    loadSettings();
    checkAuthStatus();
    setupIPCListeners();
    console.log('[App] Initialization complete');
  } catch (e) {
    console.error('[App] Init error:', e);
  }
}

async function loadLanguage() {
  try {
    const langName = await window.api.language.getCurrent();
    state.language = langName;
    let data = await window.api.language.getData(langName);

    // Fallback to english if requested language not found
    if (!data && langName !== 'english') {
      console.warn('[i18n] Language not found:', langName, '— falling back to english');
      data = await window.api.language.getData('english');
      if (data) state.language = 'english';
    }

    if (data) {
      state.langData = data;
      document.documentElement.lang = data.code || 'en';
      document.title = t('title') || 'CSR Launcher';
      applyTranslations();
    }
  } catch (e) {
    console.error('[i18n] Load error:', e);
  }

  // Always populate the selector so it shows available languages
  await populateLanguageSelector();
}

function t(key) {
  return state.langData[key] || key;
}

function tf(key, params) {
  let str = t(key);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      str = str.replace(`{${k}}`, v);
    });
  }
  return str;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key && state.langData[key]) {
      el.textContent = state.langData[key];
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key && state.langData[key]) {
      el.setAttribute('title', state.langData[key]);
    }
  });
}

let _langSelectorInitialized = false;

async function populateLanguageSelector() {
  const sel = id('language-select');
  if (!sel) return;

  // Populate options
  sel.innerHTML = '';
  try {
    const langs = await window.api.language.getList();
    langs.forEach(lang => {
      const opt = document.createElement('option');
      opt.value = lang.file;
      opt.textContent = lang.name;
      if (lang.file === state.language) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error('[i18n] Failed to load language list:', e);
  }

  // Attach change listener only once
  if (!_langSelectorInitialized) {
    _langSelectorInitialized = true;
    sel.addEventListener('change', async () => {
      const newName = sel.value;
      await window.api.language.save(newName);
      const data = await window.api.language.getData(newName);
      if (data) {
        state.language = newName;
        state.langData = data;
        document.documentElement.lang = data.code || 'en';
        document.title = t('title') || 'CSR Launcher';
        applyTranslations();
        updateAuthLanguageStrings();
      }
    });
  }
}

function updateAuthLanguageStrings() {
  const user = elements.userElo?.textContent;
  if (user && user === 'Unverified') {
    elements.userElo.textContent = t('user_unverified');
  }
}

function cacheElements() {
  elements.btnMinimize = id('btn-minimize');
  elements.btnMaximize = id('btn-maximize');
  elements.btnClose = id('btn-close');

  elements.navItems = document.querySelectorAll('.nav-item');
  elements.pages = document.querySelectorAll('.page');

  elements.btnLaunch = id('btn-launch-game');

  elements.btnLogin = id('btn-login');
  elements.topbarUser = id('topbar-user');
  elements.topbarAvatar = id('topbar-avatar');
  elements.topbarName = id('topbar-name');
  elements.topbarUnverified = id('topbar-unverified');
  elements.userElo = id('topbar-name');

  elements.csgoDirInput = id('csgo-dir');
  elements.launchArgsInput = id('launch-args');
  elements.btnBrowseDir = id('btn-browse-dir');

  elements.inventoryGrid = id('inventory-grid');
  elements.inventoryCount = id('inventory-count');
  elements.btnRefreshInventory = id('btn-refresh-inventory');

  elements.progressFilename = id('progress-filename');
  elements.progressPercent = id('progress-percent');
  elements.progressBarFill = id('progress-bar-fill');

  elements.modalInstall = id('modal-install');
  elements.progressSteps = id('progress-steps');
  elements.modalProgressFill = id('modal-progress-fill');
  elements.progressStatus = id('progress-status');
  elements.installResult = id('install-result');
  elements.btnModalClose = id('btn-modal-close');
  elements.btnCancelDownload = id('btn-cancel-download');

  elements.btnStartDpi = id('btn-start-dpi');
  elements.btnStopDpi = id('btn-stop-dpi');
  elements.dpiStatusIcon = id('dpi-status-icon');
  elements.dpiStatusText = id('dpi-status-text');
}

function setupNavigation() {
  elements.navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToPage(item.dataset.page);
    });
  });
}

function navigateToPage(page) {
  elements.navItems.forEach(item => item.classList.remove('active'));
  elements.pages.forEach(p => p.classList.remove('active'));

  const targetNav = document.querySelector(`[data-page="${page}"]`);
  if (targetNav) targetNav.classList.add('active');

  const targetPage = document.getElementById(`page-${page}`);
  if (targetPage) targetPage.classList.add('active');

  state.currentPage = page;

  if (page === 'inventory') {
    loadInventory();
  }
}

function setupTitlebar() {
  if (elements.btnMinimize) {
    elements.btnMinimize.addEventListener('click', () => window.api.window.minimize());
  }
  if (elements.btnMaximize) {
    elements.btnMaximize.addEventListener('click', () => window.api.window.maximize());
  }
  if (elements.btnClose) {
    elements.btnClose.addEventListener('click', () => window.api.window.close());
  }
}

function setupSettings() {
  if (elements.csgoDirInput) {
    elements.csgoDirInput.addEventListener('input', () => {
      state.settings.csgoDir = elements.csgoDirInput.value;
      autoSaveSettings();
    });
  }
  if (elements.launchArgsInput) {
    elements.launchArgsInput.addEventListener('input', () => {
      state.settings.launchArgs = elements.launchArgsInput.value;
      autoSaveSettings();
    });
  }
  if (elements.btnBrowseDir) {
    elements.btnBrowseDir.addEventListener('click', async () => {
      const p = await window.api.dialog.browseFolder();
      if (p) {
        elements.csgoDirInput.value = p;
        state.settings.csgoDir = p;
        autoSaveSettings();
      }
    });
  }
}

function autoSaveSettings() {
  window.api.settings.save({
    csgoDir: state.settings.csgoDir,
    launchArgs: state.settings.launchArgs
  });
}

function setupGameLaunch() {
  if (!elements.btnLaunch) return;

  elements.btnLaunch.addEventListener('click', async () => {
    if (!state.settings.csgoDir) {
      navigateToPage('settings');
      return;
    }

    elements.btnLaunch.disabled = true;
    const playText = elements.btnLaunch.querySelector('.play-text');
    const playIcon = elements.btnLaunch.querySelector('i');
    if (playText) playText.textContent = t('launch_checking');
    if (playIcon) playIcon.className = 'fa-solid fa-spinner fa-spin';

    const checkResult = await window.api.game.checkBeforeLaunch();

    if (checkResult.error) {
      if (playText) playText.textContent = t('btn_launch');
      if (playIcon) playIcon.className = 'fa-solid fa-play';
      elements.btnLaunch.disabled = false;
      alert(checkResult.error);
      return;
    }

    if (checkResult.needsUpdate) {
      const sizeMB = (checkResult.totalSize / 1024 / 1024).toFixed(1);
      showInstallModal();

      const statusEl = id('progress-status');
      const barEl = id('modal-progress-fill');
      const cancelBtn = id('btn-cancel-download');
      if (statusEl) statusEl.textContent = tf('modal_downloading', { count: checkResult.files.length, size: sizeMB });
      if (barEl) barEl.style.width = '0%';
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';

      window.api.csr.onUpdateProgress((data) => {
        if (statusEl) statusEl.textContent = data.file;
        if (barEl) barEl.style.width = `${data.percent}%`;
      });

      const gameDir = elements.csgoDirInput ? elements.csgoDirInput.value : state.settings.csgoDir;
      const dlResult = await window.api.game.downloadWithProgress(gameDir);

      if (dlResult.cancelled) {
        showError(t('modal_cancelled'));
        if (playText) playText.textContent = t('btn_launch');
        if (playIcon) playIcon.className = 'fa-solid fa-play';
        elements.btnLaunch.disabled = false;
        return;
      }

      if (dlResult.error || dlResult.failed > 0) {
        const err = dlResult.error || tf('modal_failed', { failed: dlResult.failed });
        showError(err);
        if (playText) playText.textContent = t('btn_launch');
        if (playIcon) playIcon.className = 'fa-solid fa-play';
        elements.btnLaunch.disabled = false;
        return;
      }

      showSuccess(t('modal_success'));
      await new Promise(r => setTimeout(r, 1500));
      closeModal();
    }

    if (playText) playText.textContent = t('launch_launching');
    if (playIcon) playIcon.className = 'fa-solid fa-spinner fa-spin';

    const result = await window.api.game.launch();

    if (result && result.success === false) {
      if (playText) playText.textContent = t('btn_launch');
      if (playIcon) playIcon.className = 'fa-solid fa-play';
      elements.btnLaunch.disabled = false;
      alert(result.error || 'Launch error');
      return;
    }

    _launchResetTimer = setTimeout(() => {
      resetLaunchButton();
    }, 5000);
  });
}

function setupInventory() {
  if (elements.btnRefreshInventory) {
    elements.btnRefreshInventory.addEventListener('click', () => loadInventory());
  }
}

function setupAuth() {
  if (elements.btnLogin) {
    elements.btnLogin.addEventListener('click', async () => {
      await window.api.auth.login();
    });
  }

  if (elements.btnLogout) {
    elements.btnLogout.addEventListener('click', async () => {
      const result = await window.api.auth.logout();
      if (result.success) {
        updateAuthUI(null);
      }
    });
  }
}

async function checkAuthStatus() {
  try {
    const status = await window.api.auth.checkStatus();
    if (status.loggedIn && status.user) {
      updateAuthUI(status.user);
    } else {
      updateAuthUI(null);
    }
  } catch (e) {
    console.error('[Auth] Check error:', e);
    updateAuthUI(null);
  }
}

function updateAuthUI(user) {
  if (!elements.btnLogin || !elements.topbarUser) return;

  if (user) {
    elements.btnLogin.style.display = 'none';
    elements.topbarUser.style.display = 'flex';

    if (elements.topbarName) {
      elements.topbarName.textContent = user.name || 'User';
    }

    if (elements.topbarUnverified) {
      elements.topbarUnverified.style.display = user.steam ? 'none' : 'flex';
    }

    if (elements.topbarAvatar && user.avatar && user.id) {
      elements.topbarAvatar.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    }
  } else {
    elements.btnLogin.style.display = 'flex';
    elements.topbarUser.style.display = 'none';
  }
}

async function loadInventory() {
  if (!elements.inventoryGrid || !elements.inventoryCount) return;

  const loadingEl = id('inventory-loading');
  if (loadingEl) loadingEl.style.display = 'flex';
  elements.inventoryGrid.innerHTML = '';
  elements.inventoryCount.textContent = tf('inventory_count', { count: 0 });

  try {
    const result = await window.api.inventory.getCSR();

    if (loadingEl) loadingEl.style.display = 'none';

    if (result.error) {
      elements.inventoryGrid.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <p data-i18n="inventory_error">${t('inventory_error')}</p>
        </div>
      `;
      elements.inventoryCount.textContent = tf('inventory_count', { count: 0 });
      return;
    }

    const items = result.items || [];
    elements.inventoryCount.textContent = tf('inventory_count', { count: items.length });

    const userResult = await window.api.auth.getUser();
    if (!userResult.error && userResult.user) {
      const coinsEl = id('inventory-coins');
      if (coinsEl) coinsEl.textContent = `${userResult.user.coins || 0} Coins`;
    }

    if (items.length === 0) {
      elements.inventoryGrid.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-briefcase"></i>
          <p data-i18n="inventory_empty">${t('inventory_empty')}</p>
        </div>
      `;
      return;
    }

    items.forEach(item => {
      const el = createInventoryItem(item);
      elements.inventoryGrid.appendChild(el);
    });
  } catch (e) {
    console.error('[Inventory] Load error:', e);
    if (loadingEl) loadingEl.style.display = 'none';
    elements.inventoryGrid.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>Error: ${e.message}</p>
      </div>
    `;
  }
}

function createInventoryItem(item) {
  const el = document.createElement('div');
  const rarityClasses = [
    '',
    'item-rarity-covert',
    'item-rarity-classified',
    'item-rarity-restricted',
    'item-rarity-mil-spec',
    'item-rarity-industrial',
    'item-rarity-consumer'
  ];
  const rarity = parseInt(item.rarity) || 7;
  const rarityClass = rarity < rarityClasses.length && rarityClasses[rarity] ? rarityClasses[rarity] : 'item-rarity-consumer';
  const weaponNames = ['Gloves', 'Knife', 'Rifle', 'Heavy', 'Pistol', 'SMG', 'Equipment', 'Music', 'Case', 'Agent', ''];
  const itemTypeId = parseInt(item.item_type);
  const weaponName = itemTypeId < weaponNames.length && weaponNames[itemTypeId] ? weaponNames[itemTypeId] : 'Item';

  el.className = `inventory-item ${rarityClass}${item.stattrak ? ' stattrak' : ''}`;

  const imgUrl = `https://cdn.csrestored.fun/skins/${item.item_id}.png`;
  const floatText = item.float ? tf('float_label', { value: parseFloat(item.float).toFixed(4) }) : '';

  el.innerHTML = `
    <div class="item-icon">
      <img src="${imgUrl}" alt="${item.name}" onerror="this.parentElement.innerHTML='<i class=\\'fa-solid fa-gun\\'></i>'">
    </div>
    <div class="item-name" title="${item.name}">${item.name}</div>
    <div class="item-type">${weaponName}</div>
    ${floatText ? `<div class="item-float">${floatText}</div>` : ''}
  `;

  return el;
}

function showInstallModal() {
  if (!elements.modalInstall) return;
  elements.modalInstall.classList.add('active');
  elements.progressSteps.innerHTML = '';
  elements.installResult.innerHTML = '';
  if (elements.btnModalClose) elements.btnModalClose.style.display = 'none';
}

function closeModal() {
  if (elements.modalInstall) elements.modalInstall.classList.remove('active');
}

function showSuccess(message) {
  if (elements.progressStatus) elements.progressStatus.textContent = '';
  if (elements.modalProgressFill) elements.modalProgressFill.style.width = '100%';
  if (elements.installResult) {
    elements.installResult.className = 'install-result success';
    elements.installResult.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${message}`;
  }
  if (elements.btnModalClose) elements.btnModalClose.style.display = 'inline-flex';
}

function showError(message) {
  if (elements.progressStatus) elements.progressStatus.textContent = '';
  if (elements.installResult) {
    elements.installResult.className = 'install-result error';
    elements.installResult.textContent = message;
  }
  if (elements.btnModalClose) elements.btnModalClose.style.display = 'inline-flex';
}

function showPartialSuccess(result) {
  if (elements.installResult) {
    elements.installResult.className = 'install-result';
    elements.installResult.innerHTML = `
      <div style="color: var(--warning); font-weight: 600;">
        ${result.downloaded} / ${result.total}
      </div>
      ${result.errors.length > 0 ? `
        <div class="error-list">
          ${result.errors.map(e => `<div class="error-item">${e.file}: ${e.error}</div>`).join('')}
        </div>
      ` : ''}
    `;
  }
  if (elements.btnModalClose) elements.btnModalClose.style.display = 'inline-flex';
}

function loadSettings() {
  if (window.api && window.api.settings) {
    window.api.settings.get().then(saved => {
      if (saved) {
        state.settings = { ...state.settings, ...saved };
      }
      applySettings();
    }).catch(e => {
      console.error('[Settings] Load error:', e);
      applySettings();
    });
  } else {
    applySettings();
  }
}

function applySettings() {
  if (elements.csgoDirInput) elements.csgoDirInput.value = state.settings.csgoDir || '';
  if (elements.launchArgsInput) elements.launchArgsInput.value = state.settings.launchArgs || '';
}

let _launchResetTimer = null;

function resetLaunchButton() {
  const playText = elements.btnLaunch?.querySelector('.play-text');
  const playIcon = elements.btnLaunch?.querySelector('i');
  if (playText) playText.textContent = t('btn_launch');
  if (playIcon) playIcon.className = 'fa-solid fa-play';
  if (elements.btnLaunch) elements.btnLaunch.disabled = false;
}

function setupIPCListeners() {
  window.api.game.onLaunchStatus((data) => {
    if (data.success) {
      state.gameRunning = true;
    } else {
      clearTimeout(_launchResetTimer);
      resetLaunchButton();
      alert(data.error || 'Failed to launch game. Check the game directory in Settings.');
    }
  });

  window.api.auth.onStatusChange((data) => {
    if (data.loggedIn) {
      checkAuthStatus();
      if (state.currentPage === 'inventory') loadInventory();
    } else {
      updateAuthUI(null);
    }
  });
}


document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] DOMContentLoaded fired');
  init();
});
