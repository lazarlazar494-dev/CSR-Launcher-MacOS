const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close')
  },
  game: {
    launch: () => ipcRenderer.invoke('launch-game'),
    onStateUpdate: (callback) => {
      ipcRenderer.removeAllListeners('game-state-update');
      ipcRenderer.on('game-state-update', (event, data) => callback(data));
    },
    onLaunchStatus: (callback) => {
      ipcRenderer.removeAllListeners('game-launch');
      ipcRenderer.on('game-launch', (event, data) => callback(data));
    },
    getStatus: () => ipcRenderer.invoke('get-game-status'),
    checkBeforeLaunch: () => ipcRenderer.invoke('check-and-update-before-launch'),
    downloadWithProgress: (gameDir) => ipcRenderer.invoke('download-updates-with-progress', gameDir)
  },
  settings: {
    get: () => ipcRenderer.invoke('get-settings'),
    save: (data) => ipcRenderer.send('save-settings', data),
    onSaved: (callback) => {
      ipcRenderer.removeAllListeners('settings-saved');
      ipcRenderer.on('settings-saved', (event, data) => callback(data));
    }
  },
  inventory: {
    getCSR: () => ipcRenderer.invoke('get-csr-inventory')
  },
  dialog: {
    browseFolder: () => ipcRenderer.invoke('browse-folder'),
    browseFile: (filters) => ipcRenderer.invoke('browse-file', filters)
  },
  auth: {
    login: () => ipcRenderer.invoke('start-login'),
    logout: () => ipcRenderer.invoke('logout'),
    checkStatus: () => ipcRenderer.invoke('check-auth'),
    getUser: () => ipcRenderer.invoke('get-csr-user'),
    onStatusChange: (callback) => {
      ipcRenderer.removeAllListeners('auth-status');
      ipcRenderer.on('auth-status', (event, data) => callback(data));
    }
  },
  csr: {
    getHistory: () => ipcRenderer.invoke('get-csr-history'),
    getLeaderboard: () => ipcRenderer.invoke('get-csr-leaderboard'),
    checkUpdates: () => ipcRenderer.invoke('check-csr-updates'),
    downloadFiles: (gameDir) => ipcRenderer.invoke('download-csr-files', gameDir),
    cancelDownload: () => ipcRenderer.send('cancel-download'),
    onUpdateProgress: (callback) => {
      ipcRenderer.removeAllListeners('update-progress');
      ipcRenderer.on('update-progress', (event, data) => callback(data));
    }
  },
  language: {
    getCurrent: () => ipcRenderer.invoke('get-language'),
    save: (name) => ipcRenderer.invoke('save-language', name),
    getList: () => ipcRenderer.invoke('get-languages'),
    getData: (name) => ipcRenderer.invoke('get-language-data', name)
  }
});
