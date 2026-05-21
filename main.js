const { app, BrowserWindow, ipcMain, Menu, dialog, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { launchInCrossOver } = require('./src/crossover');
const langDir = path.join(__dirname, 'lang');

let customLangDir = null;

function getCustomLangDir() {
  if (customLangDir) return customLangDir;

  const launcherRoot = app.isPackaged
    ? path.dirname(process.execPath)
    : process.cwd();

  customLangDir = path.join(launcherRoot, 'custom_lang');
  console.log('[Lang] customLangDir resolved to:', customLangDir);
  console.log('[Lang] app.isPackaged:', app.isPackaged);
  console.log('[Lang] process.execPath:', process.execPath);
  console.log('[Lang] process.cwd():', process.cwd());
  return customLangDir;
}

let mainWindow;
let gsisServer = null;
let csrProcess = null;

let loginWindow = null;
let downloadCancelled = false;

const API_BASE_URL = 'https://api.csrestored.fun';
const crypto = require('crypto');
const https = require('https');

const DOWNLOAD_API_URL = 'https://download-api.csrestored.fun/';
const DOWNLOAD_BASE_URL = 'https://download.csrestored.fun/';
const GSIS_PORT = 3000;
const GSIS_AUTH_TOKEN = 'csr_launcher_token_2024';
const IGNORED_FILES = ['index.nginx-debian.html'];

function isIgnored(file) {
  return IGNORED_FILES.includes(file.file || file);
}

const defaultSettings = {
  csgoDir: '',
  gsisPort: GSIS_PORT,
  gsisEnabled: true,
  theme: 'dark',
  animations: true,
  launchArgs: ''
};

function loadSettings() {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return { ...defaultSettings, ...saved };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return defaultSettings;
}

async function loadAuthCookies() {
  try {
    const cookiePath = path.join(app.getPath('userData'), 'auth_cookies.json');
    if (fs.existsSync(cookiePath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
      const sess = session.defaultSession;

      for (const cookie of cookies) {
        try {
          await sess.cookies.set({
            url: cookie.url || API_BASE_URL,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || '.csrestored.fun',
            path: cookie.path || '/',
            secure: cookie.secure !== false,
            httpOnly: cookie.httpOnly !== false,
            expirationDate: cookie.expirationDate || (Date.now() / 1000) + (30 * 24 * 60 * 60)
          });
        } catch (e) {
          console.error('[Auth] Failed to restore cookie:', cookie.name, e.message);
        }
      }
      console.log('[Auth] Loaded', cookies.length, 'cookies from storage');
    } else {
      console.log('[Auth] No saved cookies found');
    }
  } catch (e) {
    console.error('[Auth] Failed to load auth cookies:', e);
  }
}

async function saveAuthCookies() {
  try {
    const sess = session.defaultSession;
    const cookies = await sess.cookies.get({});

    const csrCookies = cookies.filter(c =>
      c.name.includes('jwt') ||
      c.name.includes('session') ||
      c.name.includes('token') ||
      (c.domain && c.domain.includes('csrestored'))
    );

    const cookiePath = path.join(app.getPath('userData'), 'auth_cookies.json');
    fs.writeFileSync(cookiePath, JSON.stringify(csrCookies, null, 2));
    console.log('[Auth] Saved', csrCookies.length, 'cookies:', csrCookies.map(c => c.name));
  } catch (e) {
    console.error('[Auth] Failed to save auth cookies:', e);
  }
}

function saveSettings(settings) {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function ensureCustomLangFolder() {
  try {
    const dir = getCustomLangDir();

    console.log('[Lang] Checking custom_lang at:', dir);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('[Lang] custom_lang folder CREATED at:', dir);
    } else {
      console.log('[Lang] custom_lang folder already exists at:', dir);
    }

    const exampleFile = path.join(dir, 'example_language.json');

    if (!fs.existsSync(exampleFile)) {
      const template = {
        name: 'Example Language',
        code: 'example',
        title: 'CSR Launcher',
        nav_home: 'Home',
        nav_settings: 'Settings',
        nav_play: 'Play',
        button_play: 'PLAY',
        button_close: 'Close'
      };

      fs.writeFileSync(exampleFile, JSON.stringify(template, null, 2), 'utf8');
      console.log('[Lang] example_language.json CREATED at:', exampleFile);
    }
  } catch (e) {
    console.error('[Lang] Failed to create custom_lang:', e.code, e.message, e.path);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: true,
    transparent: false,
    backgroundColor: '#0a0a0f',
    hasShadow: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: true
    }
  });

  mainWindow.loadFile('src/index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();

    const settings = loadSettings();
    loadAuthCookies();
    if (settings.gsisEnabled) {
      startGSIS(settings.gsisPort);
    }
  });

  // Build a minimal application menu with a View > Toggle Developer Tools item
const isMac = process.platform === 'darwin';
const template = [
  // { role: 'appMenu' } (macOS) omitted for simplicity
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'toggledevtools' }
    ]
  },
  {
    role: 'help',
    submenu: [
      {
        label: 'Learn More',
        click: async () => {
          const { shell } = require('electron');
          await shell.openExternal('https://electronjs.org');
        }
      }
    ]
  }
];
const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
}

function startGSIS(port) {
  if (gsisServer) return;

  const gsisApp = express();
  gsisApp.use(cors());
  gsisApp.use(express.json({ limit: '10mb' }));

  gsisApp.post('/gsis', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== GSIS_AUTH_TOKEN) {
      return res.status(401).send('Unauthorized');
    }

    const gameState = req.body;
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('game-state-update', gameState);
    }

    res.status(200).send('OK');
  });

  gsisApp.get('/status', (req, res) => {
    res.json({ status: 'running', port });
  });

  gsisServer = gsisApp.listen(port, '127.0.0.1', () => {
    console.log(`GSIS server running on http://127.0.0.1:${port}`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('gsis-status', { running: true, port });
    }
  });

  gsisServer.on('error', (err) => {
    console.error('GSIS server error:', err);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('gsis-status', { running: false, error: err.message });
    }
  });
}

function launchCSR(settings, loginToken) {
  try {
const gameDir = settings.csgoDir;

const possiblePaths = [
  path.join(gameDir, 'csr.exe'),
  path.join(gameDir, 'csgo_legacy', 'csr.exe'),
  path.join(gameDir, 'game', 'bin', 'win64', 'csr.exe'),
];

const csrExe = possiblePaths.find(p => fs.existsSync(p));

console.log('[CSR] Checking executable paths:', possiblePaths);
console.log('[CSR] Using executable:', csrExe);

if (!csrExe) {
  throw new Error('csr.exe not found');
}

  return found;
})();

    if (!gameDir || !fs.existsSync(gameDir)) {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('game-launch', {
          success: false,
          error: 'Game directory not set. Configure in Settings.'
        });
      }
      return;
    }

    if (!fs.existsSync(csrExe)) {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('game-launch', {
          success: false,
          error: 'csr.exe not found. Download CS:Restored files first.'
        });
      }
      return;
    }

    const launchArgs = settings.launchArgs.split(' ').filter(Boolean);

    // Required CSR game args (mirrors the Windows launcher exactly)
    launchArgs.push('-game', 'csgo/csr', '-tickrate', '128');

    if (loginToken) {
      launchArgs.push('-login_token', loginToken);
    }

    console.log('[Launch]', csrExe, launchArgs.join(' '));

    // Launch through CrossOver (macOS Wine layer) instead of direct spawn
    csrProcess = launchInCrossOver(csrExe, launchArgs, 'Steam');

    csrProcess.on('exit', () => {
      console.log('[Launch] CSR process exited');
      csrProcess = null;
    });

    csrProcess.on('error', (err) => {
      console.error('[Launch] CSR error:', err.message);
    });

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('game-launch', { success: true });
    }
  } catch (err) {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('game-launch', { success: false, error: err.message });
    }
  }
}

app.whenReady().then(async () => {
  ensureCustomLangFolder();
  createWindow();

  // Register shortcut to toggle DevTools (Cmd+Alt+I)
  const shortcut = 'CommandOrControl+Alt+I';
  const registered = globalShortcut.register(shortcut, () => {
    if (mainWindow && mainWindow.webContents) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });
  if (!registered) {
    console.warn('[Shortcut] Failed to register DevTools toggle shortcut');
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (gsisServer) {
    gsisServer.close();
    gsisServer = null;
  }
  if (csrProcess) {
    try { csrProcess.kill(); } catch (e) { }
    csrProcess = null;
  }
  app.quit();
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.destroy();
});

ipcMain.handle('launch-game', async () => {
  const settings = loadSettings();
  const gameDir = settings.csgoDir;

  if (!gameDir || !fs.existsSync(gameDir)) {
    return { success: false, error: 'Game directory not set. Configure in Settings.' };
  }

  // Retrieve auth cookies for login token
  const sess = session.defaultSession;
  const cookies = await sess.cookies.get({});
  const wsCookie = cookies.find(c => c.name === 'jwt_websocket_session');
  const sessionCookie = cookies.find(c => c.name === 'jwt_session');
  let loginToken = '';
  if (wsCookie) loginToken += `jwt_websocket_session=${wsCookie.value}`;
  if (wsCookie && sessionCookie) loginToken += '; ';
  if (sessionCookie) loginToken += `jwt_session=${sessionCookie.value}`;

  console.log('[Launch] loginToken found:', !!loginToken);

  if (!loginToken) {
    return { success: false, error: 'No login token. Please login first.' };
  }

  // Launch the game using existing launchCSR function
  launchCSR(settings, loginToken);
  return { success: true, status: 'launched' };
});

ipcMain.handle('check-and-update-before-launch', async (event) => {
  const settings = loadSettings();
  const gameDir = settings.csgoDir;

  if (!gameDir || !fs.existsSync(gameDir)) {
    return { needsUpdate: false, error: 'Game directory not set' };
  }

  try {
    const manifest = await fetchDownloadManifest();
    if (!manifest) {
      return { needsUpdate: false, error: 'Failed to fetch manifest' };
    }

    const filesToDownload = [];
    let totalSize = 0;

    for (const file of manifest) {
      if (isIgnored(file)) continue;
      const localPath = path.join(gameDir, file.file);
      if (!fs.existsSync(localPath) || md5File(localPath) !== file.hash) {
        filesToDownload.push(file);
        totalSize += file.length || 0;
      }
    }

    if (filesToDownload.length === 0) {
      return { needsUpdate: false, files: [], totalSize: 0 };
    }

    return { needsUpdate: true, files: filesToDownload, totalSize };
  } catch (e) {
    return { needsUpdate: false, error: e.message };
  }
});

ipcMain.handle('download-updates-with-progress', async (event, gameDir) => {
  try {
    downloadCancelled = false;
    const manifest = await fetchDownloadManifest();
    if (!manifest) {
      return { error: true, message: 'Failed to fetch manifest' };
    }

    const filesToDownload = manifest.filter(file => {
      if (isIgnored(file)) return false;
      const localPath = path.join(gameDir, file.file);
      return !fs.existsSync(localPath) || md5File(localPath) !== file.hash;
    });

    const results = {
      total: filesToDownload.length,
      downloaded: 0,
      failed: 0,
      errors: [],
      currentFile: '',
      cancelled: false
    };

    for (const file of filesToDownload) {
      if (downloadCancelled) {
        results.cancelled = true;
        break;
      }

      results.currentFile = file.file;
      const localPath = path.join(gameDir, file.file);

      try {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await downloadFile(file.file, localPath);

        const newHash = md5File(localPath);
        if (newHash !== file.hash) {
          throw new Error(`MD5 mismatch after download: expected ${file.hash}, got ${newHash}`);
        }

        results.downloaded++;
        mainWindow.webContents.send('update-progress', {
          file: file.file,
          current: results.downloaded,
          total: results.total,
          percent: Math.round((results.downloaded / results.total) * 100)
        });
      } catch (e) {
        results.failed++;
        results.errors.push({ file: file.file, error: e.message });
        console.error(`[Update] Failed: ${file.file}`, e.message);
      }
    }

    results.currentFile = '';
    return results;
  } catch (e) {
    return { error: true, message: e.message };
  }
});

ipcMain.on('save-settings', (event, settings) => {
  saveSettings(settings);
  if (settings.gsisEnabled && !gsisServer) {
    startGSIS(settings.gsisPort);
  }
  event.reply('settings-saved', { success: true });
});

ipcMain.handle('get-settings', () => {
  return { ...loadSettings() };
});

ipcMain.handle('get-gsis-status', () => {
  return { running: !!gsisServer };
});

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('browse-file', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'Folders', extensions: [] }],
    title: 'Select folder or file'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-game-status', () => {
  const settings = loadSettings();
  const gameDir = settings.csgoDir;
  return {
    running: csrProcess ? !csrProcess.killed : false,
    hasGame: gameDir ? fs.existsSync((() => {

;


  const found = possiblePaths.find(p => fs.existsSync(p));

  console.log('[CSR] Searching paths:', possiblePaths);
  console.log('[CSR] Found executable:', found);

  if (!found) {
    throw new Error('csr.exe not found');
  }

  return found;
})()) : false
  };
});

ipcMain.handle('start-login', async () => {
  if (loginWindow) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 500,
    height: 600,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:auth'
    }
  });

  loginWindow.loadURL(`https://csrestored.fun/login`).catch((err) => {
    console.error('[Auth] Login page load error:', err.message);
  });

  loginWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Auth] Failed to load:', errorCode, errorDescription);
  });

  const authSession = session.fromPartition('persist:auth');
  let authCompleted = false;

  loginWindow.webContents.on('did-navigate', async (event, url) => {
    console.log('[Auth] Navigated to:', url);
    if (authCompleted) return;

    if (url.includes('csrestored.fun') && !url.includes('/login')) {
      try {
        const cookies = await authSession.cookies.get({});
        const csrCookies = cookies.filter(c =>
          c.name.includes('jwt') ||
          c.name.includes('session') ||
          c.name.includes('token') ||
          (c.domain && c.domain.includes('csrestored'))
        );

        if (csrCookies.length > 0) {
          authCompleted = true;
          const sess = session.defaultSession;

          for (const cookie of csrCookies) {
            try {
              await sess.cookies.set({
                url: cookie.url || 'https://csrestored.fun',
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain || '.csrestored.fun',
                path: cookie.path || '/',
                secure: cookie.secure !== false,
                httpOnly: cookie.httpOnly !== false,
                expirationDate: cookie.expirationDate || (Date.now() / 1000) + (30 * 24 * 60 * 60)
              });
            } catch (e) {
              console.error('[Auth] Failed to set cookie:', cookie.name, e.message);
            }
          }

          await saveAuthCookies();

          loginWindow.close();
          loginWindow = null;

          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('auth-status', { loggedIn: true });
          }
        }
      } catch (e) {
        console.error('[Auth] Cookie capture error:', e);
      }
    }
  });

  loginWindow.webContents.on('did-navigate-in-page', async (event, url) => {
    console.log('[Auth] Navigate in page:', url);
    if (authCompleted) return;
    if (url.includes('csrestored.fun') && !url.includes('/login')) {
      try {
        const cookies = await authSession.cookies.get({});
        const csrCookies = cookies.filter(c =>
          c.name.includes('jwt') ||
          c.name.includes('session') ||
          c.name.includes('token') ||
          (c.domain && c.domain.includes('csrestored'))
        );

        if (csrCookies.length > 0) {
          authCompleted = true;
          const sess = session.defaultSession;

          for (const cookie of csrCookies) {
            try {
              await sess.cookies.set({
                url: cookie.url || 'https://csrestored.fun',
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain || '.csrestored.fun',
                path: cookie.path || '/',
                secure: cookie.secure !== false,
                httpOnly: cookie.httpOnly !== false,
                expirationDate: cookie.expirationDate || (Date.now() / 1000) + (30 * 24 * 60 * 60)
              });
            } catch (e) {
              console.error('[Auth] Failed to set cookie:', cookie.name, e.message);
            }
          }

          await saveAuthCookies();

          loginWindow.close();
          loginWindow = null;

          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('auth-status', { loggedIn: true });
          }
        }
      } catch (e) {
        console.error('[Auth] Cookie capture error:', e);
      }
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
});

ipcMain.handle('check-auth', async () => {
  try {
    const sess = session.defaultSession;
    const cookies = await sess.cookies.get({});
    const authCookies = cookies.filter(c =>
      c.name.includes('jwt') ||
      c.name.includes('session') ||
      c.name.includes('token') ||
      (c.domain && c.domain.includes('csrestored'))
    );
    console.log('[Auth Check] Found', authCookies.length, 'auth cookies:', authCookies.map(c => c.name));

    if (authCookies.length === 0) {
      return { loggedIn: false };
    }

    const cookieHeader = authCookies.map(c => `${c.name}=${c.value}`).join('; ');

    const { net } = require('electron');
    return new Promise((resolve) => {
      const request = net.request({
        method: 'GET',
        url: `${API_BASE_URL}/users/@me`
      });

      request.setHeader('Cookie', cookieHeader);
      request.setHeader('Accept', 'application/json');

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          console.log('[Auth Check] Response:', response.statusCode, data.substring(0, 300));
          if (response.statusCode === 200) {
            try {
              const userData = JSON.parse(data);
              resolve({ loggedIn: true, user: userData });
            } catch (e) {
              console.error('[Auth Check] Parse error:', e);
              resolve({ loggedIn: false });
            }
          } else {
            resolve({ loggedIn: false, statusCode: response.statusCode });
          }
        });
      });

      request.on('error', (err) => {
        console.error('[Auth Check] Request error:', err);
        resolve({ loggedIn: false, error: err.message });
      });

      request.end();
    });
  } catch (e) {
    console.error('[Auth Check] Error:', e);
    return { loggedIn: false, error: e.message };
  }
});

ipcMain.handle('logout', async () => {
  try {
    const sess = session.defaultSession;
    const cookies = await sess.cookies.get({ domain: '.csrestored.fun' });

    for (const cookie of cookies) {
      const url = `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
      await sess.cookies.remove(url, cookie.name);
    }

    const cookiePath = path.join(app.getPath('userData'), 'auth_cookies.json');
    if (fs.existsSync(cookiePath)) {
      fs.unlinkSync(cookiePath);
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-language', (event, lang) => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    settings.language = lang;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-languages', () => {
  try {
    ensureCustomLangFolder();

    const result = [];
    const added = new Set();

    const loadLanguagesFrom = (directory) => {
      if (!fs.existsSync(directory)) return;

      const files = fs.readdirSync(directory);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const fullPath = path.join(directory, file);
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

          const fileName = path.basename(file, '.json');

          if (added.has(fileName)) continue;

          result.push({
            name: data.language || data.name || fileName,
            file: fileName
          });

          added.add(fileName);
        } catch (e) {
          console.error('[Lang] Failed to parse language:', file, e);
        }
      }
    };

    loadLanguagesFrom(langDir);
    loadLanguagesFrom(getCustomLangDir());

    return result;
  } catch (e) {
    console.error('[Lang] Failed to get language list:', e);
    return [];
  }
});

ipcMain.handle('get-language-data', (event, langName) => {
  try {
    const defaultPath = path.join(langDir, `${langName}.json`);
    const customPath = path.join(getCustomLangDir(), `${langName}.json`);

    let targetPath = null;

    if (fs.existsSync(customPath)) {
      targetPath = customPath;
    } else if (fs.existsSync(defaultPath)) {
      targetPath = defaultPath;
    }

    if (!targetPath) {
      console.warn('[Lang] Language not found:', langName);
      return null;
    }

    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (e) {
    console.error('[Lang] Failed to load language data:', e);
    return null;
  }
});

ipcMain.handle('get-language', async () => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');

    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.language || 'english';
    }
  } catch (e) { }

  return 'english';
});

ipcMain.handle('get-csr-inventory', async () => {
  try {
    const { net } = require('electron');
    const sess = session.defaultSession;
    const cookies = await sess.cookies.get({ domain: '.csrestored.fun' });

    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: 'https://api.csrestored.fun/inventory/'
      });

      request.setHeader('Origin', 'https://csrestored.fun');
      request.setHeader('Referer', 'https://csrestored.fun/');
      request.setHeader('Accept', 'application/json');

      if (cookies.length > 0) {
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        request.setHeader('Cookie', cookieHeader);
      }

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (response.statusCode >= 200 && response.statusCode < 300) {
              const items = Array.isArray(parsed) ? parsed : (parsed.data || parsed.items || []);
              resolve({ error: false, items });
            } else {
              resolve({ error: true, items: [] });
            }
          } catch (e) {
            resolve({ error: true, items: [] });
          }
        });
      });

      request.on('error', (err) => {
        resolve({ error: true, items: [], message: err.message });
      });

      request.end();
    });
  } catch (e) {
    return { error: true, items: [], message: e.message };
  }
});

ipcMain.handle('get-csr-user', async () => {
  try {
    const { net } = require('electron');
    const sess = session.defaultSession;
    const cookies = await sess.cookies.get({ domain: '.csrestored.fun' });

    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: 'https://api.csrestored.fun/users/@me'
      });

      request.setHeader('Origin', 'https://csrestored.fun');
      request.setHeader('Accept', 'application/json');

      if (cookies.length > 0) {
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        request.setHeader('Cookie', cookieHeader);
      }

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (response.statusCode === 200) {
              resolve({ error: false, user: parsed });
            } else {
              resolve({ error: true, status: response.statusCode });
            }
          } catch (e) {
            resolve({ error: true });
          }
        });
      });

      request.on('error', (err) => {
        resolve({ error: true, message: err.message });
      });

      request.end();
    });
  } catch (e) {
    return { error: true, message: e.message };
  }
});

ipcMain.handle('get-csr-history', async () => {
  try {
    const { net } = require('electron');
    const sess = session.defaultSession;
    const cookies = await sess.cookies.get({ domain: '.csrestored.fun' });

    const endpoints = [
      'https://api.csrestored.fun/history',
      'https://api.csrestored.fun/users/@me/history',
      'https://api.csrestored.fun/matches',
      'https://api.csrestored.fun/matches/history',
      'https://api.csrestored.fun/users/history'
    ];

    for (const endpoint of endpoints) {
      const result = await makeApiRequest(endpoint, cookies);
      if (!result.error && result.matches && result.matches.length > 0) {
        return result;
      }
      if (!result.error && result.matches) {
        return result;
      }
    }

    return { error: false, matches: [] };
  } catch (e) {
    return { error: true, matches: [], message: e.message };
  }
});

function makeApiRequest(url, cookies) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const request = net.request({
      method: 'GET',
      url
    });

    request.setHeader('Origin', 'https://csrestored.fun');
    request.setHeader('Referer', 'https://csrestored.fun/');
    request.setHeader('Accept', 'application/json');

    if (cookies.length > 0) {
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      request.setHeader('Cookie', cookieHeader);
    }

    request.on('response', (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode === 200) {
            const matches = Array.isArray(parsed) ? parsed : (parsed.data || parsed.matches || []);
            resolve({ error: false, matches });
          } else {
            resolve({ error: true, matches: [] });
          }
        } catch (e) {
          resolve({ error: true, matches: [] });
        }
      });
    });

    request.on('error', () => {
      resolve({ error: true, matches: [] });
    });

    request.end();
  });
}

ipcMain.handle('get-csr-leaderboard', async () => {
  try {
    if (mainWindow && mainWindow.webContents) {
      const result = await mainWindow.webContents.executeJavaScript(`
        fetch('https://api.csrestored.fun/leaderboard', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        }).then(r => r.json()).catch(e => ({ error: true, message: e.message }))
      `);
      if (result.error) return { error: true, players: [] };
      return { error: false, players: Array.isArray(result) ? result : [] };
    }
    return { error: true, players: [], message: 'No main window' };
  } catch (e) {
    return { error: true, players: [], message: e.message };
  }
});

ipcMain.handle('check-csr-updates', async () => {
  try {
    const manifest = await fetchDownloadManifest();
    if (!manifest) {
      return { error: true, message: 'Failed to fetch manifest' };
    }

    const settings = loadSettings();
    const gameDir = settings.csgoDir;
    if (!gameDir || !fs.existsSync(gameDir)) {
      return { error: true, message: 'Game directory not set' };
    }

    const filesToDownload = [];
    let totalSize = 0;

    for (const file of manifest) {
      if (isIgnored(file)) continue;
      const localPath = path.join(gameDir, file.file);
      let needsDownload = false;

      if (!fs.existsSync(localPath)) {
        needsDownload = true;
      } else {
        const localHash = md5File(localPath);
        if (localHash !== file.hash) {
          needsDownload = true;
        }
      }

      if (needsDownload) {
        filesToDownload.push(file);
        totalSize += file.length || 0;
      }
    }

    if (totalSize > 0) {
      const drive = path.parse(gameDir).root;
      const freeSpace = await getFreeDiskSpace(drive);
      if (freeSpace !== null && totalSize > freeSpace) {
        return {
          error: true,
          message: `Not enough disk space. Need ${(totalSize / 1024 / 1024).toFixed(1)} MB, but only ${(freeSpace / 1024 / 1024).toFixed(1)} MB free on ${drive}`,
          insufficientSpace: true
        };
      }
    }

    console.log(`[Update] ${filesToDownload.length} files need download (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
    return { error: false, files: filesToDownload, totalSize };
  } catch (e) {
    return { error: true, message: e.message };
  }
});

ipcMain.handle('download-csr-files', async (event, gameDir) => {
  try {
    downloadCancelled = false;

    const manifest = await fetchDownloadManifest();
    if (!manifest) {
      return { error: true, message: 'Failed to fetch manifest' };
    }

    const filteredManifest = manifest.filter(f => !isIgnored(f));
    const results = {
      total: filteredManifest.length,
      downloaded: 0,
      failed: 0,
      errors: [],
      currentFile: '',
      cancelled: false
    };

    for (const file of filteredManifest) {
      if (downloadCancelled) {
        results.cancelled = true;
        break;
      }

      results.currentFile = file.file;
      const localPath = path.join(gameDir, file.file);

      try {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });

        const localHash = fs.existsSync(localPath) ? md5File(localPath) : null;
        if (localHash !== file.hash) {
          await downloadFile(file.file, localPath);

          const newHash = md5File(localPath);
          if (newHash !== file.hash) {
            throw new Error(`MD5 mismatch after download: expected ${file.hash}, got ${newHash}`);
          }
        }

        results.downloaded++;
        console.log(`[Update] Downloaded: ${file.file}`);

        mainWindow.webContents.send('update-progress', {
          file: file.file,
          current: results.downloaded,
          total: results.total,
          percent: Math.round((results.downloaded / results.total) * 100)
        });
      } catch (e) {
        results.failed++;
        results.errors.push({ file: file.file, error: e.message });
        console.error(`[Update] Failed: ${file.file}`, e.message);
      }
    }

    results.currentFile = '';
    return results;
  } catch (e) {
    return { error: true, message: e.message };
  }
});

ipcMain.on('cancel-download', () => {
  downloadCancelled = true;
});

function fetchDownloadManifest() {
  return new Promise((resolve, reject) => {
    https.get(DOWNLOAD_API_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed) ? parsed : null);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => {
      resolve(null);
    });
  });
}

function md5File(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  } catch (e) {
    return null;
  }
}

function getFreeDiskSpace(drive) {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        const driveLetter = drive.charAt(0);
        exec(`powershell -NoProfile -Command "(Get-PSDrive '${driveLetter}').Free"`, (err, stdout) => {
          if (err || isNaN(stdout)) {
            resolve(null);
          } else {
            resolve(parseInt(stdout.trim()));
          }
        });
      } else {
        const stat = fs.statfsSync(drive);
        const free = stat.bavail * stat.bsize;
        resolve(free);
      }
    } catch (e) {
      resolve(null);
    }
  });
}

function downloadFile(remotePath, localPath, maxRetries = 3) {
  return new Promise((resolve, reject) => {
    const url = `${DOWNLOAD_BASE_URL}${remotePath}`;
    let attempts = 0;

    function attempt() {
      attempts++;
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          https.get(redirectUrl, (res2) => {
            if (res2.statusCode < 200 || res2.statusCode >= 300) {
              const err = new Error(`HTTP ${res2.statusCode} on redirect for ${remotePath}`);
              if (attempts < maxRetries) {
                setTimeout(attempt, 1000 * attempts);
              } else {
                reject(err);
              }
              return;
            }
            pipeResponseToFile(res2, localPath, resolve, (err) => {
              if (attempts < maxRetries) {
                setTimeout(attempt, 1000 * attempts);
              } else {
                reject(err);
              }
            });
          }).on('error', (err) => {
            if (attempts < maxRetries) {
              setTimeout(attempt, 1000 * attempts);
            } else {
              reject(err);
            }
          });
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode} for ${remotePath}`);
          if (attempts < maxRetries) {
            setTimeout(attempt, 1000 * attempts);
          } else {
            reject(err);
          }
          return;
        }

        pipeResponseToFile(res, localPath, resolve, (err) => {
          if (attempts < maxRetries) {
            setTimeout(attempt, 1000 * attempts);
          } else {
            reject(err);
          }
        });
      }).on('error', (err) => {
        if (attempts < maxRetries) {
          setTimeout(attempt, 1000 * attempts);
        } else {
          reject(err);
        }
      });
    }

    attempt();
  });
}

function pipeResponseToFile(res, localPath, onDone, onError) {
  const file = fs.createWriteStream(localPath);

  res.on('error', () => {
    file.destroy();
    fs.unlink(localPath, () => { });
    onError(new Error('Download stream error'));
  });

  res.pipe(file);

  file.on('finish', () => {
    file.close();
    onDone();
  });

  file.on('error', (err) => {
    fs.unlink(localPath, () => { });
    onError(err);
  });
}