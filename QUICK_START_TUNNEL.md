# Quick Start: Cloudflare Tunnel

## Fastest Way (Quick Tunnel - 2 minutes)

1. **Start your backend:**
   ```bash
   cd backend
   npm run dev
   ```

2. **In a new terminal, start the tunnel:**
   ```bash
   cd backend
   npm run tunnel:quick
   ```

3. **Copy the HTTPS URL** that appears (looks like `https://abc123-def456.trycloudflare.com`)

4. **Update `backend/.env`:**
   ```env
   BASE_URL=https://abc123-def456.trycloudflare.com
   ```

5. **Restart your backend** (Ctrl+C and `npm run dev` again)

6. **Done!** Your backend is now accessible at that URL. Kora can send webhooks to:
   ```
   https://abc123-def456.trycloudflare.com/api/webhooks/korapay
   ```

**Note:** The URL changes each time you restart the tunnel. For a stable URL, see `CLOUDFLARE_TUNNEL_SETUP.md` for the named tunnel setup.
