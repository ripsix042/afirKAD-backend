module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['routes/**/*.js', 'models/**/*.js', 'middleware/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
