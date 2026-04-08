import { useState } from 'react';
import { Button } from '@/components/ui/button';
import LoginDialog from './LoginDialog';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { genUserName } from '@/lib/genUserName';
import { User } from 'lucide-react';

export interface LoginAreaProps {
  className?: string;
}

export function LoginArea({ className }: LoginAreaProps) {
  const { currentUser } = useLoggedInAccounts();
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);

  if (currentUser) {
    const displayName = currentUser.metadata.name ?? genUserName(currentUser.pubkey);

    return (
      <div className={className}>
        <div className="flex items-center gap-2 p-1.5 rounded-lg">
          <Avatar className="w-7 h-7">
            <AvatarImage src={currentUser.metadata.picture} alt={displayName} />
            <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{displayName}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <Button
        onClick={() => setLoginDialogOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90"
      >
        <User className="w-4 h-4" />
        <span className="hidden sm:inline">Login</span>
      </Button>
      <LoginDialog
        isOpen={loginDialogOpen}
        onClose={() => setLoginDialogOpen(false)}
        onLogin={() => setLoginDialogOpen(false)}
      />
    </div>
  );
}
