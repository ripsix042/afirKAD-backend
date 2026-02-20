const request = require('supertest');
const User = require('../models/User');

process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';

const app = require('../server');

describe('Auth', () => {
  const testUser = {
    email: 'test-auth-' + Date.now() + '@example.com',
    password: 'password123',
    firstName: 'Test',
    lastName: 'User',
  };

  afterEach(async () => {
    await User.deleteOne({ email: testUser.email });
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user and return token', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send(testUser)
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(testUser.email);
    });

    it('should reject duplicate email', async () => {
      await request(app).post('/api/auth/register').send(testUser).expect(201);
      const res = await request(app).post('/api/auth/register').send(testUser).expect(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(testUser);
    });

    it('should login and return token', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: testUser.password })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
    });

    it('should reject wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: 'wrongpassword' })
        .expect(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/auth/me', () => {
    let token;

    beforeEach(async () => {
      const res = await request(app).post('/api/auth/register').send(testUser);
      token = res.body.token;
    });

    it('should return current user with valid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.email).toBe(testUser.email);
    });

    it('should return 401 without token', async () => {
      await request(app).get('/api/auth/me').expect(401);
    });
  });
});
