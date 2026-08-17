/**
 * Route selection and the wire format of both OTP protocols.
 *
 * Everything asserted here was measured against the live server, and each one
 * replaced a plausible belief that turned out to be false:
 *
 *  - the route is decided by whether the handoff DECODES to a LaunchTicket, not
 *    by the handoff being present (600309/A2 has one and belongs on legacy);
 *  - step 5's SecretCode comes from the portal's cookie, not from the value
 *    `get_cookies.ashx` returns — they differ, and only the cookie is accepted;
 *  - `generic_handlers` calls need a Referer, and the long poll must be bounded
 *    once they have one.
 *
 * These are wiring tests because that is where the failures were: every step
 * answered HTTP 200 while refusing to work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The v2 refusal path consults the launcher-identity check, which reaches the
// network. The suite stays offline, so it is stubbed — and asserted, because a
// refusal we cannot read is exactly when that line has to be in the log.
const ggmVerdict = vi.hoisted(() => vi.fn(() => Promise.resolve({ status: 'aligned', line: 'STUB VERDICT' })));
vi.mock('../src/beanfun/ggmCheck.js', () => ({ ggmVerdict }));

import type { BeanfunClient } from '../src/beanfun/client.js';
import { GGM_CV, GGM_HASH } from '../src/beanfun/clientIntegrity.js';
import { getOtp } from '../src/beanfun/otp.js';
import { encryptHex } from '../src/beanfun/wcdes.js';
import {
  encodeLaunchData,
  launchPlaintext,
  legacyPlaintext,
  SAMPLE_PPPPP,
  SAMPLE_TICKET,
} from './helpers/launchBlob.js';
import type { ServiceAccount, Session } from '../src/beanfun/types.js';

const SESSION: Session = {
  region: 'TW',
  skey: 'k',
  webToken: 'web-token',
  accountId: '',
  serviceCode: '600309',
  serviceRegion: 'A2',
};

const ACCOUNT = {
  sid: 'A29d3e4eda9991991514',
  ssn: '12345',
  sname: 'char',
  screatetime: '2011-08-22 20:02:08',
} as ServiceAccount;

const BLOB = encodeLaunchData(3, '1a2b3c4d', launchPlaintext(SAMPLE_TICKET));

/** Step 1's page on the migrated route. */
const MIGRATED_PAGE = `
  <html><script>
  var m_objData = {
      "region": "TW;Production",
      "sn": "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
      "data": "${BLOB}"
  };
  </script></html>`;

/** A page whose handoff decodes fine but carries no ticket — 600309/A2's shape.
 *  It still has the legacy literals, because that is the route it belongs on. */
const NO_TICKET_PAGE = `
  <html><script>
  var m_objData = { "sn": "SN-2", "data": "${encodeLaunchData(11, '1a2b3c4d', legacyPlaintext())}" };
  x = "GetResultByLongPolling&key=LPK123"
  y = MyAccountData.ServiceAccountCreateTime + "unk=val";
  </script></html>`;

/** Step 1's page before migration — carries the literals the legacy flow reads. */
const LEGACY_PAGE = `
  <html><script>
  x = "GetResultByLongPolling&key=LPK123"
  y = MyAccountData.ServiceAccountCreateTime + "unk=val";
  </script></html>`;

/** The portal's own `bfSecretCode` cookie — what step 5 is actually validated
 *  against, and NOT what `get_cookies.ashx` hands back. */
const COOKIE_SECRET = 'cookie-secret-value';

/** The OTP as the server hands it back: 8-char ASCII key then cipher hex. */
const OTP_PLAINTEXT = 'A1B2C3D4';
const OTP_KEY = 'ABCDEFGH';
const OTP_DATA = OTP_KEY + encryptHex(OTP_PLAINTEXT, OTP_KEY);

interface Call {
  url: string;
  opts: {
    headers?: Record<string, string>;
    json?: Record<string, unknown>;
    timeout?: { request?: number };
  };
}

/** Records every request; answers step 1 with `page` and the v2 POST with `v2`.
 *  `failOn` makes any URL containing that fragment throw, like a 5xx would. */
function recordingClient(
  page: string,
  v2: unknown,
  failOn?: string,
): { client: BeanfunClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (url: string): unknown => {
    if (url.includes('get_webstart_otp_v2.ashx')) return v2;
    if (url.includes('game_start_step2.aspx')) return page;
    if (url.includes('get_cookies.ashx')) return "var m_strSecretCode = 'SECRET';";
    return '';
  };
  const handler = (url: string, opts: Call['opts'] = {}): Promise<unknown> => {
    calls.push({ url, opts });
    if (failOn && url.includes(failOn)) return Promise.reject(new Error('upstream blew up'));
    const body = respond(url);
    return Promise.resolve({
      statusCode: 200,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      url,
    });
  };
  return {
    calls,
    client: {
      http: { get: handler, post: handler },
      readSecretCode: () => Promise.resolve(COOKIE_SECRET),
      readBfWebToken: () => Promise.resolve('web-token'),
    } as unknown as BeanfunClient,
  };
}

const called = (calls: Call[], fragment: string): Call | undefined =>
  calls.find((c) => c.url.includes(fragment));

// getOtp now reports its route decision. Captured rather than printed so the
// suite stays readable, and asserted where the decision is the point.
let logged: string[];
beforeEach(() => {
  logged = [];
  const record = (...a: unknown[]): void => void logged.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
});
afterEach(() => vi.restoreAllMocks());

describe('getOtp — v2 route', () => {
  it('POSTs the launch ticket and decrypts the reply', async () => {
    const { client, calls } = recordingClient(MIGRATED_PAGE, {
      result: 1,
      data: OTP_DATA,
      message: null,
    });

    expect(await getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).toBe(OTP_PLAINTEXT);

    const post = called(calls, 'get_webstart_otp_v2.ashx');
    expect(post?.opts.json).toEqual({
      SN: '3F2504E0-4F89-11D3-9A0C-0305E82C3301',
      LaunchTicket: SAMPLE_TICKET,
      CV: GGM_CV,
      Hash: GGM_HASH,
      arch: expect.stringMatching(/^x(64|86)$/) as unknown as string,
    });
  });

  it('never touches the retired endpoint', async () => {
    const { client, calls } = recordingClient(MIGRATED_PAGE, { result: 1, data: OTP_DATA });
    await getOtp(client, SESSION, ACCOUNT, '600309', 'A2');

    // `get_webstart_otp.ashx` is a prefix of the v2 path, so match on the query
    // shape only the legacy GET has.
    expect(calls.some((c) => c.url.includes('ppppp='))).toBe(false);
    // No secret code and no long poll on this route.
    expect(called(calls, 'get_cookies.ashx')).toBeUndefined();
    expect(called(calls, 'get_result.ashx')).toBeUndefined();
  });

  it("names step 1's page as the Referer on the v2 POST", async () => {
    const { client, calls } = recordingClient(MIGRATED_PAGE, { result: 1, data: OTP_DATA });
    await getOtp(client, SESSION, ACCOUNT, '600309', 'A2');

    const step1Url = calls[0]!.url;
    expect(step1Url).toContain('game_start_step2.aspx');
    expect(called(calls, 'get_webstart_otp_v2.ashx')?.opts.headers?.referer).toBe(step1Url);
  });

  it('still delivers the OTP when recording the start fails', async () => {
    // A migrated page may not carry the fields record_service_start wants, and
    // nothing downstream depends on it — it must not cost the user their OTP.
    const { client } = recordingClient(
      MIGRATED_PAGE,
      { result: 1, data: OTP_DATA },
      'record_service_start',
    );
    expect(await getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).toBe(OTP_PLAINTEXT);
  });

  it('reports the launcher identity beside a refusal it cannot read', async () => {
    // Without this, a rejected CV/Hash pair looks like any other refusal and the
    // one question worth asking gets asked days later, by hand.
    const { client } = recordingClient(MIGRATED_PAGE, { result: 0, message: '???' });
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    expect(ggmVerdict).toHaveBeenCalled();
    expect(logged.join('\n')).toContain('STUB VERDICT');
  });

  it("surfaces the server's own refusal", async () => {
    const { client } = recordingClient(MIGRATED_PAGE, {
      result: 0,
      data: null,
      message: '帳號狀態異常',
    });
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toMatchObject({
      code: 'otp.server_rejected',
      message: '帳號狀態異常',
    });
  });

  it('reports a refusal with no message rather than an empty string', async () => {
    const { client } = recordingClient(MIGRATED_PAGE, { result: 0, data: null, message: null });
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrowError(/result=0/);
  });

  it('does not relay a non-JSON body', async () => {
    const { client } = recordingClient(MIGRATED_PAGE, '<html>Err Msg</html>');
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toMatchObject({
      code: 'otp.empty_response',
    });
  });
});

describe('getOtp — route selection', () => {
  it('takes the legacy route when the page carries no handoff', async () => {
    const { client, calls } = recordingClient(LEGACY_PAGE, {});
    // The legacy step 5 answers '' here, which fails at the envelope — we only
    // care that the legacy steps were attempted at all.
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toMatchObject({
      code: 'otp.empty_response',
    });

    expect(called(calls, 'get_cookies.ashx')).toBeDefined();
    expect(called(calls, 'get_result.ashx')).toBeDefined();
    expect(called(calls, 'ppppp=')).toBeDefined();
  });

  it('falls back to legacy when the handoff carries no LaunchTicket', async () => {
    // 600309/A2's real shape: `m_objData` is present and decodes perfectly, but
    // its payload is the legacy parameter set. Routing on the literal's mere
    // presence sent these pages at an endpoint with nothing to trade.
    const { client, calls } = recordingClient(NO_TICKET_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    expect(called(calls, 'get_webstart_otp_v2.ashx')).toBeUndefined();
    expect(called(calls, 'get_cookies.ashx')).toBeDefined();
  });

  it("sends the page's own ppppp rather than the historical constant", async () => {
    const { client, calls } = recordingClient(NO_TICKET_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    const legacy = called(calls, 'ppppp=');
    expect(legacy?.url).toContain(`ppppp=${SAMPLE_PPPPP}`);
    expect(legacy?.url).not.toContain('ppppp=1F552AEA');
  });

  it("sends the portal's cookie secret, not the one get_cookies.ashx returns", async () => {
    // Measured against the live server: the newlogin page's m_strSecretCode is
    // a different value from the portal's bfSecretCode cookie, and step 5 is
    // validated against the cookie. Sending the page's yields
    // "Secret codes do not match!"; sending the cookie's yields the envelope.
    const { client, calls } = recordingClient(LEGACY_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    const legacy = called(calls, 'ppppp=');
    expect(legacy?.url).toContain(`SecretCode=${COOKIE_SECRET}`);
    expect(legacy?.url).not.toContain('SecretCode=SECRET&');
  });

  it('sends no Referer on the legacy chain', async () => {
    // Measured, not assumed: record_service_start answers Success without one,
    // and step 5 returns the envelope without one. get_result.ashx does want it
    // — and giving it one makes it hold the connection open for an answer we
    // discard, so the header stays off deliberately.
    const { client, calls } = recordingClient(LEGACY_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    for (const call of calls) {
      expect(call.opts.headers?.referer, call.url).toBeUndefined();
    }
  });

  it('does not let the long poll stall the OTP', async () => {
    // get_result.ashx holds the connection open and step 5 does not need it —
    // a failure there must not surface as a failed OTP.
    const { client, calls } = recordingClient(LEGACY_PAGE, {}, 'get_result.ashx');
    // Still fails, but at the envelope (step 5 answered ''), not at step 4.
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toMatchObject({
      code: 'otp.empty_response',
    });
    expect(called(calls, 'ppppp=')).toBeDefined();
  });

  it('bounds how long the long poll may hold the request', async () => {
    const { client, calls } = recordingClient(LEGACY_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    const poll = called(calls, 'get_result.ashx');
    expect(poll?.opts.timeout?.request).toBeLessThanOrEqual(10_000);
  });

  it('logs which route it took, and why', async () => {
    // The single question a whole day of investigation came down to, and the
    // answer was nowhere in the logs.
    const { client } = recordingClient(NO_TICKET_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    expect(logged.join('\n')).toContain('600309_A2 -> legacy');
    expect(logged.join('\n')).toContain('no LaunchTicket');
  });

  it('warns loudly when a handoff is present but cannot be decoded', async () => {
    // The signature of the decode tables having changed inside the launcher
    // DLL. Silently falling back to legacy would surface as an unrelated
    // `Query String Error` on a migrated game, with the real cause nowhere.
    const undecodable = `
      <html><script>
      var m_objData = { "sn": "SN-3", "data": "0${'abcdef01'.repeat(21)}" };
      x = "GetResultByLongPolling&key=LPK123"
      y = MyAccountData.ServiceAccountCreateTime + "unk=val";
      </script></html>`;
    const { client } = recordingClient(undecodable, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    const out = logged.join('\n');
    expect(out).toContain('could NOT be decoded');
    expect(out).toContain('decode tables likely changed');
  });

  it('declares the launcher build on the legacy route too', async () => {
    // GGM 1.5.x appends CV/Hash/arch to the legacy GET and the server now
    // rejects requests that omit it, so the fallback must not be born doomed.
    const { client, calls } = recordingClient(LEGACY_PAGE, {});
    await expect(getOtp(client, SESSION, ACCOUNT, '600309', 'A2')).rejects.toThrow();

    const legacy = called(calls, 'ppppp=');
    expect(legacy?.url).toContain(`&CV=${GGM_CV}`);
    expect(legacy?.url).toContain(`&Hash=${GGM_HASH}`);
  });
});
