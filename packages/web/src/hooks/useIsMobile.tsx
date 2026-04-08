import { useEffect, useState } from "react"

const MOBILE_BREAKPOINT = 768;

// Singleton state to avoid multiple listeners across components
let cachedIsMobile: boolean | null = null;
const listeners: Set<(isMobile: boolean) => void> = new Set();
let mediaQuery: MediaQueryList | null = null;

function getIsMobile(): boolean {
  if (cachedIsMobile === null && typeof window !== 'undefined') {
    cachedIsMobile = window.innerWidth < MOBILE_BREAKPOINT;
  }
  return cachedIsMobile ?? false;
}

function initMediaQuery() {
  if (typeof window === 'undefined' || mediaQuery) return;
  
  mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  const handler = () => {
    const newValue = window.innerWidth < MOBILE_BREAKPOINT;
    if (cachedIsMobile !== newValue) {
      cachedIsMobile = newValue;
      listeners.forEach(fn => fn(newValue));
    }
  };
  mediaQuery.addEventListener('change', handler);
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    initMediaQuery();
    listeners.add(setIsMobile);
    return () => { listeners.delete(setIsMobile); };
  }, []);

  return isMobile;
}

export function useIsLandscapeMobile(): boolean {
  const [isLandscapeMobile, setIsLandscapeMobile] = useState(() => 
    typeof window !== 'undefined' 
      ? window.innerWidth < MOBILE_BREAKPOINT && window.innerWidth > window.innerHeight 
      : false
  );

  useEffect(() => {
    const checkLandscape = () => {
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      const isLandscape = window.innerWidth > window.innerHeight;
      setIsLandscapeMobile(isMobile && isLandscape);
    };

    checkLandscape();
    initMediaQuery();
    
    const handler = () => checkLandscape();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return isLandscapeMobile;
}
