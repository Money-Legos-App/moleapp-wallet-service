import crypto from 'crypto';
import axios, { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

interface FonbnkConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  webhookSecret: string;
}

let _config: FonbnkConfig | null = null;
let _client: AxiosInstance | null = null;

export function initFonbnkConfig(config: FonbnkConfig): void {
  _config = config;
  _client = null;
}

function signRequest(clientSecret: string, timestamp: string, endpoint: string): string {
  const secretBuffer = Buffer.from(clientSecret, 'base64');
  const payload = `${timestamp}:${endpoint}`;
  const hmac = crypto.createHmac('sha256', secretBuffer);
  hmac.update(payload);
  return hmac.digest('base64');
}

export function createFonbnkClient(): AxiosInstance {
  if (_client) return _client;
  if (!_config) throw new Error('Fonbnk not configured. Call initFonbnkConfig first.');

  const config = _config;

  _client = axios.create({
    baseURL: config.baseUrl,
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  _client.interceptors.request.use((req: InternalAxiosRequestConfig) => {
    const timestamp = Date.now().toString();

    // Build full endpoint: path + query params (Fonbnk signs the full endpoint)
    let endpoint = req.url || '';
    if (req.params && Object.keys(req.params).length > 0) {
      const qs = new URLSearchParams(req.params).toString();
      endpoint = `${endpoint}?${qs}`;
    }

    req.headers.set('x-client-id', config.clientId);
    req.headers.set('x-timestamp', timestamp);
    req.headers.set('x-signature', signRequest(config.clientSecret, timestamp, endpoint));

    return req;
  });

  // Response interceptor — log failures with URL + response body so on-ramp/off-ramp
  // 4xx/5xx errors are debuggable (default axios error message hides the URL).
  _client.interceptors.response.use(
    (resp) => resp,
    (err) => {
      // Use console.error so it shows up in Render logs even if the controller
      // doesn't surface the full error.
      const cfg = err?.config || {};
      const status = err?.response?.status;
      const body = err?.response?.data;
      // eslint-disable-next-line no-console
      console.error('[Fonbnk] request failed', {
        method: cfg.method,
        url: (cfg.baseURL || '') + (cfg.url || ''),
        status,
        responseBody: body,
      });
      return Promise.reject(err);
    },
  );

  return _client;
}

export function verifyWebhookSignature(body: string, signature: string): boolean {
  if (!_config) return false;

  const secretHash = crypto.createHash('sha256').update(_config.webhookSecret).digest('hex');
  const expected = crypto.createHash('sha256').update(secretHash + body).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function getFonbnkConfig(): FonbnkConfig {
  if (!_config) throw new Error('Fonbnk not configured');
  return _config;
}
