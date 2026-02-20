const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const axios = require('axios');

const router = express.Router();

// Store SSE connections for admin dashboard (Map: clientId -> response object)
const sseClients = new Map();

// SSE endpoint for admin dashboard to receive real-time webhook events
router.get('/events', async (req, res) => {
  try {
    // Verify authentication token
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Verify user exists and is admin
    const user = await User.findById(decoded.userId).select('role');
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connection', message: 'Connected' })}\n\n`);

    // Store this client connection
    const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    sseClients.set(clientId, res);

    console.log(`✅ Admin SSE client connected: ${clientId} (Total: ${sseClients.size})`);

    // Handle client disconnect
    req.on('close', () => {
      sseClients.delete(clientId);
      console.log(`❌ Admin SSE client disconnected: ${clientId} (Total: ${sseClients.size})`);
      res.end();
    });
  } catch (error) {
    console.error('SSE connection error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to broadcast events to all SSE clients
function broadcastSSEEvent(type, event, data) {
  if (sseClients.size === 0) {
    return; // No clients connected
  }

  const message = JSON.stringify({ type, event, data, timestamp: new Date().toISOString() });
  const sseMessage = `data: ${message}\n\n`;

  sseClients.forEach((res, clientId) => {
    try {
      res.write(sseMessage);
    } catch (error) {
      console.error(`Error sending SSE to client ${clientId}:`, error.message);
      sseClients.delete(clientId);
    }
  });
}

// KoraPay webhook signature verification
// According to KoraPay docs: HMAC SHA256 signature of ONLY the data object signed using secret key
function verifyKoraWebhookSignature(req, secretKey) {
  try {
    const signature = req.headers['x-korapay-signature'];
    if (!signature) {
      console.warn('⚠️  KoraPay webhook: Missing x-korapay-signature header');
      return false;
    }

    // Validate that data object exists
    if (!req.body || !req.body.data) {
      console.warn('⚠️  KoraPay webhook: Missing data object in payload');
      return false;
    }

    // KoraPay signs only the data object (not the entire body)
    // Use JSON.stringify to ensure consistent serialization
    const dataString = JSON.stringify(req.body.data);
    const hash = crypto
      .createHmac('sha256', secretKey)
      .update(dataString)
      .digest('hex');

    const isValid = hash === signature;
    if (!isValid) {
      console.warn('⚠️  KoraPay webhook: Invalid signature. Expected:', hash, 'Received:', signature);
    }
    return isValid;
  } catch (error) {
    console.error('❌ Error verifying KoraPay webhook signature:', error);
    return false;
  }
}

// Webhook configuration - URLs to notify (admin dashboard polls backend for updates; set only if you have a receiver)
const WEBHOOK_URLS = {
  admin: process.env.ADMIN_WEBHOOK_URL || '',
  mobile: process.env.MOBILE_WEBHOOK_URL || null, // Mobile apps typically use push notifications
};

// Helper function to send webhook notifications
async function sendWebhook(type, event, data) {
  const webhookData = {
    type,
    event,
    data,
    timestamp: new Date().toISOString(),
  };

  // Broadcast to all SSE clients (admin dashboard)
  broadcastSSEEvent(type, event, data);

  // Send to admin webhook URL if configured (for external integrations)
  if (WEBHOOK_URLS.admin && WEBHOOK_URLS.admin.trim()) {
    try {
      await axios.post(WEBHOOK_URLS.admin, webhookData, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error(`Failed to send webhook to admin:`, error.message);
    }
  }

  // For mobile, we'd typically use push notifications via expo-notifications
  // This is a placeholder for future implementation
  if (WEBHOOK_URLS.mobile) {
    try {
      await axios.post(WEBHOOK_URLS.mobile, webhookData, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error(`Failed to send webhook to mobile:`, error.message);
    }
  }
}

// Transaction webhook - called when transaction status changes
router.post('/transaction/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { status, metadata } = req.body;

    const transaction = await Transaction.findById(transactionId).populate('userId', 'email firstName lastName');
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Update transaction status
    if (status) {
      transaction.status = status;
      if (metadata) {
        transaction.metadata = { ...transaction.metadata, ...metadata };
      }
      await transaction.save();
    }

    // Send webhook notifications
    await sendWebhook('transaction', 'status_update', {
      transactionId: transaction._id,
      status: transaction.status,
      userId: transaction.userId?._id,
      amount: transaction.amount,
      currency: transaction.currency,
      type: transaction.type,
    });

    res.json({ success: true, transaction });
  } catch (error) {
    console.error('Transaction webhook error:', error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

// Payment webhook - called when payment is processed
router.post('/payment', async (req, res) => {
  try {
    const { transactionId, status, amount, currency, merchantName } = req.body;

    const transaction = await Transaction.findById(transactionId).populate('userId', 'email firstName lastName');
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Update transaction
    if (status) transaction.status = status;
    if (merchantName) transaction.merchantName = merchantName;
    await transaction.save();

    // Update user wallet if payment completed
    if (status === 'completed' && transaction.userId) {
      const user = await User.findById(transaction.userId._id);
      if (user && transaction.type === 'payment') {
        // Wallet already updated during payment processing
        // This is just for notification
      }
    }

    // Send webhook notifications
    await sendWebhook('payment', status === 'completed' ? 'payment_success' : 'payment_failed', {
      transactionId: transaction._id,
      status: transaction.status,
      userId: transaction.userId?._id,
      amount: transaction.amount,
      currency: transaction.currency,
      merchantName: transaction.merchantName,
    });

    res.json({ success: true, transaction });
  } catch (error) {
    console.error('Payment webhook error:', error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

// Deposit webhook - called when deposit is received
router.post('/deposit', async (req, res) => {
  try {
    const { transactionId, status, amount } = req.body;

    const transaction = await Transaction.findById(transactionId).populate('userId', 'email firstName lastName');
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (status) {
      transaction.status = status;
      await transaction.save();
    }

    // Send webhook notifications
    await sendWebhook('deposit', status === 'completed' ? 'deposit_success' : 'deposit_failed', {
      transactionId: transaction._id,
      status: transaction.status,
      userId: transaction.userId?._id,
      amount: transaction.amount,
      currency: transaction.currency,
    });

    res.json({ success: true, transaction });
  } catch (error) {
    console.error('Deposit webhook error:', error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

// Card webhook - called when virtual card is created/updated
router.post('/card', async (req, res) => {
  try {
    const { userId, cardId, status, action } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (cardId) {
      user.koraVirtualCardId = cardId;
      await user.save();
    }

    // Send webhook notifications
    await sendWebhook('card', action || 'card_created', {
      userId: user._id,
      cardId: user.koraVirtualCardId,
      status,
    });

    res.json({ success: true, user: { _id: user._id, koraVirtualCardId: user.koraVirtualCardId } });
  } catch (error) {
    console.error('Card webhook error:', error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

// KoraPay webhook - receive webhooks from KoraPay API
// This endpoint should be configured in KoraPay dashboard: Settings > API Configuration > Notification URL
// According to KoraPay docs: Must return 200 status code to acknowledge receipt
router.post('/korapay', async (req, res) => {
  // Always return 200 immediately to acknowledge receipt (prevents retries)
  // Process webhook asynchronously after responding
  res.status(200).json({ success: true, received: true });

  // Process webhook asynchronously (after sending 200 response)
  setImmediate(async () => {
    try {
      // Validate request method (should be POST)
      if (req.method !== 'POST') {
        console.warn('⚠️  KoraPay webhook: Invalid request method:', req.method);
        return;
      }

      // Verify webhook signature
      const secretKey = process.env.KORA_SECRET_KEY;
      if (!secretKey) {
        console.error('❌ KoraPay webhook: KORA_SECRET_KEY not configured');
        return;
      }

      // Verify signature (but don't reject - we already sent 200)
      const isValidSignature = verifyKoraWebhookSignature(req, secretKey);
      if (!isValidSignature) {
        console.error('❌ KoraPay webhook: Invalid signature - request may not be from KoraPay');
        // Log the request for security review
        console.log('📋 Webhook payload:', JSON.stringify(req.body, null, 2));
        return; // Don't process if signature is invalid
      }

      // Validate payload structure
      const { event, data } = req.body;
      if (!event || !data) {
        console.error('❌ KoraPay webhook: Missing event or data in payload');
        console.log('📋 Webhook payload:', JSON.stringify(req.body, null, 2));
        return;
      }

      // Validate required data fields
      if (!data.reference && !data.payment_reference) {
        console.error('❌ KoraPay webhook: Missing reference in data object');
        return;
      }

      console.log(`📥 KoraPay webhook received: ${event} for reference: ${data.reference || data.payment_reference}`);

      // Process the webhook
      await handleKoraPayWebhook(event, data);
      
      console.log(`✅ KoraPay webhook processed successfully: ${event}`);
    } catch (error) {
      console.error('❌ Error processing KoraPay webhook:', error);
      console.error('Stack trace:', error.stack);
    }
  });
});

// Handle KoraPay webhook events
// According to KoraPay docs, events include:
// - transfer.success, transfer.failed (payouts, bulk payouts)
// - charge.success, charge.failed (pay-ins, card payments, bank transfers, mobile money)
// - refund.success, refund.failed (refunds)
async function handleKoraPayWebhook(event, data) {
  switch (event) {
    // Transfer events (payouts, conversions, bulk payouts)
    case 'transfer.success':
    case 'transfer.failed': {
      console.log(`🔄 Processing transfer event: ${event}`, {
        reference: data.reference,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        fee: data.fee,
        batch_reference: data.batch_reference,
      });

      // Find transaction by reference (could be swap, payout, or bulk payout)
      const transaction = await Transaction.findOne({
        $or: [
          { koraTransactionId: data.reference },
          { koraSwapId: data.reference },
        ],
      });

      if (transaction) {
        const oldStatus = transaction.status;
        transaction.status = event === 'transfer.success' ? 'completed' : 'failed';
        if (data.fee !== undefined) {
          transaction.fee = data.fee;
        }
        // Update amount if provided (might differ due to fees)
        if (data.amount !== undefined) {
          transaction.amount = data.amount;
        }
        await transaction.save();

        console.log(`✅ Transaction ${transaction._id} updated: ${oldStatus} → ${transaction.status}`);

        // If this is a swap/conversion, update the transaction
        if (transaction.koraSwapId === data.reference) {
          // Swap completed/failed
          await sendWebhook('kora', 'swap_' + (event === 'transfer.success' ? 'success' : 'failed'), {
            transactionId: transaction._id,
            reference: data.reference,
            status: transaction.status,
            amount: data.amount,
            currency: data.currency,
            fee: data.fee,
          });
        } else {
          // Regular transaction
          await sendWebhook('kora', event, {
            transactionId: transaction._id,
            reference: data.reference,
            status: transaction.status,
            amount: data.amount,
            currency: data.currency,
            fee: data.fee,
            batch_reference: data.batch_reference,
          });
        }
      } else {
        console.warn(`⚠️  No transaction found for transfer reference: ${data.reference}`);
      }
      break;
    }

    // Charge events (pay-ins, card payments, bank transfers, mobile money)
    case 'charge.success':
    case 'charge.failed': {
      console.log(`💳 Processing charge event: ${event}`, {
        reference: data.reference,
        payment_reference: data.payment_reference,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        fee: data.fee,
        payment_method: data.payment_method,
        transaction_date: data.transaction_date,
      });

      // Find transaction by reference or payment_reference
      const transaction = await Transaction.findOne({
        $or: [
          { koraTransactionId: data.reference },
          { paymentReference: data.reference },
          { paymentReference: data.payment_reference },
        ],
      }).populate('userId');

      if (transaction) {
        const oldStatus = transaction.status;
        transaction.status = event === 'charge.success' ? 'completed' : 'failed';
        if (data.fee !== undefined) {
          transaction.fee = data.fee;
        }
        // Update amount if provided
        if (data.amount !== undefined) {
          transaction.amount = data.amount;
        }
        await transaction.save();

        console.log(`✅ Transaction ${transaction._id} updated: ${oldStatus} → ${transaction.status}`);

        // If this is a successful deposit, credit the user's wallet
        if (event === 'charge.success' && transaction.type === 'deposit' && transaction.userId) {
          const user = await User.findById(transaction.userId._id);
          if (user && transaction.currency === 'NGN') {
            // Credit NGN wallet with the deposit amount (net of fees if applicable)
            const creditAmount = transaction.amount - (transaction.fee || 0);
            user.wallet.ngn += creditAmount;
            await user.save();
            console.log(`💰 Credited ${creditAmount} NGN to user ${user._id} wallet (amount: ${transaction.amount}, fee: ${transaction.fee || 0})`);
          }
        }

        await sendWebhook('kora', event, {
          transactionId: transaction._id,
          reference: data.reference,
          payment_reference: data.payment_reference,
          status: transaction.status,
          amount: data.amount,
          currency: data.currency,
          fee: data.fee,
          payment_method: data.payment_method,
        });
      } else {
        console.warn(`⚠️  No transaction found for charge reference: ${data.reference || data.payment_reference}`);
      }
      break;
    }

    // Refund events
    case 'refund.success':
    case 'refund.failed': {
      console.log(`↩️  Processing refund event: ${event}`, {
        reference: data.reference,
        payment_reference: data.payment_reference,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        refund_date: data.refund_date,
        completion_date: data.completion_date,
      });

      // Find transaction by payment reference
      const transaction = await Transaction.findOne({
        $or: [
          { paymentReference: data.payment_reference },
          { koraTransactionId: data.payment_reference },
        ],
      });

      if (transaction) {
        // Update original transaction or create refund transaction
        // For now, we'll just notify - you may want to create a separate refund transaction
        await sendWebhook('kora', event, {
          transactionId: transaction._id,
          reference: data.reference,
          paymentReference: data.payment_reference,
          amount: data.amount,
          currency: data.currency,
          status: data.status,
          refund_date: data.refund_date,
          completion_date: data.completion_date,
        });
        console.log(`✅ Refund processed for transaction ${transaction._id}`);
      } else {
        console.warn(`⚠️  No transaction found for refund payment_reference: ${data.payment_reference}`);
      }
      break;
    }

    // Virtual Card Events
    case 'issuing.card_withdrawal.success': {
      // Card withdrawal completed
      const transaction = await Transaction.findOne({
        koraTransactionId: data.transaction_reference,
      });

      if (transaction) {
        transaction.status = 'completed';
        if (data.fee) {
          transaction.fee = data.fee;
        }
        await transaction.save();

        await sendWebhook('kora', event, {
          transactionId: transaction._id,
          cardReference: data.card_reference,
          transactionReference: data.transaction_reference,
          amount: data.amount,
          currency: data.currency,
          cardBalance: data.card_balance,
        });
      }
      break;
    }

    case 'issuing.card_activation.success':
    case 'issuing.card_suspension.success':
    case 'issuing.card_termination.success': {
      // Find user by card reference or customer ID
      const user = await User.findOne({
        $or: [
          { koraVirtualCardId: data.card_reference },
          { koraCustomerId: data.customer_id },
        ],
      });

      if (user) {
        if (event === 'issuing.card_termination.success') {
          user.koraVirtualCardId = null;
        }
        await user.save();

        await sendWebhook('kora', event, {
          userId: user._id,
          cardReference: data.card_reference,
          status: event.includes('activation') ? 'active' : event.includes('suspension') ? 'suspended' : 'terminated',
        });
      }
      break;
    }

    default:
      console.warn(`⚠️  Unhandled KoraPay webhook event: ${event}`, {
        data: JSON.stringify(data, null, 2),
      });
      // Still send webhook notification for unhandled events
      await sendWebhook('kora', event, data);
  }
}

// Webhook endpoint for admin to receive notifications
router.post('/notify', async (req, res) => {
  try {
    const { type, event, data } = req.body;
    
    // Log webhook notification (in production, you might want to store this)
    console.log('Webhook notification received:', { type, event, data });
    
    // Here you could:
    // - Store notifications in a database
    // - Trigger real-time updates via WebSocket
    // - Send push notifications to admin dashboard
    
    res.json({ success: true, received: true });
  } catch (error) {
    console.error('Webhook notify error:', error);
    res.status(500).json({ success: false, message: 'Webhook notification failed' });
  }
});

module.exports = router;
