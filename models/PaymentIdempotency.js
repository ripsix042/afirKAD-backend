const mongoose = require('mongoose');

const paymentIdempotencySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  idempotencyKey: {
    type: String,
    required: true,
  },
  statusCode: {
    type: Number,
    required: true,
  },
  response: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

paymentIdempotencySchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
paymentIdempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('PaymentIdempotency', paymentIdempotencySchema);
