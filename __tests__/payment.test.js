const request = require('supertest');
const User = require('../models/User');
const PaymentIdempotency = require('../models/PaymentIdempotency');

const app = require('../server');

jest.mock('../services/kora', () => ({
  getFxQuote: jest.fn().mockResolvedValue({
    rate: 1600,
    totalAmountNgn: 16000,
    fee: 0,
    baseAmountNgn: 16000,
  }),
  instantSwap: jest.fn().mockResolvedValue({ reference: 'mock-swap-1', rate: 1600, amount: 10 }),
  authorizeCardPayment: jest.fn().mockResolvedValue({ reference: 'mock-pay-1' }),
}));

describe('Payment', () => {
  let token;
  let userId;
  const testUser = {
    email: `payment-${Date.now()}@example.com`,
    password: 'password123',
    firstName: 'Payment',
    lastName: 'Test',
  };

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send(testUser);
    token = res.body.token;
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    userId = me.body.user.id;
    await User.findByIdAndUpdate(userId, {
      'wallet.ngn': 100000,
      'wallet.lockedNgn': 0,
      koraVirtualCardId: 'mock-card-id',
    });
  });

  afterAll(async () => {
    await User.deleteOne({ email: testUser.email });
    await PaymentIdempotency.deleteMany({ userId });
  });

  describe('POST /api/payment with idempotency', () => {
    const idempotencyKey = `test-key-${Date.now()}`;

    it('should accept Idempotency-Key and return same response on duplicate', async () => {
      const first = await request(app)
        .post('/api/payment')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ amountUsd: 10, merchantName: 'Test Merchant' });

      const second = await request(app)
        .post('/api/payment')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ amountUsd: 10, merchantName: 'Test Merchant' });

      expect(first.status).toBe(second.status);
      expect(first.body.success).toBe(second.body.success);
      if (first.body.transaction) {
        expect(first.body.transaction.id).toEqual(second.body.transaction.id);
      }
    });
  });

  describe('GET /api/payment/quote', () => {
    it('should return quote for amountUsd', async () => {
      const res = await request(app)
        .get('/api/payment/quote?amountUsd=25')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.quote).toBeDefined();
      expect(res.body.quote.rate).toBeDefined();
      expect(res.body.quote.totalAmountNgn).toBeDefined();
    });

    it('should return 401 without token', async () => {
      await request(app).get('/api/payment/quote?amountUsd=25').expect(401);
    });
  });
});
