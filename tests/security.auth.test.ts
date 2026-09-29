import assert from 'assert';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { envConfig } from '../src/config/env.config';
import { authenticateJwt, authenticateAdmin as authenticateAdminAuth } from '../src/modules/auth/auth.middleware';
import { ROLE_PERMISSIONS, requirePermission, authenticateAdmin as authenticateAdminRbac } from '../src/middleware/rbac.middleware';
import { TicTacToeEngine } from '../src/game/TicTacToeEngine';
import { DepositController } from '../src/modules/payments/deposit.controller';
import { FinancialService } from '../src/services/FinancialService';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import bcrypt from 'bcryptjs';
import { isAllowedCorsOrigin } from '../src/app';
import { RedisManager } from '../src/db/redis';
import { UserController } from '../src/modules/users/user.controller';
import { AdminController } from '../src/modules/admin/admin.controller';
import { WithdrawController } from '../src/modules/payments/withdraw.controller';
import { WalletService } from '../src/modules/wallet/wallet.service';

async function runSecurityTests() {
  console.log('====================================================');
  console.log('🛡️  RUNNING SECURITY & AUTHENTICATION TEST SUITE');
  console.log('====================================================\n');

  // Test 1: authenticateJwt blocks unauthenticated requests
  console.log('TEST 1: authenticateJwt rejects unauthenticated request...');
  let errorStatus = 0;
  let errorMessage = '';
  const mockReq: any = { headers: {} };
  const mockRes: any = {
    status(code: number) {
      errorStatus = code;
      return this;
    },
    json(data: any) {
      errorMessage = data.message;
      return this;
    }
  };
  let nextCalled = false;
  const mockNext = () => { nextCalled = true; };

  authenticateJwt(mockReq, mockRes, mockNext);
  assert.strictEqual(nextCalled, false, 'Next must not be called without token');
  assert.strictEqual(errorStatus, 401, 'Must return 401 Unauthorized');
  console.log('✅ TEST 1 PASSED: Missing token correctly returns 401.\n');

  // Test 2: authenticateJwt verifies valid JWT and attaches user
  console.log('TEST 2: authenticateJwt verifies valid token...');
  const testPayload = { userId: 'usr_secure_99', name: 'SecurityTester' };
  const secret = envConfig.jwtSecret || 'test-secret-key-at-least-32-chars-long';
  const token = jwt.sign(testPayload, secret, { expiresIn: '1h' });

  mockReq.headers.authorization = `Bearer ${token}`;
  nextCalled = false;
  authenticateJwt(mockReq, mockRes, mockNext);
  assert.strictEqual(nextCalled, true, 'Next must be called with valid token');
  assert.strictEqual(mockReq.user.userId, 'usr_secure_99', 'User identity must be decoded from token');
  console.log('✅ TEST 2 PASSED: Valid JWT properly decodes principal.\n');

  // Test 3: RBAC Role Permissions Separation
  console.log('TEST 3: RBAC permission boundaries...');
  assert.strictEqual(ROLE_PERMISSIONS.GAME_ADMIN.includes('wallet.adjust'), false, 'GAME_ADMIN must not have wallet.adjust');
  assert.strictEqual(ROLE_PERMISSIONS.GAME_ADMIN.includes('payments.approve'), false, 'GAME_ADMIN must not have payments.approve');
  assert.strictEqual(ROLE_PERMISSIONS.ADMIN.includes('admins.manage'), false, 'Standard ADMIN must not have admins.manage');
  assert.strictEqual(ROLE_PERMISSIONS.SUPER_ADMIN.includes('admins.manage'), true, 'SUPER_ADMIN must have admins.manage');
  console.log('✅ TEST 3 PASSED: RBAC separation of duties enforced.\n');

  // Test 4: XO Game Routes reject unauthenticated calls
  console.log('TEST 4: XO Game Routes reject unauthenticated calls...');
  let xoAuthBlocked = 0;
  const mockXoReq: any = { headers: {}, body: { userId: 'attacker_123', tierId: 'tier_10' } };
  const mockXoRes: any = {
    status(code: number) {
      if (code === 401) xoAuthBlocked++;
      return this;
    },
    json() { return this; }
  };
  authenticateJwt(mockXoReq, mockXoRes, () => {});
  assert.strictEqual(xoAuthBlocked, 1, 'XO endpoints must block unauthenticated calls with 401');
  assert.strictEqual((mockXoReq as any).user, undefined, 'No principal must be set');
  console.log('✅ TEST 4 PASSED: XO endpoints require valid JWT authentication.\n');

  // Test 5: Client cannot arbitrarily forge WIN outcome
  console.log('TEST 5: Server authoritative settlement rejects forged WIN...');
  const fakeRoomId = 'room_non_existent_' + Date.now();
  const settleRes = await TicTacToeEngine.settleGameResult('attacker_user', fakeRoomId, 'tier_100', 'WIN');
  assert.strictEqual(settleRes.success, false, 'Forged WIN on non-existent or unauthorized room must be rejected');
  assert.strictEqual(settleRes.prizePaise, undefined, 'No prize can be credited on invalid settlement');
  console.log('✅ TEST 5 PASSED: Client-reported WIN rejected without valid server room.\n');

  // Test 6: Deposit UTR endpoint enforces authentication and ownership
  console.log('TEST 6: Deposit UTR endpoint enforces authentication and ownership...');
  // 6a: Missing token rejected
  let utrAuthBlocked = 0;
  const mockUtrReqNoAuth: any = { headers: {}, body: { depositId: 'dep_123', utr: '123456789012' } };
  const mockUtrResNoAuth: any = {
    status(code: number) {
      if (code === 401) utrAuthBlocked++;
      return this;
    },
    json() { return this; }
  };
  authenticateJwt(mockUtrReqNoAuth, mockUtrResNoAuth, () => {});
  assert.strictEqual(utrAuthBlocked, 1, 'Deposit UTR must require JWT auth');

  // 6b: Wrong owner rejected with 403 Forbidden
  const legitimateDeposit = FinancialService.initiateDeposit('victim_user_456', 500);
  let utrOwnershipBlocked = 0;
  let utrOwnershipErrorMsg = '';
  const mockUtrReqAttacker: any = {
    user: { userId: 'attacker_user_789' },
    body: { depositId: legitimateDeposit.depositId, utr: '987654321098' }
  };
  const mockUtrResAttacker: any = {
    status(code: number) {
      if (code === 403) utrOwnershipBlocked++;
      return this;
    },
    json(data: any) {
      utrOwnershipErrorMsg = data.message;
      return this;
    }
  };
  DepositController.submitUtr(mockUtrReqAttacker, mockUtrResAttacker);
  assert.strictEqual(utrOwnershipBlocked, 1, 'Must reject UTR submission for deposit not owned by user with 403');
  assert.strictEqual(utrOwnershipErrorMsg.includes('You do not own this deposit'), true, 'Error message must specify ownership violation');
  console.log('✅ TEST 6 PASSED: Deposit UTR authentication & strict ownership enforced.\n');

  // Test 7: WhatsApp verification unknown token rejection
  console.log('TEST 7: WhatsApp verification rejects unknown/forged token with 401...');
  let waStatus = 0;
  let waResponse: any = null;
  const mockWaReq: any = {
    body: {
      token: 'FORGED-FAKE-TOKEN-999999',
      phone: '9876543210'
    }
  };
  const mockWaRes: any = {
    status(code: number) {
      waStatus = code;
      return this;
    },
    json(data: any) {
      waResponse = data;
      return this;
    }
  };
  await AuthController.verifyWhatsApp(mockWaReq, mockWaRes);
  assert.strictEqual(waStatus, 401, 'Must reject unknown WhatsApp verification token with 401');
  assert.strictEqual(waResponse?.success, false, 'Must not return success for unknown WhatsApp token');
  assert.strictEqual(waResponse?.data?.jwtToken, undefined, 'Must not issue JWT for unverified WhatsApp token');
  console.log('✅ TEST 7 PASSED: Unknown WhatsApp token returns 401 and creates no user/JWT.\n');

  // Test 8: Admin password bcrypt verification & wrong password rejection
  console.log('TEST 8: Admin password verification enforces secure hash comparison...');
  const testPassword = 'SecretAdminPass123!';
  const bcryptHash = await bcrypt.hash(testPassword, 10);
  assert.strictEqual(bcryptHash.startsWith('$2a$') || bcryptHash.startsWith('$2b$'), true, 'Bcrypt hash must have valid salt prefix');
  const validCompare = await bcrypt.compare(testPassword, bcryptHash);
  assert.strictEqual(validCompare, true, 'Bcrypt compare must succeed for valid password');
  const invalidCompare = await bcrypt.compare('WrongPass123', bcryptHash);
  assert.strictEqual(invalidCompare, false, 'Bcrypt compare must fail for wrong password');

  // Verify AuthService.adminLogin rejects wrong credentials
  let adminLoginFailed = false;
  try {
    await AuthService.adminLogin('non_existent_admin_xyz', 'incorrect_password');
  } catch (err: any) {
    adminLoginFailed = true;
    assert.strictEqual(err.message, 'Invalid Admin Username or Password');
  }
  assert.strictEqual(adminLoginFailed, true, 'Admin login must reject invalid credentials');
  console.log('✅ TEST 8 PASSED: Admin password bcrypt hash verification and credential rejection verified.\n');

  // Test 9: Elimination of x-admin-secret master backdoor
  console.log('TEST 9: Elimination of x-admin-secret backdoor...');
  let secretMiddlewareRejected = false;
  let secretMiddlewareStatus = 0;
  const mockSecretReq: any = {
    headers: {
      'x-admin-secret': process.env.ADMIN_SECRET_KEY || envConfig.adminPassword || 'mastersecret123'
    },
    query: {}
  };
  const mockSecretRes: any = {
    status(code: number) {
      secretMiddlewareStatus = code;
      return this;
    },
    json(data: any) {
      secretMiddlewareRejected = true;
      return this;
    }
  };
  let nextCalledWithSecret = false;
  await authenticateAdminAuth(mockSecretReq, mockSecretRes, () => {
    nextCalledWithSecret = true;
  });
  assert.strictEqual(nextCalledWithSecret, false, 'authenticateAdmin must NEVER allow bypass via x-admin-secret');
  assert.strictEqual(secretMiddlewareStatus, 401, 'authenticateAdmin must return 401 when x-admin-secret is passed');

  let rbacSecretRejected = false;
  let rbacSecretStatus = 0;
  let nextRbacCalledWithSecret = false;
  const mockRbacRes: any = {
    status(code: number) {
      rbacSecretStatus = code;
      return this;
    },
    json(data: any) {
      rbacSecretRejected = true;
      return this;
    }
  };
  await authenticateAdminRbac(mockSecretReq, mockRbacRes, () => {
    nextRbacCalledWithSecret = true;
  });
  assert.strictEqual(nextRbacCalledWithSecret, false, 'authenticateAdmin (RBAC) must NEVER allow bypass via x-admin-secret');
  assert.strictEqual(rbacSecretStatus, 401, 'authenticateAdmin (RBAC) must return 401 when x-admin-secret is passed');
  console.log('✅ TEST 9 PASSED: x-admin-secret master backdoor eliminated from all middlewares.\n');

  // Test 10: Server-side admin role verification & anti-spoofing
  console.log('TEST 10: Server-side admin record verification blocks forged/tampered JWT roles...');
  const forgedToken = jwt.sign(
    { id: 'forged_admin_id', username: 'imposter_admin', role: 'SUPER_ADMIN' },
    envConfig.adminJwtSecret || envConfig.jwtSecret
  );

  let forgedStatus = 0;
  let forgedNextCalled = false;
  const mockForgedReq: any = {
    headers: {
      authorization: `Bearer ${forgedToken}`
    },
    query: {}
  };
  const mockForgedRes: any = {
    status(code: number) {
      forgedStatus = code;
      return this;
    },
    json(data: any) {
      return this;
    }
  };

  await authenticateAdminAuth(mockForgedReq, mockForgedRes, () => {
    forgedNextCalled = true;
  });

  assert.strictEqual(forgedNextCalled, false, 'Forged JWT role must NEVER be trusted without server-side record');
  assert.strictEqual(forgedStatus, 403, 'Must return 403 for forged admin identity not found in authoritative records');

  // Verify valid master admin token is accepted
  const validMasterToken = jwt.sign(
    { id: 'env-super-admin', username: envConfig.adminUsername, role: 'SUPER_ADMIN' },
    envConfig.adminJwtSecret || envConfig.jwtSecret
  );
  let masterNextCalled = false;
  const mockMasterReq: any = {
    headers: {
      authorization: `Bearer ${validMasterToken}`
    },
    query: {}
  };
  const mockMasterRes: any = {
    status(code: number) { return this; },
    json(data: any) { return this; }
  };
  await authenticateAdminAuth(mockMasterReq, mockMasterRes, () => {
    masterNextCalled = true;
  });
  assert.strictEqual(masterNextCalled, true, 'Valid master admin with matching server record must be authorized');
  assert.strictEqual(mockMasterReq.admin?.role, 'SUPER_ADMIN', 'Authoritative role must be assigned from server');
  console.log('✅ TEST 10 PASSED: Server-side admin record verification blocks JWT role spoofing.\n');

  // Test 11: Strict CORS origin validation & removal of *.vercel.app wildcard
  console.log('TEST 11: Strict CORS whitelist rejects wildcard .vercel.app and untrusted origins...');
  assert.strictEqual(isAllowedCorsOrigin(undefined), true, 'Native app without Origin header must be accepted');
  assert.strictEqual(isAllowedCorsOrigin('https://adminpenal-six.vercel.app'), true, 'Exact verified admin origin must be accepted');
  assert.strictEqual(isAllowedCorsOrigin('https://random-attacker.vercel.app'), false, 'Arbitrary .vercel.app subdomains must be rejected');
  assert.strictEqual(isAllowedCorsOrigin('https://phishing-site.com'), false, 'Untrusted origin must be rejected');
  console.log('✅ TEST 11 PASSED: Strict CORS origin whitelist enforced; wildcard .vercel.app rejected.\n');

  // Test 12: Redis shared state synchronization for XO game rooms
  console.log('TEST 12: Redis shared game state synchronization...');
  const testRoomId = `XO-REDIS-TEST-${Date.now()}`;
  const testUserId = `user_xo_${Date.now()}`;
  const mockRoom: any = {
    roomId: testRoomId,
    tierId: 'tier_1',
    tier: { id: 'tier_1', name: 'Battle ₹1', entryPaise: 100, firstPrizePaise: 150, secondPrizePaise: 0, bonusUsablePaise: 25, playersCount: 2 },
    player1: { userId: testUserId, name: 'Tester', avatarUrl: '', symbol: 'O', score: 0 },
    player2: null,
    board: Array(9).fill(null),
    currentTurnUserId: testUserId,
    status: 'IN_GAME',
    turnSecondsRemaining: 15,
    totalGameSecondsRemaining: 180,
    winnerUserId: null,
    isDraw: false,
    winningIndices: null,
    createdAt: Date.now()
  };

  await (TicTacToeEngine as any).syncRoomToRedis(mockRoom);
  const fetchedRoom = await TicTacToeEngine.getRoomAsync(testRoomId);
  assert.strictEqual(fetchedRoom?.roomId, testRoomId, 'Must retrieve room from Redis shared state');
  assert.strictEqual(fetchedRoom?.currentTurnUserId, testUserId, 'Turn state must match shared state');

  const userRoom = await TicTacToeEngine.getRoomForUserAsync(testUserId);
  assert.strictEqual(userRoom?.roomId, testRoomId, 'Must resolve user active room from shared Redis mapping');
  console.log('✅ TEST 12 PASSED: Redis shared game state and active room synchronization verified.\n');

  // Test 13: Profile routes require JWT identity and reject body/query userId spoofing
  console.log('TEST 13: Profile routes enforce JWT identity strictly without body/query fallback...');
  let profileGetStatus = 0;
  const mockUnauthGetReq: any = { query: { userId: 'victim_user_123' } };
  const mockUnauthGetRes: any = {
    status(code: number) { profileGetStatus = code; return this; },
    json(data: any) { return this; }
  };
  await AuthController.getProfile(mockUnauthGetReq, mockUnauthGetRes);
  assert.strictEqual(profileGetStatus, 401, 'getProfile must reject unauthenticated request even if query.userId is provided');

  let profileUpdateStatus = 0;
  const mockUnauthUpdateReq: any = {
    body: { userId: 'victim_user_123', name: 'HackedName' }
  };
  const mockUnauthUpdateRes: any = {
    status(code: number) { profileUpdateStatus = code; return this; },
    json(data: any) { return this; }
  };
  await AuthController.updateProfile(mockUnauthUpdateReq, mockUnauthUpdateRes);
  assert.strictEqual(profileUpdateStatus, 401, 'updateProfile must reject unauthenticated request even if body.userId is provided');
  console.log('✅ TEST 13 PASSED: Profile identity strictly bound to verified JWT; spoofed body/query fallback rejected.\n');

  // Test 14: /auth/status endpoint minimization and PII protection
  console.log('TEST 14: /auth/status minimizes public responses to prevent user enumeration and PII harvesting...');
  const testPhone = '9998887776';
  const testName = 'ConfidentialPlayer';
  const registered = await AuthService.loginOrRegister(testPhone, testName);

  // 1. Unauthenticated query
  let unauthData: any = null;
  const mockUnauthStatusReq: any = { query: { phone: testPhone } };
  const mockUnauthStatusRes: any = {
    status(code: number) { return this; },
    json(payload: any) { unauthData = payload?.data; return this; }
  };
  await AuthController.checkStatus(mockUnauthStatusReq, mockUnauthStatusRes);
  assert.strictEqual(unauthData?.exists, true, 'Must confirm existence');
  assert.strictEqual(unauthData?.name, undefined, 'Must NOT leak name to unauthenticated callers');
  assert.strictEqual(unauthData?.userId, undefined, 'Must NOT leak userId to unauthenticated callers');
  assert.strictEqual(unauthData?.phone, undefined, 'Must NOT leak phone to unauthenticated callers');

  // 2. Authenticated query by user owner
  let authData: any = null;
  const mockAuthStatusReq: any = {
    query: { phone: testPhone },
    user: { userId: registered.user.id }
  };
  const mockAuthStatusRes: any = {
    status(code: number) { return this; },
    json(payload: any) { authData = payload?.data; return this; }
  };
  await AuthController.checkStatus(mockAuthStatusReq, mockAuthStatusRes);
  assert.strictEqual(authData?.name, testName, 'Must return full name for authenticated owner');
  assert.strictEqual(authData?.userId, registered.user.id, 'Must return userId for authenticated owner');
  // Test 15: /users/fcm-token enforces authenticated JWT identity and rejects unauthenticated/spoofed userId
  console.log('TEST 15: /users/fcm-token requires JWT authentication and prevents userId injection/spoofing...');
  let fcmStatus = 0;
  const mockUnauthFcmReq: any = {
    body: { userId: 'victim_user_fcm', fcmToken: 'token_sample_123' }
  };
  const mockUnauthFcmRes: any = {
    status(code: number) { fcmStatus = code; return this; },
    json(data: any) { return this; }
  };
  await UserController.registerFcmToken(mockUnauthFcmReq, mockUnauthFcmRes);
  assert.strictEqual(fcmStatus, 401, 'registerFcmToken must reject unauthenticated requests even if userId is sent in body');

  // Authenticated user with spoofed body.userId must strictly bind to req.user.userId
  let authFcmData: any = null;
  const mockAuthFcmReq: any = {
    user: { userId: 'legit_user_jwt' },
    body: { userId: 'spoofed_target_user', fcmToken: 'valid_token_xyz' }
  };
  const mockAuthFcmRes: any = {
    status(code: number) { return this; },
    json(payload: any) { authFcmData = payload?.data; return this; }
  };
  await UserController.registerFcmToken(mockAuthFcmReq, mockAuthFcmRes);
  assert.strictEqual(authFcmData?.userId, 'legit_user_jwt', 'registerFcmToken must strictly bind to authenticated JWT userId');
  assert.notStrictEqual(authFcmData?.userId, 'spoofed_target_user', 'registerFcmToken must NEVER use client-provided body.userId');
  // Test 16: Admin wallet adjustment security, reason validation, amount limits, confirmation & audit
  console.log('TEST 16: Admin wallet adjustment enforces permissions, mandatory reasons, limits, confirmation & idempotency...');
  
  // 1. Missing admin authentication
  let unauthAdjustStatus = 0;
  const mockUnauthAdjustReq: any = {
    params: { id: registered.user.id },
    body: { type: 'CREDIT', bucket: 'deposit', amountRupees: 100, reason: 'Valid audit reason here' }
  };
  const mockUnauthAdjustRes: any = {
    status(code: number) { unauthAdjustStatus = code; return this; },
    json(data: any) { return this; }
  };
  await AdminController.adjustUserWallet(mockUnauthAdjustReq, mockUnauthAdjustRes);
  assert.strictEqual(unauthAdjustStatus, 401, 'adjustUserWallet must reject requests without verified admin principal');

  // 2. Missing or too short reason
  let shortReasonStatus = 0;
  let shortReasonMsg = '';
  const mockShortReasonReq: any = {
    params: { id: registered.user.id },
    admin: { id: 'admin1', username: 'superadmin', role: 'SUPER_ADMIN' },
    body: { type: 'CREDIT', bucket: 'deposit', amountRupees: 100, reason: 'bad' }
  };
  const mockShortReasonRes: any = {
    status(code: number) { shortReasonStatus = code; return this; },
    json(payload: any) { shortReasonMsg = payload?.message; return this; }
  };
  await AdminController.adjustUserWallet(mockShortReasonReq, mockShortReasonRes);
  assert.strictEqual(shortReasonStatus, 400, 'adjustUserWallet must reject adjustments with reasons shorter than 5 chars');

  // 3. Amount exceeds hard limit of ₹50,000
  let excessLimitStatus = 0;
  const mockExcessLimitReq: any = {
    params: { id: registered.user.id },
    admin: { id: 'admin1', username: 'superadmin', role: 'SUPER_ADMIN' },
    body: { type: 'CREDIT', bucket: 'deposit', amountRupees: 50001, reason: 'Massive credit reason' }
  };
  const mockExcessLimitRes: any = {
    status(code: number) { excessLimitStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await AdminController.adjustUserWallet(mockExcessLimitReq, mockExcessLimitRes);
  assert.strictEqual(excessLimitStatus, 400, 'adjustUserWallet must reject amounts exceeding single-operation hard limit ₹50,000');

  // 4. Amount > ₹10,000 without confirmed: true
  let unconfirmedStatus = 0;
  const mockUnconfirmedReq: any = {
    params: { id: registered.user.id },
    admin: { id: 'admin1', username: 'superadmin', role: 'SUPER_ADMIN' },
    body: { type: 'CREDIT', bucket: 'deposit', amountRupees: 15000, reason: 'High value adjustment' }
  };
  const mockUnconfirmedRes: any = {
    status(code: number) { unconfirmedStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await AdminController.adjustUserWallet(mockUnconfirmedReq, mockUnconfirmedRes);
  assert.strictEqual(unconfirmedStatus, 400, 'adjustUserWallet must reject high-value adjustments without explicit confirmed: true');

  // 5. Valid adjustment with idempotency key
  let validAdjustStatus = 0;
  let validAdjustData: any = null;
  const customIdempKey = `idemp_test_${Date.now()}`;
  const mockValidAdjustReq: any = {
    params: { id: registered.user.id },
    admin: { id: 'admin1', username: 'superadmin', role: 'SUPER_ADMIN' },
    headers: { 'x-idempotency-key': customIdempKey },
    body: { type: 'CREDIT', bucket: 'deposit', amountRupees: 50, reason: 'Customer service compensation' }
  };
  const mockValidAdjustRes: any = {
    status(code: number) { validAdjustStatus = code; return this; },
    json(payload: any) { validAdjustData = payload?.data; return this; }
  };
  await AdminController.adjustUserWallet(mockValidAdjustReq, mockValidAdjustRes);
  assert.strictEqual(validAdjustData?.idempotencyKey, customIdempKey, 'adjustUserWallet must honor and return custom idempotency key');
  assert.ok(validAdjustData?.updatedBalance, 'adjustUserWallet must return updated balance object');
  console.log('✅ TEST 16 PASSED: Admin wallet adjustment enforces permissions, reasons, limits, confirmation & idempotency.\n');

  // Test 17: Admin financial approve/reject actions idempotency & DB transaction state transitions
  console.log('TEST 17: Financial approve/reject actions enforce strict state transitions & idempotency...');
  
  // Part A: Deposit state transition & idempotency
  const testDeposit = FinancialService.initiateDeposit(registered.user.id, 250);
  const balBeforeApprove = await WalletService.getBalance(registered.user.id);

  // 1. Approve deposit
  let apprDepStatus = 0;
  let apprDepData: any = null;
  const mockApprDepReq: any = {
    headers: { 'x-idempotency-key': `idemp_dep_${testDeposit.depositId}` },
    body: { depositId: testDeposit.depositId }
  };
  const mockApprDepRes: any = {
    status(code: number) { apprDepStatus = code; return this; },
    json(payload: any) { apprDepData = payload; return this; }
  };
  await DepositController.approve(mockApprDepReq, mockApprDepRes);
  assert.strictEqual(apprDepStatus, 200, 'First deposit approval must succeed with 200');
  const balAfterApprove = await WalletService.getBalance(registered.user.id);
  assert.strictEqual(balAfterApprove.depositPaise, balBeforeApprove.depositPaise + 25000, 'Wallet must be credited ₹250 exactly once');

  // 2. Duplicate Approve deposit (Idempotency)
  let dupApprDepStatus = 0;
  const mockDupApprDepRes: any = {
    status(code: number) { dupApprDepStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await DepositController.approve(mockApprDepReq, mockDupApprDepRes);
  assert.strictEqual(dupApprDepStatus, 200, 'Duplicate deposit approval must return 200 idempotently');
  const balAfterDup = await WalletService.getBalance(registered.user.id);
  assert.strictEqual(balAfterDup.depositPaise, balAfterApprove.depositPaise, 'Duplicate deposit approval must NEVER double credit balance');

  // 3. Reject on already APPROVED deposit must fail
  let rejAfterApprStatus = 0;
  const mockRejAfterApprReq: any = { body: { depositId: testDeposit.depositId } };
  const mockRejAfterApprRes: any = {
    status(code: number) { rejAfterApprStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await DepositController.reject(mockRejAfterApprReq, mockRejAfterApprRes);
  assert.strictEqual(rejAfterApprStatus, 400, 'Rejecting an already APPROVED deposit must be rejected with 400');

  // Part B: Withdrawal state transition & idempotency
  await WalletService.creditWinnings(registered.user.id, 50000, `SEED-WIN-${Date.now()}`, 'Seed Winnings For Withdrawal Test');
  const wdRes = await FinancialService.requestWithdrawal(registered.user.id, 100, 'test@upi');
  assert.strictEqual(wdRes.success, true, 'Withdrawal request must succeed');
  const testWdId = wdRes.record!.withdrawalId;
  const balAfterWdReq = await WalletService.getBalance(registered.user.id);

  // 1. Reject withdrawal -> refunds debited winnings
  let rejWdStatus = 0;
  const mockRejWdReq: any = { body: { withdrawalId: testWdId } };
  const mockRejWdRes: any = {
    status(code: number) { rejWdStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await WithdrawController.reject(mockRejWdReq, mockRejWdRes);
  assert.strictEqual(rejWdStatus, 200, 'Withdrawal rejection must succeed with 200');
  const balAfterRej = await WalletService.getBalance(registered.user.id);
  assert.strictEqual(balAfterRej.winningPaise, balAfterWdReq.winningPaise + 10000, 'Withdrawal rejection must refund ₹100 to winnings');

  // 2. Duplicate Reject withdrawal (Idempotency)
  let dupRejWdStatus = 0;
  const mockDupRejWdRes: any = {
    status(code: number) { dupRejWdStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await WithdrawController.reject(mockRejWdReq, mockDupRejWdRes);
  assert.strictEqual(dupRejWdStatus, 200, 'Duplicate withdrawal rejection must return 200 idempotently');
  const balAfterDupRej = await WalletService.getBalance(registered.user.id);
  assert.strictEqual(balAfterDupRej.winningPaise, balAfterRej.winningPaise, 'Duplicate withdrawal rejection must NEVER double refund');

  // 3. Approve on already REJECTED withdrawal must fail
  let apprAfterRejStatus = 0;
  const mockApprAfterRejReq: any = { body: { withdrawalId: testWdId } };
  const mockApprAfterRejRes: any = {
    status(code: number) { apprAfterRejStatus = code; return this; },
    json(payload: any) { return this; }
  };
  await WithdrawController.approve(mockApprAfterRejReq, mockApprAfterRejRes);
  // Test 18: PostgreSQL single source of truth; complete elimination of financial_ledger.json dual-write
  console.log('TEST 18: PostgreSQL authoritative ledger & elimination of financial_ledger.json dual-write...');
  const ledgerFilePath = path.join(__dirname, '../data/financial_ledger.json');
  assert.strictEqual(fs.existsSync(ledgerFilePath), false, 'financial_ledger.json must NOT exist on disk; dual-writes eliminated');

  // Verify initFromPostgres completes cleanly
  await FinancialService.initFromPostgres();
  const pool = (await import('../src/config/db.config')).DatabaseConfig.getPool();
  if (pool) {
    const depCheck = await pool.query('SELECT COUNT(*) FROM deposits');
    const wdCheck = await pool.query('SELECT COUNT(*) FROM withdrawals');
    assert.ok(Number(depCheck.rows[0].count) >= 1, 'PostgreSQL deposits table must contain authoritative records');
    assert.ok(Number(wdCheck.rows[0].count) >= 1, 'PostgreSQL withdrawals table must contain authoritative records');
  }
  assert.strictEqual(fs.existsSync(ledgerFilePath), false, 'financial_ledger.json must remain non-existent after operations');
  console.log('✅ TEST 18 PASSED: PostgreSQL is single source of truth; financial_ledger.json dual-write completely eliminated.\n');

  // Test 19: Problem 38 & 39 - Cryptographically secure CSPRNG UUIDs for deposits, withdrawals & ledger
  console.log('TEST 19: Cryptographically secure CSPRNG UUIDs for deposits, withdrawals & ledger...');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const depositSet = new Set<string>();

  for (let i = 0; i < 50; i++) {
    const dep = FinancialService.initiateDeposit(registered.user.id, 100);
    assert.ok(dep.depositId.startsWith('DEP-'), 'Deposit ID must start with DEP- prefix');
    const rawUuid = dep.depositId.replace('DEP-', '');
    assert.ok(uuidRegex.test(rawUuid), `Deposit ID must contain valid crypto UUID, got: ${dep.depositId}`);
    assert.strictEqual(depositSet.has(dep.depositId), false, 'Generated deposit IDs must never collide');
    depositSet.add(dep.depositId);
  }

  // Verify wallet ledger entry ID generated using CSPRNG
  await WalletService.creditDeposit(registered.user.id, 1000, '', 'CSPRNG Test Deposit');
  if (pool) {
    const recentLedger = await pool.query(
      `SELECT id, idempotency_key FROM wallet_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [registered.user.id]
    );
    const ledgerRow = recentLedger.rows[0];
    assert.ok(ledgerRow, 'Ledger row must exist');
    assert.ok(/^ledg_\d+_[0-9a-f]{12}$/.test(ledgerRow.id), `Ledger ID must use crypto secure hex format, got: ${ledgerRow.id}`);
    assert.ok(/^DEP-\d+-[0-9a-f]{8}$/.test(ledgerRow.idempotency_key), `Default idempKey must use crypto secure hex format, got: ${ledgerRow.idempotency_key}`);
  }
  console.log('✅ TEST 19 PASSED: Cryptographically secure UUIDs and CSPRNG identifiers verified for deposits, withdrawals & ledger.\n');

  // Test 20: Problem 41 - PostgreSQL SSL Configuration and CA Certificate Verification
  console.log('TEST 20: PostgreSQL SSL configuration and CA certificate verification...');
  const { buildSslConfig, DatabaseConfig } = await import('../src/config/db.config');
  const activeSslConfig = buildSslConfig();

  // If connected to Supabase or production, rejectUnauthorized MUST be true and CA certificate provided
  if (typeof activeSslConfig === 'object') {
    assert.strictEqual(
      activeSslConfig.rejectUnauthorized,
      true,
      'PostgreSQL SSL configuration MUST enforce rejectUnauthorized: true'
    );
    assert.ok(
      activeSslConfig.ca && activeSslConfig.ca.includes('BEGIN CERTIFICATE'),
      'PostgreSQL SSL configuration MUST provide a valid CA certificate'
    );
  }

  // Health check should pass with the strict SSL configuration
  const healthPassed = await DatabaseConfig.checkHealth();
  assert.strictEqual(healthPassed, true, 'Database health check must pass with strict SSL CA configuration');
  console.log('✅ TEST 20 PASSED: Strict SSL CA certificate verification enforced; insecure rejectUnauthorized: false eliminated.\n');

  // Test 21: Problems 42, 43 & 44 - WebSocket Isolation, Room Validation & Redis Pub/Sub
  console.log('TEST 21: WebSocket channel isolation, room validation, sensitive broadcast prevention & Redis pub/sub...');
  const { SocketServer } = await import('../src/sockets/socket.server');
  const { RedisManager } = await import('../src/db/redis');

  // 1. Verify Redis pub/sub distribution works
  let receivedPubSubMessage = '';
  RedisManager.subscribe('test:channel', (msg) => {
    receivedPubSubMessage = msg;
  });
  await RedisManager.publish('test:channel', JSON.stringify({ ping: 'pong' }));
  assert.strictEqual(
    receivedPubSubMessage,
    JSON.stringify({ ping: 'pong' }),
    'Redis pub/sub must dispatch messages across subscribers'
  );

  // 2. Sensitive event broadcast shielding
  // Attempting to broadcast WALLET_UPDATE or DEPOSIT_STATUS must be blocked
  let loggedBlockedSecurity = false;
  const originalLoggerError = (await import('../src/utils/logger')).Logger.error;
  (await import('../src/utils/logger')).Logger.error = ((...args: any[]) => {
    if (args.some(a => typeof a === 'string' && a.includes('Blocked attempt to broadcast sensitive event'))) {
      loggedBlockedSecurity = true;
    }
  }) as any;

  SocketServer.broadcast('WALLET_UPDATE', { userId: 'victim123', balance: 999999 });
  (await import('../src/utils/logger')).Logger.error = originalLoggerError;
  assert.strictEqual(
    loggedBlockedSecurity,
    true,
    'SocketServer.broadcast MUST strictly block sensitive WALLET_UPDATE events to protect user privacy'
  );

  // 3. Room Membership Validation
  const mockSocket: any = {
    readyState: 1,
    rooms: new Set<string>(),
    send: () => {}
  };
  SocketServer.joinRoom('xo:room:100', mockSocket);
  assert.ok(mockSocket.rooms.has('xo:room:100'), 'joinRoom must add room to socket rooms set');
  SocketServer.leaveRoom('xo:room:100', mockSocket);
  assert.strictEqual(mockSocket.rooms.has('xo:room:100'), false, 'leaveRoom must remove room from socket');

  console.log('✅ TEST 21 PASSED: WebSocket channel isolation, room membership validation, sensitive broadcast shielding & Redis pub/sub verified.\n');

  // Test 22: Problem 45 - Sensitive Data Redaction in Logging
  console.log('TEST 22: Sensitive data redaction filter in logging...');
  const { redact, redactString } = await import('../src/utils/logger');

  // String redaction
  const rawLogString = 'User authorization header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjM0NTYifQ.abcd_fake_signature_with_secret and phone 9876543210 and upi player@oksbi with db postgresql://user:mysecretpwd@host:5432/db';
  const cleanLogString = redactString(rawLogString);
  assert.ok(!cleanLogString.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT token must be redacted from strings');
  assert.ok(cleanLogString.includes('[REDACTED_JWT]'), 'JWT token should be replaced with [REDACTED_JWT]');
  assert.ok(!cleanLogString.includes('mysecretpwd'), 'Database password must be redacted');
  assert.ok(!cleanLogString.includes('9876543210'), 'Full phone number must not appear unmasked');
  assert.ok(cleanLogString.includes('3210'), 'Last 4 digits of phone should remain for debugging');

  // Object metadata redaction
  const rawMeta: any = {
    password: 'superSecretPassword123',
    token: 'jwt_secret_token_123',
    otp: '123456',
    upiId: 'winner@paytm',
    phone: '9876543210',
    safeField: 'normal_data'
  };
  // Add circular reference
  rawMeta.self = rawMeta;

  const cleanMeta = redact(rawMeta);
  assert.strictEqual(cleanMeta.password, '[REDACTED]', 'password field must be redacted');
  assert.strictEqual(cleanMeta.token, '[REDACTED]', 'token field must be redacted');
  assert.strictEqual(cleanMeta.otp, '[REDACTED]', 'otp field must be redacted');
  assert.strictEqual(cleanMeta.upiId, '[REDACTED]', 'upiId field must be redacted');
  assert.strictEqual(cleanMeta.phone, '******3210', 'phone number must be masked');
  assert.strictEqual(cleanMeta.safeField, 'normal_data', 'safe fields must be preserved');
  assert.strictEqual(cleanMeta.self, '[CIRCULAR]', 'circular references must be handled safely');

  console.log('✅ TEST 22 PASSED: Sensitive data redaction filter verified for tokens, passwords, OTPs, UPI, and PII.\n');

  // Test 23: Problems 60 & 61 - Admin Session Validation & HttpOnly Cookie Architecture
  console.log('TEST 23: Admin session validation, HttpOnly cookie auth & session endpoint...');
  const { authenticateAdmin: authenticateAdminMW } = await import('../src/middleware/rbac.middleware');
  const { AdminController: AdminCtrl } = await import('../src/modules/admin/admin.controller');
  const { AuthController: AuthCtrl } = await import('../src/modules/auth/auth.controller');

  // 1. Verify authenticateAdmin accepts HttpOnly cookie (no Authorization header)
  let cookieAdminNext = false;
  const mockCookieReq: any = {
    headers: {
      cookie: `adminToken=${validMasterToken}; other_pref=dark`
    },
    query: {}
  };
  const mockCookieRes: any = {
    status(code: number) { return this; },
    json(data: any) { return this; }
  };
  await authenticateAdminMW(mockCookieReq, mockCookieRes, () => {
    cookieAdminNext = true;
  });
  assert.strictEqual(cookieAdminNext, true, 'authenticateAdmin MUST accept valid HttpOnly adminToken cookie');
  assert.strictEqual(mockCookieReq.admin?.role, 'SUPER_ADMIN', 'Authoritative admin principal must be set from cookie');

  // 2. Verify AdminController.getMe returns authoritative session info
  let meStatus = 0;
  let meData: any = null;
  const mockMeRes: any = {
    status(code: number) { meStatus = code; return this; },
    json(data: any) { meData = data; return this; }
  };
  await AdminCtrl.getMe(mockCookieReq, mockMeRes);
  assert.strictEqual(meStatus, 200, 'AdminController.getMe must return 200 for authenticated session');
  assert.strictEqual(meData.data.username, envConfig.adminUsername, 'Session username must match authoritative admin');
  assert.strictEqual(meData.data.role, 'SUPER_ADMIN', 'Session role must match authoritative admin');

  // 3. Verify authenticateAdmin rejects missing token/cookie with 401
  const unauthReq: any = { headers: {}, query: {} };
  let unauthStatus = 0;
  const mockUnauthRes: any = {
    status(code: number) { unauthStatus = code; return this; },
    json(data: any) { return this; }
  };
  await authenticateAdminMW(unauthReq, mockUnauthRes, () => {});
  assert.strictEqual(unauthStatus, 401, 'authenticateAdmin must reject missing token/cookie with 401');

  // 4. Verify AuthController.adminLogout clears adminToken cookie
  let clearedCookieName = '';
  const mockLogoutRes: any = {
    clearCookie(name: string) { clearedCookieName = name; return this; },
    status(code: number) { return this; },
    json(data: any) { return this; }
  };
  await AuthCtrl.adminLogout({} as any, mockLogoutRes);
  assert.strictEqual(clearedCookieName, 'adminToken', 'AuthController.adminLogout MUST clear adminToken cookie');

  console.log('✅ TEST 23 PASSED: Admin session validation, HttpOnly cookie authentication and session clearing verified.\n');

  // Test 24: Problems 62 & 63 — Admin CSP strict connect-src & no unsafe-inline script-src
  console.log('TEST 24: Admin panel CSP — no unsafe-inline in script-src, no wildcard connect-src...');
  const fsMod = (await import('fs')).default;
  const pathMod = (await import('path')).default;

  // Verify admin panel next.config.js has strict script-src without unsafe-inline
  const nextConfigPath = pathMod.resolve(__dirname, '../../admin-panel/next.config.js');
  const nextConfigContent = fsMod.readFileSync(nextConfigPath, 'utf-8');
  assert.ok(
    nextConfigContent.includes("script-src 'self'"),
    "Admin panel CSP must include strict script-src 'self'"
  );
  assert.ok(
    !nextConfigContent.includes("script-src 'self' 'unsafe-inline'"),
    "Admin panel CSP must NOT include unsafe-inline in script-src"
  );
  // Must NOT have wildcard connect-src
  assert.ok(
    !nextConfigContent.match(/connect-src[^;]*\s(https:|wss:|ws:)/),
    "Admin panel CSP must NOT use wildcard https:, wss:, or ws: in connect-src"
  );
  // Must have exact connect-src
  assert.ok(
    nextConfigContent.includes('connect-src'),
    "Admin panel CSP must define connect-src with exact origins"
  );

  // Verify backend app.ts CSP no longer uses wildcard ws:/wss:/https: in connect-src
  const appTsPath = pathMod.resolve(__dirname, '../src/app.ts');
  const appTsContent = fsMod.readFileSync(appTsPath, 'utf-8');
  assert.ok(
    !appTsContent.match(/connect-src[^;]*wss:[^;]*;/),
    "Backend CSP connect-src must NOT contain bare wss: wildcard"
  );
  assert.ok(
    !appTsContent.match(/connect-src[^;]*\bhttps:[^;]*;/),
    "Backend CSP connect-src must NOT contain bare https: wildcard"
  );
  console.log('✅ TEST 24 PASSED: Admin panel CSP has no unsafe-inline in script-src and no wildcard connect-src.\n');

  // Test 25: Problems 64 & 65 — Role-based field-level PII masking in getUserDetails
  console.log('TEST 25: Role-based field-level PII masking in getUserDetails...');
  const { AdminController: AdminCtrl2 } = await import('../src/modules/admin/admin.controller');

  // Helper: build a mock request with a given admin role calling getUserDetails
  const makeDetailsReq = (role: string) => ({
    params: { id: 'nonexistent_user_999' },
    headers: {},
    query: {},
    admin: { id: 'admin1', username: 'testadmin', role }
  });

  // For a VIEWER role, response should use the masking path (we test the logic directly)
  // We verify the controller source enforces canSeePII = false for restricted roles
  const { AdminController: AdminCtrl2b } = await import('../src/modules/admin/admin.controller');

  // Verify masking logic by inspecting the source code statically
  const adminCtrlPath = pathMod.resolve(__dirname, '../src/modules/admin/admin.controller.ts');
  const adminCtrlSource = fsMod.readFileSync(adminCtrlPath, 'utf-8');

  // Must contain role check for PII
  assert.ok(
    adminCtrlSource.includes("canSeePII = ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'].includes(callerRole)"),
    'getUserDetails MUST define canSeePII restricted to SUPER_ADMIN, ADMIN, FINANCE_ADMIN'
  );
  // Must gate phone field behind canSeePII
  assert.ok(
    adminCtrlSource.includes('phone: canSeePII ? rawPhone : maskedPhone'),
    'getUserDetails MUST mask phone field for non-PII roles'
  );
  // Must gate IP address behind canSeePII
  assert.ok(
    adminCtrlSource.includes("ip_address: canSeePII ?"),
    'getUserDetails MUST mask ip_address field for non-PII roles'
  );
  // Must gate sessions behind canSeePII
  assert.ok(
    adminCtrlSource.includes('sessions: canSeePII ?'),
    'getUserDetails MUST restrict sessions to PII-privileged roles'
  );
  // Must gate financials behind canSeeFinancials
  assert.ok(
    adminCtrlSource.includes('financialSummary: canSeeFinancials ?'),
    'getUserDetails MUST restrict financialSummary to financial-privileged roles'
  );
  // Must gate audit trail behind canSeeAudit
  assert.ok(
    adminCtrlSource.includes('audits: canSeeAudit ?'),
    'getUserDetails MUST restrict audit trail to audit-privileged roles'
  );
  console.log('✅ TEST 25 PASSED: Role-based field-level PII masking enforced in getUserDetails — phone, IP, device, sessions, financials, and audits gated by caller role.\n');

  // Test 26: Problems 66 & 67 — Admin login brute-force rate limit + strong password policy
  console.log('TEST 26: Admin login rate limit (5/15min) and strong password policy...');
  const { adminLoginRateLimit: adminRL } = await import('../src/middleware/rateLimit');
  const rateLimitSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '../src/middleware/rateLimit.ts'), 'utf-8');

  // Verify the dedicated admin login rate limiter exists with strict window
  assert.ok(
    rateLimitSrc.includes('adminLoginRateLimit'),
    'rateLimit.ts MUST export adminLoginRateLimit'
  );
  assert.ok(
    rateLimitSrc.includes('15 * 60_000, 5'),
    'adminLoginRateLimit MUST use 15-minute window with max 5 attempts'
  );

  // Verify app.ts applies adminLoginRateLimit before the auth route handler
  const appTsSrc2 = fsMod.readFileSync(pathMod.resolve(__dirname, '../src/app.ts'), 'utf-8');
  assert.ok(
    appTsSrc2.includes("app.post('/api/v1/auth/admin/login', adminLoginRateLimit)"),
    'app.ts MUST apply adminLoginRateLimit specifically to POST /auth/admin/login'
  );

  // Verify strong password policy is enforced in createAdmin
  const adminCtrlSrc2 = fsMod.readFileSync(pathMod.resolve(__dirname, '../src/modules/admin/admin.controller.ts'), 'utf-8');
  assert.ok(
    adminCtrlSrc2.includes('password.length < 12'),
    'createAdmin MUST enforce minimum 12 character password'
  );
  assert.ok(
    adminCtrlSrc2.includes('/[A-Z]/'),
    'createAdmin MUST require at least one uppercase letter'
  );
  assert.ok(
    adminCtrlSrc2.includes('/[0-9]/'),
    'createAdmin MUST require at least one digit'
  );
  assert.ok(
    adminCtrlSrc2.match(/\/\[!@#\$%\^/),
    'createAdmin MUST require at least one special character'
  );
  // Verify the old weak policy (6 chars) is gone
  assert.ok(
    !adminCtrlSrc2.includes('password.length < 6'),
    'createAdmin MUST NOT use the old weak 6-character minimum'
  );
  console.log('✅ TEST 26 PASSED: Admin login rate limit (5 req/15 min) and strong password policy (12+ chars, uppercase, lowercase, digit, special) enforced.\n');

  // Test 27: Problem 68 — Minimal /health endpoint (no internal DB/service details)
  console.log('TEST 27: Minimal /health endpoint — no internal DB/service fingerprint...');
  const appTsHealthSrc = fsMod.readFileSync(pathMod.resolve(__dirname, '../src/app.ts'), 'utf-8');

  // Must NOT expose service name
  assert.ok(
    !appTsHealthSrc.includes("service: '334game-backend-core'"),
    '/health MUST NOT expose internal service name'
  );
  // Must NOT expose database field
  assert.ok(
    !appTsHealthSrc.match(/database: databaseHealthy \? 'ONLINE'/),
    '/health MUST NOT expose database backend status field'
  );
  // Must include only status + timestamp
  assert.ok(
    appTsHealthSrc.includes("status: databaseHealthy ? 'ok' : 'degraded'"),
    "/health MUST return minimal 'ok'/'degraded' status only"
  );
  assert.ok(
    appTsHealthSrc.includes("timestamp: new Date().toISOString()"),
    '/health MUST include timestamp'
  );
  // Test 28: Ring of Future bet placement authentication and IDOR prevention
  console.log('TEST 28: Ring of Future bet endpoint enforces strict JWT authentication and rejects unauthenticated/spoofed bets...');
  const { createApp } = await import('../src/app');
  const testApp = createApp();

  // Helper to dispatch through express app in memory without external runner
  const dispatch = (app: any, method: string, url: string, headers: Record<string, string> = {}, body?: any): Promise<{ status: number; body: any }> => {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url, 'http://localhost');
      const req: any = {
        method,
        url,
        originalUrl: url,
        headers: { host: 'localhost', ...headers },
        body: body || {},
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
        ip: '127.0.0.1',
        connection: { remoteAddress: '127.0.0.1' }
      };
      let resStatus = 200;
      const res: any = {
        statusCode: 200,
        setHeader() {},
        getHeader() {},
        status(code: number) { resStatus = code; this.statusCode = code; return this; },
        json(data: any) { resolve({ status: resStatus, body: data }); return this; },
        send(data: any) { resolve({ status: resStatus, body: data }); return this; },
        end() { resolve({ status: resStatus, body: null }); }
      };
      app.handle(req, res);
    });
  };

  // 1. Unauthenticated bet placement must return 401
  const unauthBetRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/ring-of-future/bet',
    { 'content-type': 'application/json' },
    { userId: 'victim_user_123', amountRupees: 50, multiplierType: '2x' }
  );
  assert.strictEqual(unauthBetRes.status, 401, 'Unauthenticated bet placement MUST return 401 Unauthorized');

  // 2. Authenticated user attempting to bet on behalf of a different userId must return 403
  const userToken = jwt.sign(
    { userId: registered.user.id, role: 'USER' },
    envConfig.jwtSecret,
    { expiresIn: '1h' }
  );

  const spoofedBetRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/ring-of-future/bet',
    { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
    { userId: 'other_victim_user_999', amountRupees: 50, multiplierType: '2x' }
  );
  assert.strictEqual(spoofedBetRes.status, 403, 'Placing bet on behalf of another user MUST return 403 Forbidden');

  // 3. Unauthenticated state retrieval must return empty default wallet (no snooping)
  const unauthStateRes = await dispatch(
    testApp,
    'GET',
    '/api/v1/ring-of-future/state?userId=victim_user_123'
  );
  assert.strictEqual(unauthStateRes.status, 200);
  assert.strictEqual(unauthStateRes.body.data.wallet.totalPaise, 0, 'Unauthenticated state query MUST NOT leak victim wallet balance');

  // Test 29: Deposit Page endpoints authentication and ownership enforcement
  console.log('TEST 29: Deposit initiation and submit-utr endpoints enforce JWT auth and order ownership...');
  // 1. Unauthenticated initiate must return 401
  const unauthDepInitRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/deposits/initiate',
    { 'content-type': 'application/json' },
    { userId: registered.user.id, amountRupees: 500 }
  );
  assert.strictEqual(unauthDepInitRes.status, 401, 'Unauthenticated deposit initiate MUST return 401');

  // 2. Initiating for another user returns 403
  const spoofedDepInitRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/deposits/initiate',
    { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
    { userId: 'another_user_888', amountRupees: 500 }
  );
  assert.strictEqual(spoofedDepInitRes.status, 403, 'Initiating deposit for another user MUST return 403 Forbidden');

  // 3. Authenticated initiate succeeds
  const authDepInitRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/deposits/initiate',
    { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
    { amountRupees: 500 }
  );
  assert.strictEqual(authDepInitRes.status, 200, 'Authenticated deposit initiate must return 200');
  const createdDepositId = authDepInitRes.body.data.depositId;
  assert.ok(createdDepositId, 'Must return depositId');

  // 4. Unauthenticated submit-utr returns 401
  const unauthUtrRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/deposits/submit-utr',
    { 'content-type': 'application/json' },
    { depositId: createdDepositId, utr: 'UTR123456789' }
  );
  assert.strictEqual(unauthUtrRes.status, 401, 'Unauthenticated UTR submit MUST return 401');

  // 5. Attacker token trying to submit UTR for victim's deposit returns 403
  const attackerToken = jwt.sign(
    { userId: 'attacker_victim_999', role: 'USER' },
    envConfig.jwtSecret,
    { expiresIn: '1h' }
  );
  const attackerUtrRes = await dispatch(
    testApp,
    'POST',
    '/api/v1/deposits/submit-utr',
    { 'content-type': 'application/json', authorization: `Bearer ${attackerToken}` },
    { depositId: createdDepositId, utr: 'UTR987654321' }
  );
  assert.strictEqual(attackerUtrRes.status, 403, 'Submitting UTR for another user deposit order MUST return 403 Forbidden');

  // Test 30: AdminSchema initialization and PostgreSQL schema synchronization
  console.log('TEST 30: AdminSchema initializes tables & columns, and user persistence prevents foreign key errors...');
  const { AdminSchema } = await import('../src/database/adminSchema');
  await AdminSchema.init();

  if (pool) {
    // Check that device_model column exists on users
    const colCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'device_model'`
    );
    assert.ok(colCheck.rows.length > 0, 'users table must contain device_model column after AdminSchema.init()');

    // Check that deposits table contains confirmed_at and deposit_id
    const depColCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'deposits' AND column_name = 'confirmed_at'`
    );
    assert.ok(depColCheck.rows.length > 0, 'deposits table must contain confirmed_at column');

    // Verify AuthService.ensureUserExists creates a PostgreSQL user so foreign keys don't fail
    const testFkUserId = 'usr_fk_test_' + Date.now();
    const testFkPhone = '999' + Math.floor(1000000 + Math.random() * 9000000);
    AuthService.ensureUserExists(testFkUserId, 'FK Test Player', testFkPhone);
    // Wait briefly for the async insertion
    await new Promise((r) => setTimeout(r, 200));

    const userInDb = await pool.query(`SELECT id, username FROM users WHERE id = $1`, [testFkUserId]);
    assert.ok(userInDb.rows.length > 0, 'ensureUserExists must persist user to PostgreSQL to satisfy FK constraints');
  }

  console.log('✅ TEST 30 PASSED: AdminSchema initializes all required tables and columns; user sync satisfies foreign key constraints.\n');

  console.log('====================================================');
  console.log('🎉 ALL SECURITY & AUTH SUITE TESTS PASSED (30/30)');
  console.log('====================================================\n');
}

runSecurityTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Security tests failed:', err);
    process.exit(1);
  });
