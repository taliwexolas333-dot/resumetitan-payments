# ResumeTitan AI — Crypto Payment System

Non-custodial cryptocurrency payment infrastructure for AI-powered career services.

## Architecture

```
crypto-pay/
├── app.js                 # Express web server (portal + dashboard + API)
├── db/schema.js           # SQLite database schema (sql.js)
├── services/sentinel.js   # Blockchain monitoring agent (BTC, POL, SOL)
├── config/wallets.json    # Wallet addresses & pricing configuration
├── public/
│   ├── index.html         # Customer payment portal
│   ├── dashboard.html     # Admin revenue dashboard
│   ├── css/style.css
│   └── js/
│       ├── app.js         # Customer portal logic
│       └── dashboard.js   # Admin dashboard logic
```

## Supported Currencies
- **Bitcoin (BTC)** — monitored via mempool.space API
- **Polygon (POL/MATIC)** — monitored via Polygonscan API or RPC
- **Solana (SOL)** — monitored via public Solana RPC

## Products & Pricing
| Product | USD | BTC (approx) |
|---|---|---|
| Professional Resume | $79 | 0.00116 |
| Cover Letter | $39 | 0.00057 |
| LinkedIn Optimization | $49 | 0.00072 |
| Interview Prep Guide | $59 | 0.00087 |
| Career Advisory Report | $49 | 0.00072 |
| Basic Bundle (3 services) | $149 | 0.00219 |
| Premium Bundle (all 5) | $219 | 0.00322 |

## Wallet Addresses (Owner Controlled)
- **BTC:** `bc1quvacykmvd6akyus02zl54m7khu2dstnl50ezxl`
- **POL:** `0x49AE3D13539674D04D71978CF4Ad8344464C6ac9`
- **SOL:** `HKBNwe5qkipHoZtAvmqgyL61ZaLschk2B1d1R3nWNaeD`

## How It Works
1. Customer selects a service → enters info → pays directly to your wallet
2. Sentinel monitors all 3 blockchains for incoming transactions
3. On sufficient confirmations → invoice confirmed → service fulfillment triggered
4. Dashboard tracks revenue, invoices, transactions, and audit log

## Quick Start
```bash
npm install
cp .env.example .env
node app.js                    # Web server (port 3000)
node services/sentinel.js      # Blockchain monitor (separate process)
```

## Security
- **Non-custodial:** Funds go directly to owner's wallets. Private keys never stored.
- **Audit trail:** Every payment event logged with timestamps
- **Expiry:** Invoices expire after 60 minutes
- **Duplicate prevention:** TXIDs tracked to prevent double-processing

## API Endpoints
- `GET /api/products` — Available services with crypto prices
- `POST /api/invoices` — Create payment request
- `GET /api/invoices/:id` — Check invoice status
- `GET /api/admin/stats` — Revenue dashboard stats
- `GET /api/admin/invoices` — All invoices
- `GET /api/admin/transactions` — All transactions
- `GET /api/admin/export` — Download CSV for accounting
- `GET /api/admin/audit` — Audit event log
