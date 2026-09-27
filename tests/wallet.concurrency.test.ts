import assert from 'assert';
import { DatabaseConfig } from '../src/config/db.config';
import { WalletService } from '../src/modules/wallet/wallet.service';

async function runConcurrencyStressTest() {
  console.log('====================================================');
  console.log('⚡ RUNNING HIGH-CONCURRENCY WALLET STRESS TEST');
  console.log('====================================================\n');

  const isHealthy = await DatabaseConfig.checkHealth();
  assert.strictEqual(isHealthy, true, 'Database must be online');

  const testUserId = `stress_usr_${Date.now()}`;
  console.log(`👤 Initializing stress test user: ${testUserId}`);

  // Initial deposit: ₹1,000 (100,000 paise)
  const initDep = await WalletService.creditDeposit(
    testUserId,
    100000,
    `dep_init_${Date.now()}`,
    'Initial Stress Test Deposit',
    `idemp_dep_init_${Date.now()}`
  );
  assert.strictEqual(initDep.totalPaise, 100000, 'Initial balance should be 100,000 paise');

  console.log('⚡ Firing 10 concurrent bet debit requests in parallel (₹50 each = 5,000 paise)...');
  const betPromises = [];
  for (let i = 0; i < 10; i++) {
    const refId = `stress_bet_${Date.now()}_${i}`;
    betPromises.push(
      WalletService.debitBet(
        testUserId,
        5000,
        refId,
        `Concurrent Bet #${i + 1}`,
        `idemp_${refId}`
      )
    );
  }

  const results = await Promise.all(betPromises);
  const successCount = results.filter((r) => r.success).length;
  console.log(`📊 Concurrent bets completed: ${successCount}/10 succeeded.`);
  assert.strictEqual(successCount, 10, 'All 10 parallel bets should succeed without race conditions');

  // Expected balance: 100,000 - (10 * 5,000) = 50,000 paise
  const finalBal = await WalletService.getBalance(testUserId);
  console.log(`💰 Final verified balance: ${finalBal.totalPaise} paise (₹${(finalBal.totalPaise / 100).toFixed(2)})`);
  assert.strictEqual(finalBal.totalPaise, 50000, 'Final balance must be exactly 50,000 paise');

  console.log('\n✅ CONCURRENCY TEST PASSED: Zero race conditions, exact mathematical consistency.\n');
  process.exit(0);
}

runConcurrencyStressTest().catch((err) => {
  console.error('❌ Concurrency Test Failed:', err);
  process.exit(1);
});
