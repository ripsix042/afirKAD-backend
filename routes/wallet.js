const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authenticate } = require('../middleware/auth');
const koraService = require('../services/kora');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get wallet balance (includes live NGN/USD exchange rate from Kora)
router.get('/balance', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('wallet');
    let exchangeRate = null;
    try {
      const rateData = await koraService.getFxRate('USD', 'NGN');
      exchangeRate = rateData.rate != null ? rateData.rate : null;
    } catch (rateErr) {
      // Keep exchangeRate null; client can use fallback
    }
    res.json({
      success: true,
      wallet: user.wallet,
      ...(exchangeRate != null && { exchangeRate }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch wallet balance.',
    });
  }
});

// Deposit NGN (simple internal deposit - legacy / test)
router.post('/deposit', [
  body('amount').isFloat({ min: 0.01 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { amount } = req.body;

    const user = await User.findById(req.user._id);
    
    user.wallet.ngn += amount;
    await user.save();

    const transaction = new Transaction({
      userId: user._id,
      type: 'deposit',
      status: 'completed',
      amount,
      currency: 'NGN',
      description: 'NGN wallet deposit (internal)',
    });
    await transaction.save();

    res.json({
      success: true,
      message: 'Deposit successful.',
      wallet: user.wallet,
      transaction: {
        id: transaction._id,
        amount: transaction.amount,
        currency: transaction.currency,
        status: transaction.status,
      },
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({
      success: false,
      message: 'Deposit failed.',
      error: error.message,
    });
  }
});

/**
 * Deposit NGN via bank transfer (Kora dynamic virtual account)
 * POST /api/wallet/deposit/bank-transfer
 */
router.post('/deposit/bank-transfer', [
  body('amount').isFloat({ min: 0.01 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { amount } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const reference = `DEP-BANK-${user._id}-${Date.now()}`;

    // Initiate bank transfer payment with Kora
    const koraResponse = await koraService.initiateBankTransferDeposit({
      reference,
      amount,
      customer: {
        email: user.email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || undefined,
      },
      notificationUrl: `${process.env.BASE_URL || ''}/api/webhooks/korapay`,
      metadata: {
        userId: String(user._id),
        channel: 'bank_transfer',
      },
    });

    const data = koraResponse?.data || {};

    // Record pending transaction; wallet will be credited on webhook (charge.success)
    const transaction = new Transaction({
      userId: user._id,
      type: 'deposit',
      status: 'processing',
      amount,
      currency: 'NGN',
      description: 'NGN wallet deposit via bank transfer',
      paymentReference: data.payment_reference || reference,
      metadata: {
        channel: 'bank_transfer',
        bank_account: data.bank_account || null,
      },
    });
    await transaction.save();

    res.json({
      success: true,
      message: 'Bank transfer initiated. Fund your wallet by sending NGN to the account below.',
      bankAccount: data.bank_account,
      expectedAmount: data.amount_expected || data.amount || amount,
      fee: data.fee,
      reference: data.reference || reference,
      transaction: {
        id: transaction._id,
        status: transaction.status,
      },
    });
  } catch (error) {
    console.error('Bank transfer deposit error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate bank transfer deposit.',
      error: error.message,
    });
  }
});

// Get list of Nigerian banks and microfinance banks (for withdraw "Select Bank")
router.get('/banks', authenticate, async (req, res) => {
  try {
    const banksData = await koraService.getBanks();
    let banks = banksData?.data ?? banksData?.banks ?? (Array.isArray(banksData) ? banksData : []);
    if (!Array.isArray(banks)) banks = [];
    banks = banks.map((b) => ({
      code: String(b?.code ?? b?.bank_code ?? ''),
      name: String(b?.name ?? b?.bank_name ?? b?.bank ?? ''),
    })).filter((b) => b.code && b.name);
    res.json({
      success: true,
      banks,
    });
  } catch (error) {
    console.error('Get banks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch banks.',
      banks: [],
    });
  }
});

// Withdraw NGN (payout to bank via Kora)
router.post('/withdraw', [
  body('amount').isFloat({ min: 0.01 }),
  body('accountNumber').trim().notEmpty().withMessage('Account number is required'),
  body('bankCode').trim().notEmpty().withMessage('Bank code is required'),
  body('bankName').optional().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { amount, accountNumber, bankCode, bankName } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Validate bank code is provided
    if (!bankCode || !bankCode.toString().trim()) {
      return res.status(400).json({
        success: false,
        message: 'Bank code is required.',
      });
    }

    // Check available balance (excluding locked funds)
    const availableBalance = user.wallet.ngn - user.wallet.lockedNgn;
    if (availableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance.',
        available: availableBalance,
        required: amount,
      });
    }

    const reference = `WD-${user._id}-${Date.now()}`;

    // Ask Kora to process the payout to the bank account
    const payout = await koraService.payoutToBank({
      reference,
      amount,
      bankCode,
      accountNumber,
      narration: `Wallet withdrawal for ${user.email}`,
      customer: {
        email: user.email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || undefined,
      },
      metadata: {
        userId: String(user._id),
        channel: 'wallet_withdrawal',
      },
    });

    const payoutData = payout?.data || {};

    // Only debit user wallet if Kora accepted the payout request
    user.wallet.ngn -= amount;
    await user.save();

    const transaction = new Transaction({
      userId: user._id,
      type: 'withdrawal',
      status: 'processing',
      amount,
      currency: 'NGN',
      description: `NGN wallet withdrawal${bankName ? ` to ${bankName}` : ''}`,
      paymentReference: payoutData.reference || reference,
      metadata: {
        accountNumber,
        bankName,
        bankCode,
      },
    });
    await transaction.save();

    res.json({
      success: true,
      message: 'Withdrawal initiated. Funds will be transferred shortly.',
      wallet: user.wallet,
      transaction: {
        id: transaction._id,
        amount: transaction.amount,
        currency: transaction.currency,
        status: transaction.status,
      },
      payout: payoutData,
    });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({
      success: false,
      message: 'Withdrawal failed.',
      error: error.message,
    });
  }
});

module.exports = router;
