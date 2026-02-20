const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const { authenticate } = require('../middleware/auth');
const { sendMail } = require('../utils/emailService');

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const OTP_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const router = express.Router();

// Access token (short-lived)
const generateAccessToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
};

// Legacy: long-lived token (for backward compatibility if client doesn't use refresh)
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

async function createRefreshToken(userId) {
  const token = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await RefreshToken.create({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
  });
  return token;
}

// Register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, firstName, lastName, phone, username } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email.',
      });
    }

    // Check if username is taken (if provided)
    if (username) {
      const existingUsername = await User.findOne({ username });
      if (existingUsername) {
        return res.status(400).json({
          success: false,
          message: 'Username already taken.',
        });
      }
    }

    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenHash = crypto.createHash('sha256').update(emailVerificationToken).digest('hex');

    const user = new User({
      email,
      password,
      firstName,
      lastName,
      phone,
      username,
      emailVerificationToken: emailVerificationTokenHash,
      emailVerificationExpires: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
    });

    await user.save();

    const baseUrl = (process.env.BASE_URL || 'http://localhost:5001').replace(/\/$/, '');
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${emailVerificationToken}`;
    await sendMail({
      to: email,
      subject: 'Verify your AfriKAD email',
      text: `Click to verify: ${verifyUrl}`,
      html: `<p>Click the link to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>Link expires in 24 hours.</p>`,
    });

    const token = generateAccessToken(user._id);
    const refreshToken = await createRefreshToken(user._id);

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email to verify your account.',
      token,
      expiresIn: 900,
      refreshToken,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        username: user.username,
        wallet: user.wallet,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed.',
      error: error.message,
    });
  }
});

// Login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const token = generateAccessToken(user._id);
    const refreshToken = await createRefreshToken(user._id);

    res.json({
      success: true,
      message: 'Login successful.',
      token,
      expiresIn: 900,
      refreshToken,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        username: user.username,
        wallet: user.wallet,
        role: user.role,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed.',
      error: error.message,
    });
  }
});

// Verify email (GET or POST with token)
router.get('/verify-email', async (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).json({ success: false, message: 'Token is required.' });
  }
  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() },
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification token.' });
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    user.updatedAt = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: 'Email verified successfully. You can now log in.',
    });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ success: false, message: 'Verification failed.', error: error.message });
  }
});
router.post('/verify-email', [
  body('token').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const hashedToken = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() },
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification token.' });
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    user.updatedAt = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: 'Email verified successfully.',
    });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ success: false, message: 'Verification failed.', error: error.message });
  }
});

// Refresh access token
router.post('/refresh', [
  body('refreshToken').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const tokenHash = crypto.createHash('sha256').update(req.body.refreshToken).digest('hex');
    const ref = await RefreshToken.findOne({ tokenHash, expiresAt: { $gt: Date.now() } });
    if (!ref) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
    }
    const newAccessToken = generateAccessToken(ref.userId);
    res.json({
      success: true,
      token: newAccessToken,
      expiresIn: 900,
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ success: false, message: 'Refresh failed.', error: error.message });
  }
});

// Logout (revoke refresh token)
router.post('/logout', [
  body('refreshToken').optional(),
], async (req, res) => {
  try {
    const token = req.body.refreshToken;
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await RefreshToken.deleteOne({ tokenHash });
    }
    res.json({ success: true, message: 'Logged out.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Logout failed.', error: error.message });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        username: user.username,
        wallet: user.wallet,
        role: user.role,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user.',
    });
  }
});

// Update profile
router.put('/profile', authenticate, [
  body('email').optional().isEmail().normalizeEmail(),
  body('firstName').optional().notEmpty().trim(),
  body('lastName').optional().notEmpty().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { firstName, lastName, email, phone, username } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // Check if email is being changed and if it's already taken
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use.',
        });
      }
      user.email = email;
    }

    // Check if username is being changed and if it's already taken
    if (username !== undefined && username !== user.username) {
      if (username) {
        const existingUsername = await User.findOne({ username });
        if (existingUsername) {
          return res.status(400).json({
            success: false,
            message: 'Username already taken.',
          });
        }
      }
      user.username = username || undefined;
    }

    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (phone !== undefined) user.phone = phone || undefined;

    user.updatedAt = Date.now();
    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        username: user.username,
        wallet: user.wallet,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile.',
      error: error.message,
    });
  }
});

// Change password
router.put('/change-password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.',
      });
    }

    // Update password
    user.password = newPassword;
    user.updatedAt = Date.now();
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully.',
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to change password.',
      error: error.message,
    });
  }
});

// Forgot password - request reset (sends token; in production you would email it)
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email } = req.body;
    const user = await User.findOne({ email }).select('+resetPasswordToken +resetPasswordExpires +resetOtp +resetOtpExpires');

    if (!user) {
      // Don't reveal whether email exists
      return res.json({
        success: true,
        message: 'If an account exists with this email, you will receive reset instructions.',
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);
    user.resetOtp = undefined;
    user.resetOtpExpires = undefined;
    user.updatedAt = new Date();
    await user.save({ validateBeforeSave: false });

    const baseUrl = (process.env.BASE_URL || 'http://localhost:5001').replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;
    await sendMail({
      to: user.email,
      subject: 'AfriKAD – Reset your password',
      text: `Reset link (expires in 1 hour): ${resetUrl}`,
      html: `<p>Click the link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
    });

    const isDev = process.env.NODE_ENV !== 'production';
    res.json({
      success: true,
      message: 'If an account exists with this email, you will receive reset instructions.',
      ...(isDev && { resetToken, expiresIn: '1 hour' }),
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process request.',
      error: error.message,
    });
  }
});

// Verify reset token (optional - for UI to validate token before showing new password form)
router.post('/verify-reset-token', [
  body('token').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const hashedToken = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).select('_id email');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token.',
      });
    }

    res.json({
      success: true,
      message: 'Token is valid.',
      email: user.email,
    });
  } catch (error) {
    console.error('Verify reset token error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify token.',
      error: error.message,
    });
  }
});

// Reset password (with token from forgot-password)
router.post('/reset-password', [
  body('token').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { token, newPassword } = req.body;
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).select('+password +resetPasswordToken +resetPasswordExpires');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token.',
      });
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.resetOtp = undefined;
    user.resetOtpExpires = undefined;
    user.updatedAt = new Date();
    await user.save();

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in.',
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password.',
      error: error.message,
    });
  }
});

// Request OTP for password reset (alternative flow - e.g. for mobile)
router.post('/forgot-password/otp', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email } = req.body;
    const user = await User.findOne({ email }).select('+resetOtp +resetOtpExpires');

    if (!user) {
      return res.json({
        success: true,
        message: 'If an account exists with this email, you will receive an OTP.',
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    user.resetOtp = otp;
    user.resetOtpExpires = new Date(Date.now() + OTP_EXPIRY_MS);
    user.updatedAt = new Date();
    await user.save({ validateBeforeSave: false });

    await sendMail({
      to: user.email,
      subject: 'AfriKAD – Your password reset OTP',
      text: `Your OTP is: ${otp}. It expires in 15 minutes.`,
      html: `<p>Your password reset OTP is: <strong>${otp}</strong></p><p>It expires in 15 minutes. If you didn't request this, ignore this email.</p>`,
    });

    const isDev = process.env.NODE_ENV !== 'production';
    res.json({
      success: true,
      message: 'If an account exists with this email, you will receive an OTP.',
      ...(isDev && { otp, expiresIn: '15 minutes' }),
    });
  } catch (error) {
    console.error('Forgot password OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process request.',
      error: error.message,
    });
  }
});

// Reset password with OTP
router.post('/reset-password/otp', [
  body('email').isEmail().normalizeEmail(),
  body('otp').notEmpty().isLength({ min: 6, max: 6 }),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, otp, newPassword } = req.body;
    const user = await User.findOne({ email }).select('+password +resetOtp +resetOtpExpires');

    if (!user || user.resetOtp !== otp || !user.resetOtpExpires || user.resetOtpExpires < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP.',
      });
    }

    user.password = newPassword;
    user.resetOtp = undefined;
    user.resetOtpExpires = undefined;
    user.updatedAt = new Date();
    await user.save();

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in.',
    });
  } catch (error) {
    console.error('Reset password OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password.',
      error: error.message,
    });
  }
});

module.exports = router;
