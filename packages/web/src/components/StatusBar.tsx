
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { RotateCcw, Layers, Check, Image, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StatusBarProps {
  onLoadNewer: () => void;
  onLoadMoreByCount: (count: number) => void;
  onConsolidate: () => void;
  onSave: () => void;
  onRestore: () => void;
  isLoading: boolean;
  loadingMessage: string | null;
  blankSpaceCount: number;
  multiplier: number;
  indexedDbStats?: { total: number; visible: number; dismissed: number; filtered: number };
  backupStatus: string;
  _hasChanges?: boolean;
  isSavedTab?: boolean;
  isDiscoverTab?: boolean;
  newestTimestamp?: number | null;
  autofetch?: boolean;
  autofetchIntervalSecs?: number;
  /** Timestamp (Date.now()) of the last autofetch fire — drives countdown display */
  lastAutofetchTime?: number;
  onToggleAutofetch?: () => void;
  autoConsolidate?: boolean;
  onToggleAutoConsolidate?: () => void;
  autoScrollTop?: boolean;
  onToggleAutoScrollTop?: () => void;
  loadAllMedia?: boolean;
  onToggleLoadAllMedia?: () => void;
  scrolledFromTop?: boolean;
  columnCount?: number;
  onColumnCountChange?: (count: number) => void;
  isColumnPending?: boolean;
  isNotificationsTab?: boolean;
  onLoadMoreNotifications?: (count: number) => void;
  hasMoreNotifications?: boolean;
  onLoadNewerNotifications?: () => void;
  newestNotificationTimestamp?: number | null;
}

// Format time gap for "Newer" button label
function formatNewerTime(newestTimestamp: number | null | undefined): string {
  if (!newestTimestamp) return '';
  const now = Math.floor(Date.now() / 1000);
  const gap = now - newestTimestamp;
  if (gap < 60) return ''; // Less than a minute, don't show
  if (gap < 3600) return `:${Math.floor(gap / 60)}m`;
  if (gap < 86400) return `:${Math.floor(gap / 3600)}h`;
  return `:${Math.floor(gap / 86400)}d`;
}

export function StatusBar({
  onLoadNewer,
  onLoadMoreByCount,
  onConsolidate,
  onSave: _onSave,
  onRestore: _onRestore,
  isLoading,
  loadingMessage,
  blankSpaceCount,
  multiplier,
  indexedDbStats,
  backupStatus,
  _hasChanges,
  isSavedTab = false,
  isDiscoverTab = false,
  newestTimestamp,
  autofetch = false,
  autofetchIntervalSecs = 120,
  lastAutofetchTime = 0,
  onToggleAutofetch,
  autoConsolidate = false,
  onToggleAutoConsolidate,
  autoScrollTop = false,
  onToggleAutoScrollTop,
  loadAllMedia = false,
  onToggleLoadAllMedia,
  scrolledFromTop = false,
  columnCount,
  onColumnCountChange,
  isColumnPending = false,
  isNotificationsTab = false,
  onLoadMoreNotifications,
  hasMoreNotifications = false,
  onLoadNewerNotifications,
  newestNotificationTimestamp,
}: StatusBarProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [isSticky, setIsSticky] = useState(true);
  const [_redClickCount, setRedClickCount] = useState(0);
  const statusBarRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // When user clicks red button to dismiss, block re-showing until mouse leaves the bottom zone
  const dismissedUntilLeftRef = useRef(false);
  
  const isSaving = backupStatus === 'encrypting' || backupStatus === 'saving';
  const isRestoring = backupStatus === 'restoring' || backupStatus === 'checking';
  const _hasError = backupStatus === 'save-error' || backupStatus === 'restore-error';

  // Autofetch countdown: ticks every second, shows remaining time after 15s
  const [countdownSecs, setCountdownSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!autofetch || !lastAutofetchTime) { setCountdownSecs(null); return; }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - lastAutofetchTime) / 1000);
      const remaining = autofetchIntervalSecs - elapsed;
      setCountdownSecs(elapsed >= 15 && remaining > 0 ? remaining : null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [autofetch, lastAutofetchTime, autofetchIntervalSecs]);

  // Auto-expand when loading or when there are important actions available
  const shouldAutoExpand = isLoading || blankSpaceCount > 0 || isSaving || isRestoring;
  
  // Handle hover at bottom of page to show status bar
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const windowHeight = window.innerHeight;
      const mouseY = event.clientY;
      const isNearBottom = mouseY > windowHeight - 50; // Within 50px of bottom

      if (!isNearBottom) {
        // Mouse has left the bottom zone — clear dismiss block
        dismissedUntilLeftRef.current = false;
      }

      if (isNearBottom && !isVisible && !dismissedUntilLeftRef.current) {
        setIsVisible(true);
        if (hoverTimeoutRef.current) {
          clearTimeout(hoverTimeoutRef.current);
        }
      } else if (!isNearBottom && isVisible && !isSticky) {
        // Hide after 1 second of not being near bottom (unless sticky)
        hoverTimeoutRef.current = setTimeout(() => {
          setIsVisible(false);
        }, 1000);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, [isVisible, isSticky]);

  // Update visibility based on auto-expand conditions
  useEffect(() => {
    if (shouldAutoExpand && !isVisible) {
      setIsVisible(true);
    }
  }, [shouldAutoExpand, isVisible]);

  // Handle red button clicks
  const handleRedClick = useCallback(() => {
    if (isSticky) {
      // If sticky, remove sticky and reset click count
      setIsSticky(false);
      setRedClickCount(0);
    } else {
      // If not sticky, hide immediately and block re-show until mouse leaves bottom zone
      dismissedUntilLeftRef.current = true;
      setIsVisible(false);
      setRedClickCount(0);
    }
  }, [isSticky]);

  // Handle green button clicks
  const handleGreenClick = useCallback(() => {
    dismissedUntilLeftRef.current = false; // Clear dismiss block
    if (!isVisible) {
      // When bar is hidden, clicking green shows it but NOT sticky (hover mode)
      setIsVisible(true);
      setIsSticky(false);
    } else {
      // When bar is visible, clicking green makes it sticky
      setIsSticky(true);
    }
    setRedClickCount(0); // Reset red click count
  }, [isVisible]);

  const handleCountClick = (count: number) => {
    onLoadMoreByCount(count * multiplier);
  };

  const statusText = isLoading ? (
    <span className="flex items-center gap-1">
      <RotateCcw className="h-3 w-3 animate-spin" />
      {loadingMessage || 'Loading...'}
    </span>
  ) : indexedDbStats ? (
    `Visible ${indexedDbStats.visible} | Dismissed ${indexedDbStats.dismissed} | Filtered ${indexedDbStats.filtered} | Total ${indexedDbStats.total}`
  ) : 'Ready';

  return (
    <>
      {/* Mobile-only floating scroll-to-top (touch devices can't hover to reveal the status bar) */}
      {scrolledFromTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="sm:hidden fixed bottom-20 left-1/2 -translate-x-1/2 z-40 w-0 h-0 border-l-[20px] border-l-transparent border-t-[20px] border-t-green-600/80 active:border-t-green-500 transition-colors -rotate-45"
          aria-label="Scroll to top"
          title="Back to top"
        />
      )}

      {/* Corner-only green triangle when completely hidden */}
      {!isVisible && (
        <>
          {scrolledFromTop && (
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="fixed bottom-12 left-1/2 -translate-x-1/2 z-40 w-0 h-0 border-l-[20px] border-l-transparent border-t-[20px] border-t-green-600/80 hover:border-t-green-500 sm:border-l-[26px] sm:border-t-[26px] transition-colors -rotate-45"
              aria-label="Scroll to top"
              title="Back to top"
            />
          )}
          <div className="fixed bottom-4 right-4 z-40">
            <button
              onClick={handleGreenClick}
              className={`w-0 h-0 border-l-[28px] border-l-transparent border-b-[28px] sm:border-l-[36px] sm:border-b-[36px] transition-colors ${
                isSticky
                  ? 'border-b-green-500 hover:border-b-green-400'
                  : 'border-b-green-600/70 hover:border-b-green-500/70'
              }`}
              title="Show status bar"
            />
          </div>
        </>
      )}

      {/* Full status bar when visible */}
      {isVisible && (
        <div 
          ref={statusBarRef}
          className={`fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-r from-gray-100/95 to-gray-200/95 backdrop-blur-sm border-t border-white/20 transition-all duration-300 ease-in-out ${isSticky ? 'shadow-lg' : ''}`}
        >
      {/* Desktop: Single row layout */}
        <div className={`hidden sm:flex items-center justify-center px-8 py-1.5 min-h-[28px] transition-all duration-300 ease-in-out opacity-100 relative`}>
        {/* Centered button group */}
        <div className="flex items-center gap-1">
          {isNotificationsTab ? (<>
            {hasMoreNotifications && onLoadMoreNotifications && (<>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onLoadMoreNotifications(25 * multiplier)}
                className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                title={`Load ${25 * multiplier} more notifications`}
              >
                +{25 * multiplier}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onLoadMoreNotifications(100 * multiplier)}
                className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                title={`Load ${100 * multiplier} more notifications`}
              >
                +{100 * multiplier}
              </Button>
            </>)}
            {!autofetch && onLoadNewerNotifications && (
              <Button
                size="sm"
                variant="outline"
                onClick={onLoadNewerNotifications}
                disabled={isLoading}
                className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors gap-0.5"
                title="Load newer notifications"
              >
                <RotateCcw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
                Newer{formatNewerTime(newestNotificationTimestamp)}
              </Button>
            )}
          </>) : !isDiscoverTab && (<>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleCountClick(25)}
            disabled={isLoading || isSavedTab}
            className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Load ${25 * multiplier} more notes`}
          >
            +{25 * multiplier}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleCountClick(100)}
            disabled={isLoading || isSavedTab}
            className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Load ${100 * multiplier} more notes`}
          >
            +{100 * multiplier}
          </Button>
          {!autofetch && (
          <Button
            size="sm"
            variant="outline"
            onClick={onLoadNewer}
            disabled={isLoading || isSavedTab}
            className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed gap-0.5"
            title="Load all newer notes"
          >
            <RotateCcw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            Newer{formatNewerTime(newestTimestamp)}
          </Button>
          )}
          </>)}
          <Button
            size="sm"
            variant={autofetch ? "default" : "outline"}
            onClick={onToggleAutofetch}
            disabled={isSavedTab}
            className={`h-5 px-2 text-xs transition-colors gap-0.5 ${
              autofetch
                ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
            title={`Autofetch newer notes every ${autofetchIntervalSecs}s`}
          >
            {autofetch && <Check className="h-3 w-3" />}
            {countdownSecs !== null ? `${countdownSecs}s` : 'Autofetch'}
          </Button>
          <Button
            size="sm"
            variant={autoConsolidate ? "default" : "outline"}
            onClick={onToggleAutoConsolidate}
            className={`h-5 px-1.5 text-[10px] transition-colors gap-0.5 ${
              autoConsolidate
                ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
            title="Auto-consolidate blank spaces when new notes arrive"
          >
            {autoConsolidate && <Check className="h-2.5 w-2.5" />}
            <Layers className="h-2.5 w-2.5" />
          </Button>
          <Button
            size="sm"
            variant={autoScrollTop ? "default" : "outline"}
            onClick={onToggleAutoScrollTop}
            className={`h-5 px-1.5 text-[10px] transition-colors gap-0.5 ${
              autoScrollTop
                ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
            title="Scroll to top when new notes arrive"
          >
            {autoScrollTop && <Check className="h-2.5 w-2.5" />}
            <ArrowUp className="h-2.5 w-2.5" />
          </Button>
          <Button
            size="sm"
            variant={loadAllMedia ? "default" : "outline"}
            onClick={onToggleLoadAllMedia}
            className={`h-5 px-2 text-xs transition-colors gap-0.5 ${
              loadAllMedia
                ? 'bg-blue-600 hover:bg-blue-700 text-white border-blue-600'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
            title={loadAllMedia ? "Loading all images & video thumbnails" : "Only loading media for top row — click to load all"}
          >
            {loadAllMedia && <Check className="h-3 w-3" />}
            <Image className="h-3 w-3" />
            Media
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onConsolidate}
            disabled={blankSpaceCount === 0 || isLoading || isSavedTab}
            className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed gap-1"
            title={`Consolidate blank spaces${blankSpaceCount > 0 ? ` (${blankSpaceCount})` : ''}`}
          >
            <Layers className="h-3 w-3" />
            Consolidate{blankSpaceCount > 0 ? ` (${blankSpaceCount})` : ''}
          </Button>
          {columnCount !== undefined && onColumnCountChange && (
            <div className={`flex items-center gap-0.5 bg-accent rounded px-0.5 transition-opacity ${isColumnPending ? 'opacity-50' : ''}`}>
              <Button variant="ghost" size="sm" onClick={() => onColumnCountChange(Math.max(1, columnCount - 1))} disabled={columnCount <= 1} className="h-5 w-5 p-0 text-xs">-</Button>
              <span className="text-[10px] font-medium px-0.5">{columnCount}col</span>
              <Button variant="ghost" size="sm" onClick={() => onColumnCountChange(Math.min(9, columnCount + 1))} disabled={columnCount >= 9} className="h-5 w-5 p-0 text-xs">+</Button>
            </div>
          )}
        </div>

        {/* Status text — absolute on wide screens, hidden on narrow to avoid overlap */}
        <div className="absolute left-9 top-1/2 -translate-y-1/2 text-xs text-gray-600 hidden lg:block">
          {statusText}
        </div>

        {/* Corner buttons */}
        <div className="absolute top-0 left-0 flex">
          {/* Green sticky button - left corner */}
          <button
            onClick={handleGreenClick}
            className={`w-0 h-0 border-r-[28px] border-r-transparent border-t-[28px] transition-colors ${
              isSticky 
                ? 'border-t-green-500 hover:border-t-green-400' 
                : 'border-t-green-600/70 hover:border-t-green-500/70'
            }`}
            title={isSticky ? "Unstick status bar" : "Stick status bar"}
          />
        </div>
        <div className="absolute top-0 right-0 flex">
          {/* Red collapse button - right corner */}
          <button
            onClick={handleRedClick}
            className="w-0 h-0 border-l-[28px] border-l-transparent border-t-[28px] border-t-red-600/70 hover:border-t-red-500/70 transition-colors"
            title="Collapse status bar"
          />
        </div>
        {/* Back to top — centered horizontally at top of status bar */}
        {scrolledFromTop && (
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="absolute -top-[20px] left-1/2 -translate-x-1/2 w-0 h-0 border-l-[20px] border-l-transparent border-t-[20px] border-t-green-600/80 hover:border-t-green-500 sm:border-l-[26px] sm:border-t-[26px] transition-colors -rotate-45"
            aria-label="Scroll to top"
            title="Back to top"
          />
        )}
      </div>

      {/* Tablet (sm–lg): stats row below buttons, hidden on large screens and mobile */}
      <div className="hidden sm:flex lg:hidden items-center justify-center px-8 py-1 border-t border-white/10">
        <div className="text-center text-xs text-gray-600">
          {statusText}
        </div>
      </div>

      {/* Mobile: Three-row layout */}
        <div className={`sm:hidden transition-all duration-300 ease-in-out opacity-100 relative`}>
        {/* First row: Load buttons + column selector */}
        <div className="flex items-center justify-between px-8 py-1 min-h-[24px] border-b border-white/10 relative">
          <div className="flex items-center gap-1">
            {isNotificationsTab ? (<>
              {hasMoreNotifications && onLoadMoreNotifications && (<>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onLoadMoreNotifications(25 * multiplier)}
                  className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                  title={`Load ${25 * multiplier} more notifications`}
                >
                  +{25 * multiplier}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onLoadMoreNotifications(100 * multiplier)}
                  className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                  title={`Load ${100 * multiplier} more notifications`}
                >
                  +{100 * multiplier}
                </Button>
              </>)}
              {!autofetch && onLoadNewerNotifications && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onLoadNewerNotifications}
                  disabled={isLoading}
                  className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors gap-0.5"
                  title="Load newer notifications"
                >
                  <RotateCcw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
                  Newer{formatNewerTime(newestNotificationTimestamp)}
                </Button>
              )}
            </>) : !isDiscoverTab && (<>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleCountClick(25)}
              disabled={isLoading || isSavedTab}
              className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Load ${25 * multiplier} more notes`}
            >
              +{25 * multiplier}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleCountClick(100)}
              disabled={isLoading || isSavedTab}
              className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Load ${100 * multiplier} more notes`}
            >
              +{100 * multiplier}
            </Button>
            {!autofetch && (
            <Button
              size="sm"
              variant="outline"
              onClick={onLoadNewer}
              disabled={isLoading || isSavedTab}
              className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed gap-0.5"
              title="Load all newer notes"
            >
              <RotateCcw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
              Newer{formatNewerTime(newestTimestamp)}
            </Button>
            )}
            </>)}
          </div>
          {columnCount !== undefined && onColumnCountChange && (
            <div className={`flex items-center gap-0 transition-opacity ${isColumnPending ? 'opacity-50' : ''}`}>
              <Button variant="outline" size="sm" onClick={() => onColumnCountChange(Math.max(1, columnCount - 1))} disabled={columnCount <= 1} className="h-5 w-5 p-0 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 rounded-r-none">-</Button>
              <span className="h-5 px-1 text-[10px] font-medium border-y border-gray-300 flex items-center text-gray-700">{columnCount}col</span>
              <Button variant="outline" size="sm" onClick={() => onColumnCountChange(Math.min(9, columnCount + 1))} disabled={columnCount >= 9} className="h-5 w-5 p-0 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 rounded-l-none">+</Button>
            </div>
          )}

          {/* Mobile corner buttons */}
          <div className="absolute top-0 left-0 flex">
            {/* Green sticky button - left corner */}
            <button
              onClick={handleGreenClick}
              className={`w-0 h-0 border-r-[28px] border-r-transparent border-t-[28px] transition-colors ${
                isSticky 
                  ? 'border-t-green-500 hover:border-t-green-400' 
                  : 'border-t-green-600/70 hover:border-t-green-500/70'
              }`}
              title={isSticky ? "Unstick status bar" : "Stick status bar"}
            />
          </div>
          <div className="absolute top-0 right-0 flex">
            {/* Red collapse button - right corner */}
            <button
              onClick={handleRedClick}
              className="w-0 h-0 border-l-[28px] border-l-transparent border-t-[28px] border-t-red-600/70 hover:border-t-red-500/70 transition-colors"
              title="Collapse status bar"
            />
          </div>
        </div>

        {/* Second row: Status text only */}
        <div className="flex items-center justify-center px-8 py-0.5 min-h-[20px] border-b border-white/10">
          {/* Status text */}
          <div className="text-center text-[11px] text-gray-700 px-2">
            {statusText}
          </div>
        </div>

{/* Third row: Toggles and consolidate */}
        <div className="flex items-center justify-center px-8 py-1 min-h-[24px]">
          <div className="flex items-center gap-1">
            {/* Autofetch + Media toggles */}
            <Button
              size="sm"
              variant={autofetch ? "default" : "outline"}
              onClick={onToggleAutofetch}
              disabled={isSavedTab}
              className={`h-5 px-2 text-xs transition-colors gap-0.5 ${
                autofetch
                  ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
              title={`Autofetch newer notes every ${autofetchIntervalSecs}s`}
            >
              {autofetch && <Check className="h-3 w-3" />}
              {countdownSecs !== null ? `${countdownSecs}s` : 'Autofetch'}
            </Button>
            <Button
              size="sm"
              variant={autoConsolidate ? "default" : "outline"}
              onClick={onToggleAutoConsolidate}
              className={`h-5 px-1.5 text-[10px] transition-colors gap-0.5 ${
                autoConsolidate
                  ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
              title="Auto-consolidate blank spaces when new notes arrive"
            >
              {autoConsolidate && <Check className="h-2.5 w-2.5" />}
              <Layers className="h-2.5 w-2.5" />
            </Button>
            <Button
              size="sm"
              variant={autoScrollTop ? "default" : "outline"}
              onClick={onToggleAutoScrollTop}
              className={`h-5 px-1.5 text-[10px] transition-colors gap-0.5 ${
                autoScrollTop
                  ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
              title="Scroll to top when new notes arrive"
            >
              {autoScrollTop && <Check className="h-2.5 w-2.5" />}
              <ArrowUp className="h-2.5 w-2.5" />
            </Button>
            <Button
              size="sm"
              variant={loadAllMedia ? "default" : "outline"}
              onClick={onToggleLoadAllMedia}
              className={`h-5 px-2 text-xs transition-colors gap-0.5 ${
                loadAllMedia
                  ? 'bg-blue-600 hover:bg-blue-700 text-white border-blue-600'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
              title={loadAllMedia ? "Loading all media" : "Load all media"}
            >
              {loadAllMedia && <Check className="h-3 w-3" />}
              <Image className="h-3 w-3" />
            </Button>
            {/* Consolidate button */}
            <Button
              size="sm"
              variant="outline"
              onClick={onConsolidate}
              disabled={blankSpaceCount === 0 || isLoading || isSavedTab}
              className="h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed gap-1"
              title={`Consolidate blank spaces${blankSpaceCount > 0 ? ` (${blankSpaceCount})` : ''}`}
            >
              <Layers className="h-3 w-3" />
              Consolidate{blankSpaceCount > 0 ? ` (${blankSpaceCount})` : ''}
            </Button>
          </div>
        </div>

      
</div>
        </div>
      )}
    </>
  );
}