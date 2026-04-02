const axios = require('axios');

const KORA_BASE_URL = process.env.KORA_BASE_URL || 'https://api.korapay.com';
const KORA_API_KEY = process.env.KORA_API_KEY;
const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY;

/** Avoid calling Kora FX on every wallet poll + stop log spam (same bad response each time). */
const FX_RATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let fxRateCache = null; // { rate, from_currency, to_currency, expiry_in_seconds?, expiresAt }
let fxRateNonJsonWarned = false;

class KoraService {
  constructor() {
    this.client = axios.create({
      baseURL: KORA_BASE_URL,
      headers: {
        'Authorization': `Bearer ${KORA_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'AfriKAD-Backend/1.0',
      },
    });
  }

  /**
   * Create a customer in Kora (legacy)
   */
  async createCustomer(userData) {
    try {
      const response = await this.client.post('/customers', {
        email: userData.email,
        first_name: userData.firstName,
        last_name: userData.lastName,
        phone: userData.phone,
      });
      return response.data;
    } catch (error) {
      console.error('Kora createCustomer error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create Kora customer');
    }
  }

  /**
   * Create a virtual card for a customer (legacy)
   */
  async createVirtualCard(customerId) {
    try {
      const response = await this.client.post(`/customers/${customerId}/cards`, {
        type: 'virtual',
        currency: 'USD',
      });
      return response.data;
    } catch (error) {
      console.error('Kora createVirtualCard error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create virtual card');
    }
  }

  /**
   * Create card holder (KoraPay Card Issuing)
   * POST /api/v1/cardholders
   */
  async createCardholder(data) {
    try {
      const payload = {
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
        phone: data.phone || undefined,
        date_of_birth: data.dateOfBirth,
        address: {
          street: data.address.street,
          city: data.address.city,
          state: data.address.state,
          country: data.address.country,
          zip_code: data.address.zipCode,
        },
        country_identity: {
          type: data.countryIdentity.type,
          number: data.countryIdentity.number,
          country: data.countryIdentity.country,
        },
        identity: {
          type: data.identity.type,
          number: data.identity.number,
          image: data.identity.image,
          country: data.identity.country,
        },
      };
      const response = await this.client.post('/api/v1/cardholders', payload);
      const resData = response.data;
      // Log response shape (no PII) to debug missing reference
      if (resData && !resData.reference && !resData.data?.reference) {
        const keys = resData.data ? Object.keys(resData.data) : Object.keys(resData);
        console.info('Kora cardholder response keys:', keys.join(', '));
      }
      return resData;
    } catch (error) {
      console.error('Kora createCardholder error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create card holder');
    }
  }

  /**
   * Create virtual card (KoraPay Card Issuing)
   * POST /api/v1/cards
   */
  async createCard(data) {
    try {
      const payload = {
        currency: 'USD',
        amount: data.amount ?? 0,
        card_holder_reference: data.cardHolderReference,
        reference: data.reference,
        type: 'virtual',
        brand: data.brand || 'visa',
      };
      const response = await this.client.post('/api/v1/cards', payload);
      const resData = response.data;
      // Doc: response is { status, message, data: { reference, ... } }. Normalize if API returns reference as plain string or array-like.
      if (typeof resData === 'string' && resData.length >= 10 && resData.length <= 200) {
        return { status: true, data: { reference: resData.trim(), status: 'pending' } };
      }
      if (resData && typeof resData === 'object' && !resData.reference && !resData.data?.reference && !resData.id) {
        const keys = resData.data != null ? Object.keys(resData.data) : Object.keys(resData);
        const isArrayLike = keys.length >= 10 && keys.every((k, i) => String(i) === k);
        if (isArrayLike) {
          const arr = Array.isArray(resData) ? resData : Array.from({ length: keys.length }, (_, i) => resData[i]);
          const ref = arr.map((x) => (typeof x === 'string' ? x : (typeof x === 'number' && x >= 0 && x <= 255 ? String.fromCharCode(x) : (x != null ? String(x) : '')))).join('');
          if (ref.length >= 10 && ref.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(ref)) {
            return { status: true, data: { reference: ref, status: 'pending' } };
          }
        }
        console.info('Kora card response keys:', keys.join(', '));
      }
      return resData;
    } catch (error) {
      console.error('Kora createCard error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create virtual card');
    }
  }

  /**
   * Get card details
   * GET /api/v1/cards/:reference
   */
  async getCard(reference) {
    try {
      const response = await this.client.get(`/api/v1/cards/${reference}`);
      return response.data;
    } catch (error) {
      console.error('Kora getCard error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to fetch card details');
    }
  }

  /**
   * Activate or suspend card
   * PATCH /api/i/cards/:card_reference/status
   */
  async updateCardStatus(cardReference, action, reason) {
    try {
      const response = await this.client.patch(`/api/i/cards/${cardReference}/status`, {
        action,
        reason: reason || (action === 'activate' ? 'User requested' : 'User requested freeze'),
      });
      return response.data;
    } catch (error) {
      console.error('Kora updateCardStatus error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || `Failed to ${action} card`);
    }
  }

  /**
   * Terminate card
   * PATCH /api/i/cards/:card_reference/terminate
   */
  async terminateCard(cardReference, reason, initiator) {
    try {
      const response = await this.client.patch(`/api/i/cards/${cardReference}/terminate`, {
        reason: reason || 'User requested',
        initiator,
      });
      return response.data;
    } catch (error) {
      console.error('Kora terminateCard error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to terminate card');
    }
  }

  /**
   * Perform instant FX swap (NGN to USD)
   */
  async instantSwap(amountNgn) {
    try {
      // Kora API endpoint for instant swap
      const response = await this.client.post('/swaps/instant', {
        from_currency: 'NGN',
        to_currency: 'USD',
        amount: amountNgn,
      });
      return response.data;
    } catch (error) {
      console.error('Kora instantSwap error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'FX swap failed');
    }
  }

  /**
   * Authorize a payment on a virtual card
   */
  async authorizeCardPayment(cardId, amountUsd, merchantData) {
    try {
      const response = await this.client.post(`/cards/${cardId}/authorize`, {
        amount: amountUsd,
        currency: 'USD',
        merchant_name: merchantData.name || 'Unknown Merchant',
        merchant_category: merchantData.category || 'general',
      });
      return response.data;
    } catch (error) {
      console.error('Kora authorizeCardPayment error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Card authorization failed');
    }
  }

  /**
   * Get live FX rate from Kora Exchange Rate API (real rates when product is enabled).
   * POST /api/v1/conversions/rates
   * Docs: https://developers.korapay.com/docs/exchange-rate-api
   * Returns rate (e.g. NGN per 1 USD when from=USD, to=NGN). Fallback if API fails or Currency Conversion not enabled.
   */
  async getFxRate(fromCurrency = 'USD', toCurrency = 'NGN') {
    const FALLBACK_RATE = 1600; // 1 USD = 1600 NGN (fallback when API unavailable or product not enabled)
    const path = '/api/v1/conversions/rates';
    const now = Date.now();
    if (
      fxRateCache &&
      fxRateCache.from_currency === fromCurrency &&
      fxRateCache.to_currency === toCurrency &&
      now < fxRateCache.expiresAt
    ) {
      const out = {
        rate: fxRateCache.rate,
        from_currency: fxRateCache.from_currency,
        to_currency: fxRateCache.to_currency,
      };
      if (fxRateCache.expiry_in_seconds != null) {
        out.expiry_in_seconds = fxRateCache.expiry_in_seconds;
      }
      return out;
    }

    const setCache = (payload) => {
      fxRateCache = {
        ...payload,
        expiresAt: now + FX_RATE_CACHE_TTL_MS,
      };
    };

    try {
      const response = await this.client.post(path, {
        from_currency: fromCurrency,
        to_currency: toCurrency,
        amount: 1,
        reference: `rate-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      });
      const raw = response.data;
      // Kora may return "Welcome to Kora" (string) or HTML when endpoint is wrong or product not enabled
      if (raw == null || typeof raw !== 'object') {
        if (!fxRateNonJsonWarned) {
          fxRateNonJsonWarned = true;
          console.warn(
            'Kora getFxRate: response is not JSON (got "' + String(raw).slice(0, 50) + '").',
            'Check KORA_BASE_URL (use https://api.korapay.com) and enable Currency Conversion on Kora dashboard.',
            '(Further identical warnings suppressed until restart; FX rate cached for 5 min.)'
          );
        }
        const fallback = {
          rate: FALLBACK_RATE,
          from_currency: fromCurrency,
          to_currency: toCurrency,
        };
        setCache(fallback);
        return fallback;
      }
      const data = raw?.data || raw;
      let rate = data?.rate != null ? Number(data.rate) : null;
      if (rate == null && data?.from_amount != null && data?.to_amount != null && Number(data.from_amount) > 0) {
        rate = Number(data.to_amount) / Number(data.from_amount);
      }
      if (rate == null || !Number.isFinite(rate) || rate <= 0) {
        if (!fxRateNonJsonWarned) {
          fxRateNonJsonWarned = true;
          console.warn('Kora getFxRate: no valid rate in response, using fallback', { data });
        }
        const fallback = {
          rate: FALLBACK_RATE,
          from_currency: fromCurrency,
          to_currency: toCurrency,
        };
        setCache(fallback);
        return fallback;
      }
      const ok = {
        rate,
        from_currency: data?.from_currency || fromCurrency,
        to_currency: data?.to_currency || toCurrency,
        expiry_in_seconds: data?.expiry_in_seconds,
      };
      setCache(ok);
      return ok;
    } catch (error) {
      const status = error.response?.status;
      const body = error.response?.data;
      if (!fxRateNonJsonWarned) {
        fxRateNonJsonWarned = true;
        console.warn(
          'Kora getFxRate error (using fallback):',
          status,
          body?.message || body?.error || error.message,
          '(URL: ' + (this.client.defaults?.baseURL || '') + path + ')',
          body?.message ? '' : 'Enable Currency Conversion on Kora dashboard for real rates.',
          '(Further identical warnings suppressed until restart; FX rate cached for 5 min.)'
        );
      }
      const fallback = {
        rate: FALLBACK_RATE,
        from_currency: fromCurrency,
        to_currency: toCurrency,
      };
      setCache(fallback);
      return fallback;
    }
  }

  /**
   * Get FX quote for USD amount (uses live rate from Kora when available).
   * Returns: amountUsd, rate, baseAmountNgn, fee, totalAmountNgn
   */
  async getFxQuote(amountUsd) {
    const FALLBACK_RATE = 1600;
    try {
      const rateData = await this.getFxRate('USD', 'NGN');
      const rate = rateData.rate || FALLBACK_RATE;

      const baseAmountNgn = amountUsd * rate;
      const feePercent = 0.002;
      const calculatedFee = baseAmountNgn * feePercent;
      const fee = Math.max(calculatedFee, 300);
      const totalAmountNgn = baseAmountNgn + fee;

      return {
        amountUsd,
        rate,
        baseAmountNgn,
        fee,
        totalAmountNgn,
      };
    } catch (error) {
      console.error('Kora getFxQuote error:', error);
      const rate = FALLBACK_RATE;
      const baseAmountNgn = amountUsd * rate;
      const fee = Math.max(baseAmountNgn * 0.002, 300);
      return {
        amountUsd,
        rate,
        baseAmountNgn,
        fee,
        totalAmountNgn: baseAmountNgn + fee,
      };
    }
  }

  /**
   * Initiate an NGN bank-transfer payment (dynamic virtual account)
   * POST /merchant/api/v1/charge/bank-transfer
   *
   * Used for NGN wallet deposits via bank transfer.
   * Note: This feature must be enabled on your KoraPay account.
   */
  async initiateBankTransferDeposit({ reference, amount, customer, notificationUrl, metadata = {} }) {
    try {
      const payload = {
        reference,
        amount,
        currency: 'NGN',
        notification_url: notificationUrl,
        customer: {
          email: customer.email,
          name: customer.name || undefined,
        },
        // Tag so we can recognise this as a wallet deposit in webhooks
        metadata: {
          ...metadata,
          purpose: 'wallet_deposit',
        },
      };

      // Try with /merchant prefix (similar to payout endpoint)
      const response = await this.client.post('/merchant/api/v1/charge/bank-transfer', payload);
      return response.data;
    } catch (error) {
      // Better error logging
      if (error.response) {
        console.error('Kora API Error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers,
        });
        
        // Check if it's a Cloudflare block
        if (error.response.status === 403 && error.response.data?.includes?.('Cloudflare')) {
          throw new Error('KoraPay API access blocked. Please ensure: 1) Bank Transfer API is enabled on your account, 2) You are using the correct secret key, 3) Your IP is not blocked. Contact KoraPay support if issue persists.');
        }
        
        throw new Error(error.response.data?.message || error.response.data?.error || 'Failed to initiate bank transfer deposit');
      } else if (error.request) {
        console.error('Kora API Request Error:', error.request);
        throw new Error('Network error: Could not reach KoraPay API. Please check your internet connection.');
      } else {
        console.error('Kora API Error:', error.message);
        throw new Error(error.message || 'Failed to initiate bank transfer deposit');
      }
    }
  }

  /**
   * Payout to NGN bank account (used for wallet withdrawals)
   * POST /merchant/api/v1/transactions/disburse
   * Note: Deposit (charge) and withdraw (disburse) both use the same secret key; if deposit works
   * but withdraw returns not_authorized, enable Payouts on your Kora dashboard or contact Kora support.
   */
  async payoutToBank({ reference, amount, bankCode, accountNumber, narration, customer, metadata = {} }) {
    if (!KORA_SECRET_KEY || !String(KORA_SECRET_KEY).trim()) {
      throw new Error('KORA_SECRET_KEY is not set in .env. Use your Secret key from Kora Dashboard → Settings → API Configuration.');
    }
    try {
      // Kora requires amount in two decimal places (number)
      const amountNum = Math.round(Number(amount) * 100) / 100;
      // metadata: max 5 keys; empty object not allowed per Kora docs
      const meta = Object.keys(metadata || {}).length ? metadata : undefined;
      const payload = {
        reference: String(reference),
        destination: {
          type: 'bank_account',
          amount: amountNum,
          currency: 'NGN',
          narration: narration || 'Wallet withdrawal',
          bank_account: {
            bank: String(bankCode).trim(),
            account: String(accountNumber).trim(),
          },
          customer: {
            name: customer?.name || undefined,
            email: customer?.email || '',
          },
        },
        ...(meta && { metadata: meta }),
      };

      // Try documented merchant path first; fallback to /api/v1/... if not_authorized (some accounts use non-merchant path)
      const endpoints = [
        '/merchant/api/v1/transactions/disburse',
        '/api/v1/transactions/disburse',
      ];
      let lastError = null;
      for (const path of endpoints) {
        try {
          const response = await this.client.post(path, payload);
          return response.data;
        } catch (err) {
          const d = err.response?.data;
          lastError = err;
          const isNotAuthorized = d?.error === 'not_authorized' || (d?.message && String(d.message).toLowerCase().includes('not authorized'));
          if (isNotAuthorized && path !== endpoints[endpoints.length - 1]) {
            console.info(`Kora disburse ${path} returned not_authorized, trying next endpoint...`);
            continue;
          }
          break;
        }
      }
      throw lastError;
    } catch (error) {
      const data = error.response?.data;
      console.error('Kora payoutToBank error:', data || error.message);
      if (data?.error === 'not_authorized' || (data?.message && String(data.message).toLowerCase().includes('not authorized'))) {
        throw new Error(
          'Kora payout not authorized. Deposit uses the same key—if deposit works but withdraw does not, enable Payouts/Disburse on your Kora account (Dashboard or contact support). Otherwise check KORA_SECRET_KEY: use Secret key from Settings → API Configuration and match test/live mode.'
        );
      }
      throw new Error(data?.message || 'Failed to initiate payout');
    }
  }

  /**
   * Normalize Kora banks response to { code, name }[].
   * Kora may return { data: [...] }, { banks: [...] }, or array; items may be { code, name }, { bank_code, bank_name }, etc.
   */
  _normalizeBanksResponse(raw) {
    let list = raw?.data ?? raw?.banks ?? (Array.isArray(raw) ? raw : []);
    if (!Array.isArray(list)) return [];
    return list
      .map((b) => ({
        code: String(b?.code ?? b?.bank_code ?? b?.BankCode ?? ''),
        name: String(b?.name ?? b?.bank_name ?? b?.BankName ?? b?.bank ?? ''),
      }))
      .filter((b) => b.code && b.name);
  }

  /**
   * Get list of Nigerian banks and microfinance banks.
   * Tries Kora's documented path first: /merchant/api/v1/misc/banks?countryCode=NG
   * then fallback paths; on failure returns comprehensive static list.
   * See Kora docs: https://developers.korapay.com/docs/payout-via-api (List Banks).
   */
  async getBanks() {
    const paths = [
      '/merchant/api/v1/misc/banks?countryCode=NG',
      '/merchant/api/v1/banks',
      '/api/v1/banks',
    ];
    for (const path of paths) {
      try {
        const response = await this.client.get(path);
        const normalized = this._normalizeBanksResponse(response.data);
        if (normalized.length > 0) {
          return { data: normalized };
        }
      } catch (_error) {
        // Use next path or static list below.
      }
    }
    console.info(`Kora banks API unavailable; using static list (${NIGERIAN_BANKS_AND_MFB_LIST.length} banks).`);
    return { data: NIGERIAN_BANKS_AND_MFB_LIST };
  }
}

/**
 * Comprehensive Nigerian commercial banks + microfinance banks (CBN codes).
 * Used when Kora API is unavailable. Includes major commercial and popular MFBs.
 */
const NIGERIAN_BANKS_AND_MFB_LIST = [
  // Commercial banks
  { code: '044', name: 'Access Bank' },
  { code: '063', name: 'Access Bank (Diamond)' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '084', name: 'Enterprise Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '526', name: 'Parallex Bank' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '100', name: 'Suntrust Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
  { code: '090', name: 'VFD Microfinance Bank' },
  // Microfinance banks (popular / national)
  { code: '50001', name: 'AB Microfinance Bank' },
  { code: '50002', name: 'LAPO Microfinance Bank' },
  { code: '50003', name: 'Accion Microfinance Bank' },
  { code: '50004', name: 'Baobab Microfinance Bank' },
  { code: '50005', name: 'RenMoney Microfinance Bank' },
  { code: '50006', name: 'Finca Microfinance Bank' },
  { code: '50007', name: 'Lagos Building Investment Company (LBIC) MFB' },
  { code: '50008', name: 'Addosser Microfinance Bank' },
  { code: '50009', name: 'Fortis Microfinance Bank' },
  { code: '50010', name: 'Haven Microfinance Bank' },
  { code: '50011', name: 'Infinity Trust Microfinance Bank' },
  { code: '50012', name: 'NPF Microfinance Bank' },
  { code: '50013', name: 'FBN Microfinance Bank' },
  { code: '50014', name: 'Grooming Microfinance Bank' },
  { code: '50015', name: 'Kuda Microfinance Bank' },
  { code: '50016', name: 'Moniepoint Microfinance Bank' },
  { code: '50017', name: 'Opay (Opay Digital Services)' },
  { code: '50018', name: 'Palmpay (Palmpay Limited)' },
  { code: '50019', name: 'Paga' },
  { code: '50020', name: 'Sparkle Microfinance Bank' },
  { code: '50022', name: 'FairMoney Microfinance Bank' },
  { code: '50023', name: 'Carbon' },
  { code: '50024', name: 'Quickteller Paypoint (Interswitch)' },
];

module.exports = new KoraService();
