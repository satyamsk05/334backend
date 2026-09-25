import assert from 'assert';
import { Pool } from 'pg';
import { DatabaseConfig } from '../src/config/db.config';
import { WalletService } from '../src/modules/wallet/wallet.service';

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING POSTGRESQL WALLET PERSISTENCE TEST SUITE');
  console.log('====================================================\n');

  // Verify DB connection
  const isHealthy = await DatabaseConfig.checkHealth();
  assert.strictEqual(isHealthy, true, 'Database must be online');
  const pool = DatabaseConfig.getPool()!;

  const testUserId = `test_usr_${Date.now()}`;
  console.log(`👤 Using test user: ${testUserId}\n`);

  try {
    // ----------------------------------------------------
    // TEST 1: Deposit Credit
    // ----------------------------------------------------
    console.log('TEST 1: Deposit Credit...');
    const depAmount = 50000; // ₹500 in paise
    const depKey = `dep_test_${Date.now()}`;
    const afterDeposit = await WalletService.creditDeposit(testUserId, depAmount, depKey, 'Test Deposit', depKey);

    assert.strictEqual(afterDeposit.depositPaise, 50000, 'depositPaise should be 50000');
    assert.strictEqual(afterDeposit.winningPaise, 0, 'winningPaise should be 0');
    assert.strictEqual(afterDeposit.bonusPaise, 0, 'bonusPaise should be 0');
    assert.strictEqual(afterDeposit.totalPaise, 50000, 'totalPaise should be 50000');

    // Query DB directly to verify durability
    const rawWallet1 = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [testUserId]);
    assert.strictEqual(rawWallet1.rows.length, 1, 'Wallet row must exist in DB');
    assert.strictEqual(Number(rawWallet1.rows[0].deposit_balance), 50000, 'DB deposit_balance must be 50000');
    assert.strictEqual(Number(rawWallet1.rows[0].available_balance), 50000, 'DB available_balance must be 50000');

    // Verify ledger
    const rawLedger1 = await pool.query('SELECT * FROM wallet_ledger WHERE idempotency_key = $1', [depKey]);
    assert.strictEqual(rawLedger1.rows.length, 1, 'Ledger entry must exist');
    assert.strictEqual(rawLedger1.rows[0].type, 'DEPOSIT');
    assert.strictEqual(rawLedger1.rows[0].direction, 'CREDIT');
    assert.strictEqual(Number(rawLedger1.rows[0].amount), 50000);
    console.log('✅ TEST 1 PASSED: Deposit correctly credited and persisted in PostgreSQL.\n');

    // ----------------------------------------------------
    // TEST 2: Bet Debit (Bucket Priority: Deposit -> Winning -> Bonus)
    // ----------------------------------------------------
    console.log('TEST 2: Bet Debit Bucket Priority...');
    // Add ₹200 bonus
    await WalletService.creditBonus(testUserId, 20000, `bon_${Date.now()}`, 'Test Bonus');
    // Balance is now: deposit 50000, winning 0, bonus 20000 (total: 70000)

    // Debit ₹600 (60000 paise): should debit 50000 from deposit, 0 from winning, 10000 from bonus
    const debitRes = await WalletService.debitBet(
      testUserId,
      60000,
      `bet_ref_${Date.now()}`,
      'Test 600 Bet',
      `bet_idemp_${Date.now()}`
    );

    assert.strictEqual(debitRes.success, true, 'Bet debit should succeed');
    assert.strictEqual(debitRes.debitBreakdown?.depositDebited, 50000, 'Deposit should be debited 50000');
    assert.strictEqual(debitRes.debitBreakdown?.winningDebited, 0, 'Winning should be debited 0');
    assert.strictEqual(debitRes.debitBreakdown?.bonusDebited, 10000, 'Bonus should be debited 10000');

    assert.strictEqual(debitRes.newBalance?.depositPaise, 0, 'Remaining deposit should be 0');
    assert.strictEqual(debitRes.newBalance?.winningPaise, 0, 'Remaining winning should be 0');
    assert.strictEqual(debitRes.newBalance?.bonusPaise, 10000, 'Remaining bonus should be 10000');
    assert.strictEqual(debitRes.newBalance?.totalPaise, 10000, 'Remaining total should be 10000');
    console.log('✅ TEST 2 PASSED: Bet debit correctly respects deposit -> winning -> bonus order.\n');

    // ----------------------------------------------------
    // TEST 3: Insufficient Balance
    // ----------------------------------------------------
    console.log('TEST 3: Insufficient Balance...');
    // Attempt to debit ₹500 (50000 paise) when only ₹100 (10000 paise) is available
    const failDebit = await WalletService.debitBet(
      testUserId,
      50000,
      `bet_fail_${Date.now()}`,
      'Excessive Bet',
      `bet_fail_idemp_${Date.now()}`
    );

    assert.strictEqual(failDebit.success, false, 'Debit must fail');
    assert.strictEqual(failDebit.message, 'Insufficient balance');

    // Verify balance untouched
    const balAfterFail = await WalletService.getBalance(testUserId);
    assert.strictEqual(balAfterFail.totalPaise, 10000, 'Balance must remain unchanged after rejected bet');
    console.log('✅ TEST 3 PASSED: Insufficient balance rejected and balance remains untouched.\n');

    // ----------------------------------------------------
    // TEST 4: Winning Payout (Credits Winnings Bucket Only)
    // ----------------------------------------------------
    console.log('TEST 4: Winning Payout...');
    const winAmount = 30000; // ₹300
    const winRes = await WalletService.creditWinnings(
      testUserId,
      winAmount,
      `win_ref_${Date.now()}`,
      'Game Win 3x',
      `win_idemp_${Date.now()}`
    );

    assert.strictEqual(winRes.depositPaise, 0, 'Deposit must not change on win');
    assert.strictEqual(winRes.winningPaise, 30000, 'Winning bucket should receive 30000');
    assert.strictEqual(winRes.bonusPaise, 10000, 'Bonus must not change on win');
    assert.strictEqual(winRes.totalPaise, 40000, 'Total should be 40000');

    const rawWalletWin = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [testUserId]);
    assert.strictEqual(Number(rawWalletWin.rows[0].winnings_balance), 30000);
    console.log('✅ TEST 4 PASSED: Winning payout credits to winnings bucket only.\n');

    // ----------------------------------------------------
    // TEST 5: Bet Refund Equity (Restores Original Buckets)
    // ----------------------------------------------------
    console.log('TEST 5: Bet Refund Equity...');
    // Current: deposit=0, winning=30000, bonus=10000 (total: 40000)
    // Refund debited: deposit=20000, winning=10000, bonus=5000
    const refundRes = await WalletService.refundEquity(
      testUserId,
      20000,
      10000,
      5000,
      `ref_${Date.now()}`,
      'Bet Voided Refund',
      `ref_idemp_${Date.now()}`
    );

    assert.strictEqual(refundRes.depositPaise, 20000, 'Deposit should receive 20000');
    assert.strictEqual(refundRes.winningPaise, 40000, 'Winning should receive 10000 (30000 + 10000 = 40000)');
    assert.strictEqual(refundRes.bonusPaise, 15000, 'Bonus should receive 5000 (10000 + 5000 = 15000)');
    assert.strictEqual(refundRes.totalPaise, 75000, 'Total should be 75000');
    console.log('✅ TEST 5 PASSED: Refund equity restores original debited buckets accurately.\n');

    // ----------------------------------------------------
    // TEST 6: Concurrent Bet Attempts (Row-Level Locking & No Double Spend)
    // ----------------------------------------------------
    console.log('TEST 6: Concurrent Bet Attempts with Row Locking...');
    const raceUserId = `race_usr_${Date.now()}`;
    // Give user exactly ₹100 (10000 paise)
    await WalletService.creditDeposit(raceUserId, 10000, `race_seed_${Date.now()}`);

    // Fire 5 simultaneous bets of ₹80 (8000 paise) each
    const concurrentBets = [1, 2, 3, 4, 5].map((i) =>
      WalletService.debitBet(
        raceUserId,
        8000,
        `race_bet_${i}_${Date.now()}`,
        `Concurrent Bet #${i}`,
        `race_idemp_${i}_${Date.now()}`
      )
    );

    const raceResults = await Promise.all(concurrentBets);
    const successfulBets = raceResults.filter((r) => r.success);
    const failedBets = raceResults.filter((r) => !r.success);

    assert.strictEqual(successfulBets.length, 1, 'Exactly ONE concurrent bet of ₹80 out of ₹100 must succeed');
    assert.strictEqual(failedBets.length, 4, 'The other 4 concurrent bets must be rejected for insufficient funds');

    const finalRaceBalance = await WalletService.getBalance(raceUserId);
    assert.strictEqual(finalRaceBalance.totalPaise, 2000, 'Final balance must be exactly ₹20 (10000 - 8000 = 2000 paise)');
    console.log('✅ TEST 6 PASSED: Concurrency prevented double-spend via SELECT ... FOR UPDATE.\n');

    // ----------------------------------------------------
    // TEST 7: Duplicate Transaction / Idempotency
    // ----------------------------------------------------
    console.log('TEST 7: Duplicate Transaction / Idempotency...');
    const fixedIdempKey = `fixed_idemp_${Date.now()}`;
    const initialBal = await WalletService.getBalance(testUserId);

    // Call 1
    const credit1 = await WalletService.creditDeposit(testUserId, 15000, fixedIdempKey, 'First Credit', fixedIdempKey);
    // Call 2 with identical idempotency key
    const credit2 = await WalletService.creditDeposit(testUserId, 15000, fixedIdempKey, 'Duplicate Attempt', fixedIdempKey);

    assert.strictEqual(credit1.totalPaise, initialBal.totalPaise + 15000, 'First call must credit ₹150');
    assert.strictEqual(credit2.totalPaise, credit1.totalPaise, 'Duplicate call must NOT credit a second time');

    const idempRows = await pool.query('SELECT COUNT(*) FROM wallet_ledger WHERE idempotency_key = $1', [fixedIdempKey]);
    assert.strictEqual(Number(idempRows.rows[0].count), 1, 'Only one ledger row should exist for idempotency key');
    console.log('✅ TEST 7 PASSED: Idempotency key prevents duplicate financial processing.\n');

    // ----------------------------------------------------
    // TEST 8: Server Restart Persistence
    // ----------------------------------------------------
    console.log('TEST 8: Server Restart Persistence...');
    const currentBal = await WalletService.getBalance(testUserId);

    // Simulate server restart by creating a new standalone Pool instance disconnected from module state
    const newPool = new Pool({
      connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false }
    });
    const directQuery = await newPool.query(
      `SELECT deposit_balance, winnings_balance, rewards_balance, available_balance
       FROM wallets WHERE user_id = $1`,
      [testUserId]
    );
    await newPool.end();

    const persistedRow = directQuery.rows[0];
    assert.strictEqual(Number(persistedRow.deposit_balance), currentBal.depositPaise);
    assert.strictEqual(Number(persistedRow.winnings_balance), currentBal.winningPaise);
    assert.strictEqual(Number(persistedRow.rewards_balance), currentBal.bonusPaise);
    assert.strictEqual(Number(persistedRow.available_balance), currentBal.totalPaise);
    console.log('✅ TEST 8 PASSED: State persists in PostgreSQL across connections/restarts.\n');

    // ----------------------------------------------------
    // TEST 9: Transaction Rollback on Error
    // ----------------------------------------------------
    console.log('TEST 9: Transaction Rollback on Error...');
    const balBeforeRollback = await WalletService.getBalance(testUserId);

    // Simulate an aborted transaction
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await rollbackClient.query(
        `UPDATE wallets SET deposit_balance = deposit_balance + 999999 WHERE user_id = $1`,
        [testUserId]
      );
      // Intentionally rollback
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }

    const balAfterRollback = await WalletService.getBalance(testUserId);
    assert.strictEqual(balAfterRollback.depositPaise, balBeforeRollback.depositPaise, 'Deposit must not change on rolled back txn');
    assert.strictEqual(balAfterRollback.totalPaise, balBeforeRollback.totalPaise, 'Total must not change on rolled back txn');
    console.log('✅ TEST 9 PASSED: Transaction rollback cleanly reverts changes.\n');

    console.log('====================================================');
    console.log('🎉 ALL 9 WALLET PERSISTENCE TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');
  } finally {
    // Clean up test users to keep database tidy
    try {
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, `race_usr_${testUserId.split('_')[2]}`]);
    } catch (_) {}
    await DatabaseConfig.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test Suite Failed:', err);
  process.exit(1);
});
