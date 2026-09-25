export enum DepositStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED'
}

export enum WithdrawalStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RISK_LOCKED = 'RISK_LOCKED'
}

export interface DepositOrder {
  depositId: string;
  userId: string;
  amountRupees: number;
  amountPaise: number;
  status: DepositStatus;
  utr?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WithdrawalRecord {
  withdrawalId: string;
  userId: string;
  amountRupees: number;
  amountPaise: number;
  payoutMethod: string;
  upiId: string;
  status: WithdrawalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface InitiateDepositRequest {
  userId: string;
  amountRupees: number;
}

export interface SubmitUtrRequest {
  depositId: string;
  utr: string;
}

export interface AdminDepositActionRequest {
  depositId: string;
  action: 'APPROVE' | 'REJECT';
}

export interface AdminWithdrawalActionRequest {
  withdrawalId: string;
  action: 'PROCESS' | 'APPROVE' | 'REJECT';
}
