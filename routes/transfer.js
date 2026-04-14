const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authenticate } = require('../middleware/auth');
const koraService = require('../services/kora');

const router = express.Router();

// All transfer routes require authentication
router.use(authenticate);

// Supported countries configuration
const SUPPORTED_COUNTRIES = [
  { code: 'NG', name: 'Nigeria', currency: 'NGN', flag: '🇳🇬' },
  { code: 'GH', name: 'Ghana', currency: 'GHS', flag: '🇬🇭' },
  { code: 'KE', name: 'Kenya', currency: 'KES', flag: '🇰🇪' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR', flag: '🇿🇦' },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS', flag: '🇹🇿' },
  { code: 'UG', name: 'Uganda', currency: 'UGX', flag: '🇺🇬' },
];

/**
 * GET /api/transfer/countries
 */
router.get('/countries', (req, res) => {
  res.json({ success: true, countries: SUPPORTED_COUNTRIES });
});

/**
 * GET /api/transfer/banks/:countryCode
 */
router.get('/banks/:countryCode', async (req, res) => {
  try {
    const { countryCode } = req.params;
    const banks = await koraService.getBanksByCountry(countryCode.toUpperCase());
    res.json({ success: true, banks: banks.data || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch banks', error: error.message });
  }
});

/**
 * POST /api/transfer/resolve
 * Verify bank account name
 */
router.post('/resolve', [
  body('bankCode').notEmpty(),
  body('accountNumber').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { bankCode, accountNumber } = req.body;
    const resolved = await koraService.resolveAccount(bankCode, accountNumber);
    
    res.json({
      success: true,
      accountName: resolved.data?.account_name || resolved.data?.name || 'Resolved Account'
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/transfer/quote
 * Input: amountRecipient, targetCurrency
 */
router.post('/quote', [
  body('amountRecipient').isFloat({ min: 1 }),
  body('targetCurrency').isIn(['NGN', 'GHS', 'KES', 'ZAR', 'TZS', 'UGX']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { amountRecipient, targetCurrency } = req.body;
    let rate = 1;
    let afrikadFee = 100; // Default flat fee

    if (targetCurrency !== 'NGN') {
      // 1. Get live rate (NGN -> Target)
      const fxData = await koraService.getFxRate('NGN', targetCurrency);
      rate = fxData.rate;

      // 2. Add markup (0.5%)
      const markupPercent = 0.005; 
      
      // Calculate NGN needed for the recipient amount
      // RecipientAmount = (NgnAmount - TotalFees) * rate
      // Let NetNgn = amountRecipient / rate
      const netNgn = amountRecipient / rate;
      
      // AfriKAD Fee: 0.5% + fixed 100 NGN
      afrikadFee = Math.max(netNgn * markupPercent, 100);
    } else {
      // Local transfer: flat 50 NGN fee
      afrikadFee = 50;
    }

    // Kora Payout Fee (constant approximation)
    const koraFee = 50; 
    const totalFees = afrikadFee + koraFee;
    
    // totalDebitNgn = netNgn + totalFees
    // (If NGN to NGN, netNgn = amountRecipient)
    const netNgnNeeded = targetCurrency === 'NGN' ? amountRecipient : (amountRecipient / rate);
    const totalDebitNgn = netNgnNeeded + totalFees;

    res.json({
      success: true,
      quote: {
        amountRecipient,
        rate,
        afrikadFee: Math.round(afrikadFee),
        koraFee,
        totalFees: Math.round(totalFees),
        totalDebitNgn: Math.round(totalDebitNgn),
        recipientAmount: amountRecipient,
        recipientCurrency: targetCurrency,
        kycStatus: 'verified', // Placeholder
        limitNgn: 100000, // Placeholder
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate quote', error: error.message });
  }
});

/**
 * POST /api/transfer/execute
 * Atomic flow for international transfer
 */
router.post('/execute', [
  body('amountNgn').isFloat({ min: 100 }),
  body('targetCurrency').isString(),
  body('recipient').isObject(),
  body('recipient.bankCode').isString(),
  body('recipient.accountNumber').isString(),
  body('recipient.name').isString(),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amountNgn, targetCurrency, recipient, narration } = req.body;
    const userId = req.user._id;

    const user = await User.findById(userId).session(session);
    if (user.wallet.ngn < amountNgn) {
      throw new Error('Insufficient NGN balance');
    }

    // 1. Create Transaction record (status: processing)
    const transaction = new Transaction({
      userId,
      type: 'transfer',
      status: 'processing',
      amount: amountNgn,
      currency: 'NGN',
      convertedCurrency: targetCurrency,
      description: narration || `Transfer to ${recipient.name}`,
      recipient: {
        ...recipient,
        countryCode: req.body.countryCode || 'GH',
        narration: narration || 'Transfer via AfriKAD'
      }
    });
    await transaction.save({ session });

    // 2. Lock/Debit user balance
    user.wallet.ngn -= amountNgn;
    await user.save({ session });

    // Commit balance change first to avoid holding locks during external API call
    await session.commitTransaction();
    session.endSession();

    // 3. Trigger Kora Payout
    try {
      const payoutResponse = await koraService.initiateInternationalTransfer({
        reference: transaction._id.toString(),
        amountNgn: amountNgn - 150, // Subtracting estimated fees
        recipientCurrency: targetCurrency,
        bankCode: recipient.bankCode,
        accountNumber: recipient.accountNumber,
        recipientName: recipient.name,
        narration: narration
      });

      transaction.status = 'completed';
      transaction.paymentReference = payoutResponse.data?.reference || transaction._id.toString();
      await transaction.save();

      res.json({
        success: true,
        message: 'Transfer initiated successfully',
        transactionId: transaction._id
      });

    } catch (apiError) {
      // 4. Refund on API failure
      transaction.status = 'failed';
      transaction.errorMessage = apiError.message;
      await transaction.save();

      await User.findByIdAndUpdate(userId, { $inc: { 'wallet.ngn': amountNgn } });
      
      res.status(400).json({ success: false, message: apiError.message });
    }

  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
      session.endSession();
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
