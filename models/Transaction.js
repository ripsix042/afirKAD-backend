const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'payment', 'fx_conversion', 'card_payment'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'processing',
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    enum: ['NGN', 'USD'],
    required: true,
  },
  fxRate: {
    type: Number,
  },
  amountConverted: {
    type: Number,
  },
  convertedCurrency: {
    type: String,
    enum: ['NGN', 'USD'],
  },
  description: {
    type: String,
  },
  merchantName: {
    type: String,
  },
  paymentMethod: {
    type: String,
    enum: ['wallet', 'virtual_card'],
  },
  koraTransactionId: {
    type: String,
  },
  koraSwapId: {
    type: String,
  },
  paymentReference: {
    type: String,
    // KoraPay reference for webhook matching
  },
  errorMessage: {
    type: String,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Indexes for efficient queries
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ paymentReference: 1 });
transactionSchema.index({ koraSwapId: 1 });
transactionSchema.index({ koraTransactionId: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
