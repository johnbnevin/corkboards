/**
 * ProfileCacheSettings
 * 
 * Settings component for managing the persistent profile cache.
 * Provides manual cleanup options and cache statistics.
 */

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Trash2, RefreshCw, Database, Clock } from 'lucide-react';
import { getProfileCacheStats, clearProfileCache, getAllCachedProfilePubkeys } from '@/lib/profileCache';

interface CacheStats {
  totalProfiles: number;
  profilesNeedingRefresh: number;
  oldestCache: number | null;
  newestCache: number | null;
}

export function ProfileCacheSettings() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [showRefreshDialog, setShowRefreshDialog] = useState(false);
  const [lastCleared, setLastCleared] = useState<string | null>(null);

  // Load cache stats
  const loadStats = async () => {
    setIsLoading(true);
    try {
      const cacheStats = await getProfileCacheStats();
      setStats(cacheStats);
    } catch (error) {
      console.error('Failed to load profile cache stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Load stats on mount
  useEffect(() => {
    loadStats();
  }, []);

  // Format timestamp to readable date
  const formatDate = (timestamp: number | null): string => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleDateString() + ' ' + new Date(timestamp).toLocaleTimeString();
  };

  // Format age in human readable format
  const formatAge = (timestamp: number | null): string => {
    if (!timestamp) return 'Unknown';
    const now = Date.now();
    const age = now - timestamp;
    const days = Math.floor(age / (1000 * 60 * 60 * 24));
    const hours = Math.floor((age % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) {
      return `${days}d ${hours}h ago`;
    } else if (hours > 0) {
      return `${hours}h ago`;
    } else {
      return 'Just now';
    }
  };

  // Clear cache
  const handleClearCache = async () => {
    try {
      await clearProfileCache();
      setLastCleared(new Date().toLocaleString());
      await loadStats(); // Reload stats
    } catch (error) {
      console.error('Failed to clear profile cache:', error);
    }
    setShowClearDialog(false);
  };

  // Get profiles needing refresh
  const handleGetProfilesNeedingRefresh = async () => {
    try {
      const pubkeys = await getAllCachedProfilePubkeys();
      console.log('Profiles needing refresh check:', pubkeys.length, 'total profiles');
      // Note: Profile refresh happens automatically when profiles are accessed
      // This dialog is for informational purposes only
      setShowRefreshDialog(false);
    } catch (error) {
      console.error('Failed to get profiles needing refresh:', error);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Profile Cache Statistics
          </CardTitle>
          <CardDescription>
            Persistent profile cache stores user metadata across sessions for instant loading.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="text-center py-4">Loading cache statistics...</div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="text-sm font-medium">Total Profiles</div>
                  <div className="text-2xl font-bold">{stats.totalProfiles}</div>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium">Need Refresh</div>
                  <div className="text-2xl font-bold text-orange-600">{stats.profilesNeedingRefresh}</div>
                </div>
              </div>
              
              <Separator />
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="text-sm font-medium flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    Oldest Cache
                  </div>
                  <div className="text-sm">{formatDate(stats.oldestCache)}</div>
                  <div className="text-xs text-muted-foreground">{formatAge(stats.oldestCache)}</div>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    Newest Cache
                  </div>
                  <div className="text-sm">{formatDate(stats.newestCache)}</div>
                  <div className="text-xs text-muted-foreground">{formatAge(stats.newestCache)}</div>
                </div>
              </div>

              {stats.profilesNeedingRefresh > 0 && (
                <div className="flex items-center gap-2 p-3 bg-orange-50 dark:bg-orange-950 rounded-lg">
                  <Badge variant="outline" className="text-orange-600 border-orange-600">
                    {stats.profilesNeedingRefresh} profiles
                  </Badge>
                  <span className="text-sm text-orange-600 dark:text-orange-400">
                    need refresh (older than 30 days)
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              No cache statistics available
            </div>
          )}
          
          <div className="flex gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={loadStats}
              disabled={isLoading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh Stats
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            Cache Management
          </CardTitle>
          <CardDescription>
            Manual cleanup options for the profile cache. Profiles are automatically refreshed when accessed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3">
            <Button
              variant="destructive"
              onClick={() => setShowClearDialog(true)}
              className="w-full sm:w-auto"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear All Cached Profiles
            </Button>
            
            <p className="text-sm text-muted-foreground">
              This will remove all cached profile data. Profiles will be re-fetched on next access.
            </p>
          </div>

          {lastCleared && (
            <div className="text-sm text-green-600 dark:text-green-400">
              Cache cleared: {lastCleared}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Clear Cache Confirmation Dialog */}
      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Profile Cache?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove all cached profile data from your browser. 
              Profiles will be re-fetched from the network when you next encounter them.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearCache} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Clear Cache
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Refresh Profiles Dialog */}
      <AlertDialog open={showRefreshDialog} onOpenChange={setShowRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh Profiles?</AlertDialogTitle>
            <AlertDialogDescription>
              This will check which profiles need refreshing and fetch updated metadata from the network.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleGetProfilesNeedingRefresh}>
              Check for Updates
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}