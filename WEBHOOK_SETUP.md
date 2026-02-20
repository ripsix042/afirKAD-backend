# KoraPay Webhook Setup Guide

## Overview

This document explains how KoraPay webhooks are integrated into the AfriKAD backend.

---

## Receive webhooks locally (Cloudflare Tunnel)

To get webhooks on your machine (e.g. during development), expose your backend with Cloudflare Tunnel and point Kora to the public URL.

### 1. Install cloudflared (if needed)

- **macOS:** `brew install cloudflared`
- **Windows:** [Download](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)
- **Linux:** See [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)

### 2. Start your backend

```bash
cd backend
npm run dev
```

Leave this running. In another terminal, start the tunnel.

### 3. Start the tunnel (quick – temporary URL)

```bash
cd backend
npm run tunnel:quick
```

Copy the **HTTPS URL** shown (e.g. `https://abc123-def456.trycloudflare.com`). This URL changes each time you restart the tunnel.

**For a stable URL** (named tunnel with your domain), see [CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md).

### 4. Set BASE_URL and get webhook URL

In `backend/.env` add or update:

```env
BASE_URL=https://YOUR-TUNNEL-URL.trycloudflare.com
```

Replace with the URL from step 3 (no trailing slash). Restart the backend so it picks up the new `BASE_URL`.

Then run:

```bash
npm run webhook:url
```

This prints the exact URL to use in the Kora dashboard.

### 5. Register the URL in Kora

1. Open [Kora Dashboard](https://dashboard.korapay.com) → **Settings** → **API Configuration**.
2. Set **Notification URL** to the URL from step 4 (e.g. `https://YOUR-TUNNEL-URL.trycloudflare.com/api/webhooks/korapay`).
3. Save.

Keep the tunnel and backend running; Kora will send webhooks to this URL.

---

## Webhook Endpoint

**URL:** `POST /api/webhooks/korapay`

This endpoint receives webhook notifications from KoraPay. Configure this URL in your KoraPay dashboard:
- Go to **Settings** > **API Configuration**
- Under **Notification URL**, enter: `https://your-domain.com/api/webhooks/korapay`

## Webhook Security

All webhooks are verified using HMAC SHA256 signature:
- Header: `x-korapay-signature`
- Secret Key: `KORA_SECRET_KEY` from environment variables
- Signature is calculated from **ONLY the `data` object** in the payload (not the entire body)
- Invalid signatures are logged but still return 200 to prevent retries
- Webhook processing only proceeds if signature is valid

## Supported Webhook Events

### Payment Events

1. **`transfer.success`** / **`transfer.failed`**
   - Triggered for payouts, currency conversions, and transfers
   - Updates transaction status based on KoraPay reference
   - Matches transactions by `koraSwapId` or `koraTransactionId`

2. **`charge.success`** / **`charge.failed`**
   - Triggered for pay-ins and card payments
   - Updates transaction status
   - Matches by `paymentReference` or `koraTransactionId`

3. **`refund.success`** / **`refund.failed`**
   - Triggered when refunds are processed
   - Matches by `paymentReference`

### Virtual Card Events

4. **`issuing.card_withdrawal.success`**
   - Triggered when a virtual card withdrawal completes
   - Updates transaction status and fee
   - Includes card balance information

5. **`issuing.card_activation.success`**
   - Triggered when a card is activated
   - Updates user card status

6. **`issuing.card_suspension.success`**
   - Triggered when a card is suspended
   - Updates user card status

7. **`issuing.card_termination.success`**
   - Triggered when a card is terminated
   - Removes card ID from user record

## Webhook Payload Structure

KoraPay sends webhooks with this structure:

```json
{
  "event": "transfer.success",
  "data": {
    "amount": 150.99,
    "fee": 15,
    "currency": "NGN",
    "status": "success",
    "reference": "Z78EYMAUBQ5"
  }
}
```

## Transaction Matching

The webhook handler matches transactions using:
- `paymentReference` - Primary reference from KoraPay
- `koraTransactionId` - Transaction ID from KoraPay
- `koraSwapId` - Swap/conversion reference

## Response Handling

- **Always returns 200 immediately** to acknowledge receipt (prevents KoraPay retries)
- Processing happens asynchronously after sending 200 response
- Signature verification happens after responding (security check)
- Invalid signatures are logged but don't trigger retries
- Failed processing is logged with detailed error information
- All webhook events are logged for debugging and audit purposes

## Testing Webhooks

1. Use KoraPay Sandbox environment for testing
2. Configure webhook URL in dashboard
3. Test events will be sent for:
   - Successful/failed transfers
   - Successful/failed charges
   - Card events

## Environment Variables

Required in `.env`:
```env
KORA_SECRET_KEY=sk_live_xxxxx  # For webhook signature verification
KORA_API_KEY=pk_live_xxxxx     # For API calls
```

## Webhook Flow for Payment

1. User initiates payment → Backend creates transaction
2. Backend calls KoraPay API for swap/conversion
3. Backend saves `koraSwapId` and `paymentReference` in transaction
4. KoraPay processes swap → Sends `transfer.success` webhook
5. Webhook handler matches transaction by reference
6. Transaction status updated to `completed`
7. Internal webhook notification sent to admin/mobile

## Troubleshooting

- **Webhook not received**: 
  - Check URL is publicly accessible and configured in dashboard
  - Verify `BASE_URL` in `.env` matches your public URL
  - For local development, use Cloudflare Tunnel (see `CLOUDFLARE_TUNNEL_SETUP.md`)
  
- **Invalid signature**: 
  - Verify `KORA_SECRET_KEY` matches dashboard secret key
  - Check logs for signature mismatch details
  - Ensure you're using the correct secret key (test vs live)
  
- **Transaction not found**: 
  - Ensure `paymentReference` or `koraSwapId` is saved correctly when creating transactions
  - Check webhook logs for the reference being searched
  - Verify transaction was created before webhook arrives
  
- **Timeout errors**: 
  - Webhook responds immediately (200), processing is async
  - Check server logs for processing errors
  - Verify database connection is stable
  
- **Missing data in payload**: 
  - Check logs for payload structure
  - Verify KoraPay is sending complete payloads
  - Some events may have optional fields

## References

- [KoraPay Webhooks Documentation](https://developers.korapay.com/docs/webhooks)
- [KoraPay Currency Conversion API](https://developers.korapay.com/docs/currency-conversion-api)
- [Virtual Card Events](https://developers.korapay.com/docs/virtual-card-management)
