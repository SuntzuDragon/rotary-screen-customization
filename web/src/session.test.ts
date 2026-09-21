import { describe, expect, it } from 'vitest';
import { parseSession } from './api';

// The dial hands the page a settings URL over Improv. The page adopts the
// device id and secret from it -- so a URL that is not our own must never be
// taken as a session.
const HERE = 'https://hdog.imcb.dev/';

describe('parseSession', () => {
  it('reads the id and secret from our own settings URL', () => {
    expect(parseSession('https://hdog.imcb.dev/#d=abcd1234&k=s3cret', HERE)).toEqual({
      id: 'abcd1234',
      key: 's3cret',
    });
  });

  it('accepts a relative URL, which resolves to this origin', () => {
    expect(parseSession('/#d=abcd1234&k=s3cret', HERE)).toEqual({ id: 'abcd1234', key: 's3cret' });
  });

  it('refuses a URL on another origin', () => {
    expect(parseSession('https://evil.example/#d=abcd1234&k=s3cret', HERE)).toBeNull();
    expect(parseSession('http://hdog.imcb.dev/#d=abcd1234&k=s3cret', HERE)).toBeNull(); // scheme
    expect(parseSession('https://hdog.imcb.dev.evil.example/#d=a&k=b', HERE)).toBeNull();
  });

  // A javascript: URL has origin "null". It once failed the origin check and
  // then executed in a fallback path; it must simply be refused.
  it('refuses a javascript: URL', () => {
    expect(
      parseSession('javascript:alert(document.cookie)//#d=abcd1234&k=s3cret', HERE),
    ).toBeNull();
  });

  it('refuses a URL missing the id or the secret', () => {
    expect(parseSession('https://hdog.imcb.dev/#d=abcd1234', HERE)).toBeNull();
    expect(parseSession('https://hdog.imcb.dev/#k=s3cret', HERE)).toBeNull();
    expect(parseSession('https://hdog.imcb.dev/', HERE)).toBeNull();
  });

  it('refuses something that is not a URL at all', () => {
    expect(parseSession('http://[not a url', HERE)).toBeNull();
  });
});
