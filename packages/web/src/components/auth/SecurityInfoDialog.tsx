import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SignerRecommendations } from '@/components/auth/SignerRecommendations';

export function SecurityInfoDialog() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
        onClick={() => setOpen(true)}
      >
        Security info
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5" />
              How login works
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 text-sm text-muted-foreground">
            {/* Simple intro */}
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 space-y-2">
              <p className="text-foreground font-medium">New here? It's simple.</p>
              <p>
                Just pick a name and hit Start — no email needed. You'll get a secret key
                to save (like a master password), and that's it. You're in.
              </p>
              <p className="text-xs text-muted-foreground/70 italic">
                That's the easy way, and it works, but it is not the most secure way
                to use Corkboards.
              </p>
            </div>

            <p>
              Saving the secret key to your password manager is as secure as a password
              on other sites, but if you are building a business or a personal profile
              you plan to keep around permanently, there are some things you should know.
            </p>

            {/* How Corkboards is different */}
            <section className="space-y-1.5">
              <h3 className="font-medium text-foreground">How Corkboards is different</h3>
              <p>
                Corkboards is built on a decentralized protocol called Nostr. You own your
                account. That means there are no central servers to stop you from posting,
                and it also means there are none to save your password for you.
              </p>
            </section>

            {/* Why key security matters */}
            <section className="space-y-1.5">
              <h3 className="font-medium text-foreground">Why key security matters</h3>
              <p>
                Your secret key is your permanent, irrevocable identity. There is no
                password reset. If someone obtains your key, they become you — forever.
                Treat it like a Bitcoin private key, not a website password.
              </p>
            </section>

            {/* How we protect your key */}
            <section className="space-y-2">
              <h3 className="font-medium text-foreground">How we protect your key</h3>
              <p>
                Corkboards lets you paste your secret key directly to log in, but this
                is the least secure option — your key is held in browser memory where
                JavaScript can access it. For stronger protection, use one of the
                alternatives below instead:
              </p>

              {/* NIP-07 */}
              <div className="rounded border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 p-3 space-y-1.5">
                <p className="font-medium text-green-800 dark:text-green-300 text-xs uppercase tracking-wide">
                  Browser extension (NIP-07) — for Corkboards web at corkboards.me
                </p>
                <p>
                  Extensions keep your key in a separate process, isolated from this
                  page's JavaScript by the browser's security boundary.
                </p>
                <SignerRecommendations variant="compact" />
              </div>

              {/* NIP-46 */}
              <div className="rounded border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 p-3 space-y-1.5">
                <p className="font-medium text-green-800 dark:text-green-300 text-xs uppercase tracking-wide">
                  Bunker / Remote Signer (NIP-46) — for Desktop or Mobile Apps
                </p>
                <p>
                  A remote signer keeps your key on a separate device entirely. This site
                  communicates with the signer over encrypted relay messages and only ever
                  receives signatures, never the key itself.
                </p>
                <div className="text-xs space-y-1 mt-1">
                  <p>
                    <strong>Android:</strong>{' '}
                    <a href="https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Amber</a>
                    {' '}(dedicated signer — keys never leave the device)
                  </p>
                  <p>
                    <strong>iPhone:</strong>{' '}
                    <a href="https://apps.apple.com/us/app/alby-go/id6471335774" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Alby Go</a>
                    {', '}
                    <a href="https://apps.apple.com/us/app/nostur-nostr-client/id1672780508" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Nostur</a>
                  </p>
                  <p>
                    <strong>Desktop:</strong>{' '}
                    <a href="https://nsecbunker.com" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">nsecBunker</a>
                    {' (self-hosted or hosted), '}
                    <a href="https://github.com/nbd-wtf/keycast" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Keycast</a>
                    {' (team/shared signing)'}
                  </p>
                </div>
              </div>
            </section>

            {/* Why not paste a secret key */}
            <section className="space-y-1.5">
              <h3 className="font-medium text-foreground">Why not just paste a secret key or use a password manager?</h3>
              <p>
                A web page is dynamically-served code. Every npm dependency, every script
                on the same origin, and any XSS vulnerability gets full access to the
                JavaScript memory where a pasted key would live.
              </p>
              <p>
                An extension or bunker limits the blast radius: even if this site's code
                were compromised, the attacker gets signatures for one session — not your
                permanent identity.
              </p>
            </section>

            {/* No account, no server */}
            <section className="space-y-1.5">
              <h3 className="font-medium text-foreground">No account, no server</h3>
              <p>
                Nostr has no accounts, emails, or passwords. Your secret key <em>is</em>{' '}
                your identity. There is no "forgot password" flow. Keep your key backed up
                securely — if you lose it, no one can recover it for you.
              </p>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
