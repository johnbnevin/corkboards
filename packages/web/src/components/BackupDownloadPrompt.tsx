import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { downloadSettingsBackup, dismissBackupPrompt } from '@/lib/downloadBackup';
import { toast } from '@/hooks/useToast';

interface BackupDownloadPromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BackupDownloadPrompt({ open, onOpenChange }: BackupDownloadPromptProps) {
  const handleDownload = async () => {
    try {
      await downloadSettingsBackup();
      toast({ title: 'Settings backup downloaded' });
      onOpenChange(false);
    } catch {
      toast({ title: 'Backup download failed', variant: 'destructive' });
    }
  };

  const handleRemindLater = () => {
    dismissBackupPrompt();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-sm p-5 rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Download className="w-4 h-4" />
            Download your settings backup
          </DialogTitle>
          <DialogDescription className="sr-only">Download a local backup of your corkboards settings</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            It's been a while since you last saved a local backup of your settings.
          </p>

          <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <p className="text-xs text-blue-900 dark:text-blue-300">
              <span className="font-semibold">Why download?</span> If you ever lose access to your account,
              this file restores all your corkboards.me settings — custom feeds, filters, dismissed notes,
              RSS feeds, wallet connection, and display preferences. Everything except your follower list.
              It won't help on other Nostr apps — it's specific to corkboards.me.
            </p>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={handleRemindLater}>
              Remind me later
            </Button>
            <Button className="flex-1 gap-1.5" onClick={handleDownload}>
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
