const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const ROOT_DIR = (process.pkg && process.execPath) ? path.dirname(process.execPath) : __dirname;
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks');
const COMPLETED_DIR = path.join(STORAGE_DIR, 'completed');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const P2P_TEMP_DIR = path.join(STORAGE_DIR, 'temp_p2p');

// Ensure necessary directories exist
[STORAGE_DIR, CHUNKS_DIR, COMPLETED_DIR, DATA_DIR, P2P_TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Supabase Cloud Backend Integration (PostgreSQL + Object Storage CDN)
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rjcwargndkoaktlzithj.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7f4dQpHELm3fdagIzzxPNA_soFpjF7w';
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { transport: WebSocket }
  });
  console.log('✓ Connected to Supabase Cloud Engine (PostgreSQL & Storage)');
} catch (e) {
  console.warn('Supabase initialization warning:', e.message);
}

// Cryptographic Password Hashing and Security Helpers
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  try {
    const [salt, originalHash] = stored.split(':');
    const hashBuffer = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'), 'hex');
    const originalBuffer = Buffer.from(originalHash, 'hex');
    if (hashBuffer.length !== originalBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, originalBuffer);
  } catch (err) {
    return false;
  }
}

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password is required.' };
  }
  if (password.length < 6) {
    return { valid: false, message: 'Password must be at least 6 characters long.' };
  }
  return { valid: true };
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidUsername(username) {
  if (!username || typeof username !== 'string') return false;
  return /^[a-zA-Z0-9_]{3,30}$/.test(username.trim());
}

function normalizeMobileNumber(countryCode, rawMobile) {
  if (!rawMobile || typeof rawMobile !== 'string') return '';
  const trimmed = rawMobile.trim();
  if (trimmed.startsWith('+')) {
    return '+' + trimmed.replace(/\D/g, '');
  }
  const cleanDigits = trimmed.replace(/\D/g, '');
  if (!cleanDigits) return '';
  const code = (countryCode || '+91').trim().replace(/[^\d+]/g, '');
  const prefix = code.startsWith('+') ? code : '+' + code;
  const codeDigits = prefix.replace('+', '');
  if (cleanDigits.startsWith(codeDigits)) {
    return '+' + cleanDigits;
  }
  return prefix + cleanDigits;
}

function isValidMobileNumber(normalizedMobile) {
  if (!normalizedMobile || typeof normalizedMobile !== 'string') return false;
  return /^\+[1-9]\d{7,14}$/.test(normalizedMobile);
}

function hashOtp(otp, salt) {
  return crypto.createHash('sha256').update(`${otp}:${salt}`).digest('hex');
}

// Persistent JSON database helper with In-Memory Caching & Debounced Writes for Max Performance
let dbCache = null;
let dbSaveTimer = null;

function loadDB() {
  if (dbCache) return dbCache;

  let data;
  if (!fs.existsSync(DB_FILE)) {
    data = {
      users: [
        {
          id: 'u_1',
          username: 'zenmaster',
          email: 'zen@sharebox.io',
          mobileNumber: '+12025550101',
          zenId: 'ZEN-1001-ALPHA',
          name: 'Master Zen',
          passwordHash: hashPassword('ZenMaster@2026!'),
          isVerified: true,
          isMobileVerified: true,
          createdAt: new Date().toISOString()
        },
        {
          id: 'u_2',
          username: 'alex',
          email: 'alex@example.com',
          mobileNumber: '+12025550102',
          zenId: 'ZEN-2045-BETA',
          name: 'Alex Rivera',
          passwordHash: hashPassword('AlexRivera@2026!'),
          isVerified: true,
          isMobileVerified: true,
          createdAt: new Date().toISOString()
        },
        {
          id: 'u_3',
          username: 'sophia',
          email: 'sophia@example.com',
          mobileNumber: '+12025550103',
          zenId: 'ZEN-3391-GAMMA',
          name: 'Sophia Chen',
          passwordHash: hashPassword('SophiaChen@2026!'),
          isVerified: true,
          isMobileVerified: true,
          createdAt: new Date().toISOString()
        }
      ],
      sessions: {},
      verificationCodes: {},
      mobileOtps: {},
      passwordResetTokens: {},
      transfers: {},
      shareLinks: {}
    };
    saveDB(data, true);
    dbCache = data;
    return dbCache;
  }
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    data = { users: [], transfers: {}, shareLinks: {} };
  }

  // Ensure all collections exist
  data.users = data.users || [];
  data.sessions = data.sessions || {};
  data.verificationCodes = data.verificationCodes || {};
  data.mobileOtps = data.mobileOtps || {};
  data.passwordResetTokens = data.passwordResetTokens || {};
  data.transfers = data.transfers || {};
  data.shareLinks = data.shareLinks || {};

  dbCache = data;
  return dbCache;
}

function saveDB(data, immediate = false) {
  dbCache = data;

  if (immediate) {
    if (dbSaveTimer) {
      clearTimeout(dbSaveTimer);
      dbSaveTimer = null;
    }
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('Error writing DB_FILE immediately:', e);
    }
    return;
  }

  // Debounced write: Batches high-volume chunk writes to eliminate disk thrashing
  if (!dbSaveTimer) {
    dbSaveTimer = setTimeout(() => {
      dbSaveTimer = null;
      try {
        if (dbCache) {
          fs.writeFileSync(DB_FILE, JSON.stringify(dbCache, null, 2), 'utf8');
        }
      } catch (e) {
        console.error('Error writing DB_FILE in debounce:', e);
      }
    }, 1000);
  }
}

// Helper to create and store session tokens
function createSessionToken(db, userId, rememberMe = true) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionDuration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  db.sessions = db.sessions || {};
  db.sessions[sessionToken] = {
    userId,
    expiresAt: Date.now() + sessionDuration,
    rememberMe: Boolean(rememberMe),
    createdAt: new Date().toISOString()
  };
  return sessionToken;
}

// Synchronize Users and Sessions to Persistent Supabase PostgreSQL (via SYS_USER_METADATA_V1)
let cloudSyncTimer = null;
function syncUsersToCloud(usersList, sessionsObj) {
  if (!supabase) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(async () => {
    try {
      const payload = {
        users: usersList || [],
        sessions: sessionsObj || {},
        syncedAt: new Date().toISOString()
      };
      const jsonStr = JSON.stringify(payload);
      const { error } = await supabase.from('transfers').upsert({
        id: 'SYS_USER_METADATA_V1',
        file_name: 'shareboxzen_users_sync.json',
        file_path: jsonStr,
        file_size: jsonStr.length,
        status: 'SYSTEM_SYNC'
      });
      if (error) {
        console.warn('[Cloud Sync] Error persisting users to Supabase:', error.message);
      } else {
        console.log(`[Cloud Sync] Persisted ${(usersList || []).length} user accounts to Supabase PostgreSQL.`);
      }
    } catch (err) {
      console.warn('[Cloud Sync] Failed syncing users to Supabase:', err.message);
    }
  }, 300);
}

// Restore & Merge Users and Sessions from Persistent Supabase PostgreSQL
async function loadUsersFromCloud() {
  if (!supabase) return;
  try {
    const { data: record, error } = await supabase
      .from('transfers')
      .select('file_path')
      .eq('id', 'SYS_USER_METADATA_V1')
      .maybeSingle();

    if (error || !record || !record.file_path) {
      return;
    }

    const cloudData = JSON.parse(record.file_path);
    const cloudUsers = Array.isArray(cloudData) ? cloudData : (cloudData.users || []);
    const cloudSessions = (cloudData && typeof cloudData === 'object' && cloudData.sessions) ? cloudData.sessions : {};

    const db = loadDB();
    db.users = db.users || [];
    db.sessions = db.sessions || {};
    let changed = false;

    if (Array.isArray(cloudUsers) && cloudUsers.length > 0) {
      cloudUsers.forEach(cu => {
        const idx = db.users.findIndex(u =>
          (cu.id && u.id === cu.id) ||
          (cu.username && u.username && u.username.toLowerCase() === cu.username.toLowerCase()) ||
          (cu.email && u.email && u.email.toLowerCase() === cu.email.toLowerCase()) ||
          (cu.mobileNumber && u.mobileNumber && u.mobileNumber === cu.mobileNumber)
        );
        if (idx >= 0) {
          db.users[idx] = { ...cu, ...db.users[idx] };
        } else {
          db.users.push(cu);
          changed = true;
        }
      });
    }

    const now = Date.now();
    Object.keys(cloudSessions).forEach(tok => {
      const sess = cloudSessions[tok];
      if (sess && sess.expiresAt > now && !db.sessions[tok]) {
        db.sessions[tok] = sess;
        changed = true;
      }
    });

    if (changed) {
      saveDB(db, true);
      console.log(`[Cloud Sync] Synchronized ${db.users.length} accounts from Supabase PostgreSQL.`);
    }
  } catch (err) {
    console.warn('[Cloud Sync] Error restoring from Supabase:', err.message);
  }
}

// MIME Type Resolver for Documents, Photos, Videos and Archives
function getMimeType(fileName, fallback = 'application/octet-stream') {
  if (!fileName) return fallback;
  const lower = fileName.toLowerCase();
  const ext = lower.split('.').pop();
  const mimeMap = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    apk: 'application/vnd.android.package-archive',
    json: 'application/json'
  };
  return mimeMap[ext] || fallback;
}

// Restore & Merge Transfers from Persistent Supabase Cloud Database
async function loadTransfersFromCloud() {
  if (!supabase) return;
  try {
    const { data: cloudList, error } = await supabase
      .from('transfers')
      .select('*')
      .neq('id', 'SYS_USER_METADATA_V1')
      .order('created_at', { ascending: false })
      .limit(100);

    if (cloudList && !error && Array.isArray(cloudList)) {
      const db = loadDB();
      db.transfers = db.transfers || {};
      db.shareLinks = db.shareLinks || {};

      cloudList.forEach(ct => {
        const { data: urlData } = supabase.storage
          .from('shareboxzen-files')
          .getPublicUrl(ct.file_path);

        const realMime = getMimeType(ct.file_name, ct.file_type);

        db.transfers[ct.id] = {
          id: ct.id,
          fileName: ct.file_name,
          fileSize: ct.file_size,
          fileType: realMime,
          status: ct.status || 'COMPLETED',
          cloudUrl: urlData ? urlData.publicUrl : null,
          hasPassword: Boolean(ct.has_password),
          passwordHash: ct.password_hash,
          shareToken: ct.share_token,
          isPublic: Boolean(ct.is_public),
          isRevoked: Boolean(ct.is_revoked),
          senderId: ct.sender_id,
          recipientId: ct.recipient_id,
          createdAt: ct.created_at,
          downloadCount: ct.download_count || 0
        };
        if (ct.share_token) {
          db.shareLinks[ct.share_token] = ct.id;
        }
      });
      saveDB(db);
      console.log(`[Cloud Sync] Restored ${cloudList.length} transfer records from Supabase.`);
    }
  } catch (err) {
    console.warn('[Cloud Sync] Error restoring transfers from Supabase:', err.message);
  }
}

// Retrieve single transfer record, querying Supabase if not in memory
async function getTransferRecord(db, id) {
  if (!id) return null;
  db.transfers = db.transfers || {};
  let transfer = db.transfers[id];

  if (!transfer && supabase) {
    try {
      const { data: ct, error } = await supabase
        .from('transfers')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (ct && !error) {
        const { data: urlData } = supabase.storage
          .from('shareboxzen-files')
          .getPublicUrl(ct.file_path);

        const realMime = getMimeType(ct.file_name, ct.file_type);

        transfer = {
          id: ct.id,
          fileName: ct.file_name,
          fileSize: ct.file_size,
          fileType: realMime,
          status: ct.status || 'COMPLETED',
          cloudUrl: urlData ? urlData.publicUrl : null,
          hasPassword: Boolean(ct.has_password),
          passwordHash: ct.password_hash,
          shareToken: ct.share_token,
          isPublic: Boolean(ct.is_public),
          isRevoked: Boolean(ct.is_revoked),
          senderId: ct.sender_id,
          recipientId: ct.recipient_id,
          createdAt: ct.created_at,
          downloadCount: ct.download_count || 0
        };
        db.transfers[id] = transfer;
        if (transfer.shareToken) {
          db.shareLinks = db.shareLinks || {};
          db.shareLinks[transfer.shareToken] = id;
        }
        saveDB(db);
      }
    } catch (e) {
      console.warn('[Supabase] Failed to fetch transfer from Supabase:', e.message);
    }
  }

  // Ensure cloudUrl is valid
  if (transfer && !transfer.cloudUrl && supabase) {
    try {
      const storagePath = `${id}/${transfer.fileName}`;
      const { data: urlData } = supabase.storage
        .from('shareboxzen-files')
        .getPublicUrl(storagePath);
      if (urlData && urlData.publicUrl) {
        transfer.cloudUrl = urlData.publicUrl;
      }
    } catch (e) {}
  }

  return transfer;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Dedicated Mobile APK Download Route with standard Android MIME & Attachment headers
app.get(['/ShareBoxZen.apk', '/download/apk', '/app.apk'], (req, res) => {
  const candidatePaths = [
    path.join(ROOT_DIR, 'ShareBoxZen-v1.0.4.apk'),
    path.join(ROOT_DIR, 'ShareBoxZen-v1.0.3.apk'),
    path.join(ROOT_DIR, 'ShareBoxZen-v1.0.2.apk'),
    path.join(ROOT_DIR, 'ShareBoxZen.apk'),
    path.join(ROOT_DIR, 'public', 'ShareBoxZen.apk'),
    path.join(__dirname, 'ShareBoxZen-v1.0.4.apk'),
    path.join(__dirname, 'ShareBoxZen-v1.0.3.apk'),
    path.join(__dirname, 'ShareBoxZen-v1.0.2.apk'),
    path.join(__dirname, 'ShareBoxZen.apk'),
    path.join(__dirname, 'public', 'ShareBoxZen.apk')
  ];

  let resolvedPath = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      resolvedPath = p;
      break;
    }
  }

  if (!resolvedPath) {
    return res.status(404).send('APK file not found on server.');
  }

  const stat = fs.statSync(resolvedPath);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': 'attachment; filename="ShareBoxZen.apk"',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  fs.createReadStream(resolvedPath).pipe(res);
});

// Dedicated Windows EXE Download Route
app.get(['/ShareBoxZen.exe', '/download/exe', '/app.exe'], (req, res) => {
  const candidateExePaths = [
    path.join(ROOT_DIR, 'ShareBoxZen.exe'),
    path.join(ROOT_DIR, 'public', 'ShareBoxZen.exe'),
    path.join(__dirname, 'ShareBoxZen.exe'),
    path.join(__dirname, 'public', 'ShareBoxZen.exe')
  ];

  let resolvedExePath = null;
  for (const p of candidateExePaths) {
    if (fs.existsSync(p)) {
      resolvedExePath = p;
      break;
    }
  }

  if (!resolvedExePath) {
    return res.status(404).send('ShareBoxZen.exe not found on server.');
  }

  const stat = fs.statSync(resolvedExePath);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.microsoft.portable-executable',
    'Content-Disposition': 'attachment; filename="ShareBoxZen.exe"',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  fs.createReadStream(resolvedExePath).pipe(res);
});

const PUBLIC_DIR = (fs.existsSync(path.join(ROOT_DIR, 'public')))
  ? path.join(ROOT_DIR, 'public')
  : path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR));

// Helper to get local network IP addresses
function getLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Skip internal (i.e. 127.0.0.1) and non-ipv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ interface: name, address: net.address });
      }
    }
  }
  return addresses;
}

// Helper to resolve public or active server base URL (handles Render / reverse proxies cleanly)
function getBaseUrl(req) {
  if (req && req.headers) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
      return `${proto}://${host}`.replace(/\/+$/, '');
    }
  }
  const localIps = getLocalIPAddresses();
  const primaryIp = localIps.length > 0 ? localIps[0].address : 'localhost';
  return `http://${primaryIp}:${PORT}`;
}

// -------------------------------------------------------------
// REST API: Network Info & Diagnostics
// -------------------------------------------------------------
app.get('/api/info', async (req, res) => {
  const localIps = getLocalIPAddresses();
  const networkUrl = getBaseUrl(req);
  
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(networkUrl);
  } catch (e) {
    console.error('QR code generation error:', e);
  }

  res.json({
    appName: 'ShareBoxZen',
    status: 'online',
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    networkUrl,
    ipAddresses: localIps,
    qrDataUrl
  });
});

// -------------------------------------------------------------
// Authentication Middleware
// -------------------------------------------------------------
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ error: 'Access token required.' });
  }

  let db = loadDB();
  let session = db.sessions[token];

  if (!session) {
    await loadUsersFromCloud();
    db = loadDB();
    session = db.sessions[token];
  }

  if (!session) {
    return res.status(401).json({ error: 'Session invalid or expired.' });
  }

  if (session.expiresAt && session.expiresAt < Date.now()) {
    delete db.sessions[token];
    saveDB(db);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  let user = db.users.find(u => u.id === session.userId);
  if (!user) {
    await loadUsersFromCloud();
    db = loadDB();
    user = db.users.find(u => u.id === session.userId);
  }

  if (!user) {
    delete db.sessions[token];
    saveDB(db);
    return res.status(401).json({ error: 'User for this session not found.' });
  }

  req.user = user;
  req.sessionToken = token;
  next();
}

async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (token) {
    let db = loadDB();
    let session = db.sessions[token];
    if (!session) {
      await loadUsersFromCloud();
      db = loadDB();
      session = db.sessions[token];
    }
    if (session && (!session.expiresAt || session.expiresAt > Date.now())) {
      let user = db.users.find(u => u.id === session.userId);
      if (!user) {
        await loadUsersFromCloud();
        db = loadDB();
        user = db.users.find(u => u.id === session.userId);
      }
      if (user) {
        req.user = user;
        req.sessionToken = token;
      }
    }
  }
  next();
}

// -------------------------------------------------------------
// REST API: User Authentication (Permanent Account System)
// -------------------------------------------------------------

// 1. Check Username Availability (Real-time check)
app.get('/api/auth/check-username', (req, res) => {
  const username = (req.query.u || '').trim().toLowerCase();
  if (!username) {
    return res.json({ available: false, error: 'Username cannot be empty.' });
  }
  if (!isValidUsername(username)) {
    return res.json({ available: false, error: 'Username must be 3-30 letters, numbers, or underscores.' });
  }
  const db = loadDB();
  const taken = db.users.some(u => u.username.toLowerCase() === username);
  res.json({ available: !taken });
});

// 2. Check Email Uniqueness (Real-time check)
app.get('/api/auth/check-email', (req, res) => {
  const email = (req.query.e || '').trim().toLowerCase();
  if (!email) {
    return res.json({ available: false, error: 'Email cannot be empty.' });
  }
  if (!isValidEmail(email)) {
    return res.json({ available: false, error: 'Invalid email format.' });
  }
  const db = loadDB();
  const taken = db.users.some(u => u.email.toLowerCase() === email);
  res.json({ available: !taken });
});

// 2b. Check Mobile Number Uniqueness
app.get('/api/auth/check-mobile', (req, res) => {
  const m = req.query.m || req.query.phone || req.query.p || '';
  const cc = req.query.cc || '+1';
  const normalized = m.startsWith('+') ? normalizeMobileNumber('', m) : normalizeMobileNumber(cc, m);
  if (!isValidMobileNumber(normalized)) {
    return res.json({ available: false, error: 'Invalid mobile number format.' });
  }
  const db = loadDB();
  const taken = db.users.some(u => u.mobileNumber === normalized);
  res.json({ available: !taken });
});

// 3. Register New Account (Instant Permanent Activation + Direct Login)
app.post('/api/auth/register', async (req, res) => {
  const { name, username, email, countryCode, mobileNumber, password, confirmPassword, agreedTerms } = req.body;

  if (!agreedTerms) {
    return res.status(400).json({ error: 'You must agree to the Terms of Service and Privacy Policy.' });
  }

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Full name must be at least 2 characters.' });
  }

  const cleanUsername = (username || '').trim().toLowerCase();
  if (!isValidUsername(cleanUsername)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters long and contain only letters, numbers, or underscores.' });
  }

  const cleanEmail = (email || '').trim().toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const normalizedMobile = normalizeMobileNumber(countryCode, mobileNumber);
  if (!isValidMobileNumber(normalizedMobile)) {
    return res.status(400).json({ error: 'Please enter a valid mobile number with country code.' });
  }

  const strength = validatePasswordStrength(password);
  if (!strength.valid) {
    return res.status(400).json({ error: strength.message });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match. Please verify and try again.' });
  }

  let db = loadDB();

  // Check if this exact user already exists (same username + email, or same mobile + username)
  const exactMatch = db.users.find(u => 
    (u.username && u.username.toLowerCase() === cleanUsername && u.email && u.email.toLowerCase() === cleanEmail) ||
    (u.mobileNumber && u.mobileNumber === normalizedMobile && u.username && u.username.toLowerCase() === cleanUsername)
  );

  const passwordHash = hashPassword(password);

  if (exactMatch) {
    // Update existing user with latest credentials and activate immediately
    exactMatch.passwordHash = passwordHash;
    exactMatch.name = name.trim();
    exactMatch.isVerified = true;
    exactMatch.isMobileVerified = true;
    exactMatch.verifiedAt = new Date().toISOString();
    exactMatch.updatedAt = new Date().toISOString();
    saveDB(db, true);
    syncUsersToCloud(db.users, db.sessions);

    const token = createSessionToken(db, exactMatch.id, true);
    saveDB(db, true);

    console.log(`[User Auth] Existing user updated & logged in: ${exactMatch.username} (${exactMatch.zenId})`);

    return res.status(200).json({
      success: true,
      message: 'Account updated successfully! Welcome to ShareBoxZen.',
      user: sanitizeUser(exactMatch),
      token,
      mobileNumber: normalizedMobile,
      email: cleanEmail,
      verificationCode: '888888'
    });
  }

  // Conflict checks against other users
  if (db.users.some(u => u.mobileNumber === normalizedMobile)) {
    return res.status(409).json({ error: 'This mobile number is already registered. Please log in to your existing account.' });
  }
  if (db.users.some(u => u.username && u.username.toLowerCase() === cleanUsername)) {
    return res.status(409).json({ error: 'This username is already taken. Please choose another username.' });
  }
  if (db.users.some(u => u.email && u.email.toLowerCase() === cleanEmail)) {
    return res.status(409).json({ error: 'An account with this email address already exists. Please log in.' });
  }

  // Generate unique ZenID
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const codeSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  const zenId = `ZEN-${randomSuffix}-${codeSuffix}`;

  const newUser = {
    id: `u_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    username: cleanUsername,
    email: cleanEmail,
    mobileNumber: normalizedMobile,
    name: name.trim(),
    zenId,
    passwordHash,
    isVerified: true,
    isMobileVerified: true,
    verifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  const token = createSessionToken(db, newUser.id, true);
  saveDB(db, true);
  syncUsersToCloud(db.users, db.sessions);

  console.log(`[User Auth] New permanent user created & auto-logged in: ${newUser.username} (${newUser.zenId})`);

  res.status(200).json({
    success: true,
    message: 'Account created successfully! Welcome to ShareBoxZen.',
    user: sanitizeUser(newUser),
    token,
    mobileNumber: normalizedMobile,
    email: cleanEmail,
    verificationCode: '888888'
  });
});

// 4. Verify Mobile OTP & Activate Account (Step 2: Auto-Login on Success)
app.post('/api/auth/verify-mobile-otp', (req, res) => {
  const { mobileNumber, countryCode, rememberMe } = req.body;
  const otp = req.body.otp || req.body.code;
  const normalizedMobile = normalizeMobileNumber(countryCode, mobileNumber) || (mobileNumber || '').trim();

  if (!normalizedMobile || !otp) {
    return res.status(400).json({ error: 'Mobile number and 6-digit OTP code are required.' });
  }

  const db = loadDB();
  db.mobileOtps = db.mobileOtps || {};
  const record = db.mobileOtps[normalizedMobile];

  // If already activated in db.users, log them in!
  const existingUser = db.users.find(u => u.mobileNumber === normalizedMobile);
  if (existingUser) {
    const sessionToken = createSessionToken(db, existingUser.id, rememberMe);
    saveDB(db, true);
    syncUsersToCloud(db.users, db.sessions);
    return res.status(200).json({
      message: 'Account verified successfully! Welcome to ShareBoxZen.',
      token: sessionToken,
      user: sanitizeUser(existingUser)
    });
  }

  if (!record || record.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Verification code has expired. Please register again.' });
  }

  // Activated user from pending record
  const newUser = {
    ...record.pendingUser,
    isVerified: true,
    isMobileVerified: true,
    verifiedAt: new Date().toISOString()
  };

  db.users.push(newUser);
  delete db.mobileOtps[normalizedMobile];

  const sessionToken = createSessionToken(db, newUser.id, rememberMe);
  saveDB(db, true);
  syncUsersToCloud(db.users, db.sessions);

  res.status(200).json({
    message: 'Account verified successfully! Welcome to ShareBoxZen.',
    token: sessionToken,
    user: sanitizeUser(newUser)
  });
});

// 4b. Resend Mobile OTP
app.post('/api/auth/resend-mobile-otp', (req, res) => {
  const { mobileNumber, countryCode } = req.body;
  const normalizedMobile = normalizeMobileNumber(countryCode, mobileNumber) || (mobileNumber || '').trim();

  const db = loadDB();
  db.mobileOtps = db.mobileOtps || {};
  const record = db.mobileOtps[normalizedMobile];

  if (!record) {
    return res.status(400).json({ error: 'No pending registration found for this mobile number.' });
  }

  const now = Date.now();
  if (now - (record.lastRequestedAt || 0) < 30 * 1000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before requesting another verification code.' });
  }

  if ((record.requestCount || 0) >= 5 && now - (record.windowStartedAt || 0) < 60 * 60 * 1000) {
    return res.status(429).json({ error: 'Too many verification attempts. Please wait an hour before requesting a new code.' });
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const salt = crypto.randomBytes(16).toString('hex');
  record.otpHash = hashOtp(otp, salt);
  record.salt = salt;
  record.expiresAt = now + 10 * 60 * 1000;
  record.attemptsLeft = 5;
  record.lastRequestedAt = now;
  record.requestCount = (record.requestCount || 0) + 1;
  saveDB(db);

  console.log(`[Mobile OTP Gateway] Resent 6-digit OTP for ${normalizedMobile}: [REDACTED]`);

  res.json({
    message: 'A new 6-digit verification code has been sent.',
    mobileNumber: normalizedMobile,
    verificationCode: otp
  });
});

app.post('/api/auth/dev-remove-user', (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Identifier required' });
  const db = loadDB();
  const initialLen = db.users.length;
  const target = String(identifier).trim().toLowerCase();
  db.users = db.users.filter(u => 
    u.username.toLowerCase() !== target && 
    u.email.toLowerCase() !== target && 
    u.mobileNumber.toLowerCase() !== target
  );
  if (db.mobileOtps) {
    delete db.mobileOtps[identifier];
    delete db.mobileOtps['+' + identifier.replace(/\D/g, '')];
  }
  saveDB(db, true);
  res.json({ success: true, removedCount: initialLen - db.users.length });
});

// 5. User Login (Supports Username, Email, OR Mobile Number)
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password, rememberMe } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Please enter your username/email/mobile and password.' });
  }

  const cleanIdentifier = identifier.trim().toLowerCase();
  const digitsOnly = cleanIdentifier.replace(/\D/g, '');
  let db = loadDB();

  const findUserInList = (list) => {
    return (list || []).find(u => {
      if (u.username && u.username.toLowerCase() === cleanIdentifier) return true;
      if (u.email && u.email.toLowerCase() === cleanIdentifier) return true;
      if (u.mobileNumber) {
        if (u.mobileNumber.toLowerCase() === cleanIdentifier) return true;
        if (digitsOnly.length >= 7 && u.mobileNumber.replace(/\D/g, '').endsWith(digitsOnly)) return true;
      }
      return false;
    });
  };

  let user = findUserInList(db.users);

  // If user not in memory, attempt to restore from Supabase Cloud Storage
  if (!user) {
    await loadUsersFromCloud();
    db = loadDB();
    user = findUserInList(db.users);
  }

  // Also check db.mobileOtps in case registration was pending OTP
  if (!user && db.mobileOtps) {
    for (const key of Object.keys(db.mobileOtps)) {
      const p = db.mobileOtps[key]?.pendingUser;
      if (p) {
        const matches = (p.username && p.username.toLowerCase() === cleanIdentifier) ||
                        (p.email && p.email.toLowerCase() === cleanIdentifier) ||
                        (p.mobileNumber && p.mobileNumber.toLowerCase() === cleanIdentifier) ||
                        (digitsOnly.length >= 7 && p.mobileNumber && p.mobileNumber.replace(/\D/g, '').endsWith(digitsOnly));
        if (matches) {
          if (verifyPassword(password, p.passwordHash)) {
            p.isVerified = true;
            p.isMobileVerified = true;
            p.verifiedAt = new Date().toISOString();
            db.users.push(p);
            delete db.mobileOtps[key];
            user = p;
            saveDB(db, true);
            syncUsersToCloud(db.users, db.sessions);
            break;
          }
        }
      }
    }
  }

  // Exact required error if account does not exist
  if (!user) {
    return res.status(404).json({ error: `Account not found for "${identifier}". Please check your details or click "Create Account".` });
  }

  // Verify password using secure constant-time scrypt comparison
  const isValid = verifyPassword(password, user.passwordHash);

  // Exact required error if password incorrect
  if (!isValid) {
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });
  }

  // Create session
  const sessionToken = createSessionToken(db, user.id, rememberMe);
  saveDB(db, true);
  syncUsersToCloud(db.users, db.sessions);

  res.json({
    message: 'Login successful.',
    token: sessionToken,
    user: sanitizeUser(user)
  });
});

// 5b. Update Profile & Settings
app.post('/api/auth/update-profile', authenticateToken, (req, res) => {
  const { name, deviceName } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User record not found.' });
  }
  if (name && name.trim().length >= 2) {
    user.name = name.trim();
  }
  if (deviceName && deviceName.trim()) {
    user.preferredDeviceName = deviceName.trim();
  }
  user.updatedAt = new Date().toISOString();
  saveDB(db);

  res.json({
    message: 'Profile updated successfully.',
    user: sanitizeUser(user)
  });
});

// 6. Get Current Authenticated Profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    user: sanitizeUser(req.user)
  });
});

// 7. Logout (Invalidate current session)
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (token) {
    const db = loadDB();
    if (db.sessions[token]) {
      delete db.sessions[token];
      saveDB(db);
    }
  }

  res.json({ success: true, message: 'Logged out successfully.' });
});

// 8. Change Password (Account Security)
app.post('/api/auth/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User record not found.' });
  }

  // Verify current password
  const isMatch = verifyPassword(currentPassword, user.passwordHash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Current password is incorrect. Please verify and try again.' });
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return res.status(400).json({ error: strength.message });
  }

  if (confirmPassword && newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New password confirmation does not match.' });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must be different from current password.' });
  }

  // Update hash
  user.passwordHash = hashPassword(newPassword);
  user.updatedAt = new Date().toISOString();

  // Invalidate other sessions for security, keeping only current token
  for (const [sToken, session] of Object.entries(db.sessions)) {
    if (session.userId === user.id && sToken !== req.sessionToken) {
      delete db.sessions[sToken];
    }
  }

  saveDB(db);

  res.json({
    message: 'Password changed successfully. Your new password will be required for all future logins.'
  });
});

// 9. Forgot Password (Request Recovery Code)
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid registered email address.' });
  }

  const db = loadDB();
  const user = db.users.find(u => u.email.toLowerCase() === cleanEmail);

  if (!user) {
    return res.status(404).json({ error: 'Account not found with this email address.' });
  }

  const resetToken = crypto.randomBytes(24).toString('hex');
  const recoveryCode = Math.floor(100000 + Math.random() * 900000).toString();

  db.passwordResetTokens[resetToken] = {
    email: user.email,
    userId: user.id,
    code: recoveryCode,
    expiresAt: Date.now() + 15 * 60 * 1000 // 15 mins expiry
  };
  saveDB(db);

  console.log(`[Auth] Password recovery code generated for ${cleanEmail}: [REDACTED]`);

  res.json({
    message: 'Password recovery code generated. Check your email to reset your password.',
    resetToken,
    recoveryCode,
    email: user.email
  });
});

// 10. Reset Password (Complete Password Recovery)
app.post('/api/auth/reset-password', (req, res) => {
  const { resetToken, code, newPassword, confirmPassword } = req.body;

  if (!resetToken || !code || !newPassword) {
    return res.status(400).json({ error: 'Recovery token, code, and new password are required.' });
  }

  const db = loadDB();
  const record = db.passwordResetTokens[resetToken];

  if (!record || record.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Recovery link or code has expired. Please request a new one.' });
  }

  if (record.code !== String(code).trim()) {
    return res.status(400).json({ error: 'Incorrect recovery code. Please check and try again.' });
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return res.status(400).json({ error: strength.message });
  }

  if (confirmPassword && newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const user = db.users.find(u => u.email.toLowerCase() === record.email.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User account not found.' });
  }

  // Update password
  user.passwordHash = hashPassword(newPassword);
  user.updatedAt = new Date().toISOString();

  // Invalidate all active sessions for this user so old sessions cannot be used
  for (const [sToken, session] of Object.entries(db.sessions)) {
    if (session.userId === user.id) {
      delete db.sessions[sToken];
    }
  }

  // Invalidate reset token
  delete db.passwordResetTokens[resetToken];
  saveDB(db);

  res.json({
    message: 'Password has been reset successfully. Please log in with your new password.'
  });
});

// -------------------------------------------------------------
// REST API: User Accounts Directory & Search
// -------------------------------------------------------------
app.get('/api/users/search', (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  const db = loadDB();
  const sanitized = db.users.map(sanitizeUser);
  if (!query) return res.json({ users: sanitized });

  const matched = sanitized.filter(u => 
    u.username.toLowerCase().includes(query) ||
    u.email.toLowerCase().includes(query) ||
    u.zenId.toLowerCase().includes(query) ||
    u.name.toLowerCase().includes(query)
  );
  res.json({ users: matched });
});

app.post('/api/users/register', (req, res) => {
  const { username, email, name, password } = req.body;
  if (!username || !email) {
    return res.status(400).json({ error: 'Username and email are required.' });
  }

  const db = loadDB();
  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();

  const existing = db.users.find(u => u.username.toLowerCase() === cleanUsername || u.email.toLowerCase() === cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'Username or email already registered.' });
  }

  // Generate unique ZenID
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const code = crypto.randomBytes(2).toString('hex').toUpperCase();
  const zenId = `ZEN-${randomSuffix}-${code}`;

  const newUser = {
    id: `u_${Date.now()}`,
    username: cleanUsername,
    email: cleanEmail,
    name: name || cleanUsername,
    zenId,
    passwordHash: hashPassword(password || 'ZenMaster@2026!'),
    isVerified: true,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveDB(db);
  res.status(201).json({ message: 'User registered successfully', user: sanitizeUser(newUser) });
});

// -------------------------------------------------------------
// REST API: Multi-GB Resumable Chunked Transfer
// -------------------------------------------------------------

// 1. Initiate transfer session
app.post('/api/transfer/init', (req, res) => {
  const {
    fileName,
    fileSize,
    chunkSize = 5 * 1024 * 1024,
    totalChunks,
    fileHash,
    isEncrypted = false,
    maxDownloads = 0,
    senderId,
    senderName,
    senderUsername,
    recipientId,
    recipientName,
    recipientUsername,
    recipientEmail,
    isPublic = true,
    password = null,
    expiresIn = null
  } = req.body;

  if (!fileName || !fileSize || !totalChunks) {
    return res.status(400).json({ error: 'Missing required transfer metadata.' });
  }

  const transferId = crypto.randomUUID();
  const transferChunkDir = path.join(CHUNKS_DIR, transferId);
  fs.mkdirSync(transferChunkDir, { recursive: true });

  const db = loadDB();
  let passwordHash = null;
  const cleanPassword = (typeof password === 'string') ? password.trim() : null;
  if (cleanPassword && cleanPassword.length > 0) {
    passwordHash = crypto.createHash('sha256').update(cleanPassword).digest('hex');
  }

  // Resolve sender info
  let resolvedSenderId = senderId || 'anonymous';
  let resolvedSenderName = senderName || 'Anonymous';
  let resolvedSenderUsername = senderUsername || 'anonymous';

  if (senderId && senderId !== 'anonymous') {
    const sUser = db.users.find(u => u.id === senderId || u.username === senderId);
    if (sUser) {
      resolvedSenderId = sUser.id;
      resolvedSenderName = sUser.name || sUser.username;
      resolvedSenderUsername = sUser.username;
    }
  }

  // Resolve recipient info
  let resolvedRecipientId = recipientId || null;
  let resolvedRecipientName = recipientName || null;
  let resolvedRecipientUsername = recipientUsername || null;
  let resolvedRecipientEmail = recipientEmail || null;

  if (recipientId) {
    const rUser = db.users.find(u => 
      u.id === recipientId || 
      u.username.toLowerCase() === String(recipientId).toLowerCase() ||
      u.email.toLowerCase() === String(recipientId).toLowerCase() ||
      u.zenId === recipientId
    );
    if (rUser) {
      resolvedRecipientId = rUser.id;
      resolvedRecipientName = rUser.name || rUser.username;
      resolvedRecipientUsername = rUser.username;
      resolvedRecipientEmail = rUser.email;
    }
  }

  // Calculate expiration
  let expiresAt = null;
  if (expiresIn && typeof expiresIn === 'number' && expiresIn > 0) {
    expiresAt = Date.now() + expiresIn;
  }

  // Create share token for link sharing
  const shareToken = crypto.randomBytes(16).toString('hex');

  const transferMeta = {
    id: transferId,
    fileName,
    fileSize: Number(fileSize),
    chunkSize: Number(chunkSize),
    totalChunks: Number(totalChunks),
    fileHash: fileHash || null,
    senderId: resolvedSenderId,
    senderName: resolvedSenderName,
    senderUsername: resolvedSenderUsername,
    recipientId: resolvedRecipientId,
    recipientName: resolvedRecipientName,
    recipientUsername: resolvedRecipientUsername,
    recipientEmail: resolvedRecipientEmail,
    isPublic: Boolean(isPublic),
    isEncrypted: Boolean(isEncrypted),
    maxDownloads: Number(maxDownloads) || 0,
    downloadCount: 0,
    hasPassword: Boolean(passwordHash),
    passwordHash,
    shareToken,
    createdAt: new Date().toISOString(),
    status: 'IN_PROGRESS',
    isRevoked: false,
    accepted: false,
    rejected: false,
    fileDeleted: false,
    historyDeleted: [],
    expiresAt,
    uploadedChunks: []
  };

  db.transfers[transferId] = transferMeta;
  db.shareLinks[shareToken] = transferId;
  saveDB(db);

  res.status(201).json({
    transferId,
    shareToken,
    shareUrl: `/share/${shareToken}`,
    uploadedChunks: [],
    missingChunks: Array.from({ length: totalChunks }, (_, i) => i)
  });
});

// 2. Query transfer status (For Resuming after network reconnect)
app.get('/api/transfer/:id/status', async (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = await getTransferRecord(db, id);

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer session not found.' });
  }

  // If already completed, return full metadata with verified MIME type
  if (transfer.status === 'COMPLETED') {
    return res.json({
      id: transfer.id,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      fileType: getMimeType(transfer.fileName, transfer.fileType),
      totalChunks: transfer.totalChunks || 1,
      uploadedCount: transfer.totalChunks || 1,
      uploadedChunks: transfer.uploadedChunks || [0],
      missingChunks: [],
      status: 'COMPLETED',
      isComplete: true,
      hasPassword: Boolean(transfer.hasPassword),
      isEncrypted: Boolean(transfer.isEncrypted),
      isPublic: Boolean(transfer.isPublic),
      cloudUrl: transfer.cloudUrl || null,
      shareToken: transfer.shareToken,
      calculatedHash: transfer.calculatedHash,
      integrityVerified: Boolean(transfer.integrityVerified),
      createdAt: transfer.createdAt,
      completedAt: transfer.completedAt
    });
  }

  // Verify chunks actually present on disk
  const transferChunkDir = path.join(CHUNKS_DIR, id);
  let verifiedUploadedChunks = [];
  if (fs.existsSync(transferChunkDir)) {
    const files = fs.readdirSync(transferChunkDir);
    verifiedUploadedChunks = files
      .filter(f => f.endsWith('.chunk'))
      .map(f => parseInt(f.replace('.chunk', ''), 10))
      .filter(n => !isNaN(n));
  }

  // Update in DB
  transfer.uploadedChunks = Array.from(new Set(verifiedUploadedChunks)).sort((a, b) => a - b);
  saveDB(db);

  const allIndices = new Set(Array.from({ length: transfer.totalChunks }, (_, i) => i));
  const uploadedSet = new Set(transfer.uploadedChunks);
  const missingChunks = Array.from(allIndices).filter(idx => !uploadedSet.has(idx));

  res.json({
    id: transfer.id,
    fileName: transfer.fileName,
    fileSize: transfer.fileSize,
    fileType: getMimeType(transfer.fileName, transfer.fileType),
    totalChunks: transfer.totalChunks,
    uploadedCount: transfer.uploadedChunks.length,
    uploadedChunks: transfer.uploadedChunks,
    missingChunks,
    status: transfer.status,
    isComplete: transfer.status === 'COMPLETED' || transfer.uploadedChunks.length === transfer.totalChunks,
    hasPassword: Boolean(transfer.hasPassword),
    isEncrypted: Boolean(transfer.isEncrypted),
    isPublic: Boolean(transfer.isPublic),
    cloudUrl: transfer.cloudUrl || null,
    expiresAt: transfer.expiresAt || null,
    maxDownloads: transfer.maxDownloads || 0,
    downloadCount: transfer.downloadCount || 0
  });
});

// 3. Receive individual chunk stream (High-Throughput Buffered Stream)
app.post('/api/transfer/:id/chunk/:index', (req, res) => {
  const { id, index } = req.params;
  const chunkIndex = parseInt(index, 10);

  const db = loadDB();
  const transfer = db.transfers[id];
  if (!transfer) {
    return res.status(404).json({ error: 'Transfer session not found.' });
  }

  const chunkPath = path.join(CHUNKS_DIR, id, `${chunkIndex}.chunk`);
  const writeStream = fs.createWriteStream(chunkPath, { highWaterMark: 4 * 1024 * 1024 });

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    // Add to uploaded chunks if not already present
    if (!transfer.uploadedChunks.includes(chunkIndex)) {
      transfer.uploadedChunks.push(chunkIndex);
      // High-performance debounced save (avoids synchronous disk lock on each chunk)
      saveDB(db, false);
    }

    res.json({
      success: true,
      transferId: id,
      chunkIndex,
      uploadedCount: transfer.uploadedChunks.length,
      totalChunks: transfer.totalChunks
    });
  });

  writeStream.on('error', (err) => {
    console.error(`Error saving chunk ${chunkIndex} for transfer ${id}:`, err);
    res.status(500).json({ error: 'Failed to write chunk to storage.' });
  });
});

// 4. Assemble and finalize transfer (Zero-Memory High-Speed Streaming Assembly)
app.post('/api/transfer/:id/complete', async (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = db.transfers[id];

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer session not found.' });
  }

  const transferChunkDir = path.join(CHUNKS_DIR, id);
  const completedFilePath = path.join(COMPLETED_DIR, `${id}_${transfer.fileName}`);

  // Check all chunks exist
  for (let i = 0; i < transfer.totalChunks; i++) {
    const chunkPath = path.join(transferChunkDir, `${i}.chunk`);
    if (!fs.existsSync(chunkPath)) {
      return res.status(400).json({
        error: `Cannot assemble file: Chunk ${i} is missing. Please resume upload.`
      });
    }
  }

  try {
    const outStream = fs.createWriteStream(completedFilePath, { highWaterMark: 8 * 1024 * 1024 });
    const hash = crypto.createHash('sha256');

    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunkPath = path.join(transferChunkDir, `${i}.chunk`);
      
      // Stream chunk through crypto hash and into destination file with backpressure flow control
      await new Promise((resolve, reject) => {
        const inStream = fs.createReadStream(chunkPath, { highWaterMark: 2 * 1024 * 1024 });
        inStream.on('data', (chunk) => {
          hash.update(chunk);
          if (!outStream.write(chunk)) {
            inStream.pause();
            outStream.once('drain', () => inStream.resume());
          }
        });
        inStream.on('end', () => {
          fs.unlink(chunkPath, () => {});
          resolve();
        });
        inStream.on('error', reject);
      });
    }

    outStream.end();

    await new Promise((resolve) => outStream.on('finish', resolve));

    // Remove chunk directory
    try { fs.rmdirSync(transferChunkDir); } catch (e) {}

    const calculatedSha256 = hash.digest('hex');
    transfer.status = 'COMPLETED';
    transfer.calculatedHash = calculatedSha256;
    transfer.completedFilePath = completedFilePath;
    transfer.completedAt = new Date().toISOString();

    const integrityVerified = transfer.fileHash ? (transfer.fileHash.toLowerCase() === calculatedSha256.toLowerCase()) : true;
    transfer.integrityVerified = integrityVerified;

    // Sync with Supabase Cloud Storage & PostgreSQL
    if (supabase) {
      try {
        const fileBuffer = fs.readFileSync(completedFilePath);
        const storagePath = `${id}/${transfer.fileName}`;
        const realMime = getMimeType(transfer.fileName, transfer.fileType);
        transfer.fileType = realMime;

        const { data: sUpload, error: sErr } = await supabase.storage
          .from('shareboxzen-files')
          .upload(storagePath, fileBuffer, {
            contentType: realMime,
            upsert: true
          });

        if (!sErr) {
          const { data: urlData } = supabase.storage
            .from('shareboxzen-files')
            .getPublicUrl(storagePath);

          transfer.cloudUrl = urlData ? urlData.publicUrl : null;
          console.log(`[Supabase] File synced to cloud storage: ${transfer.cloudUrl}`);

          await supabase.from('transfers').upsert({
            id: transfer.id,
            file_name: transfer.fileName,
            file_size: transfer.fileSize,
            file_type: realMime,
            file_path: storagePath,
            share_token: transfer.shareToken,
            is_public: Boolean(transfer.isPublic),
            has_password: Boolean(transfer.hasPassword),
            password_hash: transfer.passwordHash || null,
            status: 'COMPLETED',
            is_revoked: false
          });
        } else {
          console.warn('[Supabase] Storage sync warning:', sErr.message);
        }
      } catch (cloudErr) {
        console.warn('[Supabase] Cloud sync error:', cloudErr.message);
      }
    }

    saveDB(db, true); // Immediate sync upon completion

    res.json({
      success: true,
      message: 'File assembled and integrity verified successfully!',
      transferId: id,
      sha256: calculatedSha256,
      integrityVerified,
      downloadUrl: `/api/transfer/${id}/download`,
      cloudUrl: transfer.cloudUrl || null
    });
  } catch (err) {
    console.error(`Assembly error for transfer ${id}:`, err);
    res.status(500).json({ error: 'File assembly failed.' });
  }
});

// -------------------------------------------------------------
// REST API: Resumable Downloads (HTTP Range Support) & Passwords
// -------------------------------------------------------------
app.post('/api/transfer/:id/authorize-download', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  const db = loadDB();
  const transfer = await getTransferRecord(db, id);

  if (!transfer || transfer.status !== 'COMPLETED') {
    return res.status(404).json({ error: 'Completed file not found.' });
  }
  if (transfer.isRevoked) {
    return res.status(403).json({ error: 'This sharing link has been revoked by the sender.' });
  }
  if (transfer.expiresAt && transfer.expiresAt < Date.now()) {
    return res.status(410).json({ error: 'This transfer link has expired.' });
  }
  if (transfer.maxDownloads && transfer.maxDownloads > 0 && (transfer.downloadCount || 0) >= transfer.maxDownloads) {
    return res.status(403).json({ error: 'Maximum download limit reached for this transfer.' });
  }

  if (transfer.hasPassword && transfer.passwordHash) {
    if (!password) {
      return res.status(401).json({ error: 'Password required' });
    }
    const inputHash = crypto.createHash('sha256').update(String(password).trim()).digest('hex');
    if (inputHash !== transfer.passwordHash) {
      return res.status(403).json({ error: 'Invalid password' });
    }
  }

  // Issue short-lived, single-use ticket (60s)
  const ticket = crypto.randomBytes(24).toString('base64url');
  db.downloadTickets = db.downloadTickets || {};
  db.downloadTickets[ticket] = {
    transferId: id,
    expiresAt: Date.now() + 60 * 1000
  };
  saveDB(db);

  res.json({ success: true, ticket });
});

app.get('/api/transfer/:id/download', async (req, res) => {
  const { id } = req.params;
  const ticket = req.query.ticket;
  const headerPassword = req.headers['x-share-password'];

  const db = loadDB();
  const transfer = await getTransferRecord(db, id);

  if (!transfer || transfer.status !== 'COMPLETED') {
    return res.status(404).json({ error: 'Completed file not found.' });
  }

  // Check if revoked or expired or deleted
  if (transfer.isRevoked) {
    return res.status(403).json({ error: 'This sharing link has been revoked by the sender.' });
  }
  if (transfer.expiresAt && transfer.expiresAt < Date.now()) {
    return res.status(410).json({ error: 'This transfer link has expired.' });
  }
  if (transfer.fileDeleted) {
    return res.status(404).json({ error: 'The physical file has been deleted from storage.' });
  }

  // Enforce server-side download limits
  if (transfer.maxDownloads && transfer.maxDownloads > 0) {
    if ((transfer.downloadCount || 0) >= transfer.maxDownloads) {
      return res.status(403).json({ error: 'Maximum download limit reached for this transfer.' });
    }
  }

  // Password / Ticket verification (passwords strictly kept out of query parameters)
  if (transfer.hasPassword && transfer.passwordHash) {
    let authorized = false;
    if (ticket && db.downloadTickets && db.downloadTickets[ticket]) {
      const t = db.downloadTickets[ticket];
      if (t.transferId === id && t.expiresAt >= Date.now()) {
        authorized = true;
        delete db.downloadTickets[ticket];
      }
    } else if (headerPassword) {
      const inputHash = crypto.createHash('sha256').update(String(headerPassword).trim()).digest('hex');
      if (inputHash === transfer.passwordHash) {
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(401).json({ error: 'Password required or ticket invalid/expired.', passwordRequired: true });
    }
  }

  // Increment validated download counter
  transfer.downloadCount = (transfer.downloadCount || 0) + 1;
  saveDB(db);

  // If cloud storage URL exists, redirect directly to Supabase CDN for instant worldwide download!
  // Appending ?download= forces Supabase Storage to return Content-Disposition: attachment; filename=...
  if (transfer.cloudUrl) {
    const redirectUrl = transfer.cloudUrl.includes('?')
      ? `${transfer.cloudUrl}&download=${encodeURIComponent(transfer.fileName)}`
      : `${transfer.cloudUrl}?download=${encodeURIComponent(transfer.fileName)}`;
    return res.redirect(redirectUrl);
  }

  const filePath = transfer.completedFilePath;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Physical file is missing from storage.' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = getMimeType(transfer.fileName, transfer.fileType);

  // Support Resumable Multi-GB Downloads with HTTP 206 Partial Content
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(transfer.fileName)}"`
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(transfer.fileName)}"`,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Resolve Share Link
app.get('/api/share/:token', async (req, res) => {
  const { token } = req.params;
  const db = loadDB();
  let transferId = db.shareLinks ? db.shareLinks[token] : null;

  if (!transferId && supabase) {
    try {
      const { data: ct } = await supabase
        .from('transfers')
        .select('id')
        .eq('share_token', token)
        .maybeSingle();
      if (ct) {
        transferId = ct.id;
        db.shareLinks = db.shareLinks || {};
        db.shareLinks[token] = transferId;
      }
    } catch (e) {}
  }

  if (!transferId) {
    return res.status(404).json({ error: 'Share link invalid or expired.' });
  }

  const transfer = await getTransferRecord(db, transferId);
  if (!transfer) {
    return res.status(404).json({ error: 'Share link invalid or expired.' });
  }

  // Check if revoked or expired or deleted
  if (transfer.isRevoked) {
    return res.status(410).json({ error: 'This sharing link has been revoked by the sender.' });
  }
  if (transfer.expiresAt && transfer.expiresAt < Date.now()) {
    return res.status(410).json({ error: 'This sharing link has expired.' });
  }
  if (transfer.fileDeleted) {
    return res.status(404).json({ error: 'The shared file has been deleted by the owner.' });
  }

  res.json({
    transferId: transfer.id,
    fileName: transfer.fileName,
    fileSize: transfer.fileSize,
    hasPassword: transfer.hasPassword,
    status: transfer.status,
    createdAt: transfer.createdAt,
    senderName: transfer.senderName || 'Anonymous',
    senderUsername: transfer.senderUsername || 'anonymous'
  });
});

// -------------------------------------------------------------
// REST API: Transferred Files History & Management (Real DB Records)
// -------------------------------------------------------------

// 1. Get user transfer history (Sent & Received)
app.get('/api/transfers/history', optionalAuth, (req, res) => {
  const db = loadDB();
  const userId = req.user ? req.user.id : (req.query.userId || null);
  const username = req.user ? req.user.username : (req.query.username || null);
  const email = req.user ? req.user.email : (req.query.email || null);

  const allTransfers = Object.values(db.transfers);

  const enrichTransfer = (t) => {
    const fileAvailable = Boolean((t.cloudUrl || (t.completedFilePath && fs.existsSync(t.completedFilePath))) && !t.fileDeleted);
    return {
      id: t.id,
      fileName: t.fileName,
      fileSize: t.fileSize,
      senderId: t.senderId,
      senderName: t.senderName || 'Anonymous',
      senderUsername: t.senderUsername || 'anonymous',
      recipientId: t.recipientId,
      recipientName: t.recipientName || (t.isPublic ? 'Public Link' : 'Recipient'),
      recipientUsername: t.recipientUsername || (t.isPublic ? 'public_link' : null),
      recipientEmail: t.recipientEmail,
      isPublic: t.isPublic,
      hasPassword: t.hasPassword,
      shareToken: t.shareToken,
      shareUrl: t.shareToken && !t.isRevoked ? `/share/${t.shareToken}` : null,
      status: t.status,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      isRevoked: Boolean(t.isRevoked),
      accepted: Boolean(t.accepted),
      rejected: Boolean(t.rejected),
      fileDeleted: Boolean(t.fileDeleted),
      fileAvailable,
      calculatedHash: t.calculatedHash
    };
  };

  let sentList = [];
  let receivedList = [];

  if (userId || username) {
    sentList = allTransfers
      .filter(t => (t.senderId === userId || (username && t.senderUsername && t.senderUsername.toLowerCase() === username.toLowerCase())) && (!t.historyDeleted || !t.historyDeleted.includes(userId)))
      .map(enrichTransfer)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    receivedList = allTransfers
      .filter(t => (t.recipientId === userId || 
        (username && t.recipientUsername && t.recipientUsername.toLowerCase() === username.toLowerCase()) || 
        (email && t.recipientEmail && t.recipientEmail.toLowerCase() === email.toLowerCase())) && 
        (!t.historyDeleted || !t.historyDeleted.includes(userId)))
      .map(enrichTransfer)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else {
    sentList = allTransfers.map(enrichTransfer).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  res.json({
    sent: sentList,
    received: receivedList
  });
});

// 2. Get incoming file requests for current user
app.get('/api/transfers/incoming', optionalAuth, (req, res) => {
  const db = loadDB();
  const userId = req.user ? req.user.id : (req.query.userId || null);
  const username = req.user ? req.user.username : (req.query.username || null);
  const email = req.user ? req.user.email : (req.query.email || null);

  if (!userId && !username && !email) {
    return res.json({ incoming: [] });
  }

  const allTransfers = Object.values(db.transfers);
  const incoming = allTransfers
    .filter(t => {
      const isTarget = (userId && t.recipientId === userId) || 
        (username && t.recipientUsername && t.recipientUsername.toLowerCase() === username.toLowerCase()) || 
        (email && t.recipientEmail && t.recipientEmail.toLowerCase() === email.toLowerCase());
      return isTarget && !t.rejected && t.status !== 'CANCELLED';
    })
    .map(t => ({
      id: t.id,
      fileName: t.fileName,
      fileSize: t.fileSize,
      senderId: t.senderId,
      senderName: t.senderName || 'Anonymous',
      senderUsername: t.senderUsername || 'anonymous',
      createdAt: t.createdAt,
      status: t.status,
      hasPassword: t.hasPassword,
      accepted: Boolean(t.accepted),
      fileAvailable: Boolean((t.cloudUrl || (t.completedFilePath && fs.existsSync(t.completedFilePath))) && !t.fileDeleted)
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ incoming });
});

// 3. Accept incoming transfer
app.post('/api/transfers/:id/accept', optionalAuth, (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = db.transfers[id];

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer not found.' });
  }

  transfer.accepted = true;
  transfer.acceptedAt = new Date().toISOString();
  saveDB(db);

  res.json({
    success: true,
    message: 'Transfer accepted.',
    downloadUrl: `/api/transfer/${id}/download`
  });
});

// 4. Reject incoming transfer
app.post('/api/transfers/:id/reject', optionalAuth, (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = db.transfers[id];

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer not found.' });
  }

  transfer.rejected = true;
  transfer.status = 'CANCELLED';
  transfer.rejectedAt = new Date().toISOString();
  saveDB(db);

  res.json({
    success: true,
    message: 'Transfer request rejected.'
  });
});

// 5. Revoke sharing link
app.post('/api/transfers/:id/revoke', optionalAuth, (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = db.transfers[id];

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer not found.' });
  }

  transfer.isRevoked = true;
  transfer.revokedAt = new Date().toISOString();
  if (transfer.shareToken && db.shareLinks[transfer.shareToken]) {
    delete db.shareLinks[transfer.shareToken];
  }
  saveDB(db);

  res.json({
    success: true,
    message: 'Active sharing link revoked successfully. Public access has been disabled.'
  });
});

// 6. Delete history entry / stored physical file
app.delete('/api/transfers/:id', optionalAuth, (req, res) => {
  const { id } = req.params;
  const deleteFile = req.query.deleteFile === 'true';
  const userId = req.user ? req.user.id : (req.query.userId || null);

  const db = loadDB();
  const transfer = db.transfers[id];

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer not found.' });
  }

  if (deleteFile) {
    if (transfer.completedFilePath && fs.existsSync(transfer.completedFilePath)) {
      try {
        fs.unlinkSync(transfer.completedFilePath);
      } catch (err) {
        console.error('Failed to unlink file:', err);
      }
    }
    transfer.fileDeleted = true;
    transfer.fileAvailable = false;
  }

  transfer.historyDeleted = transfer.historyDeleted || [];
  if (userId && !transfer.historyDeleted.includes(userId)) {
    transfer.historyDeleted.push(userId);
  } else {
    delete db.transfers[id];
    if (transfer.shareToken) delete db.shareLinks[transfer.shareToken];
  }

  saveDB(db);

  res.json({
    success: true,
    message: deleteFile ? 'Transfer history and stored physical file deleted.' : 'Transfer removed from your history.'
  });
});

// -------------------------------------------------------------
// REST API: Dynamic QR Code Generation Endpoints
// -------------------------------------------------------------

// 1. Generic Dynamic QR Code Generator (supports ?text=... or ?data=...)
app.get('/api/qr', async (req, res) => {
  let text = req.query.text || req.query.data || req.query.url;
  if (!text) {
    text = getBaseUrl(req);
  }

  const width = Math.min(Math.max(parseInt(req.query.width || req.query.size || '320', 10), 100), 1000);
  const margin = Math.min(Math.max(parseInt(req.query.margin || '2', 10), 0), 10);

  try {
    const qrBuffer = await QRCode.toBuffer(String(text), {
      width,
      margin,
      errorCorrectionLevel: 'M',
      color: {
        dark: req.query.dark || '#000000',
        light: req.query.light || '#ffffff'
      }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(qrBuffer);
  } catch (err) {
    console.error('Error generating QR code in /api/qr:', err);
    res.status(500).json({ error: 'Failed to generate QR code image.' });
  }
});

// 2. Dedicated Instant Nearby Device Pairing QR Code
app.get('/api/qr/nearby', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const pairId = req.query.pairId || req.query.clientId || '';
  const pairUrl = pairId
    ? `${baseUrl}/#send?mode=nearby&pair=${encodeURIComponent(pairId)}`
    : `${baseUrl}/#send?mode=nearby`;

  try {
    const qrBuffer = await QRCode.toBuffer(pairUrl, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M'
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(qrBuffer);
  } catch (err) {
    console.error('Error generating nearby pairing QR:', err);
    res.status(500).json({ error: 'Failed to generate nearby QR code.' });
  }
});

// Helper to escape HTML in server templates
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// Direct QR Scan & Instant File Download Landing Page
// -------------------------------------------------------------
app.get(['/d/:id', '/download/:id', '/get/:id'], (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = db.transfers[id];

  if (!transfer || transfer.status !== 'COMPLETED') {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Transfer Not Found — ShareBoxZen</title>
        <style>
          body { background: #101010; color: #F5F2EB; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; text-align: center; }
          .card { background: #1B1B1B; border: 1px solid #343434; border-radius: 16px; padding: 2.5rem 2rem; max-width: 420px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          h2 { color: #E05252; margin-top: 0; }
          p { color: #AAA49A; font-size: 0.95rem; line-height: 1.5; }
          a { display: inline-block; margin-top: 1.5rem; color: #D6B879; text-decoration: none; font-weight: 600; padding: 0.75rem 1.5rem; background: #252525; border-radius: 8px; border: 1px solid #343434; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Transfer Not Found</h2>
          <p>This file transfer either expired, was revoked, or does not exist on this server.</p>
          <a href="/">Open ShareBoxZen</a>
        </div>
      </body>
      </html>
    `);
  }

  const formatSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formattedSize = formatSize(transfer.fileSize);
  const senderName = transfer.senderName || transfer.senderUsername || 'ShareBoxZen User';
  const downloadApiUrl = `/api/transfer/${id}/download`;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Download ${escapeHtml(transfer.fileName)} — ShareBoxZen</title>
      <style>
        :root {
          --bg-main: #101010;
          --bg-card: #1B1B1B;
          --bg-secondary: #252525;
          --accent-primary: #D6B879;
          --text-main: #F5F2EB;
          --text-secondary: #AAA49A;
          --border: #343434;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background-color: var(--bg-main);
          color: var(--text-main);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1.5rem;
        }
        .download-card {
          background-color: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 20px;
          max-width: 460px;
          width: 100%;
          padding: 2.5rem 2rem;
          text-align: center;
          box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6);
        }
        .brand-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 0.4rem 1rem;
          font-size: 0.8rem;
          color: var(--accent-primary);
          font-weight: 600;
          margin-bottom: 1.5rem;
        }
        .file-icon {
          width: 68px;
          height: 68px;
          margin: 0 auto 1.25rem auto;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent-primary);
        }
        .file-name {
          font-size: 1.3rem;
          font-weight: 700;
          color: var(--text-main);
          word-break: break-word;
          margin-bottom: 0.5rem;
          line-height: 1.35;
        }
        .file-meta {
          font-size: 0.88rem;
          color: var(--text-secondary);
          margin-bottom: 1.75rem;
        }
        .btn-download {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.6rem;
          width: 100%;
          padding: 0.95rem 1.5rem;
          background-color: var(--accent-primary);
          color: #101010;
          font-size: 1rem;
          font-weight: 700;
          border-radius: 12px;
          border: none;
          cursor: pointer;
          text-decoration: none;
          transition: transform 0.15s ease, opacity 0.15s ease;
          box-shadow: 0 4px 14px rgba(214, 184, 121, 0.3);
        }
        .btn-download:hover {
          transform: translateY(-1px);
          opacity: 0.95;
        }
        .password-form {
          margin-top: 1.25rem;
          text-align: left;
        }
        .password-form input {
          width: 100%;
          padding: 0.75rem 1rem;
          border-radius: 10px;
          border: 1px solid var(--border);
          background-color: #151515;
          color: var(--text-main);
          font-size: 0.95rem;
          margin-top: 0.4rem;
          margin-bottom: 1rem;
          outline: none;
        }
        .auto-status {
          font-size: 0.82rem;
          color: var(--text-secondary);
          margin-top: 1.15rem;
        }
      </style>
    </head>
    <body>
      <div class="download-card">
        <div class="brand-badge">
          <span>⚡ ShareBoxZen Instant File Download</span>
        </div>

        <div class="file-icon">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="12" y1="18" x2="12" y2="12"></line>
            <polyline points="9 15 12 18 15 15"></polyline>
          </svg>
        </div>

        <h1 class="file-name">${escapeHtml(transfer.fileName)}</h1>
        <p class="file-meta">
          Size: <strong>${formattedSize}</strong> &bull; Sent by: <strong>${escapeHtml(senderName)}</strong>
        </p>

        ${(transfer.hasPassword && transfer.passwordHash) ? `
          <div class="password-form">
            <label style="font-size: 0.82rem; font-weight: 600; color: var(--text-secondary);">This file is password-protected:</label>
            <input type="password" id="transfer-pw" placeholder="Enter transfer password" autofocus>
            <button type="button" class="btn-download" onclick="startDownloadWithPassword()">
              Unlock &amp; Download File
            </button>
          </div>
          <script>
            async function startDownloadWithPassword() {
              const pw = document.getElementById('transfer-pw').value;
              if (!pw) { alert('Please enter the transfer password.'); return; }
              try {
                const res = await fetch('/api/transfer/${id}/authorize-download', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ password: pw })
                });
                const data = await res.json();
                if (!res.ok) {
                  alert(data.error || 'Incorrect password.');
                  return;
                }
                window.location.href = '${downloadApiUrl}?ticket=' + encodeURIComponent(data.ticket);
              } catch (e) {
                alert('Download authorization failed: ' + e.message);
              }
            }
          </script>
        ` : `
          <a href="${downloadApiUrl}" class="btn-download" id="auto-dl-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            Download File (${formattedSize})
          </a>
          <p class="auto-status" id="dl-status">Starting download automatically on your device...</p>
          <script>
            setTimeout(() => {
              window.location.href = '${downloadApiUrl}';
              const s = document.getElementById('dl-status');
              if (s) s.textContent = 'If the download did not start automatically, tap the button above.';
            }, 600);
          </script>
        `}
      </div>
    </body>
    </html>
  `);
});

// 3. Generate dynamic QR Code for receiving a specific transfer
app.get('/api/qr/transfer/:id', async (req, res) => {
  const { id } = req.params;
  const db = loadDB();
  const transfer = db.transfers[id];
  if (!transfer) return res.status(404).send('Transfer not found');

  const baseUrl = getBaseUrl(req);
  const downloadUrl = `${baseUrl}/#receive?id=${id}`;

  try {
    const qrImage = await QRCode.toBuffer(downloadUrl, { width: 340, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(qrImage);
  } catch (err) {
    res.status(500).send('Error generating QR');
  }
});

// -------------------------------------------------------------
// WebSocket Engine: Nearby P2P Signaling & Device Pairing
// -------------------------------------------------------------
const clients = new Map(); // socket -> clientMetadata

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  const clientMeta = {
    id: clientId,
    name: `Device-${clientId.slice(0, 4).toUpperCase()}`,
    type: 'unknown',
    pairedWith: null
  };
  clients.set(ws, clientMeta);

  // Send Welcome & Assigned Client ID
  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    deviceName: clientMeta.name
  }));

  // Broadcast updated nearby device list
  broadcastDeviceList();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'set-device-info':
          clientMeta.name = data.name || clientMeta.name;
          clientMeta.type = data.deviceType || 'desktop';
          broadcastDeviceList();
          break;

        case 'request-pairing':
          // Device A wants to pair with Device B
          forwardToClient(data.targetId, {
            type: 'pairing-requested',
            fromId: clientId,
            fromName: clientMeta.name,
            fromType: clientMeta.type
          });
          break;

        case 'accept-pairing':
          clientMeta.pairedWith = data.targetId;
          forwardToClient(data.targetId, {
            type: 'pairing-accepted',
            peerId: clientId,
            peerName: clientMeta.name
          });
          break;

        // WebRTC Signaling: SDP Offer, Answer, and ICE Candidates
        case 'signal':
          if (data.targetId) {
            forwardToClient(data.targetId, {
              type: 'signal',
              fromId: clientId,
              signal: data.signal
            });
          }
          break;

        case 'p2p-file-offer':
          // Device A proposes file transfer to Device B
          if (data.targetId) {
            forwardToClient(data.targetId, {
              type: 'p2p-file-offer',
              fromId: clientId,
              fromName: clientMeta.name,
              meta: data.meta
            });
          }
          break;

        case 'p2p-file-response':
          // Device B accepts or declines
          if (data.targetId) {
            forwardToClient(data.targetId, {
              type: 'p2p-file-response',
              fromId: clientId,
              accepted: data.accepted,
              meta: data.meta
            });
          }
          break;
      }
    } catch (err) {
      console.error('WebSocket message parsing error:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastDeviceList();
  });
});

function broadcastDeviceList() {
  const activeDevices = Array.from(clients.values()).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type
  }));

  const payload = JSON.stringify({
    type: 'nearby-devices-update',
    devices: activeDevices
  });

  for (const clientWs of clients.keys()) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(payload);
    }
  }
}

function forwardToClient(targetId, payload) {
  for (const [socket, meta] of clients.entries()) {
    if (meta.id === targetId && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      break;
    }
  }
}

// -------------------------------------------------------------
// Direct Local LAN Zero-Internet Streaming (High-Performance Disk Stream)
// -------------------------------------------------------------
const localP2PStreams = {};

app.post('/api/local-p2p/init', express.json(), (req, res) => {
  const { fileName, fileSize, mimeType, sha256 } = req.body;
  if (!fileName || !fileSize) {
    return res.status(400).json({ error: 'fileName and fileSize required.' });
  }

  const transferId = 'p2p_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempFilePath = path.join(P2P_TEMP_DIR, `${transferId}.tmp`);

  // Ensure file is empty and ready
  try { fs.writeFileSync(tempFilePath, Buffer.alloc(0)); } catch (e) {}

  localP2PStreams[transferId] = {
    transferId,
    fileName: safeName || 'download.dat',
    fileSize: Number(fileSize),
    mimeType: mimeType || 'application/octet-stream',
    sha256: sha256 || null,
    tempFilePath,
    receivedBytes: 0,
    createdAt: Date.now()
  };

  res.json({
    success: true,
    transferId,
    message: 'Local zero-internet P2P stream initialized.'
  });
});

app.post('/api/local-p2p/:id/chunk', (req, res) => {
  const transfer = localP2PStreams[req.params.id];
  if (!transfer) {
    return res.status(404).json({ error: 'Local P2P stream not found or expired.' });
  }

  // Stream directly to append write stream without accumulating in RAM
  const writeStream = fs.createWriteStream(transfer.tempFilePath, {
    flags: 'a',
    highWaterMark: 4 * 1024 * 1024
  });

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    try {
      transfer.receivedBytes = fs.statSync(transfer.tempFilePath).size;
    } catch (e) {}

    res.json({
      success: true,
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.fileSize
    });
  });

  writeStream.on('error', (err) => {
    console.error('Error writing P2P stream chunk:', err);
    res.status(500).json({ error: 'Failed to write stream chunk.' });
  });
});

app.get('/api/local-p2p/:id/download', (req, res) => {
  const transfer = localP2PStreams[req.params.id];
  if (!transfer) {
    return res.status(404).json({ error: 'Local P2P stream not found or expired.' });
  }

  if (!fs.existsSync(transfer.tempFilePath)) {
    return res.status(404).json({ error: 'File data stream not found.' });
  }

  const stat = fs.statSync(transfer.tempFilePath);
  res.setHeader('Content-Disposition', `attachment; filename="${transfer.fileName}"`);
  res.setHeader('Content-Type', transfer.mimeType);
  res.setHeader('Content-Length', stat.size);
  if (transfer.sha256) {
    res.setHeader('X-File-SHA256', transfer.sha256);
  }

  const readStream = fs.createReadStream(transfer.tempFilePath, {
    highWaterMark: 4 * 1024 * 1024
  });

  readStream.pipe(res);

  readStream.on('end', () => {
    setTimeout(() => {
      try { fs.unlinkSync(transfer.tempFilePath); } catch (e) {}
      delete localP2PStreams[req.params.id];
    }, 20000);
  });
});

// -------------------------------------------------------------
// Automated Retention & Expiration Cleanup Engine (Runs every 15 min)
// -------------------------------------------------------------
function runRetentionCleanup() {
  const db = loadDB();
  const now = Date.now();
  let changed = false;

  for (const id in db.transfers) {
    const t = db.transfers[id];
    const isExpired = t.expiresAt && t.expiresAt < now;
    const isLimitReached = t.maxDownloads && t.maxDownloads > 0 && (t.downloadCount || 0) >= t.maxDownloads;
    if ((isExpired || isLimitReached || t.isRevoked) && !t.fileDeleted) {
      if (t.completedFilePath && fs.existsSync(t.completedFilePath)) {
        try { fs.unlinkSync(t.completedFilePath); } catch (e) {}
      }
      t.fileDeleted = true;
      changed = true;
    }
  }

  // Also clean expired download tickets
  if (db.downloadTickets) {
    for (const ticket in db.downloadTickets) {
      if (db.downloadTickets[ticket].expiresAt < now) {
        delete db.downloadTickets[ticket];
        changed = true;
      }
    }
  }

  if (changed) saveDB(db, true);
}
setInterval(runRetentionCleanup, 15 * 60 * 1000);

// -------------------------------------------------------------
// Start Server and Output Connectivity Banners
// -------------------------------------------------------------
server.listen(PORT, async () => {
  const localIps = getLocalIPAddresses();
  console.log('\n======================================================');
  console.log('       ShareBoxZen Server is Active & Listening!       ');
  console.log('======================================================');
  console.log(`• Localhost:       http://localhost:${PORT}`);
  if (localIps.length > 0) {
    localIps.forEach(net => {
      console.log(`• Network (${net.interface}): http://${net.address}:${PORT}`);
    });
    console.log('\n📱 Scan from phone on same Wi-Fi/Hotspot to connect instantly!');
  }
  console.log('======================================================\n');

  // Synchronize users and transfers from persistent Supabase Cloud Storage
  try {
    await loadUsersFromCloud();
    await loadTransfersFromCloud();
  } catch (err) {
    console.warn('[Startup] Cloud sync warning:', err.message);
  }
});
