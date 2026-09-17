export interface Transaction {
  id: string;
  userId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'BET_DEBIT' | 'WIN_PAYOUT' | 'BET_REFUND' | 'BONUS_CREDIT' | 'ADMIN_ADJUST';
  amountPaise: number;
  balanceAfterPaise: number;
  status: 'PENDING' | 'SUCCESS' | 'REJECTED' | 'FAILED';
  referenceId: string;
  description: string;
  timestamp: number;
}
