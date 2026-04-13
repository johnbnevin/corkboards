/**
 * Compact login prompt widget — embeddable in screens that require auth.
 * Mobile port of web's LoginArea component.
 * Shows current user info if logged in, or a login button that opens LoginDialog.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
} from 'react-native';
import { useAuth } from '../../lib/AuthContext';
import { useAuthor } from '../../hooks/useAuthor';
import { genUserName } from '@core/genUserName';
import { LoginDialog } from './LoginDialog';

interface LoginAreaProps {
  style?: object;
}

function LoggedInDisplay({ pubkey, style }: { pubkey: string; style?: object }) {
  const { data: author } = useAuthor(pubkey);
  const displayName = author?.metadata?.name ?? author?.metadata?.display_name ?? genUserName(pubkey);
  const picture = author?.metadata?.picture;

  return (
    <View style={[styles.loggedInRow, style]}>
      {picture ? (
        <Image source={{ uri: picture }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarText}>{displayName.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <Text style={styles.displayName} numberOfLines={1}>{displayName}</Text>
    </View>
  );
}

export function LoginArea({ style }: LoginAreaProps) {
  const { pubkey } = useAuth();
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);

  if (pubkey) {
    return <LoggedInDisplay pubkey={pubkey} style={style} />;
  }

  return (
    <View style={style}>
      <TouchableOpacity style={styles.loginBtn} onPress={() => setLoginDialogOpen(true)}>
        <Text style={styles.loginBtnText}>Login</Text>
      </TouchableOpacity>
      <LoginDialog
        isOpen={loginDialogOpen}
        onClose={() => setLoginDialogOpen(false)}
        onLogin={() => setLoginDialogOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loggedInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    borderRadius: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#404040',
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#f2f2f2',
    fontSize: 12,
    fontWeight: '600',
  },
  displayName: {
    color: '#f2f2f2',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  loginBtn: {
    backgroundColor: '#f97316',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
  },
  loginBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
