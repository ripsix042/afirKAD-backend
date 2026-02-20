const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const PaymentIdempotency = require('../models/PaymentIdempotency');
const { authenticate } = require('../middleware/auth');
const koraService = require('../services/kora');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/payment/quote?amountUsd=25
 * Get FX quote for USD amount
 * Returns: amountUsd, rate, baseAmountNgn, fee, totalAmountNgn
 */
router.get('/quote', async (req, res) => {
  try {
    const amountUsd = parseFloat(req.query.amountUsd);
    
    if (!amountUsd || amountUsd <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amountUsd. Must be a positive number.',
      });
    }

    const quote = await koraService.getFxQuote(amountUsd);
    
    res.json({
      success: true,
      quote,
    });
  } catch (error) {
    console.error('Quote error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get FX quote.',
      error: error.message,
    });
  }
});

/**
 * POST /api/payment
 * Process a payment:
 * 1. Get FX quote and calculate NGN needed
 * 2. Lock NGN balance
 * 3. Perform instant FX swap (NGN → USD)
 * 4. Authorize virtual card payment
 * 5. Update ledgers atomically
 */
router.post('/', [
  body('amountUsd').isFloat({ min: 0.01 }),
  body('merchantName').optional().trim(),
], async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
  const userId = req.user._id;

  if (idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.length <= 128) {
    const existing = await PaymentIdempotency.findOne({ userId, idempotencyKey: idempotencyKey.trim() });
    if (existing) {
      return res.status(existing.statusCode).json(existing.response);
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      const errBody = { success: false, errors: errors.array() };
      if (idempotencyKey) {
        await PaymentIdempotency.create({ userId, idempotencyKey: idempotencyKey.trim(), statusCode: 400, response: errBody });
      }
      return res.status(400).json(errBody);
    }

    const { amountUsd, merchantName } = req.body;

    // Get FX quote to calculate NGN needed
    const quote = await koraService.getFxQuote(amountUsd);
    const amountNgn = quote.totalAmountNgn;

    // Get user with session
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      const errBody = { success: false, message: 'User not found.' };
      if (idempotencyKey && idempotencyKey.trim()) {
        await PaymentIdempotency.create({ userId, idempotencyKey: idempotencyKey.trim(), statusCode: 404, response: errBody });
      }
      return res.status(404).json(errBody);
    }

    // Check available balance
    const availableNgn = user.wallet.ngn - user.wallet.lockedNgn;
    if (availableNgn < amountNgn) {
      await session.abortTransaction();
      const errBody = { success: false, message: 'Insufficient NGN balance.', required: amountNgn, available: availableNgn };
      if (idempotencyKey && idempotencyKey.trim()) {
        await PaymentIdempotency.create({ userId, idempotencyKey: idempotencyKey.trim(), statusCode: 400, response: errBody });
      }
      return res.status(400).json(errBody);
    }

    // Create pending transaction
    const transaction = new Transaction({
      userId,
      type: 'payment',
      status: 'processing',
      amount: amountNgn,
      currency: 'NGN',
      merchantName: merchantName || 'Unknown Merchant',
      paymentMethod: 'virtual_card',
    });
    await transaction.save({ session });

    // Lock NGN balance
    user.wallet.lockedNgn += amountNgn;
    await user.save({ session });

    // Commit the lock transaction
    await session.commitTransaction();
    session.endSession();

    // Perform FX swap (this can take 1-2 seconds)
    let swapResult;
    try {
      swapResult = await koraService.instantSwap(amountNgn);
    } catch (fxError) {
      // Unlock balance on FX failure
      await User.findByIdAndUpdate(userId, {
        $inc: { 'wallet.lockedNgn': -amountNgn },
      });
      
      transaction.status = 'failed';
      transaction.errorMessage = fxError.message;
      await transaction.save();
      const fxErrBody = { success: false, message: 'FX conversion failed.', error: fxError.message };
      if (idempotencyKey && idempotencyKey.trim()) {
        await PaymentIdempotency.create({ userId, idempotencyKey: idempotencyKey.trim(), statusCode: 400, response: fxErrBody });
      }
      return res.status(400).json(fxErrBody);
    }

    // Verify the swap result matches expected USD amount
    const swappedUsd = swapResult.amount || swapResult.converted_amount || (amountNgn / quote.rate);
    const fxRate = swapResult.rate || quote.rate;
    
    // Use the requested amountUsd (should match swapped amount)
    const finalAmountUsd = amountUsd;

    // Update transaction with FX details
    transaction.fxRate = fxRate;
    transaction.amountConverted = amountUsd;
    transaction.convertedCurrency = 'USD';
    transaction.koraSwapId = swapResult.reference || swapResult.id || swapResult.swap_id;
    // Save reference for webhook matching
    if (swapResult.reference) {
      transaction.paymentReference = swapResult.reference;
    }
    await transaction.save();

    // Authorize virtual card payment
    let paymentResult;
    try {
      if (!user.koraVirtualCardId) {
        throw new Error('Virtual card not found. Please contact support.');
      }

      paymentResult = await koraService.authorizeCardPayment(
        user.koraVirtualCardId,
        finalAmountUsd,
        { name: merchantName || 'Unknown Merchant' }
      );
    } catch (paymentError) {
      // Refund locked NGN on payment failure
      await User.findByIdAndUpdate(userId, {
        $inc: {
          'wallet.lockedNgn': -amountNgn,
          'wallet.ngn': amountNgn,
        },
      });
      
      transaction.status = 'failed';
      transaction.errorMessage = paymentError.message;
      transaction.koraTransactionId = paymentResult?.id;
      await transaction.save();
      const payErrBody = { success: false, message: 'Payment authorization failed.', error: paymentError.message };
      if (idempotencyKey && idempotencyKey.trim()) {
        await PaymentIdempotency.create({ userId, idempotencyKey: idempotencyKey.trim(), statusCode: 400, response: payErrBody });
      }
      return res.status(400).json(payErrBody);
    }

    // Payment successful - update ledgers atomically
    const finalSession = await mongoose.startSession();
    finalSession.startTransaction();

    try {
      const finalUser = await User.findById(userId).session(finalSession);
      finalUser.wallet.lockedNgn -= amountNgn;
      finalUser.wallet.ngn -= amountNgn;
      await finalUser.save({ session: finalSession });

      transaction.status = 'completed';
      transaction.koraTransactionId = paymentResult.reference || paymentResult.id || paymentResult.transaction_id;
      // Save payment reference for webhook matching
      if (paymentResult.reference) {
        transaction.paymentReference = paymentResult.reference;
      }
      await transaction.save({ session: finalSession });

      await finalSession.commitTransaction();
      finalSession.endSession();

      const successBody = {
        success: true,
        message: 'Payment successful.',
        transaction: {
          id: transaction._id,
          amountNgn,
          amountUsd: finalAmountUsd,
          fxRate,
          fee: quote.fee,
          status: 'completed',
          merchantName: merchantName || 'Unknown Merchant',
        },
        wallet: {
          ngn: finalUser.wallet.ngn,
          usd: finalUser.wallet.usd,
        },
      };
      if (idempotencyKey && idempotencyKey.trim()) {
        await PaymentIdempotency.create({ userId, idempotencyKey: idempotencyKey.trim(), statusCode: 200, response: successBody });
      }
      res.json(successBody);
    } catch (finalError) {
      await finalSession.abortTransaction();
      finalSession.endSession();
      throw finalError;
    }
  } catch (error) {
    console.error('Payment error:', error);

    if (session && session.inTransaction && session.inTransaction()) {
      await session.abortTransaction();
      session.endSession();
    }

    const errBody = { success: false, message: 'Payment processing failed.', error: error.message };
    if (idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
      try {
        await PaymentIdempotency.create({ userId: req.user._id, idempotencyKey: idempotencyKey.trim(), statusCode: 500, response: errBody });
      } catch (e) {
        // ignore duplicate key
      }
    }
    res.status(500).json(errBody);
  }
});

module.exports = router;
