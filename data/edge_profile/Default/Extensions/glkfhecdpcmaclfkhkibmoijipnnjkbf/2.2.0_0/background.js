// Google Analytics (GA4 property linked to the metapompt-transfer Firebase project). Extensions
// can't load gtag, so events go to the trackEvent function, which adds the Measurement Protocol
// secret and forwards them. Pages and content scripts send { type: 'analytics', name, params } here.
const TRACK_EVENT_URL = 'https://us-central1-metapompt-transfer.cloudfunctions.net/trackEvent';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Cached so events sent together on first run share one ID.
let clientIdPromise;
function getClientId() {
  clientIdPromise ??= (async () => {
    const { gaClientId } = await chrome.storage.local.get('gaClientId');
    if (gaClientId) return gaClientId;
    const clientId = crypto.randomUUID();
    await chrome.storage.local.set({ gaClientId: clientId });
    return clientId;
  })();
  return clientIdPromise;
}

async function getSessionId() {
  const now = Date.now();
  const { gaSession } = await chrome.storage.session.get('gaSession');
  const session = gaSession && now - gaSession.lastSeen < SESSION_TIMEOUT_MS
    ? { ...gaSession, lastSeen: now }
    : { id: String(Math.floor(now / 1000)), lastSeen: now };
  await chrome.storage.session.set({ gaSession: session });
  return session.id;
}

// Usage events are sent from install on, unless usage data is turned off in the popup.
// Accepting the policy (I AGREE) only gates prompt collection.
async function trackEvent(name, params = {}) {
  try {
    const { analyticsOptOut } = await chrome.storage.local.get('analyticsOptOut');
    if (analyticsOptOut) return;
    const [clientId, sessionId] = await Promise.all([getClientId(), getSessionId()]);
    await fetch(TRACK_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        events: [{
          name,
          params: {
            ...params,
            session_id: sessionId,
            engagement_time_msec: 100,
            extension_version: chrome.runtime.getManifest().version
          }
        }]
      })
    });
  } catch (error) {
    console.error('Error sending analytics event:', error);
  }
}

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request?.type === 'analytics' && typeof request.name === 'string') trackEvent(request.name, request.params);
  if (request?.type === 'genaiMessages') queueGenaiMessages(request, sender);
});

// ChatGPT and Claude conversations, captured the same way as AIWise and Friendly AI: the
// collectors (src/genaiCollector.ts) post what the page shows, src/genaiRelay.ts redacts it,
// and settled messages are queued here and uploaded to the panel's GenAI messages endpoint
// (staywise, `panel_gen_ai_messages`). Each version of a message goes once: a ledger keeps the
// fingerprint last accepted. Only for users who accepted the policy version that discloses it.
const GENAI_ENDPOINT = 'https://purchases.stayfreeapps.com/api/v1/analytics/genai/messages';
const GENAI_APP_ID = 'metaprompt-extension';
// The @sensortower/genai-collection version in package.json (checked by tests/genai.test.ts).
const GENAI_COLLECTOR_VERSION = '1.1.0';
const GENAI_POLICY_VERSION = '1.1.0';
const GENAI_HOSTS = { 'chatgpt.com': 'chatgpt.com', 'claude.ai': 'claude.ai' };
const GENAI_ALARM = 'genai-upload';
const GENAI_FLUSH_MINUTES = 15;
// Flush early once this much is waiting.
const GENAI_FLUSH_AT_MESSAGES = 100;
const GENAI_FLUSH_AT_BYTES = 1_000_000;
const GENAI_MAX_BATCH_MESSAGES = 2000;
const GENAI_MAX_BATCH_BYTES = 4_000_000;
const GENAI_MAX_BATCHES_PER_RUN = 10;
// storage.local holds 10 MB for the whole extension: this queue, History and everything else.
const GENAI_MAX_QUEUE_BYTES = 2_000_000;
const GENAI_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GENAI_MIN_BACKOFF_MS = 60_000;
const GENAI_MAX_BACKOFF_MS = 30 * 60_000;
const INSTALL_ID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function versionAtLeast(version, minimum) {
  const parts = String(version).split('.').map(Number);
  const wanted = minimum.split('.').map(Number);
  for (let i = 0; i < wanted.length; i++) {
    if ((parts[i] || 0) !== wanted[i]) return (parts[i] || 0) > wanted[i];
  }
  return true;
}

// Capture needs I AGREE on the policy that discloses it (1.1.0+), not just usage data being on.
// genaiSites holds the sites turned off in the popup's Your data, e.g. { 'claude.ai': false }.
async function hasCaptureConsent(site) {
  const { analyticsOptOut, genaiSites, onboarding, privacyOptIn, uid } =
    await chrome.storage.local.get(['analyticsOptOut', 'genaiSites', 'onboarding', 'privacyOptIn', 'uid']);
  if (analyticsOptOut || (site && genaiSites?.[site] === false)) return false;
  const accepted = (consent) => Boolean(consent?.acceptedAt && versionAtLeast(consent.policyVersion, GENAI_POLICY_VERSION));
  return accepted(onboarding) || (accepted(privacyOptIn) && privacyOptIn.uid === uid);
}

// The queue and ledger are read, changed and written back; one change at a time.
let genaiLock = Promise.resolve();
function withGenaiLock(task) {
  const run = genaiLock.then(task, task);
  genaiLock = run.catch(() => {});
  return run;
}

// Same format as @sensortower/panel-api-utils' generateInstallId.
let installIdPromise;
function getInstallId() {
  installIdPromise ??= (async () => {
    const { installId } = await chrome.storage.local.get('installId');
    if (installId) return installId;
    const id = [...crypto.getRandomValues(new Uint8Array(13))]
      .map((byte) => INSTALL_ID_CHARACTERS[byte % INSTALL_ID_CHARACTERS.length]).join('');
    await chrome.storage.local.set({ installId: id });
    return id;
  })();
  return installIdPromise;
}

// JSON with object keys sorted at every level and no whitespace.
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

// The first 16 hex characters of SHA-256 over what is sent, as the iOS app, Android app and AIWise make it.
async function genaiFingerprint(message) {
  const content = canonicalJson([message.text, message.status, message.model, message.parent_message_id, message.attachments]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const utf8Bytes = (text) => new TextEncoder().encode(text).length;

function isValidGenaiMessage(message, provider) {
  return message?.provider === provider &&
    typeof message.conversation_id === 'string' && message.conversation_id && !message.conversation_id.startsWith('pending:') &&
    typeof message.message_id === 'string' && message.message_id &&
    typeof message.text === 'string' &&
    ['user', 'assistant'].includes(message.role) &&
    ['complete', 'stopped', 'error'].includes(message.status);
}

async function queueGenaiMessages({ provider, messages }, sender) {
  try {
    // Page scripts could post a snapshot too, so its site has to be the tab's.
    const host = sender?.url ? new URL(sender.url).hostname : '';
    const site = Object.hasOwn(GENAI_HOSTS, provider) ? GENAI_HOSTS[provider] : null;
    if (!site || (host !== site && !host.endsWith(`.${site}`)) || !Array.isArray(messages)) return;
    if (!(await hasCaptureConsent(site))) return;

    const prepared = [];
    for (const message of messages) {
      if (!isValidGenaiMessage(message, provider)) continue;
      const upload = { ...message, observed_at: Date.now(), fingerprint: await genaiFingerprint(message) };
      prepared.push({
        key: `${provider}\n${message.conversation_id}\n${message.message_id}`,
        message: upload,
        bytes: utf8Bytes(JSON.stringify(upload))
      });
    }
    if (prepared.length === 0) return;

    const shouldFlush = await withGenaiLock(async () => {
      const { genaiQueue = [], genaiLedger = {} } = await chrome.storage.local.get(['genaiQueue', 'genaiLedger']);
      let changed = false;
      for (const item of prepared) {
        if (genaiLedger[item.key]?.fingerprint === item.message.fingerprint) continue;
        const index = genaiQueue.findIndex((queued) => queued.key === item.key);
        // Already waiting in this version: it keeps its observed_at.
        if (index >= 0 && genaiQueue[index].message.fingerprint === item.message.fingerprint) continue;
        // Only the latest version of a message still waiting is worth sending.
        if (index >= 0) genaiQueue.splice(index, 1);
        genaiQueue.push(item);
        changed = true;
      }
      if (!changed) return false;
      let total = genaiQueue.reduce((sum, queued) => sum + queued.bytes, 0);
      while (total > GENAI_MAX_QUEUE_BYTES && genaiQueue.length > 0) total -= genaiQueue.shift().bytes;
      await chrome.storage.local.set({ genaiQueue });
      return genaiQueue.length >= GENAI_FLUSH_AT_MESSAGES || total >= GENAI_FLUSH_AT_BYTES;
    });
    if (shouldFlush) await uploadGenaiQueue();
  } catch (error) {
    console.error('Error queueing messages:', error);
  }
}

function takeGenaiBatch(queue, limit) {
  const batch = [];
  let bytes = 0;
  for (const item of queue) {
    if (batch.length >= limit || (batch.length > 0 && bytes + item.bytes > GENAI_MAX_BATCH_BYTES)) break;
    batch.push(item);
    bytes += item.bytes;
  }
  return batch;
}

// 'accepted', 'rejected' (never will be), 'too-large', or { retryAfterMs } to try again later.
async function sendGenaiBatch(batch) {
  const body = JSON.stringify({
    schema: 1,
    batch_id: crypto.randomUUID(),
    install_id: await getInstallId(),
    app_id: GENAI_APP_ID,
    app_version: chrome.runtime.getManifest().version,
    collector_version: GENAI_COLLECTOR_VERSION,
    platform: 'chrome',
    messages: batch.map((item) => item.message)
  });
  let response;
  try {
    const gzipped = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    response = await fetch(GENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gzipped
    });
  } catch {
    return { retryAfterMs: null };
  }
  if (response.ok) return 'accepted';
  if (response.status === 413) return 'too-large';
  if (response.status === 429 || response.status >= 500) {
    const seconds = Number(response.headers.get('Retry-After'));
    return { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
  }
  return 'rejected';
}

// One upload run: as many batches as are waiting, until one fails.
async function uploadGenaiQueue() {
  if (!(await hasCaptureConsent())) return;
  const { genaiRetry } = await chrome.storage.local.get('genaiRetry');
  if (genaiRetry && Date.now() < genaiRetry.at) return;

  await withGenaiLock(async () => {
    let limit = GENAI_MAX_BATCH_MESSAGES;
    for (let run = 0; run < GENAI_MAX_BATCHES_PER_RUN; run++) {
      const { genaiQueue = [] } = await chrome.storage.local.get('genaiQueue');
      if (genaiQueue.length === 0) return;
      const batch = takeGenaiBatch(genaiQueue, limit);
      const result = await sendGenaiBatch(batch);

      if (result === 'too-large' && batch.length > 1) {
        limit = Math.max(1, Math.floor(batch.length / 2));
        continue;
      }
      if (typeof result === 'object') {
        const backoffMs = Math.min(GENAI_MAX_BACKOFF_MS, Math.max(GENAI_MIN_BACKOFF_MS, (genaiRetry?.backoffMs ?? GENAI_MIN_BACKOFF_MS / 2) * 2));
        await chrome.storage.local.set({ genaiRetry: { at: Date.now() + (result.retryAfterMs ?? backoffMs), backoffMs } });
        return;
      }

      // Accepted, or never will be: either way it leaves the queue.
      const sent = new Set(batch.map((item) => item.key + item.message.fingerprint));
      const { genaiQueue: latest = [], genaiLedger = {} } = await chrome.storage.local.get(['genaiQueue', 'genaiLedger']);
      const update = { genaiQueue: latest.filter((item) => !sent.has(item.key + item.message.fingerprint)) };
      if (result === 'accepted') {
        const now = Date.now();
        const ledger = Object.fromEntries(Object.entries(genaiLedger).filter(([, entry]) => now - entry.at < GENAI_LEDGER_RETENTION_MS));
        for (const item of batch) ledger[item.key] = { fingerprint: item.message.fingerprint, at: now };
        Object.assign(update, { genaiLedger: ledger, genaiRetry: null });
      }
      await chrome.storage.local.set(update);
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GENAI_ALARM) uploadGenaiQueue();
});
// The service worker restarts after every idle stretch: recreating the alarm would push it back each time.
chrome.alarms.get(GENAI_ALARM).then((existing) => {
  if (existing?.periodInMinutes !== GENAI_FLUSH_MINUTES) chrome.alarms.create(GENAI_ALARM, { periodInMinutes: GENAI_FLUSH_MINUTES });
});

// Turning usage data off drops whatever is still waiting; turning a site off drops that site's.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.analyticsOptOut?.newValue) {
    withGenaiLock(() => chrome.storage.local.remove(['genaiQueue', 'genaiRetry']));
  }
  const sites = area === 'local' ? changes.genaiSites?.newValue ?? {} : {};
  const off = Object.keys(sites).filter((site) => sites[site] === false);
  if (off.length > 0) {
    withGenaiLock(async () => {
      const { genaiQueue } = await chrome.storage.local.get('genaiQueue');
      if (!genaiQueue) return;
      await chrome.storage.local.set({ genaiQueue: genaiQueue.filter((item) => !off.includes(item.message.provider)) });
    });
  }
});

// History: the user's ChatGPT and Claude conversations, kept on this device for the popup's
// History view (src/history.ts). Never uploaded from here, and not redacted, so people see what
// they wrote. Saved under the same consent as capture. historyIndex holds one entry per
// conversation; each conversation's messages are under history:<provider>:<id>.
const HISTORY_PREFIX = 'history:';
// The most recent conversations, with messages for as many as fit in HISTORY_MAX_BYTES.
const HISTORY_MAX_CONVERSATIONS = 100;
const HISTORY_MAX_BYTES = 4_000_000;
const HISTORY_MAX_MESSAGES = 500;
const HISTORY_MAX_LIST = 500;
// Past conversations the user hasn't opened are imported (fetched by the site's tab, see
// genaiCollector.ts) on these sites, up to the most recent HISTORY_IMPORT_MAX.
const HISTORY_IMPORT_SITES = ['chatgpt.com'];
const HISTORY_IMPORT_MAX = 100;
// One tab imports a conversation at a time; another may retry it after this.
const HISTORY_IMPORT_RETRY_MS = 10 * 60 * 1000;
const historyImporting = new Map();

let historyLock = Promise.resolve();
function withHistoryLock(task) {
  const run = historyLock.then(task, task);
  historyLock = run.catch(() => {});
  return run;
}

// The provider's site, when the tab that sent it is that site.
function historySite(provider, sender) {
  const host = sender?.url ? new URL(sender.url).hostname : '';
  const site = Object.hasOwn(GENAI_HOSTS, provider) ? GENAI_HOSTS[provider] : null;
  return site && (host === site || host.endsWith(`.${site}`)) ? site : null;
}

const timeOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const latest = (...times) => Math.max(0, ...times.map((time) => time ?? 0)) || null;

// Drops the least recently updated conversations past the count cap. Past the size cap, older
// ones keep their title but lose their messages (trimmed, so they aren't imported again).
// Returns the message keys to remove.
function pruneHistory(index) {
  const keys = Object.keys(index).sort((a, b) => (index[b].updatedAt ?? 0) - (index[a].updatedAt ?? 0));
  let bytes = 0;
  const removed = [];
  keys.forEach((key, i) => {
    const entry = index[key];
    if (i >= HISTORY_MAX_CONVERSATIONS) {
      delete index[key];
    } else if (bytes + (entry.bytes ?? 0) > HISTORY_MAX_BYTES) {
      index[key] = { ...entry, prompts: 0, messages: 0, bytes: 0, trimmed: true };
    } else {
      bytes += entry.bytes ?? 0;
      return;
    }
    removed.push(HISTORY_PREFIX + key);
  });
  return removed;
}

async function writeHistory(historyIndex, values = {}) {
  const removed = pruneHistory(historyIndex);
  removed.forEach((key) => delete values[key]);
  if (removed.length > 0) await chrome.storage.local.remove(removed);
  await chrome.storage.local.set({ ...values, historyIndex });
}

// The sidebar's list: every conversation's title and dates, before its messages are seen.
// Answers the ids the tab should import: recent ones with no messages yet, or newer ones since.
async function saveHistoryConversations({ provider, conversations }, sender) {
  try {
    const site = historySite(provider, sender);
    if (!site || !Array.isArray(conversations) || !(await hasCaptureConsent(site))) return [];
    return await withHistoryLock(async () => {
      const { historyIndex = {} } = await chrome.storage.local.get('historyIndex');
      // @sensortower/genai-collection's Conversation
      for (const conversation of conversations.slice(0, HISTORY_MAX_LIST)) {
        const id = conversation?.conversationId;
        if (typeof id !== 'string' || !id) continue;
        const key = `${provider}:${id}`;
        const entry = historyIndex[key] ?? { provider, id, title: '', prompts: 0, messages: 0 };
        historyIndex[key] = {
          ...entry,
          title: typeof conversation.title === 'string' && conversation.title ? conversation.title.slice(0, 300) : entry.title,
          createdAt: timeOrNull(conversation.createdAt) ?? entry.createdAt ?? null,
          updatedAt: latest(timeOrNull(conversation.updatedAt), entry.updatedAt)
        };
      }
      await writeHistory(historyIndex);
      return historyToImport(provider, conversations, historyIndex);
    });
  } catch (error) {
    console.error('Error saving conversations:', error);
    return [];
  }
}

// The keys of the provider's most recent conversations, which History imports.
function recentHistory(provider, historyIndex) {
  return Object.entries(historyIndex)
    .filter(([, entry]) => entry.provider === provider)
    .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, HISTORY_IMPORT_MAX)
    .map(([key]) => key);
}

function historyToImport(provider, conversations, historyIndex) {
  if (!HISTORY_IMPORT_SITES.includes(provider)) return [];
  const recent = new Set(recentHistory(provider, historyIndex));
  const now = Date.now();
  const ids = [];
  for (const conversation of conversations) {
    const key = `${provider}:${conversation?.conversationId}`;
    const entry = historyIndex[key];
    if (!entry || !recent.has(key) || now - (historyImporting.get(key) ?? 0) < HISTORY_IMPORT_RETRY_MS) continue;
    // A minute's slack: the list's date moves when the site names a new conversation.
    const changed = (timeOrNull(conversation.updatedAt) ?? 0) - (entry.lastMessageAt ?? 0) > 60_000;
    if ((entry.messages || entry.trimmed) && !changed) continue;
    historyImporting.set(key, now);
    ids.push(entry.id);
  }
  return ids;
}

// A conversation's messages, as the page shows them.
async function saveHistoryMessages({ provider, messages }, sender) {
  try {
    const site = historySite(provider, sender);
    if (!site || !Array.isArray(messages) || !(await hasCaptureConsent(site))) return;
    const byConversation = new Map();
    for (const m of messages) {
      if (typeof m?.conversation_id !== 'string' || !m.conversation_id || m.conversation_id.startsWith('pending:')) continue;
      if (typeof m.message_id !== 'string' || !m.message_id || typeof m.text !== 'string' || !['user', 'assistant'].includes(m.role)) continue;
      const list = byConversation.get(m.conversation_id) ?? [];
      list.push({
        id: m.message_id,
        role: m.role,
        text: m.text,
        createdAt: timeOrNull(m.created_at),
        model: typeof m.model === 'string' ? m.model : null
      });
      byConversation.set(m.conversation_id, list);
    }
    if (byConversation.size === 0) return;

    await withHistoryLock(async () => {
      const { historyIndex = {} } = await chrome.storage.local.get('historyIndex');
      const values = {};
      for (const [id, snapshot] of byConversation) {
        const key = `${provider}:${id}`;
        const storageKey = HISTORY_PREFIX + key;
        const { [storageKey]: stored = [] } = await chrome.storage.local.get(storageKey);
        // A snapshot that starts where the stored copy starts is the whole conversation, and
        // replaces it (an edited prompt drops its old branch). Otherwise it's part of it: merged.
        let saved = snapshot;
        if (stored.length > 0 && stored[0].id !== snapshot[0].id) {
          const ids = new Set(snapshot.map((m) => m.id));
          saved = [...stored.filter((m) => !ids.has(m.id)), ...snapshot]
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        }
        saved = saved.slice(-HISTORY_MAX_MESSAGES);
        if (JSON.stringify(saved) === JSON.stringify(stored)) continue;

        const entry = historyIndex[key] ?? { provider, id, title: '', createdAt: null, updatedAt: null };
        const prompts = saved.filter((m) => m.role === 'user');
        historyIndex[key] = {
          ...entry,
          preview: prompts[0]?.text.slice(0, 200) ?? '',
          prompts: prompts.length,
          messages: saved.length,
          createdAt: entry.createdAt ?? saved[0].createdAt,
          updatedAt: latest(entry.updatedAt, ...saved.map((m) => m.createdAt)),
          lastMessageAt: latest(...saved.map((m) => m.createdAt)),
          bytes: utf8Bytes(JSON.stringify(saved)),
          trimmed: false
        };
        values[storageKey] = saved;
      }
      if (Object.keys(values).length > 0) await writeHistory(historyIndex, values);
    });
  } catch (error) {
    console.error('Error saving history:', error);
  }
}

async function clearHistory() {
  await withHistoryLock(async () => {
    const { historyIndex = {} } = await chrome.storage.local.get('historyIndex');
    await chrome.storage.local.remove([...Object.keys(historyIndex).map((key) => HISTORY_PREFIX + key), 'historyIndex', 'historyRetro']);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'historyConversations') {
    saveHistoryConversations(request, sender).then((importIds) => sendResponse({ importIds }));
    return true;
  }
  if (request?.type === 'historyMessages') saveHistoryMessages(request, sender);
  // The tab asks before it reads past conversations (genaiRelay.ts), and again when consent changes.
  if (request?.type === 'captureAllowed') {
    const site = historySite(request.provider, sender);
    (site ? hasCaptureConsent(site) : Promise.resolve(false)).then(async (allowed) => {
      // Whether to page through the list for conversations past the sidebar's first page
      let importList = false;
      if (allowed && HISTORY_IMPORT_SITES.includes(request.provider)) {
        const { historyIndex = {} } = await chrome.storage.local.get('historyIndex');
        const recent = recentHistory(request.provider, historyIndex);
        importList = recent.length < HISTORY_IMPORT_MAX || recent.some((key) => !historyIndex[key].messages && !historyIndex[key].trimmed);
      }
      sendResponse({ allowed, importList });
    });
    return true;
  }
  // Only the extension's own pages can clear it.
  if (request?.type === 'clearHistory' && sender?.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    clearHistory().then(() => sendResponse({}));
    return true;
  }
});

// First install opens our site's welcome page (Metaprompt-Extension/metaprompt-web), which reports
// the install to Google Ads and Meta when the user came from an ad, then hands the tab to
// onboarding (src/onboarding.html, web accessible for this). Updates don't open anything.
const WELCOME_URL = 'https://metaprompt.stayfreeapps.com/welcome';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    trackEvent('extension_installed');
    const onboarding = chrome.runtime.getURL('src/onboarding.html');
    chrome.tabs.create({ url: `${WELCOME_URL}?next=${encodeURIComponent(onboarding)}` });
  } else if (details.reason === 'update') {
    trackEvent('extension_updated', { previous_version: details.previousVersion });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "openPopup") {
    chrome.action.openPopup();
    sendResponse({});
  }
});
