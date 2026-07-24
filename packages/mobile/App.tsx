import 'react-native-get-random-values'; // Must be first — polyfills crypto.getRandomValues
import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { prepareSecureStorage, mmkvInitError, mmkvIsEncrypted, mobileStorage } from './src/storage/MmkvStorage';
import { setImageProxyTemplate } from '@core/imageProxy';
import { NostrProvider, WelshmanRouterBridge } from './src/lib/NostrProvider';
import { AuthProvider } from './src/lib/AuthContext';
import { useNotificationCount } from './src/hooks/useNotificationCount';
import { NwcProvider } from './src/hooks/useNwc';
import { AppProvider } from './src/lib/AppContext';
import { ToastProvider } from './src/hooks/useToast';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { NostrSync } from './src/components/NostrSync';
import { AutoSaveManager } from './src/components/AutoSaveManager';
import { EmojiSetsModalProvider } from './src/components/EmojiSetsModalProvider';
import { HomeScreen } from './src/screens/HomeScreen';
import { DiscoverScreen } from './src/screens/DiscoverScreen';
import { SavedScreen } from './src/screens/SavedScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();

/**
 * Tab navigator — lives inside the provider tree so it can read the unseen-
 * notification count for the Activity tab badge (parity with web's TabBar
 * red count badge). Focusing the tab marks notifications seen, clearing it.
 */
function AppTabs() {
  const { newCount, markSeen } = useNotificationCount();
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: '#1f1f1f',
            borderTopColor: '#404040',
          },
          tabBarActiveTintColor: '#f2f2f2',
          tabBarInactiveTintColor: '#b3b3b3',
        }}
      >
        <Tab.Screen
          name="Feed"
          component={HomeScreen}
          options={{ tabBarLabel: 'Feed' }}
        />
        <Tab.Screen
          name="Discover"
          component={DiscoverScreen}
          options={{ tabBarLabel: 'Discover' }}
        />
        <Tab.Screen
          name="Saved"
          component={SavedScreen}
          options={{ tabBarLabel: 'Saved' }}
        />
        <Tab.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{
            tabBarLabel: 'Activity',
            tabBarBadge: newCount > 0 ? (newCount >= 50 ? '50+' : newCount) : undefined,
            tabBarBadgeStyle: { backgroundColor: '#ef4444', color: '#fff', fontSize: 10 },
          }}
          listeners={{ focus: () => markSeen() }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ tabBarLabel: 'Settings' }}
        />
      </Tab.Navigator>
      <StatusBar style="light" />
    </NavigationContainer>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  // Block render until encrypted MMKV is provisioned. The bootstrap also
  // migrates any pre-existing unencrypted data on first run, so it must
  // complete before anything reads or writes storage.
  const [storageReady, setStorageReady] = useState(false);
  // Surface init errors to the user rather than silently degrading. If keychain
  // access failed and we're running unencrypted, the user should know so they
  // can decide whether to continue.
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [warningAcked, setWarningAcked] = useState(false);
  useEffect(() => {
    Promise.all([prepareSecureStorage()]).finally(() => {
      if (mmkvInitError) {
        setStorageWarning(mmkvInitError);
      } else if (!mmkvIsEncrypted) {
        setStorageWarning('Storage is running in unencrypted mode. Sensitive data (backup metadata) is not protected at rest.');
      }
      // Activate the persisted image-proxy template (if any) before any
      // image renders. Settings UI calls setImageProxyTemplate directly on
      // save, so this only matters for cold launches.
      setImageProxyTemplate(mobileStorage.getSync('corkboard:image-proxy-template'));
      setStorageReady(true);
    });
  }, []);

  if (!storageReady) {
    return (
      <View style={{ flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 40, marginBottom: 16 }}>📌</Text>
        <ActivityIndicator color="#a855f7" />
        <Text style={{ color: '#888', fontSize: 12, marginTop: 12 }}>Unlocking secure storage…</Text>
      </View>
    );
  }

  if (storageWarning && !warningAcked) {
    return (
      <View style={{ flex: 1, backgroundColor: '#1f1f1f', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 40, marginBottom: 16 }}>⚠️</Text>
        <Text style={{ color: '#f97316', fontSize: 16, fontWeight: '600', marginBottom: 12, textAlign: 'center' }}>
          Secure storage warning
        </Text>
        <Text style={{ color: '#d4d4d4', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 }}>
          {storageWarning}
        </Text>
        <Text
          onPress={() => setWarningAcked(true)}
          style={{
            color: '#a855f7',
            fontSize: 14,
            fontWeight: '600',
            paddingVertical: 12,
            paddingHorizontal: 24,
            borderWidth: 1,
            borderColor: '#a855f7',
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          Continue anyway
        </Text>
      </View>
    );
  }

  return (
    <ErrorBoundary>
    <AppProvider>
    <ToastProvider>
    <QueryClientProvider client={queryClient}>
      <NostrProvider>
      <AuthProvider>
      <NwcProvider>
      <WelshmanRouterBridge />
      <NostrSync />
      <AutoSaveManager />
      <EmojiSetsModalProvider>
        <AppTabs />
      </EmojiSetsModalProvider>
      </NwcProvider>
      </AuthProvider>
      </NostrProvider>
    </QueryClientProvider>
    </ToastProvider>
    </AppProvider>
    </ErrorBoundary>
  );
}
