const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const koraService = require('../services/kora');
const { compressBase64Image } = require('../utils/imageHelpers');

const router = express.Router();

router.use(authenticate);

/**
 * POST /api/cards/kyc
 * Submit KYC, create cardholder, create virtual card.
 */
router.post('/kyc', [
  body('dateOfBirth').isISO8601().toDate(),
  body('address.street').notEmpty().trim(),
  body('address.city').notEmpty().trim(),
  body('address.state').notEmpty().trim(),
  body('address.country').notEmpty().trim(),
  body('address.zipCode').notEmpty().trim(),
  body('countryIdentity.type').notEmpty().trim(),
  body('countryIdentity.number').notEmpty().trim(),
  body('countryIdentity.country').notEmpty().trim(),
  body('identity.type').notEmpty().trim(),
  body('identity.number').notEmpty().trim(),
  body('identity.image').notEmpty(),
  body('identity.country').notEmpty().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.koraVirtualCardId) {
      return res.status(400).json({
        success: false,
        message: 'You already have a virtual card.',
      });
    }

    const { dateOfBirth, address, countryIdentity, identity } = req.body;
    const dob = typeof dateOfBirth === 'string' ? dateOfBirth.split('T')[0] : dateOfBirth.toISOString().split('T')[0];

    // Normalize for Kora: country must be ISO3166 alpha-2 (e.g. NG); country_identity.type must be "bvn" for Nigeria
    const toCountryCode = (c) => {
      if (!c || typeof c !== 'string') return 'NG';
      const s = c.trim();
      if (s.length === 2) return s.toUpperCase();
      if (/nigeria/i.test(s)) return 'NG';
      return s;
    };
    const countryCode = toCountryCode(address.country || countryIdentity.country);
    const identityCountryCode = toCountryCode(identity.country);

    // Kora only accepts country_identity.type = "bvn" for Nigeria (per docs)
    const countryIdentityType = (countryCode === 'NG' ? 'bvn' : (countryIdentity.type || 'bvn').toLowerCase().replace(/-/g, '_'));

    // Kora identity.type: nin, voters_card, drivers_license, passport (per docs)
    const koraIdentityTypes = ['nin', 'voters_card', 'drivers_license', 'passport'];
    let identityType = (identity.type || 'nin').toLowerCase().replace(/-/g, '_').replace(/\s/g, '_');
    if (identityType === 'national_id') identityType = 'nin';
    if (identityType === 'driver_license') identityType = 'drivers_license';
    if (!koraIdentityTypes.includes(identityType)) identityType = 'nin';

    // Base64 image: strip data URL prefix, then compress so Kora's API doesn't return 413
    let imageB64 = (identity.image || '').trim();
    if (imageB64.startsWith('data:')) {
      const i = imageB64.indexOf(',');
      if (i !== -1) imageB64 = imageB64.slice(i + 1);
    }
    imageB64 = await compressBase64Image(imageB64);

    const cardholderData = {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone || undefined,
      dateOfBirth: dob,
      address: {
        street: address.street,
        city: address.city,
        state: address.state,
        country: countryCode,
        zipCode: address.zipCode,
      },
      countryIdentity: {
        type: countryIdentityType,
        number: String(countryIdentity.number).trim(),
        country: countryCode,
      },
      identity: {
        type: identityType,
        number: String(identity.number).trim(),
        image: imageB64,
        country: identityCountryCode,
      },
    };

    let cardholderRes;
    try {
      cardholderRes = await koraService.createCardholder(cardholderData);
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: e.message || 'Failed to create card holder.',
      });
    }

    // Kora may return reference in data.reference, an array (index 0 = reference), or nested object
    function findReference(obj, seen = new Set()) {
      if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
      seen.add(obj);
      if (typeof obj.reference === 'string' && obj.reference.length > 0) return obj.reference;
      if (typeof obj.cardholder_reference === 'string' && obj.cardholder_reference.length > 0) return obj.cardholder_reference;
      if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
      for (const v of Object.values(obj)) {
        const found = findReference(v, seen);
        if (found) return found;
      }
      return null;
    }
    // Response can be: object with data.reference, array of 15 elements (chars?), or a plain string (the reference)
    let cardholderRef = null;
    if (typeof cardholderRes === 'string' && cardholderRes.length >= 10 && cardholderRes.length <= 200) {
      cardholderRef = cardholderRes;
    }
    const keys = cardholderRes && typeof cardholderRes === 'object' ? Object.keys(cardholderRes) : [];
    const isArrayLike = keys.length === 15 && keys.every((k, i) => String(i) === k);
    const arr = !cardholderRef && Array.isArray(cardholderRes) ? cardholderRes : (!cardholderRef && isArrayLike ? Array.from({ length: 15 }, (_, i) => cardholderRes[i]) : null);
    if (arr && arr.length > 0) {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (typeof item === 'string' && item.length >= 10) {
          const looksLikeBase64 = item.length > 1000 || item.startsWith('/9j') || item.startsWith('iVBOR');
          if (!looksLikeBase64) {
            cardholderRef = item;
            break;
          }
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const ref = item.reference ?? item.cardholder_reference ?? item.id ?? findReference(item);
          if (ref) {
            cardholderRef = ref;
            break;
          }
        }
      }
      // If no ref yet, the 15 elements might be 15 chars making up the reference (e.g. response parsed as array of chars)
      if (!cardholderRef && arr.length === 15) {
        const joined = arr.map((x) => (typeof x === 'string' ? x : (x != null ? String(x) : ''))).join('');
        if (joined.length >= 10 && joined.length <= 200 && !joined.includes('undefined')) {
          cardholderRef = joined;
          console.info('Kora cardholder ref from joined 15 chars, len=', joined.length);
        } else {
          console.warn('Kora joined ref rejected: len=', joined.length, 'preview=', joined.slice(0, 20) + (joined.length > 20 ? '...' : ''));
        }
      }
    }
    if (!cardholderRef) {
      cardholderRef =
        cardholderRes?.data?.reference ??
        cardholderRes?.data?.data?.reference ??
        cardholderRes?.data?.cardholder_reference ??
        cardholderRes?.data?.id ??
        cardholderRes?.data?.data?.cardholder_reference ??
        cardholderRes?.data?.data?.id ??
        cardholderRes?.reference ??
        cardholderRes?.cardholder_reference ??
        cardholderRes?.id ??
        findReference(cardholderRes);
    }
    if (!cardholderRef) {
      // Debug: log first element type and shape (no PII)
      const first = cardholderRes?.[0] ?? cardholderRes?.['0'];
      const preview = first === undefined ? 'undefined' : typeof first === 'string' ? `string(len=${first.length})` : (typeof first === 'object' && first !== null ? `object(keys=${Object.keys(first).join(',')})` : typeof first);
      console.warn('Kora cardholder response (keys):', Object.keys(cardholderRes || {}), 'first:', preview);
      return res.status(500).json({
        success: false,
        message: 'Card holder created but no reference returned. Check server logs for response shape.',
      });
    }

    user.koraCardholderReference = cardholderRef;
    user.dateOfBirth = new Date(dob);
    user.address = address;
    user.countryIdentity = countryIdentity;
    user.identity = { type: identity.type, number: identity.number, country: identity.country };
    await user.save();

    const cardRef = `afrikad-${userId}-${Date.now()}`;
    let cardRes;
    try {
      cardRes = await koraService.createCard({
        cardHolderReference: cardholderRef,
        reference: cardRef,
        amount: 0,
        brand: 'visa',
      });
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: e.message || 'Failed to create virtual card.',
      });
    }

    // Kora doc: response is { status, message, data: { reference, ... } }. Some envs return the reference as a plain string or array-like (keys 0-14).
    const looksLikeRef = (s) => typeof s === 'string' && s.length >= 10 && s.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(s);
    let cardReference = null;
    if (typeof cardRes === 'string' && looksLikeRef(cardRes.trim())) {
      cardReference = cardRes.trim();
    }
    if (!cardReference) {
      cardReference =
        cardRes?.data?.reference ??
        cardRes?.data?.data?.reference ??
        cardRes?.reference ??
        cardRes?.id ??
        findReference(cardRes?.data) ??
        findReference(cardRes);
    }
    // Treat response or response.data as array-like (15 elements = reference string chars; or string with keys 0..n)
    const tryArrayLike = (obj) => {
      if (obj == null) return null;
      if (typeof obj === 'string' && looksLikeRef(obj.trim())) return obj.trim();
      if (typeof obj !== 'object') return null;
      const keys = Object.keys(obj);
      const isArrayLike = keys.length >= 10 && keys.length <= 200 && keys.every((k, i) => String(i) === k);
      const len = keys.length;
      if (!isArrayLike && !(Array.isArray(obj) && obj.length >= 10)) return null;
      const arr = Array.isArray(obj) ? obj : Array.from({ length: len }, (_, i) => obj[i]);
      const joined = arr
        .map((x) => {
          if (typeof x === 'string') return x;
          if (typeof x === 'number' && x >= 0 && x <= 255) return String.fromCharCode(x);
          return x != null ? String(x) : '';
        })
        .join('');
      if (looksLikeRef(joined)) return joined;
      if (joined.length >= 10 && joined.length <= 200 && !joined.includes('undefined')) return joined;
      return null;
    };
    if (!cardReference) cardReference = tryArrayLike(cardRes?.data) ?? tryArrayLike(cardRes);
    if (!cardReference) {
      console.warn('Kora createCard response (keys):', Object.keys(cardRes || {}), 'data keys:', cardRes?.data != null ? Object.keys(cardRes.data) : 'n/a');
      return res.status(500).json({
        success: false,
        message: 'Card creation initiated but no reference returned. Check Kora dashboard.',
      });
    }

    user.koraVirtualCardId = cardReference;
    await user.save();

    return res.json({
      success: true,
      message: 'KYC submitted and virtual card created.',
      card: {
        reference: cardReference,
        status: cardRes.data?.status || 'pending',
      },
    });
  } catch (error) {
    console.error('Cards KYC error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'KYC submission failed.',
    });
  }
});

/**
 * GET /api/cards/me
 * Get current user's virtual card details.
 */
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user || !user.koraVirtualCardId) {
      return res.json({
        success: true,
        card: null,
        message: 'No virtual card yet. Complete KYC to get one.',
      });
    }

    try {
      const cardRes = await koraService.getCard(user.koraVirtualCardId);
      const d = cardRes.data || cardRes;
      return res.json({
        success: true,
        card: {
          reference: d.reference,
          firstSix: d.first_six,
          lastFour: d.last_four,
          pan: d.pan,
          cvv: d.cvv,
          expiryMonth: d.expiry_month,
          expiryYear: d.expiry_year,
          brand: d.brand,
          balance: d.balance,
          status: d.status,
          holderName: d.holder_name || d.card_holder?.first_name
            ? `${d.card_holder?.first_name || ''} ${d.card_holder?.last_name || ''}`.trim()
            : `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        },
      });
    } catch (e) {
      return res.status(502).json({
        success: false,
        message: e.message || 'Failed to fetch card details.',
      });
    }
  } catch (error) {
    console.error('Cards me error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch card.',
    });
  }
});

/**
 * POST /api/cards/:id/suspend
 * Freeze (suspend) virtual card.
 */
router.post('/:id/suspend', async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user || user.koraVirtualCardId !== req.params.id) {
      return res.status(404).json({ success: false, message: 'Card not found.' });
    }

    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : 'User requested freeze';
    await koraService.updateCardStatus(user.koraVirtualCardId, 'suspend', reason);

    return res.json({
      success: true,
      message: 'Card suspended.',
      card: { reference: user.koraVirtualCardId, status: 'suspended' },
    });
  } catch (error) {
    console.error('Cards suspend error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to suspend card.',
    });
  }
});

/**
 * POST /api/cards/:id/activate
 * Unfreeze (activate) virtual card.
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user || user.koraVirtualCardId !== req.params.id) {
      return res.status(404).json({ success: false, message: 'Card not found.' });
    }

    const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : 'User requested';
    await koraService.updateCardStatus(user.koraVirtualCardId, 'activate', reason);

    return res.json({
      success: true,
      message: 'Card activated.',
      card: { reference: user.koraVirtualCardId, status: 'active' },
    });
  } catch (error) {
    console.error('Cards activate error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to activate card.',
    });
  }
});

module.exports = router;
