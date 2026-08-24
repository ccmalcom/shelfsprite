import { forwardInviteHash, inviteCallbackRedirect } from '../authRedirect';

describe('inviteCallbackRedirect', () => {
  it('forwards an invite hash to /auth/callback, preserving the fragment', () => {
    const hash = '#access_token=abc&refresh_token=xyz&type=invite&expires_in=3600';
    expect(inviteCallbackRedirect(hash)).toBe(
      '/auth/callback#access_token=abc&refresh_token=xyz&type=invite&expires_in=3600'
    );
  });

  it('forwards a password-recovery hash', () => {
    expect(inviteCallbackRedirect('#type=recovery&access_token=abc')).toBe(
      '/auth/callback#type=recovery&access_token=abc'
    );
  });

  it('forwards on an access_token even without a type', () => {
    expect(inviteCallbackRedirect('#access_token=abc')).toBe('/auth/callback#access_token=abc');
  });

  it('forwards an auth error hash so the callback page can render it', () => {
    const hash = '#error=access_denied&error_description=Email+link+is+invalid+or+has+expired';
    expect(inviteCallbackRedirect(hash)).toBe(`/auth/callback${hash}`);
  });

  it('accepts a hash without the leading #', () => {
    expect(inviteCallbackRedirect('type=invite&access_token=abc')).toBe(
      '/auth/callback#type=invite&access_token=abc'
    );
  });

  it('returns null for an empty hash', () => {
    expect(inviteCallbackRedirect('')).toBeNull();
    expect(inviteCallbackRedirect('#')).toBeNull();
  });

  it('returns null for a non-auth hash (e.g. an in-page anchor)', () => {
    expect(inviteCallbackRedirect('#section-2')).toBeNull();
    expect(inviteCallbackRedirect('#foo=bar')).toBeNull();
  });
});

describe('forwardInviteHash', () => {
  function stubLocation(hash: string) {
    const replace = jest.fn();
    return { loc: { hash, replace }, replace };
  }

  it('replaces the location with the callback URL for an invite hash', () => {
    const { loc, replace } = stubLocation('#access_token=abc123&type=invite&refresh_token=def');
    forwardInviteHash(loc);
    expect(replace).toHaveBeenCalledWith(
      '/auth/callback#access_token=abc123&type=invite&refresh_token=def'
    );
  });

  it('replaces the location for a recovery hash', () => {
    const { loc, replace } = stubLocation('#type=recovery&access_token=xyz');
    forwardInviteHash(loc);
    expect(replace).toHaveBeenCalledWith('/auth/callback#type=recovery&access_token=xyz');
  });

  it('replaces the location for an auth error hash so the callback page can render it', () => {
    const { loc, replace } = stubLocation('#error=access_denied&error_description=Invalid');
    forwardInviteHash(loc);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty hash', () => {
    const { loc, replace } = stubLocation('');
    forwardInviteHash(loc);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does nothing for an unrelated hash', () => {
    const { loc, replace } = stubLocation('#how-it-works');
    forwardInviteHash(loc);
    expect(replace).not.toHaveBeenCalled();
  });
});
