import { ProxyClient, ProxyError } from './proxy-client';

describe('ProxyClient', () => {
  afterEach(() => {
    delete window.leadershipPanel;
  });

  function stubFetch(body: unknown) {
    return spyOn(window, 'fetch').and.callFake(async () => new Response(JSON.stringify(body)));
  }

  it('sends X-Proxy-Secret on every request', async () => {
    window.leadershipPanel = {
      proxyBaseUrl: 'http://127.0.0.1:3100',
      proxySecret: 's3cret',
    } as never;
    const fetchSpy = stubFetch({ ok: true, data: { status: 'ok', version: '1' } });
    const client = new ProxyClient();

    await client.health();
    await client.put('/api/connection/token', { token: 'x' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.calls.all()) {
      expect((call.args[1]?.headers as Record<string, string>)['X-Proxy-Secret']).toBe('s3cret');
    }
    expect(fetchSpy.calls.mostRecent().args[1]?.method).toBe('PUT');
  });

  it('maps an error envelope to ProxyError', async () => {
    window.leadershipPanel = { proxyBaseUrl: 'http://127.0.0.1:3100', proxySecret: 'x' } as never;
    stubFetch({ ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } });

    await expectAsync(new ProxyClient().health()).toBeRejectedWith(
      jasmine.objectContaining({ code: 'UNAUTHORIZED' }),
    );
    expect(ProxyError).toBeDefined();
  });

  it('keeps the error details for the UI', async () => {
    window.leadershipPanel = { proxyBaseUrl: 'http://127.0.0.1:3100', proxySecret: 'x' } as never;
    const issues = [{ code: 'TEAM_NAME_DUPLICATE', path: 'teams[1].name', message: 'dup' }];
    stubFetch({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'invalid', details: { issues } } });

    await expectAsync(new ProxyClient().put('/api/config', {})).toBeRejectedWith(
      jasmine.objectContaining({ code: 'VALIDATION_FAILED', details: { issues } }),
    );
  });
});
