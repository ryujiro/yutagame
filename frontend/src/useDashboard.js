import { useCallback, useEffect, useRef, useState } from 'react';

export function useDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [networkError, setNetworkError] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const busy = useRef(false);
  const deadline = useRef(0);
  const activeRequest = useRef(null);
  const readRequest = useRef(null);
  const readVersion = useRef(0);

  const accept = useCallback((next) => {
    setData(next);
    const seconds = next.retry_after_seconds || 0;
    deadline.current = performance.now() + seconds * 1000;
    setRemaining(seconds);
  }, []);

  const load = useCallback(async (signal, background = false) => {
    if (busy.current || (background && readRequest.current)) return;
    readRequest.current?.abort();
    const controller = new AbortController(), version = ++readVersion.current;
    readRequest.current = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      const response = await fetch('/api/dashboard', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('connection');
      const next = await response.json();
      if (!Object.hasOwn(next, 'record')) throw new Error('response');
      if (version === readVersion.current && !controller.signal.aborted) { accept(next); setNetworkError(null); }
    } catch (error) {
      if (version === readVersion.current && !signal?.aborted && (error.name !== 'AbortError' || timedOut)) setNetworkError(background ? '残高の最新記録を確認できません。前回の記録を表示しています。' : '画面を読み込めませんでした。接続を確認し、もう一度読み込んでください。');
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      if (readRequest.current === controller) readRequest.current = null;
      if (version === readVersion.current && !signal?.aborted) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => { controller.abort(); readVersion.current++; readRequest.current?.abort(); activeRequest.current?.abort(); };
  }, [load]);

  useEffect(() => {
    const sync = () => { if (document.visibilityState === 'visible') load(undefined, true); };
    const timer = setInterval(sync, 30000);
    window.addEventListener('focus', sync);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(timer); window.removeEventListener('focus', sync);
      window.removeEventListener('online', sync); document.removeEventListener('visibilitychange', sync);
    };
  }, [load]);

  useEffect(() => {
    if (!remaining) return;
    const timer = setInterval(() => setRemaining(Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [remaining > 0]);

  useEffect(() => {
    if (!data?.refreshing || updating) return;
    const controller = new AbortController();
    const timer = setTimeout(() => load(controller.signal), 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [data, updating, load]);

  const refresh = useCallback(async () => {
    if (busy.current || remaining || (!data?.credentials_ready && data?.refresh_mode !== 'saved_records') || data?.refreshing) return;
    busy.current = true;
    // A stale GET must not overwrite the result of an explicit learning refresh.
    readVersion.current++;
    readRequest.current?.abort();
    setUpdating(true);
    setNetworkError(null);
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 130000);
    try {
      const response = data.refresh_mode === 'saved_records' ? await fetch('/api/dashboard', {
        cache: 'no-store', signal: controller.signal,
      }) : await fetch('/api/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Learning-Request': '1' },
        body: '{}', signal: controller.signal,
      });
      const next = await response.json();
      if (!Object.hasOwn(next, 'record')) throw new Error('response');
      accept(next);
      if (next.request_message) setNetworkError(next.request_message);
    } catch {
      setNetworkError('更新結果を確認できませんでした。前回の記録を表示しています。');
      // POSTを再送しない。サーバー側で進んだ処理・待ち時間だけ再確認する。
      try {
        const response = await fetch('/api/dashboard', { cache: 'no-store' });
        if (response.ok) accept(await response.json());
      } catch { /* 前回表示を残す。 */ }
    } finally {
      clearTimeout(timeout);
      busy.current = false;
      activeRequest.current = null;
      setUpdating(false);
    }
  }, [data, remaining, accept]);

  return { data, loading, updating, networkError, remaining, refresh, reload: () => load() };
}
