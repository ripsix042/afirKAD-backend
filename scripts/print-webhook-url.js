#!/usr/bin/env node
/**
 * Prints the KoraPay webhook URL to register in the Kora dashboard.
 * Loads .env so BASE_URL is used. Run after starting Cloudflare Tunnel.
 */
require('dotenv').config();

const base = (process.env.BASE_URL || '').replace(/\/$/, '');
const webhookUrl = base ? `${base}/api/webhooks/korapay` : null;

if (webhookUrl) {
  console.log('\n📌 Set this URL in Kora Dashboard → Settings → API Configuration → Notification URL:\n');
  console.log('   ' + webhookUrl);
  console.log('\n');
} else {
  console.log('\n⚠️  BASE_URL is not set in .env.');
  console.log('   After starting the tunnel (npm run tunnel:quick), add to .env:');
  console.log('   BASE_URL=https://YOUR-TUNNEL-URL.trycloudflare.com');
  console.log('   Then run: npm run webhook:url\n');
}
