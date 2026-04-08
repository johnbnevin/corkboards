/**
 * AdvancedSettings — modal content for less-frequently-used settings.
 *
 * Each option has helper text and a confirmation dialog before acting.
 */

import { useState } from 'react';
import { Separator } from '@/components/ui/separator';
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
import { Eye, Database, Settings, Bookmark, Trash2 } from 'lucide-react';

interface AdvancedSettingsProps {
  dismissedCount: number;
  onClearDismissed: () => void;
  onOpenProfileCache: () => void;
  publishClientTag: boolean;
  onToggleClientTag: () => void;
  publicBookmarks: boolean;
  onTogglePublicBookmarks: () => void;
  onDeleteAccount: () => void;
}

type ConfirmAction = 'dismissed' | 'cache' | 'clientTag' | 'bookmarks' | 'delete' | null;

export function AdvancedSettings({
  dismissedCount,
  onClearDismissed,
  onOpenProfileCache,
  publishClientTag,
  onToggleClientTag,
  publicBookmarks,
  onTogglePublicBookmarks,
  onDeleteAccount,
}: AdvancedSettingsProps) {
  const [confirm, setConfirm] = useState<ConfirmAction>(null);

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
