import { cleanRecord, STAGES, REQUIRED_ENV, ERROR_CODES, isoJst, todayJst, LearningError, errorMessage } from './learning.js';
import { cleanMonthly, mergeMonthly, MONTHLY_FAILURE } from './monthly.js';
import { cleanArchive } from './study-archive.js';

export class LearningService {
  constructor(storage, env, seed, fetcher, clock = Date.now, { refreshIntervalMs = 600000 } = {}) {
    this.storage = storage; this.env = env; this.seed = seed; this.fetcher = fetcher; this.clock = clock;
    this.busy = false; this.state = null;
    this.refreshIntervalMs = refreshIntervalMs;
  }
  async initialize() {
    const stored = await this.storage.get('dashboard');
    const fallback = { history: [cleanRecord(this.seed)], lastAttempt: Date.parse(this.seed.fetched_at), error: null, monthly_history: [], monthly_error: null };
    if (!stored) { this.state = fallback; return; }
    try {
      const history = stored.history.map(record => cleanRecord(record)).sort((a, b) => b.fetched_at.localeCompare(a.fetched_at)).slice(0, 100);
      const allowed = STAGES.flatMap(stage => ERROR_CODES.map(code => errorMessage(code, stage)));
      const error = allowed.find(value => {
        const { code, ...legacy } = value;
        return JSON.stringify(value) === JSON.stringify(stored.error) ||
          JSON.stringify(legacy) === JSON.stringify(stored.error);
      }) || null;
      this.state = { history, lastAttempt: Number.isFinite(stored.lastAttempt) ? stored.lastAttempt : null, error, monthly_history: [], monthly_error: stored.monthly_error === MONTHLY_FAILURE ? MONTHLY_FAILURE : null };
      try {
        if (stored.monthly_history != null) {
          if (!Array.isArray(stored.monthly_history) || stored.monthly_history.length > 120) throw new Error('monthly_history');
          for (const value of stored.monthly_history) this.state.monthly_history = mergeMonthly(this.state.monthly_history, value);
        }
      } catch { this.state.monthly_history = []; this.state.monthly_error = MONTHLY_FAILURE; }
      try { this.state.study_archive = stored.study_archive ? cleanArchive(stored.study_archive) : null; }
      catch { this.state.study_archive = null; }
    } catch { this.state = fallback; }
  }
  snapshot() {
    const now = this.clock(), next = this.state.lastAttempt == null ? 0 : this.state.lastAttempt + this.refreshIntervalMs;
    const remaining = this.refreshIntervalMs ? Math.max(0, Math.ceil((next - now) / 1000)) : 0;
    const missing = REQUIRED_ENV.filter(name => !this.env[name]);
    return { record: this.state.history[0] || null, history: this.state.history,
      study_archive: this.state.study_archive || null,
      monthly_record: this.state.monthly_history.find(record => record.month === todayJst(now).slice(0, 7)) || null,
      monthly_history: this.state.monthly_history, monthly_error: this.state.monthly_error,
      today: todayJst(now), server_time: isoJst(now), refreshing: this.busy,
      last_attempt_at: this.state.lastAttempt == null ? null : isoJst(this.state.lastAttempt),
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
      const fetched = await this.fetcher(this.env, progress, this.clock);
      const record = cleanRecord(fetched);
      if (record.date !== todayJst(this.clock())) throw new LearningError('extraction', 'jst_date_changed_retry_required');
      if (fetched.study_archive) {
        try { this.state.study_archive = cleanArchive(fetched.study_archive); } catch { /* Invalid archive metadata cannot invalidate today's record. */ }
      }
      if (Object.hasOwn(fetched, 'monthly')) {
        try {
          const monthly = cleanMonthly(fetched.monthly);
          if (monthly.month !== todayJst(this.clock()).slice(0, 7)) throw new Error('monthly_date');
          this.state.monthly_history = mergeMonthly(this.state.monthly_history, monthly);
          this.state.monthly_error = null;
        } catch { this.state.monthly_error = MONTHLY_FAILURE; }
      } else if (fetched.monthly_error) this.state.monthly_error = MONTHLY_FAILURE;
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
