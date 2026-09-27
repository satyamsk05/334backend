import assert from 'assert';
import jwt from 'jsonwebtoken';
import { envConfig } from '../src/config/env.config';
import { authenticateJwt } from '../src/modules/auth/auth.middleware';
import { ROLE_PERMISSIONS, requirePermission } from '../src/middleware/rbac.middleware';

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

  console.log('====================================================');
  console.log('🎉 ALL SECURITY & AUTH SUITE TESTS PASSED (3/3)');
  console.log('====================================================\n');
}

runSecurityTests().catch((err) => {
  console.error('❌ Security tests failed:', err);
  process.exit(1);
});
