const { execFileSync } = require('child_process');
const Store = require('electron-store');
const { DEFAULT_PROVIDER_ID, getProvider } = require('./aiProviders');
const {
  LIMITS,
  hasAiContext,
  mergeSavedContext,
  readContextState,
  storableContext
} = require('./aiContext');

function readWindowsFullName() {
  if (process.platform !== 'win32') return '';
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "function Emit([string]$value) {",
    "  $clean = $value.Trim()",
    "  if ($clean.Length -ge 2) { Write-Output $clean; exit 0 }",
    "}",
    "try {",
    "  $id = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Common\\Identity'",
    "  Emit ([string]$id.ADUserDisplayName)",
    "} catch {}",
    "try {",
    "  Add-Type -AssemblyName System.DirectoryServices.AccountManagement",
    "  $user = [System.DirectoryServices.AccountManagement.UserPrincipal]::Current",
    "  Emit ([string]$user.DisplayName)",
    "} catch {}",
    "try {",
    "  Emit ([string]([adsi]\"WinNT://$env:USERDOMAIN/$env:USERNAME,user\").FullName)",
    "} catch {}"
  ].join('\n');
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return String(out || '').replace(/\u0000/g, '').trim().split(/\r?\n/).find((line) => line.trim()) || '';
  } catch {
    return '';
  }
}

const store = new Store({
  defaults: {
    undetectable: true,
    bridgeEnabled: true,
    autoEnableCaptions: true,
    autoForwardMode: 'off',
    showAnswerOverlay: true,
    enabled: true,
    agentProvider: DEFAULT_PROVIDER_ID,
    captionMode: 'live',
    selfName: '',
    aiContext: {
      instructions: '',
      resumeText: '',
      resumeFileName: '',
      jdText: '',
      jdFileName: '',
      revision: 0
    },
    aiContextApplied: {}
  }
});

class AppState {
  constructor() {
    this.chatgptWebContents = null;
    this.agentView = null;
    this.agentLoading = false;
    this.overlayWindow = null;
    this.settingsWindow = null;
    this.lastForwardKey = '';
    this.lastForwardAt = 0;
    this.lastSendResult = null;
    // Undetectable Mode is always on when the app starts (Teams/Zoom capture exclusion).
    this.setUndetectable(true);
    // Meeting→ChatGPT bridge is always on; captions go via manual Send only.
    this.set('bridgeEnabled', true);
    this.set('autoForwardMode', 'off');
    store.delete('forwardPrefix');
    store.delete('aiContextEverySend');
  }

  get(key) {
    return store.get(key);
  }

  set(key, value) {
    store.set(key, value);
  }

  getAll() {
    const agent = this.getAgent();
    return {
      ...store.store,
      undetectable: this.isUndetectable(),
      agentProvider: agent.id,
      agentName: agent.name
    };
  }

  getAiContextView() {
    const ctx = storableContext(this.get('aiContext'));
    const state = readContextState(this);
    const agent = this.getAgent();
    const active = hasAiContext(ctx);
    return {
      ...ctx,
      providerId: agent.id,
      providerName: agent.name,
      active,
      applied: active && Number(state.appliedRevision) === Number(ctx.revision),
      limits: LIMITS
    };
  }

  saveAiContext(input) {
    const saved = mergeSavedContext(this.get('aiContext'), input);
    const next = saved.context;
    this.set('aiContext', next);
    return {
      context: this.getAiContextView(),
      truncated: saved.truncated
    };
  }

  markAiContextApplied() {
    const ctx = storableContext(this.get('aiContext'));
    if (!hasAiContext(ctx)) return ctx;
    const providerId = this.getAgentProvider();
    const applied = { ...(this.get('aiContextApplied') || {}) };
    applied[providerId] = Number(ctx.revision) || 0;
    this.set('aiContextApplied', applied);
    return this.getAiContextView();
  }

  getAgentProvider() {
    return getProvider(store.get('agentProvider')).id;
  }

  getAgent() {
    return getProvider(this.getAgentProvider());
  }

  setAgentProvider(id) {
    const provider = getProvider(id);
    store.set('agentProvider', provider.id);
    return provider;
  }

  ensureSelfName() {
    const current = String(this.get('selfName') || '').trim();
    if (current) return current;
    if (this._selfNameLookup) return '';
    this._selfNameLookup = true;
    const name = readWindowsFullName();
    if (name) {
      this.set('selfName', name);
      if (!this.get('selfNameSource')) this.set('selfNameSource', 'windows');
    }
    return name;
  }

  rememberMeetingSelfName(name, platform) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 2 || clean.length > 60) return false;
    if (this.get('selfNameSource') === 'manual') return false;
    const current = String(this.get('selfName') || '').trim();
    const same = current.toLowerCase() === clean.toLowerCase();
    if (!same) this.set('selfName', clean);
    this.set('selfNameSource', 'meeting');
    this.set('selfNamePlatform', String(platform || '').toLowerCase());
    return !same;
  }

  isUndetectable() {
    return true;
  }

  setUndetectable() {
    store.set('undetectable', true);
  }

  getChatGPTWebContents() {
    const wc = this.chatgptWebContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }
}

module.exports = { AppState, store };
