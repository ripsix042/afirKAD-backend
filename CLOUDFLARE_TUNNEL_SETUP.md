# Cloudflare Tunnel Setup for AfriKAD Backend

This guide will help you set up Cloudflare Tunnel to expose your local backend so Kora webhooks can reach it.

## Prerequisites

1. **Cloudflare account** (free): Sign up at https://dash.cloudflare.com
2. **cloudflared installed**: Already installed on your system ✅

## Option 1: Quick Tunnel (Temporary URL - Easiest for Testing)

This creates a temporary URL that changes each time you restart. Good for quick testing.

### Steps:

1. **Run the quick tunnel:**
   ```bash
   cd backend
   npm run tunnel:quick
   ```

2. **Copy the HTTPS URL** that appears (e.g., `https://abc123-def456.trycloudflare.com`)

3. **Update `backend/.env`:**
   ```env
   BASE_URL=https://abc123-def456.trycloudflare.com
   ```

4. **Restart your backend** for the change to take effect

**Note:** The URL changes every time you restart the tunnel. Use Option 2 for a stable URL.

---

## Option 2: Named Tunnel (Stable URL - Recommended)

This creates a permanent tunnel with a stable URL. Better for development.

### Steps:

1. **Login to Cloudflare:**
   ```bash
   cloudflared tunnel login
   ```
   - This will open your browser
   - Select the domain you want to use (or create a free one)
   - Authorize the tunnel

2. **Create a tunnel:**
   ```bash
   cloudflared tunnel create afrikad-backend
   ```
   - This creates a tunnel named `afrikad-backend`
   - Save the tunnel ID that's displayed

3. **Route DNS (if you have a domain):**
   ```bash
   cloudflared tunnel route dns afrikad-backend afrikad-backend.yourdomain.com
   ```
   - Replace `yourdomain.com` with your actual domain
   - If you don't have a domain, skip this step and use the quick tunnel method

4. **Run the tunnel:**
   ```bash
   npm run tunnel
   ```

5. **Update `backend/.env`:**
   ```env
   BASE_URL=https://afrikad-backend.yourdomain.com
   ```
   Or if using quick tunnel, use the URL from step 2 of Option 1.

---

## Running the Tunnel

### Quick Tunnel (Temporary):
```bash
npm run tunnel:quick
```

### Named Tunnel (Stable):
```bash
npm run tunnel
```

### Run in Background:
```bash
# Quick tunnel
npm run tunnel:quick &

# Named tunnel  
npm run tunnel &
```

---

## Important Notes

1. **Keep the tunnel running** while your backend is running - webhooks won't work if the tunnel is down
2. **For production**, deploy your backend to a server with a public URL instead of using tunnels
3. **Quick tunnel URLs expire** when you close the terminal - use named tunnel for stability
4. **Update Kora dashboard** with your webhook URL: `BASE_URL/api/webhooks/korapay`

---

## Troubleshooting

- **Tunnel not connecting?** Make sure your backend is running on port 5001
- **Webhooks not working?** Verify `BASE_URL` in `.env` matches your tunnel URL
- **Need help?** Check Cloudflare docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
