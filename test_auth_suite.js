/**
 * Automated Verification Test Suite for ShareBoxZen
 * Validates All 15 Authentication Scenarios, Security Rules, Multi-Device Sessions,
 * Database Persistence, and Existing File Transfer Functionality.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';

function request(method, pathUrl, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('   SHAREBOXZEN FULL AUTHENTICATION & MULTI-DEVICE TEST SUITE    ');
  console.log('================================================================\n');

  const testUser = {
    name: 'Elena Rostova',
    username: `elena_${Date.now().toString().slice(-4)}`,
    email: `elena_${Date.now().toString().slice(-4)}@zenmail.io`,
    password: 'SecurePassword@2026!',
    newPassword: 'BrandNewPassword@2026#',
    forgotPassword: 'RecoveredPassword@2026$'
  };

  let registeredUser = null;
  let activeToken = null;
  let verificationCode = null;

  // -------------------------------------------------------------
  // Scenario 1: First-time Registration & Verification
  // -------------------------------------------------------------
  console.log('▶ [1/15] Scenario: First-time registration & email verification');
  const regRes = await request('POST', '/api/auth/register', {
    name: testUser.name,
    username: testUser.username,
    email: testUser.email,
    password: testUser.password,
    confirmPassword: testUser.password,
    agreedTerms: true
  });
  assert(regRes.status === 201, `Registration returned HTTP 201 Created (got ${regRes.status})`);
  assert(regRes.data.verificationCode, 'Verification code generated');
  verificationCode = regRes.data.verificationCode;

  // Verify email to activate account and receive permanent token
  const verifyRes = await request('POST', '/api/auth/verify-email', {
    email: testUser.email,
    code: verificationCode,
    rememberMe: true
  });
  assert(verifyRes.status === 200, `Email verification returned HTTP 200 (got ${verifyRes.status})`);
  assert(verifyRes.data.token, 'Session token issued');
  assert(verifyRes.data.user && verifyRes.data.user.zenId, 'User profile returned with unique ZenID');
  assert(!verifyRes.data.user.passwordHash, 'Security check: passwordHash is NEVER exposed in API response');
  registeredUser = verifyRes.data.user;
  activeToken = verifyRes.data.token;
  console.log(`    User ZenID: ${registeredUser.zenId}`);

  // -------------------------------------------------------------
  // Scenario 2: Duplicate Username Check
  // -------------------------------------------------------------
  console.log('\n▶ [2/15] Scenario: Duplicate username rejection');
  const dupUserRes = await request('POST', '/api/auth/register', {
    name: 'Another Person',
    username: testUser.username,
    email: `different_${Date.now()}@example.com`,
    password: 'Password@1234!',
    confirmPassword: 'Password@1234!',
    agreedTerms: true
  });
  assert(dupUserRes.status === 409, `Duplicate username returned HTTP 409 (got ${dupUserRes.status})`);
  assert(dupUserRes.data.error.includes('username'), 'Returned proper error for duplicate username');

  // Also test availability endpoint
  const checkUserRes = await request('GET', `/api/auth/check-username?u=${testUser.username}`);
  assert(checkUserRes.data.available === false, 'check-username API reports taken username as available: false');

  // -------------------------------------------------------------
  // Scenario 3: Duplicate Email Check
  // -------------------------------------------------------------
  console.log('\n▶ [3/15] Scenario: Duplicate email rejection');
  const dupEmailRes = await request('POST', '/api/auth/register', {
    name: 'Another Person',
    username: `unique_${Date.now()}`,
    email: testUser.email,
    password: 'Password@1234!',
    confirmPassword: 'Password@1234!',
    agreedTerms: true
  });
  assert(dupEmailRes.status === 409, `Duplicate email returned HTTP 409 (got ${dupEmailRes.status})`);
  assert(dupEmailRes.data.error.includes('email'), 'Returned proper error for duplicate email');

  const checkEmailRes = await request('GET', `/api/auth/check-email?e=${testUser.email}`);
  assert(checkEmailRes.data.available === false, 'check-email API reports taken email as available: false');

  // -------------------------------------------------------------
  // Scenario 4: Invalid Email Format
  // -------------------------------------------------------------
  console.log('\n▶ [4/15] Scenario: Invalid email rejection');
  const invalidEmailRes = await request('POST', '/api/auth/register', {
    name: 'Invalid Test',
    username: `inv_${Date.now()}`,
    email: 'not-an-email-at-all',
    password: 'Password@1234!',
    confirmPassword: 'Password@1234!',
    agreedTerms: true
  });
  assert(invalidEmailRes.status === 400, `Invalid email format returned HTTP 400 (got ${invalidEmailRes.status})`);

  // -------------------------------------------------------------
  // Scenario 5: Weak Password Rejection
  // -------------------------------------------------------------
  console.log('\n▶ [5/15] Scenario: Weak password rejection');
  const weakPwdRes = await request('POST', '/api/auth/register', {
    name: 'Weak Test',
    username: `weak_${Date.now()}`,
    email: `weak_${Date.now()}@example.com`,
    password: 'weak',
    confirmPassword: 'weak',
    agreedTerms: true
  });
  assert(weakPwdRes.status === 400, `Weak password returned HTTP 400 (got ${weakPwdRes.status})`);
  assert(weakPwdRes.data.error.includes('8 characters'), 'Error requires 8 characters');

  // -------------------------------------------------------------
  // Scenario 6: Password Mismatch
  // -------------------------------------------------------------
  console.log('\n▶ [6/15] Scenario: Password confirmation mismatch');
  const mismatchRes = await request('POST', '/api/auth/register', {
    name: 'Mismatch Test',
    username: `mis_${Date.now()}`,
    email: `mis_${Date.now()}@example.com`,
    password: 'Password@1234!',
    confirmPassword: 'DifferentPassword@1234!',
    agreedTerms: true
  });
  assert(mismatchRes.status === 400, `Password mismatch returned HTTP 400 (got ${mismatchRes.status})`);
  assert(mismatchRes.data.error.includes('match'), 'Error explains mismatch');

  // -------------------------------------------------------------
  // Scenario 7: Successful Login
  // -------------------------------------------------------------
  console.log('\n▶ [7/15] Scenario: Successful login with username & email');
  // 7a. Login by username
  const loginUserRes = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.password,
    rememberMe: true
  });
  assert(loginUserRes.status === 200, `Login by username returned HTTP 200 (got ${loginUserRes.status})`);
  assert(loginUserRes.data.token, 'Login returned active session token');
  assert(loginUserRes.data.user.email === testUser.email, 'User profile resolved accurately');

  // 7b. Login by email
  const loginEmailRes = await request('POST', '/api/auth/login', {
    identifier: testUser.email,
    password: testUser.password,
    rememberMe: false
  });
  assert(loginEmailRes.status === 200, `Login by email returned HTTP 200 (got ${loginEmailRes.status})`);

  // -------------------------------------------------------------
  // Scenario 8: Incorrect Password & Non-Existent Account
  // -------------------------------------------------------------
  console.log('\n▶ [8/15] Scenario: Incorrect password and non-existent account verification');
  // 8a. Wrong password -> Exact string: "Incorrect password. Please try again."
  const wrongPwdRes = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: 'WrongPassword@123'
  });
  assert(wrongPwdRes.status === 401, `Wrong password returned HTTP 401 (got ${wrongPwdRes.status})`);
  assert(wrongPwdRes.data.error === 'Incorrect password. Please try again.', 'Exact prompt required error: "Incorrect password. Please try again."');

  // 8b. Unknown account -> Exact string: "Account not found. Please check your details."
  const unknownUserRes = await request('POST', '/api/auth/login', {
    identifier: 'non_existent_zen_user_99999',
    password: 'AnyPassword@123'
  });
  assert(unknownUserRes.status === 404, `Unknown user returned HTTP 404 (got ${unknownUserRes.status})`);
  assert(unknownUserRes.data.error === 'Account not found. Please check your details.', 'Exact prompt required error: "Account not found. Please check your details."');

  // -------------------------------------------------------------
  // Scenario 9: Logout
  // -------------------------------------------------------------
  console.log('\n▶ [9/15] Scenario: Logout invalidates active session');
  const tempLogin = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.password
  });
  const tempToken = tempLogin.data.token;

  const logoutRes = await request('POST', '/api/auth/logout', null, tempToken);
  assert(logoutRes.status === 200, 'Logout succeeded with HTTP 200');

  // Verify that calling /api/auth/me with logged-out token fails
  const meAfterLogout = await request('GET', '/api/auth/me', null, tempToken);
  assert(meAfterLogout.status === 401, 'Logged-out token is rejected with HTTP 401 on protected endpoint');

  // -------------------------------------------------------------
  // Scenario 10: Permanent Database Persistence across Application
  // -------------------------------------------------------------
  console.log('\n▶ [10/15] Scenario: Verification of permanent account storage in DB file');
  const dbPath = path.join(__dirname, 'data', 'db.json');
  assert(fs.existsSync(dbPath), 'data/db.json file exists on disk');
  const rawDB = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const foundInDisk = rawDB.users.find(u => u.email === testUser.email);
  assert(foundInDisk !== undefined, 'User record is permanently persisted in data/db.json on disk');
  assert(foundInDisk.passwordHash && foundInDisk.passwordHash.includes(':'), 'Password is encrypted with salt:hash (NEVER stored plaintext)');
  assert(!foundInDisk.password, 'Security check: plaintext password field does NOT exist on disk');

  // -------------------------------------------------------------
  // Scenario 11: Persistent Session
  // -------------------------------------------------------------
  console.log('\n▶ [11/15] Scenario: Persistent session validation via /api/auth/me');
  const loginForSession = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.password,
    rememberMe: true
  });
  activeToken = loginForSession.data.token;

  const meRes = await request('GET', '/api/auth/me', null, activeToken);
  assert(meRes.status === 200, `Protected profile check returned HTTP 200 (got ${meRes.status})`);
  assert(meRes.data.user.id === registeredUser.id, 'Session token correctly resolved authenticated user');

  // -------------------------------------------------------------
  // Scenario 12: Password Change
  // -------------------------------------------------------------
  console.log('\n▶ [12/15] Scenario: Password change via security settings');
  const changePwdRes = await request('POST', '/api/auth/change-password', {
    currentPassword: testUser.password,
    newPassword: testUser.newPassword,
    confirmPassword: testUser.newPassword
  }, activeToken);
  assert(changePwdRes.status === 200, `Password change returned HTTP 200 (got ${changePwdRes.status})`);

  // -------------------------------------------------------------
  // Scenario 13: Old Password Rejection & New Password Authentication
  // -------------------------------------------------------------
  console.log('\n▶ [13/15] Scenario: Old password rejection & new password login');
  const oldLoginRes = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.password
  });
  assert(oldLoginRes.status === 401, 'Old password was rejected with HTTP 401');
  assert(oldLoginRes.data.error === 'Incorrect password. Please try again.', 'Old password returned exact error');

  const newLoginRes = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.newPassword
  });
  assert(newLoginRes.status === 200, 'New password successfully authenticates user with HTTP 200');
  activeToken = newLoginRes.data.token;

  // -------------------------------------------------------------
  // Scenario 14: Forgot Password Recovery Flow
  // -------------------------------------------------------------
  console.log('\n▶ [14/15] Scenario: Forgot password recovery flow');
  const forgotReq = await request('POST', '/api/auth/forgot-password', {
    email: testUser.email
  });
  assert(forgotReq.status === 200, `Forgot password request returned HTTP 200 (got ${forgotReq.status})`);
  assert(forgotReq.data.resetToken && forgotReq.data.recoveryCode, 'Reset token and recovery code generated');

  const resetReq = await request('POST', '/api/auth/reset-password', {
    resetToken: forgotReq.data.resetToken,
    code: forgotReq.data.recoveryCode,
    newPassword: testUser.forgotPassword,
    confirmPassword: testUser.forgotPassword
  });
  assert(resetReq.status === 200, `Reset password returned HTTP 200 (got ${resetReq.status})`);

  // Verify previous password now rejected
  const prevPwdTry = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.newPassword
  });
  assert(prevPwdTry.status === 401, 'Previous password rejected after password reset');

  // Verify recovered password authenticates
  const recoveredLogin = await request('POST', '/api/auth/login', {
    identifier: testUser.username,
    password: testUser.forgotPassword
  });
  assert(recoveredLogin.status === 200, 'Recovered password successfully authenticates account');

  // -------------------------------------------------------------
  // Scenario 15: Multi-Device Support (Concurrent Sessions)
  // -------------------------------------------------------------
  console.log('\n▶ [15/15] Scenario: Multi-device support (Web, Android, Windows concurrent sessions)');
  const sessionWeb = await request('POST', '/api/auth/login', { identifier: testUser.username, password: testUser.forgotPassword });
  const sessionAndroid = await request('POST', '/api/auth/login', { identifier: testUser.username, password: testUser.forgotPassword });
  const sessionWindows = await request('POST', '/api/auth/login', { identifier: testUser.username, password: testUser.forgotPassword });

  assert(sessionWeb.status === 200 && sessionAndroid.status === 200 && sessionWindows.status === 200, 'All three platform logins succeeded');

  const meWeb = await request('GET', '/api/auth/me', null, sessionWeb.data.token);
  const meAndroid = await request('GET', '/api/auth/me', null, sessionAndroid.data.token);
  const meWindows = await request('GET', '/api/auth/me', null, sessionWindows.data.token);

  assert(meWeb.data.user.id === registeredUser.id, 'Web session resolves same account profile');
  assert(meAndroid.data.user.id === registeredUser.id, 'Android session resolves same account profile');
  assert(meWindows.data.user.id === registeredUser.id, 'Windows session resolves same account profile');
  assert(meWeb.data.user.zenId === registeredUser.zenId, 'Unique ZenID matches across all three devices');

  // -------------------------------------------------------------
  // Verification: Existing Features & File Transfer Functionality
  // -------------------------------------------------------------
  console.log('\n▶ Verification: Preserved existing features & file transfer engine');
  // Check existing accounts
  const legacyUsers = rawDB.users.filter(u => ['zenmaster', 'alex', 'sophia'].includes(u.username));
  assert(legacyUsers.length === 3, 'Existing user accounts (zenmaster, alex, sophia) preserved in database');

  // Check network info
  const infoRes = await request('GET', '/api/info');
  assert(infoRes.status === 200 && infoRes.data.qrDataUrl, 'Network info and QR code generation active');

  // Check file transfer initiation
  const transferInit = await request('POST', '/api/transfer/init', {
    fileName: 'test_verify_file.bin',
    fileSize: 1048576,
    chunkSize: 524288,
    totalChunks: 2,
    senderId: registeredUser.id,
    isPublic: true
  });
  assert(transferInit.status === 201 && transferInit.data.transferId, 'Resilient chunk transfer initialization working');

  // Check transfer status
  const transferStatus = await request('GET', `/api/transfer/${transferInit.data.transferId}/status`);
  assert(transferStatus.status === 200 && transferStatus.data.missingChunks.length === 2, 'Transfer chunk query working');

  console.log('\n================================================================');
  console.log('       ALL 15 SCENARIOS & CORE FEATURES PASSED SUCCESSFULLY!    ');
  console.log('================================================================\n');
}

runTestSuite().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
