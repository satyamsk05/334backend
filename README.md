# Backend Service — 3334Game

Authoritative server backend responsible for:
- User Authentication & Session Verification (`auth/`)
- Game State Engine & RNG Outcome Generation (`game/`)
- Account Balances & Ledger Transactions (`account/`, `transactions/`)
- Provable Fairness Commit-Reveal Protocol (`fairness/`)
- Admin Operations & Audit Logging (`admin/`, `audit/`)

## Module Structure

```text
backend/
├── src/
│   ├── auth/          # Authentication & JWT tokens
│   ├── game/          # Round lifecycle, WS events & RNG
│   ├── account/       # Wallet state manager
│   ├── transactions/  # Idempotent financial ledger
│   ├── fairness/      # Commitment & reveal protocol
│   ├── admin/         # Authorized admin APIs
│   └── audit/         # Immutable audit trail
```
