const path = require('path');

module.exports = {
  preset: 'react-native',
  transformIgnorePatterns: [
    // @noble/* ships ESM only ("Cannot use import statement outside a module"
    // without this). webcrypto.ts pulls in @noble/ciphers + @noble/hashes to
    // give Hermes the AES-GCM/SHA that it has no native WebCrypto for, so the
    // polyfill test can't run at all unless these are transformed.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|@tanstack/.*|@nostrify/.*|@noble/.*|nostr-tools)',
  ],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/../core/src/$1',
  },
  moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}', '**/*.test.{ts,tsx}'],
};
