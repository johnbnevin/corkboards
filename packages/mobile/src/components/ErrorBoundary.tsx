import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <ScrollView style={styles.scroll}>
            <Text style={styles.error}>{this.state.error?.message}</Text>
            <Text style={styles.stack}>{this.state.error?.stack}</Text>
          </ScrollView>
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ hasError: false, error: null })}
          >
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f', padding: 20, paddingTop: 80, alignItems: 'center' },
  title: { fontSize: 20, fontWeight: 'bold', color: '#f2f2f2', marginBottom: 16 },
  scroll: { flex: 1, width: '100%', marginBottom: 16 },
  error: { color: '#f97316', fontSize: 14, marginBottom: 12 },
  stack: { color: '#888', fontSize: 11 },
  button: { paddingHorizontal: 24, paddingVertical: 12, backgroundColor: '#333', borderRadius: 8 },
  buttonText: { color: '#f97316', fontSize: 14 },
});
