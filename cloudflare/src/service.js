import { cleanRecord, STAGES, REQUIRED_ENV, isoJst, todayJst, LearningError, errorMessage } from './learning.js';

export class LearningService {
  constructor(storage, env, seed, fetcher, clock = Date.now, { refreshIntervalMs = 600000 } = {}) {
    this.storage = storage; this.env = env; this.seed = seed; this.fetcher = fetcher; this.clock = clock;
    this.busy = false; this.state = null;
    this.refreshIntervalMs = refreshIntervalMs;
  }
  async initialize() {
    const stored = await this.storage.get('dashboard');
    const fallback = { history: [cleanRecord(this.seed)], lastAttempt: Date.parse(this.seed.fetched_at), error: null };
    if (!stored) { this.state = fallback; return; }
    try {
      const history = stored.history.map(record => cleanRecord(record)).sort((a, b) => b.fetched_at.localeCompare(a.fetched_at)).slice(0, 100);
      const allowed = STAGES.flatMap(stage => ['fetch_failed', 'manual_authentication_required', 'missing_environment_variables', 'single_child_required_manual_selection_needed'].map(code => errorMessage(code, stage)));
      const error = allowed.find(value => JSON.stringify(value) === JSON.stringify(stored.error)) || null;
      this.state = { history, lastAttempt: Number.isFinite(stored.lastAttempt) ? stored.lastAttempt : null, error };
    } catch { this.state = fallback; }
  }
  snapshot() {
    const now = this.clock(), next = this.state.lastAttempt == null ? 0 : this.state.lastAttempt + this.refreshIntervalMs;
    const remaining = this.refreshIntervalMs ? Math.max(0, Math.ceil((next - now) / 1000)) : 0;
    const missing = REQUIRED_ENV.filter(name => !this.env[name]);
    return { record: this.state.history[0] || null, history: this.state.history,
      today: todayJst(now), server_time: isoJst(now), refreshing: this.busy,
      retry_after_seconds: remaining, next_refresh_at: remaining ? isoJst(next) : null,
      credentials_ready: !missing.length, missing_environment_variables: missing, error: this.state.error };
  }
  async refresh() {
    if (this.busy) return [409, { ...this.snapshot(), request_message: '学習記録を取得しています。少しお待ちください。' }];
    if (this.snapshot().missing_environment_variables.length) {
      this.state.error = errorMessage('missing_environment_variables', 'authentication');
      return [503, this.snapshot()];
    }
    if (this.snapshot().retry_after_seconds) return [429, { ...this.snapshot(), request_message: '続けて更新するには、少し時間をおいてください。' }];
    this.busy = true;
    this.state.lastAttempt = this.clock();
    const progress = Object.fromEntries(STAGES.map(stage => [stage, 'unverified']));
    let status = 200;
    try {
      try { await this.storage.put('dashboard', this.state); }
      catch {
        this.state.error = { title: '記録を保存できませんでした', message: '保存先の設定を確認してください。', stage: 'storage' };
        return [503, { ...this.snapshot(), refreshing: false }];
      }
      // 認証を自動再試行しない。ブラウザ操作の待ち時間は取得関数で制御する。
      const record = cleanRecord(await this.fetcher(this.env, progress, this.clock));
      if (record.date !== todayJst(this.clock())) throw new LearningError('extraction', 'jst_date_changed_retry_required');
      this.state.history = [record, ...this.state.history.filter(r => r.fetched_at !== record.fetched_at)].slice(0, 100);
      this.state.error = null;
      try { await this.storage.put('dashboard', this.state); }
      catch { this.state.error = { title: '取得できましたが、保存できませんでした', message: 'この画面には取得した記録を表示しています。保存先の設定を確認してください。', stage: 'storage' }; }
    } catch (error) {
      const stage = error instanceof LearningError && STAGES.includes(error.stage) ? error.stage : STAGES.find(s => progress[s] !== 'passed') || 'extraction';
      const code = error instanceof LearningError ? error.code : 'fetch_failed';
      progress[stage] = code === 'manual_authentication_required' ? 'blocked' : 'failed';
      this.state.error = errorMessage(code, stage);
      status = 502;
      try { await this.storage.put('dashboard', this.state); } catch { /* 詳細を出力しない。 */ }
    } finally { this.busy = false; }
    return [status, { ...this.snapshot(), verification_stages: progress }];
  }
}
