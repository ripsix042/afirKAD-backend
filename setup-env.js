const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generate a secure JWT secret
const jwtSecret = crypto.randomBytes(32).toString('base64');

const envContent = `# Server Configuration
PORT=5000
NODE_ENV=development

# JWT Secret - Auto-generated (secure random string)
JWT_SECRET=${jwtSecret}

# MongoDB Connection
# For local development, use: mongodb://localhost:27017/afrikad
# For MongoDB Atlas, use your connection string: mongodb+srv://username:password@cluster.mongodb.net/afrikad
MONGODB_URI=mongodb://localhost:27017/afrikad

# Kora API Configuration
# Get your API credentials from: https://kora.com
KORA_API_KEY=your-kora-api-key-here
KORA_SECRET_KEY=your-kora-secret-key-here
KORA_BASE_URL=https://api.kora.com

# Admin Configuration (Optional - for seeding admin user)
ADMIN_EMAIL=admin@afrikad.com
ADMIN_PASSWORD=changeme
`;

const envPath = path.join(__dirname, '.env');

// Check if .env already exists
if (fs.existsSync(envPath)) {
  console.log('⚠️  .env file already exists. Skipping creation.');
  console.log('If you want to recreate it, delete the existing .env file first.');
  process.exit(0);
}

// Create .env file
try {
  fs.writeFileSync(envPath, envContent);
  console.log('✅ .env file created successfully!');
  console.log('\n📝 Next steps:');
  console.log('1. Update MONGODB_URI with your MongoDB connection string');
  console.log('2. Add your Kora API credentials (KORA_API_KEY and KORA_SECRET_KEY)');
  console.log('3. Update ADMIN_EMAIL and ADMIN_PASSWORD if needed');
  console.log('\n⚠️  Remember: .env file is gitignored and should not be committed!');
} catch (error) {
  console.error('❌ Error creating .env file:', error.message);
  process.exit(1);
}
