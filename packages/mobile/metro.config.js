const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const monorepoRoot = path.resolve(__dirname, '../..');

const config = getDefaultConfig(__dirname);

config.projectRoot = __dirname;

// Watch core package + root node_modules (hoisted deps)
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/core'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Resolve node_modules from both local and root
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Force single copies of React packages — the root node_modules has React 18
// (for the web package) while mobile needs React 19. Without this, hoisted
// deps like @tanstack/react-query import React 18 from root, causing the
// "Cannot read property 'useEffect' of null" crash.
config.resolver.extraNodeModules = {
  'react': path.resolve(__dirname, 'node_modules/react'),
  'react-native': path.resolve(__dirname, 'node_modules/react-native'),
  'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
};

module.exports = config;
