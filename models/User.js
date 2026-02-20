const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  firstName: {
    type: String,
    required: true,
    trim: true,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  username: {
    type: String,
    trim: true,
    sparse: true, // Allows multiple null values but enforces uniqueness for non-null
  },
  dateOfBirth: {
    type: Date,
  },
  address: {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    zipCode: { type: String, trim: true },
  },
  countryIdentity: {
    type: { type: String, trim: true },
    number: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  identity: {
    type: { type: String, trim: true },
    number: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  koraCardholderReference: {
    type: String,
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  wallet: {
    ngn: {
      type: Number,
      default: 0,
      min: 0,
    },
    usd: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockedNgn: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  koraCustomerId: {
    type: String,
  },
  koraVirtualCardId: {
    type: String,
  },
  resetPasswordToken: {
    type: String,
    select: false,
  },
  resetPasswordExpires: {
    type: Date,
    select: false,
  },
  resetOtp: {
    type: String,
    select: false,
  },
  resetOtpExpires: {
    type: Date,
    select: false,
  },
  emailVerified: {
    type: Boolean,
    default: false,
  },
  emailVerificationToken: {
    type: String,
    select: false,
  },
  emailVerificationExpires: {
    type: Date,
    select: false,
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

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
