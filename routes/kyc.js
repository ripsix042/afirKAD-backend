const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { compressBase64Image } = require('../utils/imageHelpers');

const router = express.Router();

router.use(authenticate);

/**
 * GET /api/kyc/status
 * Get the current KYC status of the user
 */
router.get('/status', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('kycStatus kycRejectionReason lastKycSubmission');
    res.json({
      success: true,
      status: user.kycStatus,
      rejectionReason: user.kycRejectionReason,
      lastSubmission: user.lastKycSubmission
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
  }
});

/**
 * POST /api/kyc/submit
 * Submit identity documents for verification
 */
router.post('/submit', [
  body('documentType').isIn(['passport', 'national_id', 'drivers_license']),
  body('idNumber').notEmpty().trim(),
  body('image').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.kycStatus === 'pending') {
      return res.status(400).json({ success: false, message: 'You already have a pending verification request.' });
    }

    if (user.kycStatus === 'verified') {
      return res.status(400).json({ success: false, message: 'You are already verified.' });
    }

    const { documentType, idNumber, image } = req.body;

    // Process and compress image
    const compressedImage = await compressBase64Image(image);

    // Update user KYC data
    user.kycStatus = 'pending';
    user.kycRejectionReason = '';
    user.lastKycSubmission = new Date();
    
    // For simplicity, we replace the existing document if any, or keep a history
    user.kycDocuments.push({
      type: documentType,
      number: idNumber,
      imageUrl: compressedImage,
      submittedAt: new Date()
    });

    await user.save();

    res.json({
      success: true,
      message: 'KYC documents submitted successfully. Our team will review them shortly.',
      status: 'pending'
    });
  } catch (error) {
    console.error('KYC submission error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit KYC documents.' });
  }
});

module.exports = router;
