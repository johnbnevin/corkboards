// MUST be first. `import App from './App'` below transitively evaluates
// NostrProvider and friends, some of which touch AbortSignal at module scope —
// so the polyfills have to be installed before that import is resolved. ES
// module imports run in source order, so placing this line first is what
// guarantees it. See src/polyfills.ts for why React Native needs it at all.
import './src/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
