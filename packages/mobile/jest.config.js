const path = require('path');

module.exports = {
  preset: 'react-native',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|@tanstack/.*|@nostrify/.*|nostr-tools)',
  ],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/../core/src/$1',
  },
  moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}', '**/*.test.{ts,tsx}'],
};
