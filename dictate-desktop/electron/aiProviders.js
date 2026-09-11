const DEFAULT_PROVIDER_ID = 'chatgpt';

const PROVIDERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com']
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai/new',
    hosts: ['claude.ai', 'anthropic.com']
  },
  {
    id: 'cursor',
    name: 'Cursor Agents',
    url: 'https://cursor.com/agents',
    hosts: ['cursor.com', 'www.cursor.com', 'cursor.sh', 'authenticator.cursor.sh']
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    hosts: ['gemini.google.com', 'bard.google.com']
  },
  {
    id: 'copilot',
    name: 'Microsoft Copilot',
    url: 'https://copilot.microsoft.com',
    hosts: ['copilot.microsoft.com', 'm365.cloud.microsoft', 'sydney.bing.com', 'www.bing.com', 'bing.com']
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    url: 'https://www.perplexity.ai',
    hosts: ['perplexity.ai', 'www.perplexity.ai']
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com',
    hosts: ['grok.com', 'x.ai', 'grok.x.ai']
  }
];

const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.windows.net',
  'account.microsoft.com',
  'github.com',
  'auth0.com',
  'okta.com',
  'edgeservices.bing.com',
  'consents.google.com'
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function hostMatches(hostname, allowed) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return allowed.some((item) => host === item || host.endsWith(`.${item}`));
}

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function getProvider(id) {
  return BY_ID.get(String(id || '').trim()) || BY_ID.get(DEFAULT_PROVIDER_ID);
}

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, url: p.url }));
}

function isAllowedOverlayUrl(value) {
  const href = String(value || '').trim();
  if (!href || href === 'about:blank') return true;
  const parsed = parseUrl(href);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return false;
  if (hostMatches(parsed.hostname, AUTH_HOSTS)) return true;
  return PROVIDERS.some((p) => hostMatches(parsed.hostname, p.hosts));
}

function publicProvider(provider) {
  const p = provider || getProvider(DEFAULT_PROVIDER_ID);
  return { id: p.id, name: p.name, url: p.url };
}

module.exports = {
  DEFAULT_PROVIDER_ID,
  PROVIDERS,
  getProvider,
  listProviders,
  isAllowedOverlayUrl,
  publicProvider
};
