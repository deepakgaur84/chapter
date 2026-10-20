'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { audioLog } from '../audio-debug';

const CHECK_URL = '/api/health';
const CHECK_TIMEOUT_MS = 4000;
const RECHECK_DELAY_MS = 1500;
const CHECK_ATTEMPTS = 3;

/**
 * Is the server reachable? Any HTTP answer (even an error status) means yes; only a network
 * failure or a timeout means no.
 */
async function canReachServer(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    await fetch(CHECK_URL, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof window === 'undefined') return true;
    return navigator.onLine;
  });
  // Identifies the latest "offline" report, so an older check cannot overrule a newer event
  const checkIdRef = useRef(0);

  useEffect(() => {
    const handleOnline = () => {
      checkIdRef.current++;
      audioLog('network: browser says online');
      setIsOnline(true);
    };

    // Phones (iPhones especially) report "offline" for a moment when the app is resumed or the
    // connection switches between Wi-Fi and mobile data. Going offline switches the reader out of
    // listening mode and stops the audio, so the report is checked against the server first.
    const handleOffline = async () => {
      const checkId = ++checkIdRef.current;
      audioLog('network: browser says offline - checking the server');

      for (let attempt = 1; attempt <= CHECK_ATTEMPTS; attempt++) {
        if (await canReachServer()) {
          if (checkIdRef.current === checkId) {
            audioLog('network: server reachable, ignoring the offline report');
          }
          return;
        }
        if (checkIdRef.current !== checkId) return;
        if (attempt < CHECK_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RECHECK_DELAY_MS));
          if (checkIdRef.current !== checkId) return;
        }
      }

      if (checkIdRef.current === checkId) {
        audioLog('network: server unreachable, treating as offline');
        setIsOnline(false);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Force a refresh check - useful after failed requests
  const checkConnection = useCallback(async (): Promise<boolean> => {
    const reachable = await canReachServer();
    setIsOnline(reachable);
    return reachable;
  }, []);

  return { isOnline, checkConnection };
}
