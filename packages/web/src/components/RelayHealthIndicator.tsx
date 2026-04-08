import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Wifi, WifiOff, AlertTriangle, RefreshCw, CheckCircle } from 'lucide-react';
import { useRelayHealthAuto, type RelayHealth } from '@/hooks/useRelayHealth';

function StatusIcon({ status }: { status: RelayHealth['status'] }) {
  switch (status) {
    case 'healthy':
      return <CheckCircle className="h-3 w-3 text-green-500" />;
    case 'slow':
      return <AlertTriangle className="h-3 w-3 text-yellow-500" />;
    case 'error':
      return <WifiOff className="h-3 w-3 text-red-500" />;
    default:
      return <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin" />;
  }
}

function formatLatency(latency: number | null): string {
  if (latency === null) return '-';
  if (latency < 1000) return `${latency}ms`;
  return `${(latency / 1000).toFixed(1)}s`;
}

export function RelayHealthIndicator() {
  const { relayHealth, getShortName } = useRelayHealthAuto();
  const [isOpen, setIsOpen] = useState(false);

  const healthy = relayHealth.filter(r => r.status === 'healthy').length;
  const slow = relayHealth.filter(r => r.status === 'slow').length;
  const error = relayHealth.filter(r => r.status === 'error').length;
  const total = relayHealth.length;

  // Only show error (WifiOff) when ALL relays are down (0/x), not just some
  // Show slow (triangle) when slow relays equal or outnumber healthy ones
  const overallStatus = healthy === 0 && total > 0 ? 'error'
    : slow > 0 && healthy <= slow ? 'slow'
    : 'healthy';

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 gap-1.5"
          title="Relay health"
        >
          {overallStatus === 'healthy' && (
            <Wifi className="h-3.5 w-3.5 text-green-500" />
          )}
          {overallStatus === 'slow' && (
            <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
          )}
          {overallStatus === 'error' && (
            <WifiOff className="h-3.5 w-3.5 text-red-500" />
          )}
          <span className="text-xs text-muted-foreground">
            {healthy}/{total}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <div className="p-3 border-b">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Relay Health</span>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3 text-green-500" />
                {healthy}
              </span>
              <span className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-yellow-500" />
                {slow}
              </span>
              <span className="flex items-center gap-1">
                <WifiOff className="h-3 w-3 text-red-500" />
                {error}
              </span>
            </div>
          </div>
        </div>
        <ScrollArea className="max-h-48">
          <div className="p-1">
            {relayHealth.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground text-center">
                No relays configured
              </div>
            ) : (
              relayHealth.map(relay => (
                <div
                  key={relay.url}
                  className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={relay.status} />
                    <span className="text-xs truncate">
                      {getShortName(relay.url)}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatLatency(relay.latency)}
                  </span>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
