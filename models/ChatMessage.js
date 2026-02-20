const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  sender: {
    type: String,
    enum: ['user', 'support'],
    required: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

chatMessageSchema.index({ userId: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
