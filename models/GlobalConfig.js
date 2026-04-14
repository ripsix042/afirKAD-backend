const mongoose = require('mongoose');

const globalConfigSchema = new mongoose.Schema({
  maintenanceMode: {
    type: Boolean,
    default: false
  },
  maintenanceMessage: {
    type: String,
    default: 'Afrikad is currently undergoing scheduled maintenance. Please check back later.'
  },
  minAppVersion: {
    type: String,
    default: '1.0.0'
  },

  // International transfer settings
  transferEnabled: {
    type: Boolean,
    default: true,
  },
  transferFxMarkupPercent: {
    type: Number,
    default: 1.5, // % added on top of Kora rate as AfriKAD revenue
    min: 0,
    max: 20,
  },
  transferFlatFeNgn: {
    type: Number,
    default: 500, // flat NGN fee per transfer
    min: 0,
  },
  // KYC-based daily limits (NGN)
  transferLimitUnverifiedNgn: {
    type: Number,
    default: 50000,
  },
  transferLimitVerifiedNgn: {
    type: Number,
    default: 500000,
  },
}, { timestamps: true });

// We only want one config document
globalConfigSchema.statics.getConfig = async function() {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({});
  }
  return config;
};

module.exports = mongoose.model('GlobalConfig', globalConfigSchema);
