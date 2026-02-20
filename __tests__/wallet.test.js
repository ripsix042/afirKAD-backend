const request = require('supertest');
const User = require('../models/User');

const app = require('../server');

describe('Wallet', () => {
  let token;
  const testUser = {
    email: 'wallet-' + Date.now() + '@example.com',
    password: 'password123',
    firstName: 'Wallet',
    lastName: 'Test',
  };

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send(testUser);
    token = res.body.token;
  });

  afterAll(async () => {
    await User.deleteOne({ email: testUser.email });
  });

  describe('GET /api/wallet/balance', () => {
    it('should return wallet balance with valid token', async () => {
      const res = await request(app)
        .get('/api/wallet/balance')
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet).toBeDefined();
      expect(typeof res.body.wallet.ngn).toBe('number');
      expect(typeof res.body.wallet.usd).toBe('number');
    });

    it('should return 401 without token', async () => {
      await request(app).get('/api/wallet/balance').expect(401);
    });
  });
});
