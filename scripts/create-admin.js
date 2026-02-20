/**
 * Create or promote an admin user.
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from .env — change those there.
 * Run: npm run create-admin   (from backend/)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const EMAIL = (process.env.ADMIN_EMAIL || 'admin@afrikad.com').toLowerCase().trim();
const PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/afrikad';
  await mongoose.connect(uri);

  let user = await User.findOne({ email: EMAIL });
  if (user) {
    user.role = 'admin';
    user.password = PASSWORD; // reset to known password; pre('save') will re-hash
    await user.save();
    console.log('✅ Existing user promoted to admin (password reset):', EMAIL);
  } else {
    await User.create({
      email: EMAIL,
      password: PASSWORD,
      firstName: process.env.ADMIN_FIRST_NAME || 'Admin',
      lastName: process.env.ADMIN_LAST_NAME || 'User',
      role: 'admin',
    });
    console.log('✅ Admin user created:', EMAIL);
  }
  console.log('   Log in with:  ', EMAIL, '  /  ', PASSWORD);
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ create-admin failed:', err.message);
  process.exit(1);
});
