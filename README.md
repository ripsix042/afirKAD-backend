# AfriKAD Backend API

Node.js + Express.js backend for AfriKAD fintech platform.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

3. Update `.env` with your:
   - MongoDB connection string
   - JWT secret
   - Kora API credentials

4. Start MongoDB (if running locally)

5. Run the server:
```bash
npm run dev  # Development mode with nodemon
# or
npm start    # Production mode
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user (requires auth)

### Wallet
- `GET /api/wallet/balance` - Get wallet balance (requires auth)
- `POST /api/wallet/deposit` - Deposit NGN (requires auth)

### Payments
- `POST /api/pay` - Process payment with FX conversion (requires auth)

### Transactions
- `GET /api/transactions` - Get user transactions (requires auth)
- `GET /api/transactions/:id` - Get single transaction (requires auth)

### Admin (requires admin role)
- `GET /api/admin/dashboard` - Dashboard overview
- `GET /api/admin/charts/volume` - Volume charts data
- `GET /api/admin/charts/status` - Status breakdown charts
- `GET /api/admin/users` - List all users
- `GET /api/admin/transactions` - List all transactions

## Kora API Integration

The backend integrates with Kora API for:
- Customer creation
- Virtual card creation
- Instant FX swaps (NGN → USD)
- Card payment authorization

Make sure to set `KORA_API_KEY`, `KORA_SECRET_KEY`, and `KORA_BASE_URL` in `.env`.

## Nginx / reverse proxy (413 Request Entity Too Large)

If the API sits behind nginx and KYC (card) uploads return **413 Request Entity Too Large**, increase the body limit in your nginx config:

```nginx
# In your server { } or http { } block:
client_max_body_size 10M;
```

Then reload nginx: `sudo nginx -s reload`
