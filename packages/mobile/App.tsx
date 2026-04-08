import 'react-native-get-random-values'; // Must be first — polyfills crypto.getRandomValues
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NostrProvider } from './src/lib/NostrProvider';
import { AuthProvider } from './src/lib/AuthContext';
import { NwcProvider } from './src/hooks/useNwc';
import { HomeScreen } from './src/screens/HomeScreen';
import { MessagesScreen } from './src/screens/MessagesScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();
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
  return (
    <QueryClientProvider client={queryClient}>
      <NostrProvider>
      <AuthProvider>
      <NwcProvider>
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
            name="Notifications"
            component={NotificationsScreen}
            options={{ tabBarLabel: 'Activity' }}
          />
          <Tab.Screen
            name="Messages"
            component={MessagesScreen}
            options={{ tabBarLabel: 'DMs' }}
          />
          <Tab.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ tabBarLabel: 'Settings' }}
          />
        </Tab.Navigator>
        <StatusBar style="light" />
      </NavigationContainer>
      </NwcProvider>
      </AuthProvider>
      </NostrProvider>
    </QueryClientProvider>
  );
}
