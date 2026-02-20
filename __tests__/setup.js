const mongoose = require('mongoose');

beforeAll(async () => {
  const uri = process.env.MONGODB_URI_TEST || process.env.MONGODB_URI || 'mongodb://localhost:27017/afrikad_test';
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.connection.close();
});
