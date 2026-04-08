import React from 'react';
import { Button } from '@/components/ui/button';
import { Cloud, CloudUpload, CloudDownload, AlertCircle } from 'lucide-react';

interface BackupRestoreButtonsProps {
  backupStatus: string;
  hasChanges: boolean;
  lastBackupTs: number;
  onSave: () => void;
  onRestore: () => void;
}

export function BackupRestoreButtons({
  backupStatus,
  hasChanges: _hasChanges,
  lastBackupTs: _lastBackupTs,
  onSave,
  onRestore,
}: BackupRestoreButtonsProps) {
  const isSaving = backupStatus === 'encrypting' || backupStatus === 'saving';
  const isRestoring = backupStatus === 'restoring' || backupStatus === 'checking';
  const hasError = backupStatus === 'save-error' || backupStatus === 'restore-error';

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={onSave}
        disabled={isSaving}
        title="Save Changes to Nostr"
      >
        {isSaving ? (
          <>
            <CloudUpload className="h-3.5 w-3.5 animate-pulse" />
            <span>Saving</span>
          </>
        ) : hasError ? (
          <>
            <AlertCircle className="h-3.5 w-3.5 text-red-500" />
            <span>Save Changes</span>
          </>
        ) : (
          <>
            <Cloud className="h-3.5 w-3.5" />
            <span>Save Changes</span>
          </>
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={onRestore}
        disabled={isRestoring}
        title="Restore from Nostr"
      >
        {isRestoring ? (
          <>
            <CloudDownload className="h-3.5 w-3.5 animate-pulse" />
            <span>Loading</span>
          </>
        ) : (
          <>
            <CloudDownload className="h-3.5 w-3.5" />
            <span>Restore</span>
          </>
        )}
      </Button>
    </div>
  );
}
