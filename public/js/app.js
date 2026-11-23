/**
 * ShareBoxZen - Main Application Controller
 * Handles Authentication, Real Mobile OTP, Zero-Internet Nearby P2P, Remote Transfers, and Modals
 */

// -----------------------------------------------------------------
// Android APK / Web Hybrid Network Resolver
// -----------------------------------------------------------------
const DEFAULT_ZEN_SERVER = 'https://shareboxzen.onrender.com';

function getActiveServerHost() {
  if (window.location.protocol === 'file:') {
    const saved = localStorage.getItem('zen_server_host');
    return (saved || DEFAULT_ZEN_SERVER).replace(/\/+$/, '');
  }
  return '';
}

// Transparently route /api requests to active host when running locally inside APK
(function() {
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.startsWith('/')) {
      const host = getActiveServerHost();
      if (host) {
        input = host + input;
      }
    }
    return originalFetch(input, init);
  };
})();

// Global State
let currentChunker = null;
let nearbyEngine = null;
let selectedFile = null;
let selectedNearbyFile = null;
let currentUser = null;
let authToken = null;
let pendingVerificationEmail = null;
let pendingVerificationMobile = null;
let activeForgotResetToken = null;
let currentSendMode = 'nearby'; // 'nearby' or 'remote'
let activePairingCallback = null;
let activeFileOfferCallback = null;

// -----------------------------------------------------------------
// Supabase Cloud Realtime & Storage Client Integration
// -----------------------------------------------------------------
const SUPABASE_URL = 'https://rjcwargndkoaktlzithj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_7f4dQpHELm3fdagIzzxPNA_soFpjF7w';
let supabaseClient = null;

function initSupabaseRealtime() {
  if (window.supabase && !supabaseClient) {
    try {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      console.log('✓ Connected to Supabase Cloud Engine');

      supabaseClient
        .channel('public:transfers')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transfers' }, (payload) => {
          console.log('⚡ [Realtime] Cloud transfer event received:', payload);
          if (typeof loadTransferredFiles === 'function') {
            loadTransferredFiles();
          }
        })
        .subscribe();
    } catch (e) {
      console.warn('Supabase Realtime init error:', e.message);
    }
  }
}

// -----------------------------------------------------------------
// Theme Preference Management
// -----------------------------------------------------------------
function applyTheme(theme) {
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function updateThemeSwitcherButtons(pref) {
  const btnLight = document.getElementById('theme-btn-light');
  const btnDark = document.getElementById('theme-btn-dark');
  const btnSystem = document.getElementById('theme-btn-system');
  if (btnLight) btnLight.classList.toggle('active', pref === 'light');
  if (btnDark) btnDark.classList.toggle('active', pref === 'dark');
  if (btnSystem) btnSystem.classList.toggle('active', pref === 'system');
}

window.setThemePreference = function(pref) {
  try {
    localStorage.setItem('shareboxzen_theme', pref);
  } catch (e) {}
  applyTheme(pref);
  updateThemeSwitcherButtons(pref);
};

function initThemeSwitcher() {
  const currentPref = localStorage.getItem('shareboxzen_theme') || 'system';
  applyTheme(currentPref);
  updateThemeSwitcherButtons(currentPref);

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemChange = (e) => {
    const pref = localStorage.getItem('shareboxzen_theme') || 'system';
    if (pref === 'system') {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
  };
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', handleSystemChange);
  } else if (mediaQuery.addListener) {
    mediaQuery.addListener(handleSystemChange);
  }
}

// -----------------------------------------------------------------
// Toast Notification Helper
// -----------------------------------------------------------------
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let iconSvg = '';
  if (type === 'success') {
    iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  } else if (type === 'error') {
    iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  } else {
    iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }

  toast.innerHTML = `<span style="display:inline-flex; align-items:center;">${iconSvg}</span><span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// -----------------------------------------------------------------
// Authentication Controller (Permanent Account & Multi-Device Session)
// -----------------------------------------------------------------

function showAuthView(viewName) {
  const overlay = document.getElementById('auth-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
  }

  const views = {
    register: document.getElementById('auth-view-register'),
    verify: document.getElementById('auth-view-verify'),
    login: document.getElementById('auth-view-login'),
    forgot: document.getElementById('auth-view-forgot')
  };

  Object.values(views).forEach(v => {
    if (v) v.style.display = 'none';
  });

  if (views[viewName]) {
    views[viewName].style.display = 'block';
  }

  const btnCreateTab = document.getElementById('btn-switch-to-create-tab');
  const btnLoginTab = document.getElementById('btn-switch-to-login-tab');
  const btnLoginCreateTab = document.getElementById('btn-login-to-create-tab');
  const btnLoginLoginTab = document.getElementById('btn-login-to-login-tab');

  if (viewName === 'register') {
    if (btnCreateTab) btnCreateTab.classList.add('active');
    if (btnLoginTab) btnLoginTab.classList.remove('active');
    if (btnLoginCreateTab) btnLoginCreateTab.classList.add('active');
    if (btnLoginLoginTab) btnLoginLoginTab.classList.remove('active');
  } else if (viewName === 'login') {
    if (btnCreateTab) btnCreateTab.classList.remove('active');
    if (btnLoginTab) btnLoginTab.classList.add('active');
    if (btnLoginCreateTab) btnLoginCreateTab.classList.remove('active');
    if (btnLoginLoginTab) btnLoginLoginTab.classList.add('active');
  }
}
window.showAuthView = showAuthView;

function getStoredAuthToken() {
  if (authToken) return authToken;
  if (window.ShareBoxAndroidSecureStorage && typeof window.ShareBoxAndroidSecureStorage.getAuthToken === 'function') {
    const nativeToken = window.ShareBoxAndroidSecureStorage.getAuthToken();
    if (nativeToken) return nativeToken;
  }
  return localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
}

function storeAuthToken(token, rememberMe = true) {
  authToken = token;
  if (window.ShareBoxAndroidSecureStorage && typeof window.ShareBoxAndroidSecureStorage.setAuthToken === 'function') {
    window.ShareBoxAndroidSecureStorage.setAuthToken(token);
    localStorage.removeItem('shareboxzen_auth_token');
    sessionStorage.removeItem('shareboxzen_auth_token_session');
    return;
  }
  if (rememberMe) {
    localStorage.setItem('shareboxzen_auth_token', token);
    localStorage.removeItem('shareboxzen_auth_token_session');
  } else {
    sessionStorage.setItem('shareboxzen_auth_token_session', token);
    localStorage.removeItem('shareboxzen_auth_token');
  }
}

function clearStoredAuthToken() {
  authToken = null;
  currentUser = null;
  if (window.ShareBoxAndroidSecureStorage && typeof window.ShareBoxAndroidSecureStorage.clearAuthToken === 'function') {
    window.ShareBoxAndroidSecureStorage.clearAuthToken();
  }
  localStorage.removeItem('shareboxzen_auth_token');
  sessionStorage.removeItem('shareboxzen_auth_token_session');
}

function setAuthenticatedUser(user, token, rememberMe = true) {
  currentUser = user;
  authToken = token;

  // Unhide the primary dashboard and transfer suite
  const mainContent = document.getElementById('main-app-content');
  if (mainContent) {
    mainContent.classList.add('authenticated');
    mainContent.style.setProperty('display', 'block', 'important');
  }

  // Hide the authentication overlay
  const overlay = document.getElementById('auth-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.setProperty('display', 'none', 'important');
  }

  storeAuthToken(token, rememberMe);
  localStorage.setItem('shareboxzen_has_account', 'true');

  const profileBadge = document.getElementById('header-user-profile');
  const avatarCircle = document.getElementById('header-avatar-circle');
  const nameEl = document.getElementById('header-user-name');
  const zenIdEl = document.getElementById('header-user-zenid');
  const dropdownName = document.getElementById('dropdown-name');
  const dropdownEmail = document.getElementById('dropdown-email');
  const dropdownPhone = document.getElementById('dropdown-phone');

  if (profileBadge && user) {
    profileBadge.style.display = 'flex';
    const initial = (user.name || user.username || 'U').charAt(0).toUpperCase();
    if (avatarCircle) avatarCircle.textContent = initial;
    if (nameEl) nameEl.textContent = user.name || user.username;
    if (zenIdEl) zenIdEl.textContent = user.zenId || '';
    if (dropdownName) dropdownName.textContent = user.name || user.username;
    if (dropdownEmail) dropdownEmail.textContent = user.email || '';
    if (dropdownPhone) dropdownPhone.textContent = user.mobileNumber || '';
  }

  loadIncomingTransfers();
  loadTransferHistory();

  if (nearbyEngine && user) {
    nearbyEngine.deviceName = user.preferredDeviceName || `${user.name || user.username} (${user.zenId})`;
  }
}

async function initAuthSystem() {
  const overlay = document.getElementById('auth-overlay');
  const mainContent = document.getElementById('main-app-content');

  const storedToken = getStoredAuthToken();
  
  if (storedToken) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${storedToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAuthenticatedUser(data.user, storedToken, true);
        return;
      } else {
        clearStoredAuthToken();
      }
    } catch (e) {
      console.warn('[Auth] Session check failed:', e);
    }
  }

  // Ensure dashboard remains strictly hidden until authenticated
  if (mainContent) {
    mainContent.classList.remove('authenticated');
    mainContent.style.setProperty('display', 'none', 'important');
  }
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.setProperty('display', 'flex', 'important');
  }

  const hasAccount = localStorage.getItem('shareboxzen_has_account') === 'true';
  if (hasAccount) {
    showAuthView('login');
  } else {
    showAuthView('register');
  }

  setupAuthEventListeners();
}

function setupAuthEventListeners() {
  const bindClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };

  bindClick('btn-switch-to-create-tab', () => showAuthView('register'));
  bindClick('btn-login-to-create-tab', () => showAuthView('register'));
  bindClick('link-goto-register', () => showAuthView('register'));

  bindClick('btn-switch-to-login-tab', () => showAuthView('login'));
  bindClick('btn-login-to-login-tab', () => showAuthView('login'));
  bindClick('link-goto-login', () => showAuthView('login'));
  bindClick('link-forgot-back-login', () => showAuthView('login'));
  bindClick('link-verify-back', () => showAuthView('register'));
  bindClick('link-goto-forgot', () => {
    document.getElementById('forgot-step-1').style.display = 'block';
    document.getElementById('forgot-step-2').style.display = 'none';
    showAuthView('forgot');
  });

  // Password visibility toggle buttons
  document.querySelectorAll('.toggle-password-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;

      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';

      if (isPassword) {
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="23" x2="23" y2="1"></line>
          </svg>
        `;
      } else {
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      }
    });
  });

  // Real-time username check
  const regUsername = document.getElementById('reg-username');
  const regUsernameHint = document.getElementById('reg-username-hint');
  if (regUsername) {
    regUsername.addEventListener('input', debounce(async (e) => {
      const u = e.target.value.trim();
      if (!u) {
        regUsernameHint.textContent = '';
        regUsernameHint.className = 'field-hint';
        return;
      }
      try {
        const res = await fetch(`/api/auth/check-username?u=${encodeURIComponent(u)}`);
        const data = await res.json();
        if (data.available) {
          regUsernameHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Username is available
          </span>`;
          regUsernameHint.className = 'field-hint success';
        } else {
          regUsernameHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            ${data.error || 'This username is already taken. Please choose another.'}
          </span>`;
          regUsernameHint.className = 'field-hint error';
        }
      } catch (err) {}
    }, 250));
  }

  // Real-time email uniqueness check
  const regEmail = document.getElementById('reg-email');
  const regEmailHint = document.getElementById('reg-email-hint');
  if (regEmail) {
    regEmail.addEventListener('input', debounce(async (e) => {
      const val = e.target.value.trim();
      if (!val || !val.includes('@')) {
        regEmailHint.textContent = '';
        regEmailHint.className = 'field-hint';
        return;
      }
      try {
        const res = await fetch(`/api/auth/check-email?e=${encodeURIComponent(val)}`);
        const data = await res.json();
        if (data.available) {
          regEmailHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Email is available
          </span>`;
          regEmailHint.className = 'field-hint success';
        } else {
          regEmailHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            ${data.error || 'An account with this email address already exists. Please log in.'}
          </span>`;
          regEmailHint.className = 'field-hint error';
        }
      } catch (err) {}
    }, 250));
  }

  // Real-time mobile uniqueness check
  const regPhone = document.getElementById('reg-phone');
  const regPhoneCode = document.getElementById('reg-phone-code');
  const regPhoneHint = document.getElementById('reg-phone-hint');
  const checkMobileUniqueness = debounce(async () => {
    if (!regPhone || !regPhoneHint) return;
    const rawDigits = regPhone.value.trim().replace(/\D/g, '');
    if (rawDigits.length < 7) {
      regPhoneHint.textContent = '';
      regPhoneHint.className = 'field-hint';
      return;
    }
    const fullMobile = (regPhoneCode ? regPhoneCode.value : '+1') + rawDigits;
    try {
      const res = await fetch(`/api/auth/check-mobile?m=${encodeURIComponent(fullMobile)}`);
      const data = await res.json();
      if (data.available) {
        regPhoneHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Mobile number is available
        </span>`;
        regPhoneHint.className = 'field-hint success';
      } else {
        regPhoneHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          ${data.error || 'This mobile number is already registered. Please log in to your existing account.'}
        </span>`;
        regPhoneHint.className = 'field-hint error';
      }
    } catch (e) {}
  }, 250);

  if (regPhone) regPhone.addEventListener('input', checkMobileUniqueness);
  if (regPhoneCode) regPhoneCode.addEventListener('change', checkMobileUniqueness);

  // Real-time password strength meter
  const regPassword = document.getElementById('reg-password');
  const regConfirmPassword = document.getElementById('reg-confirm-password');
  const matchHint = document.getElementById('reg-match-hint');

  if (regPassword) {
    regPassword.addEventListener('input', (e) => {
      evaluatePasswordStrength(e.target.value);
      validatePasswordMatch();
    });
  }

  if (regConfirmPassword) {
    regConfirmPassword.addEventListener('input', validatePasswordMatch);
  }

  function validatePasswordMatch() {
    if (!regPassword || !regConfirmPassword || !matchHint) return;
    const p1 = regPassword.value;
    const p2 = regConfirmPassword.value;

    if (!p2) {
      matchHint.textContent = '';
      matchHint.className = 'field-hint';
      return;
    }

    if (p1 === p2) {
      matchHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Passwords match
      </span>`;
      matchHint.className = 'field-hint success';
    } else {
      matchHint.innerHTML = `<span style="display:inline-flex; align-items:center; gap:3px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Passwords do not match
      </span>`;
      matchHint.className = 'field-hint error';
    }
  }

  // Resend OTP link
  bindClick('link-verify-resend', async () => {
    if (!pendingVerificationMobile) {
      showToast('No active mobile number found. Please register first.', 'error');
      return;
    }
    try {
      showToast('Sending new 6-digit OTP...', 'info');
      const res = await fetch('/api/auth/resend-mobile-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobileNumber: pendingVerificationMobile })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('verify-code-dev-hint').textContent = data.verificationCode;
        document.getElementById('verify-code-input').value = data.verificationCode;
        showToast('New mobile OTP sent!', 'success');
      } else {
        showToast(data.error || 'Failed to resend OTP.', 'error');
      }
    } catch (e) {
      showToast('Network error resending OTP.', 'error');
    }
  });

  // Header user profile dropdown toggle
  const userBadge = document.getElementById('header-user-profile');
  const dropdownMenu = document.getElementById('user-dropdown-menu');
  if (userBadge && dropdownMenu) {
    userBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', (e) => {
      if (!userBadge.contains(e.target)) {
        dropdownMenu.classList.remove('show');
      }
    });
  }

  // FEATURE 1: Menu Items Wireup
  bindClick('btn-open-profile', () => {
    if (dropdownMenu) dropdownMenu.classList.remove('show');
    openProfileModal();
  });

  bindClick('btn-open-settings', () => {
    if (dropdownMenu) dropdownMenu.classList.remove('show');
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'flex';
  });

  bindClick('btn-open-security', () => {
    if (dropdownMenu) dropdownMenu.classList.remove('show');
    const secModal = document.getElementById('security-modal');
    if (secModal && currentUser) {
      document.getElementById('sec-profile-name').textContent = currentUser.name || currentUser.username;
      document.getElementById('sec-profile-zenid').textContent = currentUser.zenId || '';
      document.getElementById('sec-profile-email').textContent = currentUser.email || '';
      secModal.style.display = 'flex';
    }
  });

  bindClick('btn-open-theme-settings', () => {
    if (dropdownMenu) dropdownMenu.classList.remove('show');
    const modal = document.getElementById('theme-modal');
    if (modal) modal.style.display = 'flex';
  });

  // Logout button
  bindClick('btn-logout', () => {
    if (dropdownMenu) dropdownMenu.classList.remove('show');
    handleLogout();
  });

  // Modals closing triggers
  bindClick('btn-close-profile', () => document.getElementById('profile-modal').style.display = 'none');
  bindClick('btn-cancel-profile', () => document.getElementById('profile-modal').style.display = 'none');
  bindClick('btn-close-settings', () => document.getElementById('settings-modal').style.display = 'none');
  bindClick('btn-close-theme-modal', () => document.getElementById('theme-modal').style.display = 'none');
  bindClick('btn-close-theme', () => document.getElementById('theme-modal').style.display = 'none');
  bindClick('btn-close-security', () => document.getElementById('security-modal').style.display = 'none');

  // Save Settings
  bindClick('btn-save-settings', () => {
    const dir = document.getElementById('settings-download-dir').value.trim();
    localStorage.setItem('shareboxzen_download_dir', dir);
    document.getElementById('settings-modal').style.display = 'none';
    showToast('Settings saved successfully.', 'success');
  });

  // Pairing Modal Action Buttons
  bindClick('btn-pair-accept', () => {
    document.getElementById('nearby-pair-modal').style.display = 'none';
    if (activePairingCallback) activePairingCallback(true);
  });
  bindClick('btn-pair-decline', () => {
    document.getElementById('nearby-pair-modal').style.display = 'none';
    if (activePairingCallback) activePairingCallback(false);
  });

  // File Offer Modal Action Buttons
  bindClick('btn-nearby-file-accept', () => {
    document.getElementById('nearby-file-modal').style.display = 'none';
    if (activeFileOfferCallback) activeFileOfferCallback(true);
  });
  bindClick('btn-nearby-file-decline', () => {
    document.getElementById('nearby-file-modal').style.display = 'none';
    if (activeFileOfferCallback) activeFileOfferCallback(false);
  });
}

function openProfileModal() {
  const modal = document.getElementById('profile-modal');
  if (!modal || !currentUser) return;

  const initial = (currentUser.name || currentUser.username || 'U').charAt(0).toUpperCase();
  document.getElementById('profile-modal-avatar').textContent = initial;
  document.getElementById('profile-modal-fullname').textContent = currentUser.name || currentUser.username;
  document.getElementById('profile-modal-zenid').textContent = currentUser.zenId || '';
  document.getElementById('profile-modal-username').textContent = '@' + currentUser.username;
  document.getElementById('profile-modal-phone').textContent = currentUser.mobileNumber || 'Not registered';
  document.getElementById('profile-modal-email').textContent = currentUser.email || '';
  document.getElementById('profile-modal-created').textContent = formatDate(currentUser.createdAt);

  document.getElementById('profile-edit-name').value = currentUser.name || '';
  document.getElementById('profile-edit-device').value = currentUser.preferredDeviceName || '';

  modal.style.display = 'flex';
}

async function handleUpdateProfileSubmit() {
  const name = document.getElementById('profile-edit-name').value.trim();
  const preferredDeviceName = document.getElementById('profile-edit-device').value.trim();
  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');

  try {
    const res = await fetch('/api/auth/update-profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, preferredDeviceName })
    });
    const data = await res.json();
    if (res.ok) {
      setAuthenticatedUser(data.user, token, true);
      document.getElementById('profile-modal').style.display = 'none';
      showToast('Profile updated successfully!', 'success');
    } else {
      showToast(data.error || 'Failed to update profile.', 'error');
    }
  } catch (e) {
    showToast('Network error updating profile.', 'error');
  }
}

function evaluatePasswordStrength(pwd) {
  const steps = [
    document.getElementById('strength-step-1'),
    document.getElementById('strength-step-2'),
    document.getElementById('strength-step-3'),
    document.getElementById('strength-step-4')
  ];
  const label = document.getElementById('reg-strength-text');
  if (!label || !steps[0]) return;

  if (!pwd) {
    steps.forEach(s => { s.className = 'strength-bar-step'; });
    label.textContent = 'Enter password';
    label.className = 'strength-text';
    return;
  }

  let score = 0;
  if (pwd.length >= 8) score++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~\`]/.test(pwd)) score++;

  steps.forEach(s => { s.className = 'strength-bar-step'; });

  if (score === 1) {
    steps[0].classList.add('active', 'weak');
    label.textContent = 'Weak';
    label.className = 'strength-text weak';
  } else if (score === 2) {
    steps[0].classList.add('active', 'fair');
    steps[1].classList.add('active', 'fair');
    label.textContent = 'Fair';
    label.className = 'strength-text fair';
  } else if (score === 3) {
    steps[0].classList.add('active', 'good');
    steps[1].classList.add('active', 'good');
    steps[2].classList.add('active', 'good');
    label.textContent = 'Good';
    label.className = 'strength-text good';
  } else if (score >= 4) {
    steps[0].classList.add('active', 'strong');
    steps[1].classList.add('active', 'strong');
    steps[2].classList.add('active', 'strong');
    steps[3].classList.add('active', 'strong');
    label.textContent = 'Strong';
    label.className = 'strength-text strong';
  }
}

// -----------------------------------------------------------------
// FEATURE 2: Registration Submission & Mobile OTP
// -----------------------------------------------------------------

async function handleRegisterSubmit() {
  const submitBtn = document.getElementById('btn-submit-register');
  const regErrEl = document.getElementById('reg-form-error');
  if (regErrEl) { regErrEl.style.display = 'none'; regErrEl.textContent = ''; }

  const name = document.getElementById('reg-fullname').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phoneCode = document.getElementById('reg-phone-code').value;
  const rawPhone = document.getElementById('reg-phone').value.trim().replace(/\D/g, '');
  const mobileNumber = phoneCode + rawPhone;
  const password = document.getElementById('reg-password').value;
  const confirmPassword = document.getElementById('reg-confirm-password').value;
  const agreedTerms = document.getElementById('reg-terms').checked;

  if (!agreedTerms) {
    const msg = 'Please accept the Terms of Service & Privacy Policy.';
    showToast(msg, 'error');
    if (regErrEl) { regErrEl.textContent = msg; regErrEl.style.display = 'block'; }
    return;
  }

  if (rawPhone.length < 7) {
    const msg = 'Please enter a valid mobile number.';
    showToast(msg, 'error');
    if (regErrEl) { regErrEl.textContent = msg; regErrEl.style.display = 'block'; }
    return;
  }

  if (password.length < 6) {
    const msg = 'Password must be at least 6 characters long.';
    showToast(msg, 'error');
    if (regErrEl) { regErrEl.textContent = msg; regErrEl.style.display = 'block'; }
    return;
  }

  if (password !== confirmPassword) {
    const msg = 'Passwords do not match. Please verify.';
    showToast(msg, 'error');
    if (regErrEl) { regErrEl.textContent = msg; regErrEl.style.display = 'block'; }
    return;
  }

  const originalBtnText = submitBtn ? submitBtn.innerHTML : 'Create Permanent Account';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span style="display:inline-flex; align-items:center; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg> Creating Account...</span>';
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, email, countryCode: phoneCode, mobileNumber, password, confirmPassword, agreedTerms })
    });
    const data = await res.json();

    if (!res.ok) {
      const errMsg = data.error || 'Registration failed.';
      showToast(errMsg, 'error');
      if (regErrEl) { regErrEl.textContent = errMsg; regErrEl.style.display = 'block'; }
      return;
    }

    pendingVerificationMobile = data.mobileNumber;
    pendingVerificationEmail = data.email;
    document.getElementById('verify-mobile-target').textContent = data.mobileNumber;
    document.getElementById('verify-code-dev-hint').textContent = data.verificationCode;
    document.getElementById('verify-code-input').value = data.verificationCode;

    showAuthView('verify');
    showToast('6-Digit OTP sent to your mobile. Please verify to activate.', 'info');
  } catch (err) {
    const netErr = 'Registration network error. Please try again.';
    showToast(netErr, 'error');
    if (regErrEl) { regErrEl.textContent = netErr; regErrEl.style.display = 'block'; }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
  }
}

async function handleVerifySubmit() {
  const submitBtn = document.getElementById('btn-submit-verify');
  const verifyErrEl = document.getElementById('verify-form-error');
  if (verifyErrEl) { verifyErrEl.style.display = 'none'; verifyErrEl.textContent = ''; }

  if (!pendingVerificationMobile) {
    const msg = 'Mobile number missing. Please restart registration.';
    showToast(msg, 'error');
    if (verifyErrEl) { verifyErrEl.textContent = msg; verifyErrEl.style.display = 'block'; }
    return;
  }
  const code = document.getElementById('verify-code-input').value.trim();
  const rememberMe = document.getElementById('verify-remember-session').checked;

  if (!code || code.length !== 6) {
    const msg = 'Please enter the 6-digit verification code.';
    showToast(msg, 'error');
    if (verifyErrEl) { verifyErrEl.textContent = msg; verifyErrEl.style.display = 'block'; }
    return;
  }

  const originalBtnText = submitBtn ? submitBtn.innerHTML : 'Verify OTP & Auto-Login';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span style="display:inline-flex; align-items:center; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg> Verifying...</span>';
  }

  try {
    const res = await fetch('/api/auth/verify-mobile-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: pendingVerificationMobile, code, rememberMe })
    });
    const data = await res.json();

    if (!res.ok) {
      const errMsg = data.error || 'Verification failed.';
      showToast(errMsg, 'error');
      if (verifyErrEl) { verifyErrEl.textContent = errMsg; verifyErrEl.style.display = 'block'; }
      return;
    }

    setAuthenticatedUser(data.user, data.token, rememberMe);
    document.getElementById('auth-overlay').classList.add('hidden');
    showToast(`Account verified! Welcome to ShareBoxZen, ${data.user.name || data.user.username}!`, 'success');
  } catch (err) {
    const netErr = 'Verification network error. Please try again.';
    showToast(netErr, 'error');
    if (verifyErrEl) { verifyErrEl.textContent = netErr; verifyErrEl.style.display = 'block'; }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
  }
}

async function handleLoginSubmit() {
  const submitBtn = document.getElementById('btn-submit-login');
  const loginErrEl = document.getElementById('login-form-error');
  if (loginErrEl) { loginErrEl.style.display = 'none'; loginErrEl.textContent = ''; }

  const identifier = document.getElementById('login-identifier').value.trim();
  const password = document.getElementById('login-password').value;
  const rememberMe = document.getElementById('login-remember-session').checked;

  if (!identifier || !password) {
    const msg = 'Please enter your username, email, or mobile number and password.';
    showToast(msg, 'error');
    if (loginErrEl) { loginErrEl.textContent = msg; loginErrEl.style.display = 'block'; }
    return;
  }

  const originalBtnText = submitBtn ? submitBtn.innerHTML : 'Sign In';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span style="display:inline-flex; align-items:center; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg> Signing In...</span>';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password, rememberMe })
    });
    const data = await res.json();

    if (!res.ok) {
      const errMsg = data.error || 'Login failed.';
      showToast(errMsg, 'error');
      if (loginErrEl) { loginErrEl.textContent = errMsg; loginErrEl.style.display = 'block'; }
      return;
    }

    setAuthenticatedUser(data.user, data.token, rememberMe);
    document.getElementById('auth-overlay').classList.add('hidden');
    showToast(`Welcome back, ${data.user.name || data.user.username}!`, 'success');
  } catch (err) {
    const netErr = 'Login network error. Please check server connection.';
    showToast(netErr, 'error');
    if (loginErrEl) { loginErrEl.textContent = netErr; loginErrEl.style.display = 'block'; }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
  }
}
window.handleLoginSubmit = handleLoginSubmit;
window.handleRegisterSubmit = handleRegisterSubmit;
window.handleVerifySubmit = handleVerifySubmit;
window.handleForgotRequest = handleForgotRequest;
window.handleForgotResetSubmit = handleForgotResetSubmit;

// -----------------------------------------------------------------
// FEATURE 1: Proper Logout with Confirmation & Session Invalidation
// -----------------------------------------------------------------

async function handleLogout() {
  // 1. Show confirmation dialog
  const result = await showConfirmDialog({
    title: 'Sign Out of ShareBoxZen',
    message: 'Are you sure you want to log out? Your registered account and transfer history will be safely preserved.',
    showDeletePhysical: false
  });

  if (!result.confirmed) return;

  // 2. Revoke active server session token
  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (e) {}
  }

  // 3. Clear auth tokens from application storage
  localStorage.removeItem('shareboxzen_auth_token');
  sessionStorage.removeItem('shareboxzen_auth_token_session');
  currentUser = null;
  authToken = null;

  // 4. Hide main application dashboard and clear protected data
  const mainContent = document.getElementById('main-app-content');
  if (mainContent) {
    mainContent.classList.remove('authenticated');
    mainContent.style.setProperty('display', 'none', 'important');
  }

  const profileBadge = document.getElementById('header-user-profile');
  if (profileBadge) profileBadge.style.display = 'none';

  const incomingBadge = document.getElementById('incoming-count-badge');
  if (incomingBadge) incomingBadge.style.display = 'none';
  const historyContainer = document.getElementById('history-items-container');
  if (historyContainer) historyContainer.innerHTML = '';
  const incomingContainer = document.getElementById('incoming-files-container');
  if (incomingContainer) incomingContainer.innerHTML = '';

  // 5. Navigate to login screen and reveal auth overlay
  const overlay = document.getElementById('auth-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.setProperty('display', 'flex', 'important');
  }
  showAuthView('login');
  showToast('You have been logged out successfully.', 'info');
}

async function handleChangePasswordSubmit() {
  const currentPassword = document.getElementById('change-curr-password').value;
  const newPassword = document.getElementById('change-new-password').value;
  const confirmPassword = document.getElementById('change-confirm-password').value;

  if (newPassword !== confirmPassword) {
    showToast('New passwords do not match.', 'error');
    return;
  }

  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  if (!token) {
    showToast('Session expired. Please log in again.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Password change failed.', 'error');
      return;
    }

    document.getElementById('security-modal').style.display = 'none';
    document.getElementById('form-change-password').reset();
    showToast(data.message || 'Password changed successfully! Future logins will require your new password.', 'success');
  } catch (err) {
    showToast('Password change request failed.', 'error');
  }
}

async function handleForgotRequest() {
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) {
    showToast('Please enter your registered email address.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Recovery request failed.', 'error');
      return;
    }

    activeForgotResetToken = data.resetToken;
    document.getElementById('forgot-step-1').style.display = 'none';
    document.getElementById('forgot-step-2').style.display = 'block';
    document.getElementById('forgot-code-dev-hint').textContent = data.recoveryCode;
    document.getElementById('forgot-code-input').value = data.recoveryCode;

    showToast('Recovery code generated. Please set your new password.', 'info');
  } catch (e) {
    showToast('Network error while requesting recovery code.', 'error');
  }
}

async function handleForgotResetSubmit() {
  if (!activeForgotResetToken) return;
  const code = document.getElementById('forgot-code-input').value.trim();
  const newPassword = document.getElementById('forgot-new-password').value;
  const confirmPassword = document.getElementById('forgot-confirm-password').value;

  if (newPassword !== confirmPassword) {
    showToast('New passwords do not match.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resetToken: activeForgotResetToken,
        code,
        newPassword,
        confirmPassword
      })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Password reset failed.', 'error');
      return;
    }

    showToast(data.message || 'Password has been reset! Please sign in with your new password.', 'success');
    showAuthView('login');
  } catch (e) {
    showToast('Network error while resetting password.', 'error');
  }
}

// -----------------------------------------------------------------
// Redesigned 3-Section Navigation
// -----------------------------------------------------------------
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.add('active');

      if (targetId === 'tab-send') {
        if (currentSendMode === 'nearby') initNearbyEngine();
      } else if (targetId === 'tab-receive') {
        loadIncomingTransfers();
      } else if (targetId === 'tab-transferred') {
        loadTransferHistory();
      }
    });
  });
}

// -----------------------------------------------------------------
// Network Info & Host Connectivity
// -----------------------------------------------------------------
async function initNetworkInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    const networkBadge = document.getElementById('network-status-text');
    if (networkBadge) {
      networkBadge.textContent = `Online: ${data.networkUrl}`;
    }
    const localUrlEl = document.getElementById('nearby-local-url');
    if (localUrlEl) {
      localUrlEl.textContent = data.networkUrl;
    }
    const qrImg = document.getElementById('nearby-qr-image');
    if (qrImg) {
      if (data.qrDataUrl) {
        qrImg.src = data.qrDataUrl;
      } else {
        qrImg.src = `/api/qr?text=${encodeURIComponent(data.networkUrl)}&size=320`;
      }
    }
  } catch (err) {
    console.warn('Network info fetch error:', err);
  }
}

// -----------------------------------------------------------------
// Helper: File Categories & Icons
// -----------------------------------------------------------------
function getFileCategory(filename = '') {
  const ext = filename.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'archive';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md'].includes(ext)) return 'document';
  return 'file';
}

function getFileCategoryIcon(category) {
  switch (category) {
    case 'image':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    case 'video':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
    case 'audio':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    case 'archive':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
    case 'document':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
    default:
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>`;
  }
}

function formatDate(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// -----------------------------------------------------------------
// FEATURE 5: Send Mode Switching (Zero-Internet vs Remote Cloud)
// -----------------------------------------------------------------

window.switchSendMode = function(mode) {
  currentSendMode = mode;
  const btnNearby = document.getElementById('mode-btn-nearby');
  const btnRemote = document.getElementById('mode-btn-remote');
  const viewNearby = document.getElementById('view-send-nearby');
  const viewRemote = document.getElementById('view-send-remote');

  if (mode === 'nearby') {
    if (btnNearby) btnNearby.classList.add('active');
    if (btnRemote) btnRemote.classList.remove('active');
    if (viewNearby) viewNearby.style.display = 'block';
    if (viewRemote) viewRemote.style.display = 'none';
    initNearbyEngine();
  } else {
    if (btnNearby) btnNearby.classList.remove('active');
    if (btnRemote) btnRemote.classList.add('active');
    if (viewNearby) viewNearby.style.display = 'none';
    if (viewRemote) viewRemote.style.display = 'block';
  }
};

// -----------------------------------------------------------------
// FEATURE 3: True Zero-Internet Nearby P2P Engine UI Controller
// -----------------------------------------------------------------

function initNearbyEngine() {
  if (!nearbyEngine) {
    const devName = currentUser ? (currentUser.preferredDeviceName || `${currentUser.name || currentUser.username} (${currentUser.zenId})`) : `Device-${Math.floor(1000 + Math.random() * 9000)}`;

    nearbyEngine = new ZenNearby({
      deviceName: devName,
      onRegistered: (myClientId) => {
        // Dynamically update the QR code to encode the exact device-to-device pairing link
        const qrImg = document.getElementById('nearby-qr-image');
        const localUrlEl = document.getElementById('nearby-local-url');
        const hostUrl = (localUrlEl && localUrlEl.textContent && !localUrlEl.textContent.includes('Loading')) 
          ? localUrlEl.textContent 
          : window.location.origin;
        const pairUrl = `${hostUrl}/#send?mode=nearby&pair=${encodeURIComponent(myClientId)}`;
        if (qrImg) {
          qrImg.src = `/api/qr?text=${encodeURIComponent(pairUrl)}&size=320`;
        }
      },
      onDevicesUpdated: (devices) => {
        renderNearbyDevicesList(devices);
      },
      onPairingRequested: (device, callback) => {
        activePairingCallback = callback;
        const modal = document.getElementById('nearby-pair-modal');
        if (modal) {
          document.getElementById('pair-req-device-name').textContent = device.name;
          document.getElementById('pair-req-device-type').textContent = `${device.deviceType.toUpperCase()} • Direct Local Connection`;
          modal.style.display = 'flex';
        } else {
          callback(confirm(`Accept zero-internet pairing request from ${device.name}?`));
        }
      },
      onPaired: (peerName, peerId) => {
        showToast(`Paired with "${peerName}" via direct WebRTC DataChannel!`, 'success');
        const banner = document.getElementById('nearby-paired-banner');
        if (banner) {
          banner.style.display = 'flex';
          document.getElementById('paired-device-name').textContent = peerName;
          document.getElementById('paired-device-avatar').textContent = peerName.charAt(0).toUpperCase();
        }
      },
      onIncomingFileOffer: (fromName, meta, callback) => {
        activeFileOfferCallback = callback;
        const modal = document.getElementById('nearby-file-modal');
        if (modal) {
          document.getElementById('nearby-file-sender').textContent = fromName;
          document.getElementById('nearby-file-name').textContent = meta.name;
          document.getElementById('nearby-file-size').textContent = formatBytes(meta.size);
          modal.style.display = 'flex';
        } else {
          callback(confirm(`Incoming file: "${meta.name}" (${formatBytes(meta.size)}) from ${fromName}. Accept?`));
        }
      },
      onTransferProgress: (stats) => {
        const monitor = document.getElementById('nearby-transfer-monitor');
        if (monitor) {
          monitor.style.display = 'block';
          document.getElementById('nearby-monitor-filename').textContent = stats.fileName;
          document.getElementById('nearby-progress-fill').style.width = `${stats.percent}%`;
          document.getElementById('nearby-stat-pct').textContent = `${stats.percent}%`;
          document.getElementById('nearby-stat-speed').textContent = stats.speed;
          document.getElementById('nearby-stat-eta').textContent = stats.eta;
          document.getElementById('nearby-stat-hash').textContent = stats.sha256Status || 'SHA-256 Stream Active';
        }
      },
      onFileReceived: (fileName, fileSize, hash) => {
        showToast(`Transfer complete! "${fileName}" received & verified with SHA-256.`, 'success');
        const monitor = document.getElementById('nearby-transfer-monitor');
        if (monitor) {
          setTimeout(() => { monitor.style.display = 'none'; }, 2500);
        }
        loadTransferHistory();
      },
      onLog: (msg) => {
        console.log('[Nearby UI]', msg);
      }
    });

    // Wire nearby send file button
    const btnPickFile = document.getElementById('btn-nearby-pick-file');
    const nearbyFileInput = document.getElementById('nearby-file-input');
    const btnDisconnectPeer = document.getElementById('btn-disconnect-peer');
    const btnRefreshNearby = document.getElementById('btn-refresh-nearby');

    if (btnPickFile && nearbyFileInput) {
      btnPickFile.addEventListener('click', () => nearbyFileInput.click());
      nearbyFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          const file = e.target.files[0];
          showToast(`Proposing zero-internet transfer of "${file.name}" to peer...`, 'info');
          nearbyEngine.sendP2PFile(file);
        }
      });
    }

    if (btnDisconnectPeer) {
      btnDisconnectPeer.addEventListener('click', () => {
        if (nearbyEngine.peerConnection) {
          try { nearbyEngine.peerConnection.close(); } catch (e) {}
        }
        nearbyEngine.activePeerId = null;
        document.getElementById('nearby-paired-banner').style.display = 'none';
        showToast('Peer disconnected.', 'info');
      });
    }

    if (btnRefreshNearby) {
      btnRefreshNearby.addEventListener('click', () => {
        if (nearbyEngine.ws && nearbyEngine.ws.readyState === WebSocket.OPEN) {
          nearbyEngine.ws.send(JSON.stringify({ type: 'get-nearby-devices' }));
        }
        showToast('Scanning for nearby devices on local network...', 'info');
      });
    }
  }
}

function renderNearbyDevicesList(devices) {
  const container = document.getElementById('nearby-devices-container');
  const countLabel = document.getElementById('nearby-count-label');
  if (countLabel) countLabel.textContent = devices.length;

  if (!container) return;

  if (devices.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-secondary);">
        <div style="margin-bottom: 0.75rem; color: var(--text-muted);">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
        </div>
        <div style="font-weight: 600; color: var(--text-main); font-size: 0.95rem;">Looking for nearby devices...</div>
        <p style="font-size: 0.8rem; margin-top: 0.35rem; max-width: 340px; margin-left: auto; margin-right: auto;">
          Open ShareBoxZen on any phone or laptop connected to the same Wi-Fi or mobile hotspot. Devices will appear here automatically.
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  devices.forEach(dev => {
    const isPaired = nearbyEngine && nearbyEngine.activePeerId === dev.id;
    const isMobile = dev.deviceType === 'mobile';
    const row = document.createElement('div');
    row.className = 'nearby-device-row';

    const iconSvg = isMobile
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;

    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.85rem;">
        <div style="width: 38px; height: 38px; border-radius: 50%; background-color: var(--bg-card); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--accent-primary);">
          ${iconSvg}
        </div>
        <div>
          <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">${escapeHTML(dev.name)}</div>
          <div style="font-size: 0.76rem; color: var(--text-secondary); margin-top: 2px;">
            ${escapeHTML(dev.deviceType.toUpperCase())} • ${isPaired ? '<span style="color:var(--state-success); font-weight:600;">Directly Paired</span>' : 'Available for Zero-Internet Transfer'}
          </div>
        </div>
      </div>
      <div>
        ${isPaired 
          ? `<button type="button" class="btn btn-sm" onclick="document.getElementById('btn-nearby-pick-file').click();">Send File</button>`
          : `<button type="button" class="btn btn-secondary btn-sm" onclick="nearbyEngine.requestPairing('${dev.id}')">Pair Device</button>`
        }
      </div>
    `;

    container.appendChild(row);
  });
}

// -----------------------------------------------------------------
// Remote Share Files Queue & Handling
// -----------------------------------------------------------------
let selectedFilesQueue = [];
let recipientMode = 'link'; // 'link' or 'user'
let selectedRecipient = null; // { id, name, username, zenId, email }
let isSendingQueue = false;

function initSendFiles() {
  const dropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  const btnBrowseFiles = document.getElementById('btn-browse-files');
  const btnBrowseFolder = document.getElementById('btn-browse-folder');
  const btnClearQueue = document.getElementById('btn-clear-queue');
  const modeCardLink = document.getElementById('mode-card-link');
  const modeCardUser = document.getElementById('mode-card-user');
  const userRecipientBox = document.getElementById('user-recipient-box');
  const recipientInput = document.getElementById('recipient-search-input');
  const recipientDropdown = document.getElementById('recipient-dropdown-results');
  const btnClearRecipient = document.getElementById('btn-clear-recipient');
  const accordionToggle = document.getElementById('accordion-toggle');
  const securityAccordion = document.getElementById('security-accordion');
  const btnStartSend = document.getElementById('btn-start-send');
  const btnCleanPause = document.getElementById('btn-clean-pause');
  const btnCopyCompleteLink = document.getElementById('btn-copy-complete-link');
  const btnSendMore = document.getElementById('btn-send-more');

  // Browse file / folder triggers
  if (dropzone) {
    dropzone.addEventListener('click', (e) => {
      if (e.target !== btnBrowseFolder) fileInput.click();
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        addFilesToQueue(Array.from(e.dataTransfer.files));
      }
    });
  }

  if (btnBrowseFiles) {
    btnBrowseFiles.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  if (btnBrowseFolder) {
    btnBrowseFolder.addEventListener('click', (e) => {
      e.stopPropagation();
      folderInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addFilesToQueue(Array.from(e.target.files));
      }
    });
  }

  if (folderInput) {
    folderInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addFilesToQueue(Array.from(e.target.files));
      }
    });
  }

  if (btnClearQueue) {
    btnClearQueue.addEventListener('click', () => {
      selectedFilesQueue = [];
      renderSelectedFilesQueue();
      showToast('Queue cleared', 'info');
    });
  }

  // Recipient mode selection
  if (modeCardLink && modeCardUser) {
    modeCardLink.addEventListener('click', () => {
      recipientMode = 'link';
      modeCardLink.classList.add('active');
      modeCardUser.classList.remove('active');
      if (userRecipientBox) userRecipientBox.style.display = 'none';
    });

    modeCardUser.addEventListener('click', () => {
      recipientMode = 'user';
      modeCardUser.classList.add('active');
      modeCardLink.classList.remove('active');
      if (userRecipientBox) userRecipientBox.style.display = 'block';
      if (recipientInput) recipientInput.focus();
    });
  }

  // Recipient search autocomplete
  if (recipientInput && recipientDropdown) {
    recipientInput.addEventListener('input', debounce(async (e) => {
      const q = e.target.value.trim();
      if (!q) {
        recipientDropdown.style.display = 'none';
        return;
      }
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.users && data.users.length > 0) {
          recipientDropdown.innerHTML = '';
          data.users.forEach(u => {
            const item = document.createElement('div');
            item.style.padding = '0.6rem 0.85rem';
            item.style.cursor = 'pointer';
            item.style.borderBottom = '1px solid var(--border-color)';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.innerHTML = `
              <div>
                <strong style="color:var(--text-main); font-size:0.85rem;">${escapeHTML(u.name)}</strong>
                <span style="color:var(--text-secondary); font-size:0.78rem;"> (@${escapeHTML(u.username)})</span>
              </div>
              <span style="font-size:0.75rem; font-family:var(--font-mono); color:var(--accent-primary);">${escapeHTML(u.zenId)}</span>
            `;
            item.addEventListener('click', () => {
              selectedRecipient = u;
              recipientDropdown.style.display = 'none';
              recipientInput.value = '';
              renderSelectedRecipientPill();
            });
            recipientDropdown.appendChild(item);
          });
          recipientDropdown.style.display = 'block';
        } else {
          recipientDropdown.style.display = 'none';
        }
      } catch (err) {
        console.warn('Recipient search failed:', err);
      }
    }, 250));
  }

  if (btnClearRecipient) {
    btnClearRecipient.addEventListener('click', () => {
      selectedRecipient = null;
      renderSelectedRecipientPill();
    });
  }

  // Collapsible Accordion
  if (accordionToggle && securityAccordion) {
    accordionToggle.addEventListener('click', () => {
      securityAccordion.classList.toggle('open');
    });
  }

  // Password Protection Toggle & Autofill Prevention
  const chkPasswordEnable = document.getElementById('send-password-enable');
  const passwordWrapper = document.getElementById('send-password-wrapper');
  const passwordInput = document.getElementById('send-password');
  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.setAttribute('readonly', 'true');
  }
  if (chkPasswordEnable && passwordWrapper) {
    chkPasswordEnable.checked = false;
    chkPasswordEnable.addEventListener('change', () => {
      if (chkPasswordEnable.checked) {
        passwordWrapper.style.display = 'block';
        if (passwordInput) {
          passwordInput.removeAttribute('readonly');
          passwordInput.focus();
        }
      } else {
        passwordWrapper.style.display = 'none';
        if (passwordInput) {
          passwordInput.value = '';
          passwordInput.setAttribute('readonly', 'true');
        }
      }
    });
  }

  // Send action
  if (btnStartSend) {
    btnStartSend.addEventListener('click', startSendFilesQueue);
  }

  // Pause / Resume during send
  if (btnCleanPause) {
    btnCleanPause.addEventListener('click', () => {
      if (!currentChunker) return;
      if (currentChunker.state === 'UPLOADING') {
        currentChunker.pause('User paused upload');
        btnCleanPause.textContent = 'Resume';
      } else if (currentChunker.state === 'PAUSED') {
        currentChunker.resume();
        btnCleanPause.textContent = 'Pause';
      }
    });
  }

  // Copy complete link
  if (btnCopyCompleteLink) {
    btnCopyCompleteLink.addEventListener('click', () => {
      const input = document.getElementById('complete-share-link');
      if (input && input.value) {
        navigator.clipboard.writeText(input.value);
        showToast('Share link copied to clipboard!', 'success');
      }
    });
  }

  // Send more files
  if (btnSendMore) {
    btnSendMore.addEventListener('click', () => {
      selectedFilesQueue = [];
      renderSelectedFilesQueue();
      document.getElementById('transfer-complete-card').style.display = 'none';
      document.getElementById('file-dropzone').style.display = 'block';
      document.getElementById('btn-start-send').style.display = 'flex';
      btnStartSend.disabled = true;
      if (passwordInput) passwordInput.value = '';
      if (chkPasswordEnable) chkPasswordEnable.checked = false;
      if (passwordWrapper) passwordWrapper.style.display = 'none';
    });
  }
}

function addFilesToQueue(files) {
  files.forEach(f => {
    if (!selectedFilesQueue.some(item => item.name === f.name && item.size === f.size)) {
      selectedFilesQueue.push(f);
    }
  });
  renderSelectedFilesQueue();
}

function removeFileFromQueue(index) {
  selectedFilesQueue.splice(index, 1);
  renderSelectedFilesQueue();
}

function renderSelectedFilesQueue() {
  const queueSection = document.getElementById('selected-queue-section');
  const countLabel = document.getElementById('queue-count-label');
  const totalSizeEl = document.getElementById('queue-total-size');
  const listEl = document.getElementById('selected-files-list');
  const btnStartSend = document.getElementById('btn-start-send');

  if (selectedFilesQueue.length === 0) {
    if (queueSection) queueSection.style.display = 'none';
    if (btnStartSend) btnStartSend.disabled = true;
    return;
  }

  if (queueSection) queueSection.style.display = 'block';
  if (countLabel) countLabel.textContent = `${selectedFilesQueue.length} File${selectedFilesQueue.length > 1 ? 's' : ''} Selected`;

  const totalBytes = selectedFilesQueue.reduce((acc, f) => acc + f.size, 0);
  if (totalSizeEl) totalSizeEl.textContent = `${formatBytes(totalBytes)} total`;

  if (listEl) {
    listEl.innerHTML = '';
    selectedFilesQueue.forEach((f, idx) => {
      const cat = getFileCategory(f.name);
      const icon = getFileCategoryIcon(cat);
      const item = document.createElement('div');
      item.className = 'selected-file-row';
      item.innerHTML = `
        <div class="selected-file-left">
          <div class="file-type-icon">${icon}</div>
          <div class="selected-file-info">
            <div class="selected-file-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</div>
            <div class="selected-file-meta">${formatBytes(f.size)} • ${cat.toUpperCase()}</div>
          </div>
        </div>
        <button type="button" class="btn-remove-queue-item" title="Remove" onclick="removeFileFromQueue(${idx})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
      listEl.appendChild(item);
    });
  }

  if (btnStartSend) btnStartSend.disabled = false;
}

function renderSelectedRecipientPill() {
  const pill = document.getElementById('selected-recipient-pill');
  const nameEl = document.getElementById('pill-recipient-name');
  const idEl = document.getElementById('pill-recipient-id');
  const input = document.getElementById('recipient-search-input');

  if (selectedRecipient) {
    pill.style.display = 'inline-flex';
    nameEl.textContent = selectedRecipient.name || selectedRecipient.username;
    idEl.textContent = `@${selectedRecipient.username} (${selectedRecipient.zenId})`;
    if (input) input.style.display = 'none';
  } else {
    pill.style.display = 'none';
    if (input) {
      input.style.display = 'block';
      input.value = '';
    }
  }
}

async function startSendFilesQueue() {
  if (isSendingQueue) return;
  if (selectedFilesQueue.length === 0) {
    showToast('Please select at least one file to send.', 'error');
    return;
  }

  if (recipientMode === 'user' && !selectedRecipient) {
    showToast('Please search and select a registered recipient first.', 'error');
    const input = document.getElementById('recipient-search-input');
    if (input) input.focus();
    return;
  }

  const passwordEnabled = document.getElementById('send-password-enable')?.checked;
  const password = passwordEnabled ? (document.getElementById('send-password')?.value.trim() || null) : null;
  const expiresIn = document.getElementById('send-expiry')?.value || '24h';
  const maxDownloads = parseInt(document.getElementById('send-max-downloads')?.value || '0', 10);

  const dropzone = document.getElementById('file-dropzone');
  const queueSection = document.getElementById('selected-queue-section');
  const monitor = document.getElementById('clean-transfer-monitor');
  const completeCard = document.getElementById('transfer-complete-card');
  const btnStartSend = document.getElementById('btn-start-send');

  if (dropzone) dropzone.style.display = 'none';
  if (queueSection) queueSection.style.display = 'none';
  if (btnStartSend) btnStartSend.style.display = 'none';
  if (completeCard) completeCard.style.display = 'none';
  if (monitor) monitor.style.display = 'block';

  isSendingQueue = true;
  let lastTransferResult = null;

  for (let i = 0; i < selectedFilesQueue.length; i++) {
    const file = selectedFilesQueue[i];
    const prefix = selectedFilesQueue.length > 1 ? `[${i + 1}/${selectedFilesQueue.length}] ` : '';
    document.getElementById('clean-monitor-filename').textContent = `${prefix}${file.name}`;
    document.getElementById('clean-progress-fill').style.width = '0%';
    document.getElementById('clean-stat-pct').textContent = '0%';
    document.getElementById('clean-stat-speed').textContent = '0 KB/s';
    document.getElementById('clean-stat-eta').textContent = 'Estimating...';

    try {
      const recipientId = selectedRecipient ? (selectedRecipient.id || selectedRecipient.username) : null;
      await new Promise((resolve, reject) => {
        currentChunker = new ZenChunker({
          concurrency: 6,
          onProgress: (metrics) => {
            const fill = document.getElementById('clean-progress-fill');
            const pct = document.getElementById('clean-stat-pct');
            const speed = document.getElementById('clean-stat-speed');
            const eta = document.getElementById('clean-stat-eta');
            if (fill) fill.style.width = `${metrics.percentage}%`;
            if (pct) pct.textContent = `${metrics.percentage}%`;
            if (speed) speed.textContent = metrics.speedFormatted;
            if (eta) eta.textContent = metrics.etaFormatted;
          },
          onStateChange: (state) => {
            const badge = document.getElementById('clean-transfer-badge');
            if (badge) {
              badge.textContent = state;
              badge.className = 'history-status-badge ' + (state === 'UPLOADING' ? 'pending' : (state === 'PAUSED' ? 'cancelled' : 'completed'));
            }
          },
          onComplete: (res) => {
            lastTransferResult = res;
            resolve(res);
          },
          onError: (err) => {
            showToast(`Transfer failed for ${file.name}: ${err}`, 'error');
            reject(new Error(err));
          }
        });

        currentChunker.initiate(file, {
          senderId: currentUser ? currentUser.id : 'anonymous',
          recipientId,
          isPublic: recipientMode === 'link',
          password,
          expiresIn,
          maxDownloads
        }).catch(err => {
          showToast(`Upload error for "${file.name}": ${err.message}`, 'error');
          reject(err);
        });
      });
    } catch (err) {
      console.error('File queue transfer error:', err);
      break;
    }
  }

  isSendingQueue = false;
  if (monitor) monitor.style.display = 'none';

  if (lastTransferResult) {
    if (completeCard) completeCard.style.display = 'block';

    const localUrlEl = document.getElementById('nearby-local-url');
    const detectedHost = (localUrlEl && localUrlEl.textContent && !localUrlEl.textContent.includes('Loading'))
      ? localUrlEl.textContent.trim().replace(/\/+$/, '')
      : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
          ? (typeof DEFAULT_ZEN_SERVER !== 'undefined' ? DEFAULT_ZEN_SERVER : window.location.origin)
          : window.location.origin);

    const shareUrl = `${detectedHost}/d/${lastTransferResult.transferId}`;
    
    const shareInput = document.getElementById('complete-share-link');
    if (shareInput) shareInput.value = shareUrl;

    const qrImg = document.getElementById('complete-qr-img');
    if (qrImg) {
      qrImg.src = `${detectedHost}/api/qr/transfer/${lastTransferResult.transferId}?t=${Date.now()}`;
    }

    showToast(
      recipientMode === 'user'
        ? `Delivered ${selectedFilesQueue.length} file(s) to ${selectedRecipient.name || selectedRecipient.username}!`
        : `Transfer complete! Share link & unique QR generated.`,
      'success'
    );

    loadTransferHistory();
  } else {
    if (dropzone) dropzone.style.display = 'block';
    if (queueSection) queueSection.style.display = 'block';
    if (btnStartSend) btnStartSend.style.display = 'flex';
  }
}

// -----------------------------------------------------------------
// SECTION 2: Receive Files Controller
// -----------------------------------------------------------------
function initReceiveTab() {
  const btnLookup = document.getElementById('btn-lookup-transfer');
  const inputLookup = document.getElementById('receive-transfer-id');
  const btnRefreshIncoming = document.getElementById('btn-refresh-incoming');

  if (btnLookup && inputLookup) {
    btnLookup.addEventListener('click', () => {
      const input = inputLookup.value.trim();
      if (!input) {
        showToast('Please enter a Transfer ID, Share Token or Link.', 'error');
        return;
      }
      lookupReceiveTransfer(input);
    });

    inputLookup.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') btnLookup.click();
    });
  }

  if (btnRefreshIncoming) {
    btnRefreshIncoming.addEventListener('click', () => {
      loadIncomingTransfers();
      showToast('Checked for incoming transfers.', 'info');
    });
  }

  // Check URL hash on initial load
  const hash = window.location.hash;
  if (hash.startsWith('#receive')) {
    const params = new URLSearchParams(hash.replace('#receive?', ''));
    const id = params.get('id');
    if (id) {
      document.querySelector('.tab-btn[data-tab="tab-receive"]')?.click();
      if (inputLookup) inputLookup.value = id;
      lookupReceiveTransfer(id);
    }
  }
}

async function lookupReceiveTransfer(input) {
  let transferId = input;
  let token = null;

  if (input.includes('/#receive?id=')) {
    transferId = input.split('id=')[1];
  } else if (input.includes('/api/share/') || input.includes('/share/')) {
    const parts = input.split('/share/');
    token = parts[1].split('?')[0];
  }

  const detailsCard = document.getElementById('receive-details-card');
  const passContainer = document.getElementById('receive-password-container');

  try {
    let transfer = null;
    if (token) {
      const pass = document.getElementById('receive-password')?.value.trim();
      const url = `/api/share/${token}` + (pass ? `?password=${encodeURIComponent(pass)}` : '');
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401 && data.passwordRequired) {
          if (passContainer) passContainer.style.display = 'block';
          showToast('This file is password-protected. Please enter password and retry.', 'info');
          return;
        }
        showToast(data.error || 'Share link is invalid, expired, or revoked.', 'error');
        return;
      }
      transfer = data;
      transferId = data.transferId;
    } else {
      const res = await fetch(`/api/transfer/${transferId}/status`);
      if (!res.ok) {
        showToast('Transfer record not found or incomplete.', 'error');
        return;
      }
      transfer = await res.json();
    }

    if (transfer && detailsCard) {
      detailsCard.style.display = 'block';
      document.getElementById('rec-filename').textContent = transfer.fileName;
      document.getElementById('rec-filesize').textContent = formatBytes(transfer.fileSize);
      document.getElementById('rec-status').textContent = transfer.status || 'Ready';

      const downloadBtn = document.getElementById('btn-download-file');
      downloadBtn.onclick = () => {
        executeFileDownload(transferId);
      };
    }
  } catch (err) {
    showToast('Failed to lookup transfer.', 'error');
  }
}

async function loadIncomingTransfers() {
  const container = document.getElementById('incoming-files-container');
  const badge = document.getElementById('incoming-count-badge');
  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');

  if (!token || !currentUser) {
    if (badge) badge.style.display = 'none';
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/></svg>
          </div>
          <h3>Sign in to view incoming transfers</h3>
          <p>Files sent directly to your ZenID or username will appear here once authenticated.</p>
        </div>
      `;
    }
    return;
  }

  try {
    const res = await fetch('/api/transfers/incoming', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const list = data.incoming || [];

    if (badge) {
      if (list.length > 0) {
        badge.textContent = list.length;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 15 16 10 5 21"/><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/></svg>
          </div>
          <h3>No incoming files yet</h3>
          <p>When another user sends files directly to your ZenID or username, they'll appear here for you to accept or reject.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    list.forEach(item => {
      const cat = getFileCategory(item.fileName);
      const icon = getFileCategoryIcon(cat);
      const card = document.createElement('div');
      card.className = 'incoming-card';
      const senderName = item.senderInfo ? (item.senderInfo.name || item.senderInfo.username) : 'Anonymous Sender';
      const senderSub = item.senderInfo ? `@${item.senderInfo.username} (${item.senderInfo.zenId})` : item.senderId;

      card.innerHTML = `
        <div class="history-left">
          <div class="file-type-icon">${icon}</div>
          <div class="history-meta">
            <div class="history-title" title="${escapeHTML(item.fileName)}">${escapeHTML(item.fileName)}</div>
            <div class="history-desc">
              <span>From: <strong>${escapeHTML(senderName)}</strong> <span style="font-size:0.72rem; color:var(--text-muted);">${escapeHTML(senderSub)}</span></span>
              <span>• ${formatBytes(item.fileSize)}</span>
              <span>• ${formatDate(item.createdAt)}</span>
            </div>
          </div>
        </div>
        <div class="history-actions">
          <button type="button" class="btn btn-secondary btn-sm" onclick="handleRejectIncoming('${item.id}')">Reject</button>
          <button type="button" class="btn btn-sm" onclick="handleAcceptIncoming('${item.id}')">Accept &amp; Download</button>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.warn('Failed to load incoming transfers:', err);
  }
}

async function handleAcceptIncoming(id) {
  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  try {
    const res = await fetch(`/api/transfers/${id}/accept`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      showToast('Transfer accepted! Starting download...', 'success');
      executeFileDownload(id);
      loadIncomingTransfers();
      loadTransferHistory();
    } else {
      showToast('Failed to accept transfer.', 'error');
    }
  } catch (err) {
    showToast('Network error accepting transfer.', 'error');
  }
}

async function handleRejectIncoming(id) {
  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  try {
    const res = await fetch(`/api/transfers/${id}/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      showToast('Transfer request declined.', 'info');
      loadIncomingTransfers();
    } else {
      showToast('Failed to reject transfer.', 'error');
    }
  } catch (err) {
    showToast('Network error rejecting transfer.', 'error');
  }
}

// -----------------------------------------------------------------
// SECTION 3: Transferred Files History & Modals
// -----------------------------------------------------------------
let currentHistorySubtab = 'sent';
let historyData = { sent: [], received: [] };

function initTransferredFiles() {
  const subtabs = document.querySelectorAll('.history-subtab-btn');
  subtabs.forEach(btn => {
    btn.addEventListener('click', () => {
      subtabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentHistorySubtab = btn.getAttribute('data-subtab');
      renderTransferHistoryCards();
    });
  });

  const searchInput = document.getElementById('history-search');
  const filterDate = document.getElementById('history-filter-date');
  const filterStatus = document.getElementById('history-filter-status');
  const filterType = document.getElementById('history-filter-type');
  const sortSelect = document.getElementById('history-sort');

  if (searchInput) searchInput.addEventListener('input', debounce(renderTransferHistoryCards, 200));
  if (filterDate) filterDate.addEventListener('change', renderTransferHistoryCards);
  if (filterStatus) filterStatus.addEventListener('change', renderTransferHistoryCards);
  if (filterType) filterType.addEventListener('change', renderTransferHistoryCards);
  if (sortSelect) sortSelect.addEventListener('change', renderTransferHistoryCards);
}

async function loadTransferHistory() {
  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  if (!token || !currentUser) {
    historyData = { sent: [], received: [] };
    renderTransferHistoryCards();
    return;
  }

  try {
    const res = await fetch('/api/transfers/history', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    historyData = {
      sent: data.sent || [],
      received: data.received || []
    };

    const sentCountEl = document.getElementById('history-sent-count');
    const recCountEl = document.getElementById('history-received-count');
    if (sentCountEl) sentCountEl.textContent = historyData.sent.length;
    if (recCountEl) recCountEl.textContent = historyData.received.length;

    renderTransferHistoryCards();
  } catch (err) {
    console.warn('Failed to load history:', err);
  }
}

function renderTransferHistoryCards() {
  const container = document.getElementById('history-items-container');
  if (!container) return;

  let items = [...(historyData[currentHistorySubtab] || [])];

  const search = document.getElementById('history-search')?.value.toLowerCase().trim() || '';
  const dateFilter = document.getElementById('history-filter-date')?.value || 'all';
  const statusFilter = document.getElementById('history-filter-status')?.value || 'all';
  const typeFilter = document.getElementById('history-filter-type')?.value || 'all';
  const sortOrder = document.getElementById('history-sort')?.value || 'newest';

  if (search) {
    items = items.filter(i => (i.fileName || '').toLowerCase().includes(search));
  }

  if (statusFilter !== 'all') {
    items = items.filter(i => (i.status || '').toUpperCase() === statusFilter);
  }

  if (typeFilter !== 'all') {
    items = items.filter(i => getFileCategory(i.fileName) === typeFilter);
  }

  const now = Date.now();
  if (dateFilter === 'today') {
    items = items.filter(i => (now - new Date(i.createdAt).getTime()) <= 24 * 60 * 60 * 1000);
  } else if (dateFilter === '7d') {
    items = items.filter(i => (now - new Date(i.createdAt).getTime()) <= 7 * 24 * 60 * 60 * 1000);
  } else if (dateFilter === '30d') {
    items = items.filter(i => (now - new Date(i.createdAt).getTime()) <= 30 * 24 * 60 * 60 * 1000);
  }

  items.sort((a, b) => {
    if (sortOrder === 'newest') return new Date(b.createdAt) - new Date(a.createdAt);
    if (sortOrder === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
    if (sortOrder === 'size-desc') return (b.fileSize || 0) - (a.fileSize || 0);
    if (sortOrder === 'size-asc') return (a.fileSize || 0) - (b.fileSize || 0);
    return 0;
  });

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        </div>
        <h3>No transfer records found</h3>
        <p>No transfers match your current filter criteria.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  items.forEach(item => {
    const cat = getFileCategory(item.fileName);
    const icon = getFileCategoryIcon(cat);
    const card = document.createElement('div');
    card.className = 'history-card';

    let otherParty = '';
    if (currentHistorySubtab === 'sent') {
      if (item.recipientInfo) {
        otherParty = `To: <strong>${escapeHTML(item.recipientInfo.name || item.recipientInfo.username)}</strong>`;
      } else if (item.isPublic || item.shareToken) {
        otherParty = `<span class="history-badge-public">Public Share Link</span>`;
      } else {
        otherParty = `To: Direct Transfer`;
      }
    } else {
      if (item.senderInfo) {
        otherParty = `From: <strong>${escapeHTML(item.senderInfo.name || item.senderInfo.username)}</strong>`;
      } else {
        otherParty = `From: Direct Transfer`;
      }
    }

    const isRevoked = item.isRevoked;
    let statusClass = 'pending';
    let statusText = item.status;
    if (isRevoked) {
      statusClass = 'revoked';
      statusText = 'REVOKED';
    } else if (item.status === 'COMPLETED') {
      statusClass = 'completed';
      statusText = 'COMPLETED';
    } else if (item.status === 'CANCELLED') {
      statusClass = 'cancelled';
      statusText = 'CANCELLED';
    }

    let actionButtons = `
      <button type="button" class="btn btn-secondary btn-sm" onclick="showTransferDetails('${item.id}')" title="View details & SHA-256">Details</button>
    `;

    if (item.fileAvailable && item.status === 'COMPLETED' && !isRevoked) {
      actionButtons += `
        <button type="button" class="btn btn-sm" onclick="downloadTransferFile('${item.id}')" title="Download file again">Download</button>
      `;
    }

    if (item.shareToken && !isRevoked) {
      actionButtons += `
        <button type="button" class="btn btn-secondary btn-sm" onclick="copyTransferLink('${item.shareToken}', '${item.id}')" title="Copy shareable link">Copy Link</button>
      `;
      if (currentHistorySubtab === 'sent') {
        actionButtons += `
          <button type="button" class="btn btn-secondary btn-sm" onclick="promptRevokeLink('${item.id}')" title="Revoke access link">Revoke</button>
        `;
      }
    }

    actionButtons += `
      <button type="button" class="btn btn-danger btn-sm" onclick="promptDeleteTransfer('${item.id}', ${currentHistorySubtab === 'sent'})" title="Delete record or file">Delete</button>
    `;

    card.innerHTML = `
      <div class="history-left">
        <div class="file-type-icon">${icon}</div>
        <div class="history-meta">
          <div class="history-title" title="${escapeHTML(item.fileName)}">${escapeHTML(item.fileName)}</div>
          <div class="history-desc">
            <span>${otherParty}</span>
            <span>• ${formatBytes(item.fileSize)}</span>
            <span>• ${formatDate(item.createdAt)}</span>
            <span class="history-status-badge ${statusClass}">${statusText}</span>
          </div>
        </div>
      </div>
      <div class="history-actions">
        ${actionButtons}
      </div>
    `;

    container.appendChild(card);
  });
}

async function executeFileDownload(id, password = null) {
  try {
    showToast('Preparing download & checking integrity...', 'info');

    // 1. Fetch transfer metadata
    const metaRes = await fetch(`/api/transfer/${id}/status`);
    if (!metaRes.ok) {
      showToast('Transfer record not found or expired.', 'error');
      return;
    }
    const transfer = await metaRes.json();
    const fileName = transfer.fileName || 'downloaded_file';

    // 2. Obtain download ticket via POST body if password is required (keeps passwords out of URLs)
    let ticket = null;
    if (transfer.hasPassword) {
      const pwd = password || document.getElementById('receive-password')?.value.trim();
      if (!pwd) {
        showToast('Password is required to download this file.', 'error');
        return;
      }
      const authRes = await fetch(`/api/transfer/${id}/authorize-download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const authData = await authRes.json();
      if (!authRes.ok) {
        showToast(authData.error || 'Password rejected.', 'error');
        return;
      }
      ticket = authData.ticket;
    }

    // 3. Fetch file payload securely
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const downloadUrl = ticket ? `/api/transfer/${id}/download?ticket=${encodeURIComponent(ticket)}` : `/api/transfer/${id}/download`;

    const fileRes = await fetch(downloadUrl, { headers });
    if (!fileRes.ok) {
      showToast('Download request failed.', 'error');
      return;
    }

    let fileBlob = await fileRes.blob();

    // 4. Client-side E2EE Decryption (if file was encrypted on sender's device)
    if (transfer.isEncrypted) {
      showToast('Decrypting file with AES-GCM-256 on device...', 'info');
      let keyHex = null;
      if (window.location.hash.includes('key=')) {
        keyHex = window.location.hash.split('key=')[1].split('&')[0];
      }
      if (!keyHex) {
        keyHex = prompt('Enter the 256-bit encryption key or transfer password for this file:');
      }

      if (keyHex) {
        try {
          const cryptoKey = await ZenChunker.importKey(keyHex.trim());
          const cipherBuf = await fileBlob.arrayBuffer();
          const plainBuf = await ZenChunker.decryptBuffer(cipherBuf, cryptoKey);
          fileBlob = new Blob([plainBuf], { type: transfer.fileType || 'application/octet-stream' });
          showToast('✓ Client-side decryption successful!', 'success');
        } catch (decErr) {
          showToast('Decryption failed: Incorrect key or corrupted ciphertext.', 'error');
          return;
        }
      }
    }

    // 5. Save to Android My Files / Albums (or trigger browser download)
    const mimeType = transfer.fileType || fileBlob.type || 'application/octet-stream';
    if (window.ShareBoxAndroid && typeof window.ShareBoxAndroid.saveFileToDevice === 'function') {
      const reader = new FileReader();
      reader.onloadend = () => {
        try {
          const base64 = reader.result.split(',')[1];
          window.ShareBoxAndroid.saveFileToDevice(base64, fileName, mimeType);
        } catch (saveErr) {
          console.error('Android native save error:', saveErr);
        }
      };
      reader.readAsDataURL(fileBlob);
    } else {
      const url = URL.createObjectURL(fileBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('✓ Download complete: ' + fileName, 'success');
    }
  } catch (err) {
    showToast('Download failed: ' + err.message, 'error');
  }
}

function downloadTransferFile(id) {
  executeFileDownload(id);
}

function copyTransferLink(token, id) {
  const url = token ? `${window.location.origin}/api/share/${token}` : `${window.location.origin}/#receive?id=${id}`;
  navigator.clipboard.writeText(url);
  showToast('Link copied to clipboard!', 'success');
}

function showTransferDetails(id) {
  const allTransfers = [...(historyData.sent || []), ...(historyData.received || [])];
  const item = allTransfers.find(t => t.id === id);
  if (!item) return;

  const modal = document.getElementById('file-details-modal');
  if (!modal) return;

  const cat = getFileCategory(item.fileName);
  const icon = getFileCategoryIcon(cat);

  document.getElementById('details-modal-icon').innerHTML = icon;
  document.getElementById('details-modal-filename').textContent = item.fileName;
  document.getElementById('details-modal-filesize').textContent = formatBytes(item.fileSize);
  document.getElementById('details-modal-type').textContent = cat.toUpperCase();

  const statusEl = document.getElementById('details-modal-status');
  statusEl.textContent = item.isRevoked ? 'REVOKED' : item.status;
  statusEl.className = 'history-status-badge ' + (item.isRevoked ? 'revoked' : (item.status === 'COMPLETED' ? 'completed' : 'pending'));

  const senderName = item.senderInfo ? `${item.senderInfo.name || item.senderInfo.username} (@${item.senderInfo.username})` : (item.senderId || 'Anonymous');
  const recipientName = item.recipientInfo ? `${item.recipientInfo.name || item.recipientInfo.username} (@${item.recipientInfo.username})` : (item.recipientId ? item.recipientId : 'Public Share Link');

  document.getElementById('details-modal-sender').textContent = senderName;
  document.getElementById('details-modal-recipient').textContent = recipientName;
  document.getElementById('details-modal-created').textContent = formatDate(item.createdAt);
  document.getElementById('details-modal-completed').textContent = item.completedAt ? formatDate(item.completedAt) : '--';
  document.getElementById('details-modal-id').textContent = item.id;
  document.getElementById('details-modal-hash').textContent = item.calculatedHash || item.fileHash || 'Verified SHA-256';
  
  const storageEl = document.getElementById('details-modal-storage');
  if (item.fileAvailable) {
    storageEl.textContent = 'Active on Storage';
    storageEl.style.color = 'var(--state-success)';
  } else {
    storageEl.textContent = 'Deleted from Storage';
    storageEl.style.color = 'var(--text-muted)';
  }

  const dlBtn = document.getElementById('btn-details-download');
  if (item.fileAvailable && item.status === 'COMPLETED' && !item.isRevoked) {
    dlBtn.style.display = 'inline-block';
    dlBtn.onclick = () => downloadTransferFile(item.id);
  } else {
    dlBtn.style.display = 'none';
  }

  modal.style.display = 'flex';
}

function initModals() {
  const detailsModal = document.getElementById('file-details-modal');
  const btnCloseDetails = document.getElementById('btn-close-details');
  const btnDetailsCloseBottom = document.getElementById('btn-details-close-bottom');

  if (btnCloseDetails) btnCloseDetails.addEventListener('click', () => detailsModal.style.display = 'none');
  if (btnDetailsCloseBottom) btnDetailsCloseBottom.addEventListener('click', () => detailsModal.style.display = 'none');

  if (detailsModal) {
    detailsModal.addEventListener('click', (e) => {
      if (e.target === detailsModal) detailsModal.style.display = 'none';
    });
  }

  const confirmModal = document.getElementById('confirm-action-modal');
  if (confirmModal) {
    confirmModal.addEventListener('click', (e) => {
      if (e.target === confirmModal) confirmModal.style.display = 'none';
    });
  }
}

// Confirmation helper returns Promise<{ confirmed, deletePhysical }>
function showConfirmDialog({ title, message, showDeletePhysical = false }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-action-modal');
    const titleEl = document.getElementById('confirm-modal-title');
    const messageEl = document.getElementById('confirm-modal-message');
    const optionsBox = document.getElementById('confirm-delete-options');
    const checkboxPhysical = document.getElementById('checkbox-delete-physical');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    const btnProceed = document.getElementById('btn-confirm-proceed');

    if (!modal) {
      resolve({ confirmed: window.confirm(message), deletePhysical: false });
      return;
    }

    titleEl.textContent = title || 'Confirm Action';
    messageEl.textContent = message || 'Are you sure?';
    if (optionsBox) optionsBox.style.display = showDeletePhysical ? 'block' : 'none';
    if (checkboxPhysical) checkboxPhysical.checked = false;

    const cleanup = () => {
      btnCancel.removeEventListener('click', onCancel);
      btnProceed.removeEventListener('click', onProceed);
      modal.style.display = 'none';
    };

    const onCancel = () => {
      cleanup();
      resolve({ confirmed: false, deletePhysical: false });
    };

    const onProceed = () => {
      const deletePhysical = checkboxPhysical ? checkboxPhysical.checked : false;
      cleanup();
      resolve({ confirmed: true, deletePhysical });
    };

    btnCancel.addEventListener('click', onCancel);
    btnProceed.addEventListener('click', onProceed);
    modal.style.display = 'flex';
  });
}

async function promptRevokeLink(id) {
  const result = await showConfirmDialog({
    title: 'Revoke Share Link',
    message: 'Revoking this link will immediately deactivate access. Anyone trying to download with this link will be rejected. Proceed?',
    showDeletePhysical: false
  });

  if (!result.confirmed) return;

  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  try {
    const res = await fetch(`/api/transfers/${id}/revoke`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      showToast('Share link revoked successfully.', 'success');
      loadTransferHistory();
    } else {
      showToast('Could not revoke link.', 'error');
    }
  } catch (e) {
    showToast('Network error revoking link.', 'error');
  }
}

async function promptDeleteTransfer(id, isOwner = false) {
  const result = await showConfirmDialog({
    title: 'Delete Transfer Record',
    message: 'Are you sure you want to remove this record from your transfer history?',
    showDeletePhysical: isOwner
  });

  if (!result.confirmed) return;

  const token = authToken || localStorage.getItem('shareboxzen_auth_token') || sessionStorage.getItem('shareboxzen_auth_token_session');
  try {
    const url = `/api/transfers/${id}` + (result.deletePhysical ? '?deleteFile=true' : '');
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      showToast(result.deletePhysical ? 'Transfer record and physical file deleted.' : 'Removed from history.', 'success');
      loadTransferHistory();
      loadIncomingTransfers();
    } else {
      showToast('Could not delete transfer.', 'error');
    }
  } catch (e) {
    showToast('Network error deleting transfer.', 'error');
  }
}

// -----------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------
function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

// -----------------------------------------------------------------
// Deep Links & QR Pairing Code Scanner Auto-Action
// -----------------------------------------------------------------
function handleUrlDeepLinks() {
  const hash = window.location.hash || '';
  const search = window.location.search || '';

  // 1. Direct Zero-Internet Nearby Pairing via QR code scan (e.g. #send?mode=nearby&pair=<id> or ?pair=<id>)
  let pairTargetId = null;
  const searchParams = new URLSearchParams(search);
  if (searchParams.has('pair')) {
    pairTargetId = searchParams.get('pair');
  } else if (hash.includes('pair=')) {
    const qIndex = hash.indexOf('?');
    if (qIndex !== -1) {
      const hashParams = new URLSearchParams(hash.substring(qIndex + 1));
      pairTargetId = hashParams.get('pair');
    }
  }

  if (pairTargetId) {
    console.log('[QR Pairing] Detected pairing target ID:', pairTargetId);
    // Switch to Send -> Nearby tab
    const sendTabBtn = document.querySelector('.tab-btn[data-tab="tab-send"]');
    if (sendTabBtn) sendTabBtn.click();
    if (typeof window.switchSendMode === 'function') {
      window.switchSendMode('nearby');
    }

    showToast(`Instant QR Pairing detected! Requesting P2P connection to peer [${pairTargetId.slice(0, 6)}]...`, 'info');

    // Wait until local nearby engine is ready and connected to signaling
    let attempts = 0;
    const connectInterval = setInterval(() => {
      attempts++;
      if (nearbyEngine && nearbyEngine.ws && nearbyEngine.ws.readyState === WebSocket.OPEN && nearbyEngine.clientId) {
        clearInterval(connectInterval);
        console.log('[QR Pairing] Requesting pairing with target peer:', pairTargetId);
        nearbyEngine.requestPairing(pairTargetId);
      } else if (attempts > 25) {
        clearInterval(connectInterval);
        console.warn('[QR Pairing] Timed out waiting for signaling connection.');
      }
    }, 300);
  }

  // 2. Direct Receive File Link via QR code scan or share link (e.g. #receive?id=<id>)
  if (hash.startsWith('#receive')) {
    const receiveTabBtn = document.querySelector('.tab-btn[data-tab="tab-receive"]');
    if (receiveTabBtn) receiveTabBtn.click();
    const qIndex = hash.indexOf('?');
    if (qIndex !== -1) {
      const hashParams = new URLSearchParams(hash.substring(qIndex + 1));
      const fileId = hashParams.get('id');
      if (fileId) {
        const inputLookup = document.getElementById('receive-transfer-id') || document.getElementById('receive-code-input');
        if (inputLookup) inputLookup.value = fileId;
        if (typeof lookupReceiveTransfer === 'function') {
          lookupReceiveTransfer(fileId);
        }
      }
    }
  }
}

function initNetworkStatusWatcher() {
  const banner = document.getElementById('offline-network-banner');
  if (!banner) return;

  async function checkConnectivity() {
    if (!navigator.onLine) {
      banner.style.display = 'block';
      banner.innerHTML = '⚠️ <strong>Offline Mode (Cached Shell):</strong> Internet connection or ShareBoxZen server is required for Cloud Transfers. Nearby P2P transfers require local network signaling.';
      return;
    }
    try {
      const res = await fetch('/api/info', { method: 'GET', cache: 'no-store' });
      if (res.ok) {
        banner.style.display = 'none';
      } else {
        banner.style.display = 'block';
        banner.innerHTML = '⚠️ <strong>Server Connection Issue:</strong> Cloud transfers unavailable. Running from local cache.';
      }
    } catch (e) {
      banner.style.display = 'block';
      banner.innerHTML = '⚠️ <strong>Server Unreachable:</strong> Running from local cache. Connect to internet or start local ShareBoxZen server.';
    }
  }

  window.addEventListener('online', checkConnectivity);
  window.addEventListener('offline', checkConnectivity);
  checkConnectivity();
  setInterval(checkConnectivity, 30000);
}

// Global bootstrap
document.addEventListener('DOMContentLoaded', async () => {
  initThemeSwitcher();
  initNetworkStatusWatcher();
  initAuthSystem();
  initTabs();
  initNetworkInfo();
  initSendFiles();
  initReceiveTab();
  initTransferredFiles();
  initModals();
  initNearbyEngine();
  handleUrlDeepLinks();
  initSupabaseRealtime();
});
