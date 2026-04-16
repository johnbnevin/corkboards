/**
 * AdvancedSettings — modal content for less-frequently-used settings.
 *
 * Includes relay management, relay health, blossom server config, and account options.
 * Each destructive option has a confirmation dialog before acting.
 */

import { useState, useEffect, useCallback } from 'react';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Eye, Database, Settings, Bookmark, Trash2, Wifi, WifiOff, Compass,
  Plus, X, CheckCircle, AlertTriangle, Server,
} from 'lucide-react';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useRelayHealth, type RelayHealth } from '@/hooks/useRelayHealth';
import { useToast } from '@/hooks/useToast';
import { FALLBACK_RELAYS, READ_ONLY_RELAYS } from '@/components/NostrProvider';
import {
  getBlossomServers, setBlossomServers, DEFAULT_BLOSSOM_SERVERS,
} from '@/hooks/useNostrBackup';

interface AdvancedSettingsProps {
  dismissedCount: number;
  onClearDismissed: () => void;
  onOpenProfileCache: () => void;
  publishClientTag: boolean;
  onToggleClientTag: () => void;
  publicBookmarks: boolean;
  onTogglePublicBookmarks: () => void;
  onDeleteAccount: () => void;
  initialSection?: 'main' | 'relays' | 'blossom';
  isOnboarding: boolean;
  onResetOnboarding: () => void;
}

type ConfirmAction = 'dismissed' | 'cache' | 'clientTag' | 'bookmarks' | 'delete' | null;

interface Relay {
  url: string;
  read: boolean;
  write: boolean;
}

function StatusDot({ status }: { status: RelayHealth['status'] }) {
  if (status === 'healthy') return <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />;
  if (status === 'slow') return <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />;
  if (status === 'error') return <WifiOff className="h-3 w-3 text-red-500 shrink-0" />;
  return <Wifi className="h-3 w-3 text-muted-foreground shrink-0" />;
}

export function AdvancedSettings({
  dismissedCount,
  onClearDismissed,
  onOpenProfileCache,
  publishClientTag,
  onToggleClientTag,
  publicBookmarks,
  onTogglePublicBookmarks,
  onDeleteAccount,
  initialSection = 'main',
  isOnboarding,
  onResetOnboarding,
}: AdvancedSettingsProps) {
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [section, setSection] = useState<'main' | 'relays' | 'blossom'>(initialSection);

  // Sync with external section changes (e.g., opened from backup dropdown)
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const confirmMessages: Record<Exclude<ConfirmAction, null>, { title: string; description: string; action: string; destructive?: boolean }> = {
    dismissed: {
      title: 'Bring back dismissed notes?',
      description: `This will restore ${dismissedCount} dismissed note${dismissedCount === 1 ? '' : 's'} to your feed. They will reappear in their original positions.`,
      action: 'Restore notes',
    },
    cache: {
      title: 'Open Profile Cache?',
      description: 'View and manage locally cached profile data. You can clear stale profiles or force a refresh.',
      action: 'Open',
    },
    clientTag: {
      title: publishClientTag ? 'Disable client tag?' : 'Enable client tag?',
      description: publishClientTag
        ? 'Your posts will no longer include a tag identifying Corkboards as the client. Other users won\'t see which app you used.'
        : 'Your posts will include a tag identifying Corkboards as the client. This helps the Nostr ecosystem track client diversity.',
      action: publishClientTag ? 'Disable' : 'Enable',
    },
    bookmarks: {
      title: publicBookmarks ? 'Make bookmarks private?' : 'Make bookmarks public?',
      description: publicBookmarks
        ? 'Your saved notes will be encrypted so only you can see them. This is the recommended setting for privacy.'
        : 'Your saved notes will be visible to anyone who looks at your bookmark list. Other Nostr clients may display them on your profile.',
      action: publicBookmarks ? 'Make private' : 'Make public',
    },
    delete: {
      title: 'Delete your account?',
      description: 'This will broadcast a deletion event to all relays. Your profile and notes may still exist on some relays. This cannot be undone.',
      action: 'Delete account',
      destructive: true,
    },
  };

  const handleConfirm = () => {
    switch (confirm) {
      case 'dismissed': onClearDismissed(); break;
      case 'cache': onOpenProfileCache(); break;
      case 'clientTag': onToggleClientTag(); break;
      case 'bookmarks': onTogglePublicBookmarks(); break;
      case 'delete': onDeleteAccount(); break;
    }
    setConfirm(null);
  };

  const active = confirm ? confirmMessages[confirm] : null;

  if (section === 'relays') return <RelaySection />;
  if (section === 'blossom') return <BlossomSection />;

  return (
    <>
      <div className="space-y-1">
        {dismissedCount > 0 && (
          <button type="button" className="w-full text-left rounded-md px-3 py-2 hover:bg-muted transition-colors" onClick={() => setConfirm('dismissed')}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Eye className="h-4 w-4 shrink-0" />
              Bring back dismissed ({dismissedCount})
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 pl-6">Restore dismissed notes back into your feed</p>
          </button>
        )}

        <button type="button" className="w-full text-left rounded-md px-3 py-2 hover:bg-muted transition-colors" onClick={() => setConfirm('cache')}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Database className="h-4 w-4 shrink-0" />
            Profile Cache
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 pl-6">Manage locally cached Nostr profile data</p>
        </button>

        <button type="button" className="w-full text-left rounded-md px-3 py-2 hover:bg-muted transition-colors" onClick={() => setConfirm('clientTag')}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Settings className="h-4 w-4 shrink-0" />
            {publishClientTag ? '✓ ' : ''}Client Tag
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 pl-6">Tag your posts as sent from Corkboards</p>
        </button>

        <button type="button" className="w-full text-left rounded-md px-3 py-2 hover:bg-muted transition-colors" onClick={() => setConfirm('bookmarks')}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bookmark className="h-4 w-4 shrink-0" />
            {publicBookmarks ? '✓ ' : ''}Public Bookmarks
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 pl-6">
            {publicBookmarks ? 'Your saved notes are visible to others' : 'Your saved notes are encrypted and private'}
          </p>
        </button>

        {!isOnboarding && (
          <button type="button" className="w-full text-left rounded-md px-3 py-2 hover:bg-muted transition-colors" onClick={onResetOnboarding}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Compass className="h-4 w-4 shrink-0" />
              Restart Onboarding
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 pl-6">Show the discover/follow guide again</p>
          </button>
        )}

        <Separator className="my-2" />

        <button type="button" className="w-full text-left rounded-md px-3 py-2 hover:bg-red-50 dark:hover:bg-red-950 transition-colors" onClick={() => setConfirm('delete')}>
          <div className="flex items-center gap-2 text-sm font-medium text-red-600">
            <Trash2 className="h-4 w-4 shrink-0" />
            Delete Account
          </div>
          <p className="text-xs text-red-400 mt-0.5 pl-6">Broadcast a deletion event to all relays</p>
        </button>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{active?.title}</AlertDialogTitle>
            <AlertDialogDescription>{active?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              className={active?.destructive ? 'bg-red-600 hover:bg-red-700 text-white' : ''}
            >
              {active?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Relay Management Section ─────────────────────────────────────────────

function RelaySection() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutate: publishEvent } = useNostrPublish();
  const { toast } = useToast();
  const { relayHealth, getShortName, checkAllRelays } = useRelayHealth();

  // User relays are everything in their NIP-65 event (config.relayMetadata.relays).
  // This includes relays that happen to match hardcoded fallbacks — those are the
  // user's own choices and must be shown and never silently removed.
  const [relays, setRelays] = useState<Relay[]>(config.relayMetadata.relays);
  const [newRelayUrl, setNewRelayUrl] = useState('');
  const [includeFallbacks, setIncludeFallbacks] = useState(true);

  /** Normalize relay URL for comparison (strip trailing slash) */
  const norm = (url: string) => url.replace(/\/+$/, '');
  /** Check if a relay URL is already in the user's NIP-65 list */
  const isInUserList = (url: string) => relays.some(r => norm(r.url) === norm(url));

  useEffect(() => {
    setRelays(config.relayMetadata.relays);
  }, [config.relayMetadata.relays]);

  const normalizeRelayUrl = (url: string): string => {
    url = url.trim();
    try { return new URL(url).toString(); } catch {
      try { return new URL(`wss://${url}`).toString(); } catch { return url; }
    }
  };

  const handleAddRelay = () => {
    const normalized = normalizeRelayUrl(newRelayUrl);
    try { new URL(normalized); } catch {
      toast({ title: 'Invalid relay URL', variant: 'destructive' });
      return;
    }
    if (relays.some(r => r.url === normalized)) {
      toast({ title: 'Relay already exists', variant: 'destructive' });
      return;
    }
    const newRelays = [...relays, { url: normalized, read: true, write: true }];
    setRelays(newRelays);
    setNewRelayUrl('');
    saveRelays(newRelays);
  };

  const handleRemoveRelay = (url: string) => {
    const newRelays = relays.filter(r => r.url !== url);
    setRelays(newRelays);
    saveRelays(newRelays);
  };

  const handleToggleRead = (url: string) => {
    const newRelays = relays.map(r => r.url === url ? { ...r, read: !r.read } : r);
    setRelays(newRelays);
    saveRelays(newRelays);
  };

  const handleToggleWrite = (url: string) => {
    const newRelays = relays.map(r => r.url === url ? { ...r, write: !r.write } : r);
    setRelays(newRelays);
    saveRelays(newRelays);
  };

  const saveRelays = useCallback((userRelays: Relay[]) => {
    // Config stores ONLY the user's NIP-65 relays — hardcoded relays are always
    // added by NostrProvider's reqRouter/eventRouter separately. This ensures
    // NostrSync won't see hardcoded relays as "user relays" and we never
    // accidentally overwrite the user's Nostr relay list with our defaults.
    const now = Math.floor(Date.now() / 1000);
    updateConfig((current) => ({
      ...current,
      relayMetadata: { relays: userRelays, updatedAt: now },
    }));
    // Publish the user's relay list to Nostr (NIP-65 kind:10002)
    if (user) {
      const tags = userRelays.map(relay => {
        if (relay.read && relay.write) return ['r', relay.url];
        if (relay.read) return ['r', relay.url, 'read'];
        if (relay.write) return ['r', relay.url, 'write'];
        return null;
      }).filter((tag): tag is string[] => tag !== null);
      publishEvent(
        { kind: 10002, content: '', tags },
        {
          onSuccess: () => toast({ title: 'Relay list published to Nostr' }),
          onError: () => toast({ title: 'Failed to publish relay list', variant: 'destructive' }),
        }
      );
    }
  }, [updateConfig, user, publishEvent, toast]);

  const getHealthForRelay = (url: string): RelayHealth | undefined => {
    return relayHealth.find(h => h.url === url || h.url === url.replace(/\/$/, '') + '/');
  };

  const healthy = relayHealth.filter(r => r.status === 'healthy').length;
  const total = relayHealth.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium flex-1">Relays</span>
        <span className="text-xs text-muted-foreground">{healthy}/{total} healthy</span>
        <Button variant="ghost" size="sm" onClick={checkAllRelays} className="h-7 px-2 text-xs">Check</Button>
      </div>

      {/* ── Your Relays (NIP-65, editable) ── */}
      <div>
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Your Relays (NIP-65)</p>
        <p className="text-[10px] text-muted-foreground mb-1.5">Synced from your Nostr relay list. Changes publish a new kind:10002 event.</p>
        {relays.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-2">No relays in your Nostr relay list. Add one below.</p>
        ) : (
          <div className="space-y-1.5 max-h-[30vh] overflow-y-auto">
            {relays.map((relay) => {
              const health = getHealthForRelay(relay.url);
              return (
                <div key={relay.url} className="flex items-center gap-2 p-2 rounded-md border bg-muted/20 text-xs">
                  <StatusDot status={health?.status || 'unknown'} />
                  <span className="font-mono flex-1 truncate" title={relay.url}>{relay.url}</span>
                  {health && health.status !== 'unknown' && (
                    <span className={`text-[10px] shrink-0 ${health.status === 'healthy' ? 'text-green-500' : health.status === 'slow' ? 'text-yellow-500' : 'text-red-500'}`}>
                      {health.latency !== null ? `${health.latency}ms` : health.status}
                    </span>
                  )}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-5 text-muted-foreground shrink-0">
                        <Settings className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-44" align="end">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs cursor-pointer">Read</Label>
                          <Switch checked={relay.read} onCheckedChange={() => handleToggleRead(relay.url)} className="data-[state=checked]:bg-purple-500 scale-75" />
                        </div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs cursor-pointer">Write</Label>
                          <Switch checked={relay.write} onCheckedChange={() => handleToggleWrite(relay.url)} className="data-[state=checked]:bg-orange-500 scale-75" />
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="ghost" size="icon"
                    onClick={() => handleRemoveRelay(relay.url)}
                    className="size-5 text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {/* Add relay */}
        <div className="flex gap-1.5 mt-2">
          <Input
            placeholder="wss://relay.example.com"
            value={newRelayUrl}
            onChange={(e) => setNewRelayUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddRelay(); }}
            className="h-8 text-xs"
          />
          <Button onClick={handleAddRelay} disabled={!newRelayUrl.trim()} variant="outline" size="sm" className="h-8 shrink-0">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Separator />

      {/* ── Fallback Relays (hardcoded, read/write, include toggle) ── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Fallback Relays</p>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">Include</span>
            <Switch checked={includeFallbacks} onCheckedChange={setIncludeFallbacks} className="scale-75" />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mb-1.5">Read + write relays used for discovery and bootstrapping</p>
        <div className="space-y-0.5">
          {FALLBACK_RELAYS.map(url => {
            const health = getHealthForRelay(url);
            const inUserList = isInUserList(url);
            return (
              <div key={url} className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded ${includeFallbacks ? 'text-foreground' : 'text-muted-foreground/40'}`}>
                <StatusDot status={health?.status || 'unknown'} />
                <span className="font-mono truncate">{url}</span>
                {inUserList && <span className="text-green-500 shrink-0">in your list</span>}
                {health?.latency != null && <span className="shrink-0">{health.latency}ms</span>}
              </div>
            );
          })}
        </div>
      </div>

      <Separator />

      {/* ── Indexer / Archive Relays (hardcoded, read-only, no write toggle) ── */}
      <div>
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Indexer Relays</p>
        <p className="text-[10px] text-muted-foreground mb-1.5">Read-only archive relays for event lookup and discovery</p>
        <div className="space-y-0.5">
          {READ_ONLY_RELAYS.map(url => {
            const health = getHealthForRelay(url);
            return (
              <div key={url} className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded text-foreground">
                <StatusDot status={health?.status || 'unknown'} />
                <span className="font-mono truncate">{url}</span>
                <span className="text-muted-foreground shrink-0">read-only</span>
                {health?.latency != null && <span className="shrink-0">{health.latency}ms</span>}
              </div>
            );
          })}
        </div>
      </div>

      {!user && (
        <p className="text-xs text-muted-foreground">Log in to sync your relay list with Nostr</p>
      )}
    </div>
  );
}

// ─── Blossom Server Management Section ────────────────────────────────────

function BlossomSection() {
  const { toast } = useToast();
  const allServers = getBlossomServers();
  // Separate user servers (not in defaults) from fallback servers
  const [userServers, setUserServers] = useState<string[]>(() =>
    allServers.filter(s => !DEFAULT_BLOSSOM_SERVERS.includes(s))
  );
  const [includeFallbacks, setIncludeFallbacks] = useState(true);
  const [newUrl, setNewUrl] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, 'ok' | 'error'>>(new Map());

  // Persist: user servers first (priority), then fallbacks if included
  const persistServers = useCallback((users: string[], withFallbacks: boolean) => {
    const combined = [...users, ...(withFallbacks ? DEFAULT_BLOSSOM_SERVERS : [])];
    // Deduplicate while preserving order
    setBlossomServers([...new Set(combined)]);
  }, []);

  const handleAdd = () => {
    let url = newUrl.trim();
    if (!url) return;
    if (!url.startsWith('https://')) url = 'https://' + url;
    if (!url.endsWith('/')) url += '/';
    try { new URL(url); } catch {
      toast({ title: 'Invalid URL', variant: 'destructive' });
      return;
    }
    if (userServers.includes(url) || DEFAULT_BLOSSOM_SERVERS.includes(url)) {
      toast({ title: 'Server already in list', variant: 'destructive' });
      return;
    }
    const updated = [...userServers, url];
    setUserServers(updated);
    persistServers(updated, includeFallbacks);
    setNewUrl('');
    toast({ title: 'Server added' });
  };

  const handleRemoveUser = (url: string) => {
    const updated = userServers.filter(s => s !== url);
    setUserServers(updated);
    persistServers(updated, includeFallbacks);
  };

  const handleToggleFallbacks = (checked: boolean) => {
    setIncludeFallbacks(checked);
    persistServers(userServers, checked);
  };

  const testServer = async (url: string) => {
    setTesting(url);
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000), method: 'HEAD' });
      setTestResults(prev => new Map(prev).set(url, resp.ok || resp.status === 405 ? 'ok' : 'error'));
    } catch {
      setTestResults(prev => new Map(prev).set(url, 'error'));
    }
    setTesting(null);
  };

  const ServerStatusIcon = ({ url }: { url: string }) => {
    const result = testResults.get(url);
    if (result === 'ok') return <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />;
    if (result === 'error') return <WifiOff className="h-3 w-3 text-red-500 shrink-0" />;
    return <Server className="h-3 w-3 text-muted-foreground shrink-0" />;
  };

  const ServerHostname = ({ url }: { url: string }) => {
    try { return <>{new URL(url).hostname}</>; } catch { return <>{url}</>; }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium flex-1">Blossom Servers</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Blossom servers store encrypted backup files. Your servers are tried first, then fallbacks.
      </p>

      {/* ── Your Servers (priority, editable) ── */}
      <div>
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Your Servers</p>
        {userServers.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-2">No custom servers. Add one below or use the defaults.</p>
        ) : (
          <div className="space-y-1.5">
            {userServers.map((url, i) => (
              <div key={url} className="flex items-center gap-2 p-2 rounded-md border bg-muted/20 text-xs">
                <ServerStatusIcon url={url} />
                <span className="font-mono flex-1 truncate" title={url}>{url}</span>
                <span className="text-[9px] text-muted-foreground shrink-0">#{i + 1}</span>
                <Button variant="ghost" size="icon" onClick={() => testServer(url)} disabled={testing === url} className="size-5 text-muted-foreground shrink-0" title="Test server">
                  <Wifi className={`h-3 w-3 ${testing === url ? 'animate-pulse' : ''}`} />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => handleRemoveUser(url)} className="size-5 text-muted-foreground hover:text-destructive shrink-0">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {/* Add server */}
        <div className="flex gap-1.5 mt-2">
          <Input
            placeholder="https://blossom.example.com"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            className="h-8 text-xs"
          />
          <Button onClick={handleAdd} disabled={!newUrl.trim()} variant="outline" size="sm" className="h-8 shrink-0">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Separator />

      {/* ── Fallback Servers (hardcoded, include toggle) ── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Fallback Servers</p>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">Include</span>
            <Switch checked={includeFallbacks} onCheckedChange={handleToggleFallbacks} className="scale-75" />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mb-1.5">Default servers used when your servers are unavailable</p>
        <div className="space-y-0.5">
          {DEFAULT_BLOSSOM_SERVERS.map((url, i) => (
            <div key={url} className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded ${includeFallbacks ? 'text-foreground' : 'text-muted-foreground/40'}`}>
              <ServerStatusIcon url={url} />
              <span className="font-mono truncate">{url}</span>
              <span className="text-muted-foreground shrink-0">#{userServers.length + i + 1}</span>
              {includeFallbacks && (
                <Button variant="ghost" size="icon" onClick={() => testServer(url)} disabled={testing === url} className="size-4 text-muted-foreground shrink-0" title="Test server">
                  <Wifi className={`h-2.5 w-2.5 ${testing === url ? 'animate-pulse' : ''}`} />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
