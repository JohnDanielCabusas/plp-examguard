import { supabase, supabaseKey, supabaseUrl } from './supabaseClient.js';

const initialStatus = {
  available: Boolean(supabase),
  connected: false,
  checkedAt: null,
  error: null,
};

const bridge = {
  client: supabase,
  env: {
    url: supabaseUrl || '',
    hasPublishableKey: Boolean(supabaseKey),
  },
  status: { ...initialStatus },
  async smokeTest() {
    if (!supabase) {
      const error = 'Supabase env vars are missing. Check VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.';
      this.status = {
        ...this.status,
        checkedAt: new Date().toISOString(),
        connected: false,
        error,
      };
      console.warn('[Supabase] ' + error);
      document.dispatchEvent(new CustomEvent('supabaseReady', { detail: this.status }));
      return this.status;
    }

    const { error } = await supabase
      .from('settings')
      .select('id')
      .eq('id', 'main')
      .limit(1);

    this.status = {
      ...this.status,
      checkedAt: new Date().toISOString(),
      connected: !error,
      error: error ? error.message : null,
    };

    if (error) {
      console.error('[Supabase] Connection smoke test failed:', error.message);
    } else {
      console.info('[Supabase] Connection smoke test passed.');
    }

    document.dispatchEvent(new CustomEvent('supabaseReady', { detail: this.status }));
    return this.status;
  },
};

window.supabase = supabase;
window.SupabaseBridge = bridge;

bridge.smokeTest().catch(err => {
  bridge.status = {
    ...bridge.status,
    checkedAt: new Date().toISOString(),
    connected: false,
    error: err instanceof Error ? err.message : String(err),
  };
  console.error('[Supabase] Unexpected bootstrap error:', bridge.status.error);
  document.dispatchEvent(new CustomEvent('supabaseReady', { detail: bridge.status }));
});

export default bridge;
