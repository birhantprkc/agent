import { describe, expect, it } from 'vitest';
import { privateHostReason } from './privateHost.js';

describe('privateHostReason', () => {
  it('flags compressed loopback and unspecified IPv6', async () => {
    expect(await privateHostReason('::1')).toBe('loopback IPv6');
    expect(await privateHostReason('::')).toBe('unspecified IPv6');
  });

  it('flags fully expanded loopback (was a silent gate bypass)', async () => {
    expect(await privateHostReason('0:0:0:0:0:0:0:1')).toBe('loopback IPv6');
    expect(await privateHostReason('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(
      'loopback IPv6',
    );
  });

  it('flags expanded IPv4-mapped private addresses', async () => {
    expect(await privateHostReason('0:0:0:0:0:ffff:127.0.0.1')).toMatch(/loopback/i);
    expect(await privateHostReason('0:0:0:0:0:ffff:a9fe:a9fe')).toMatch(/link-local|metadata/i);
    expect(await privateHostReason('::ffff:127.0.0.1')).toMatch(/loopback/i);
    expect(await privateHostReason('::ffff:a9fe:a9fe')).toMatch(/link-local|metadata/i);
  });

  it('flags expanded unique-local and link-local', async () => {
    expect(await privateHostReason('fc00:0:0:0:0:0:0:1')).toBe('unique-local IPv6');
    expect(await privateHostReason('fe80:0:0:0:0:0:0:1')).toBe('link-local IPv6');
  });

  it('does not flag public IPv6', async () => {
    expect(await privateHostReason('2001:4860:4860::8888')).toBe('');
    expect(await privateHostReason('2606:4700:4700::1111')).toBe('');
  });

  it('still flags classic private IPv4', async () => {
    expect(await privateHostReason('127.0.0.1')).toBe('loopback IPv4');
    expect(await privateHostReason('169.254.169.254')).toMatch(/metadata|link-local/i);
    expect(await privateHostReason('10.0.0.1')).toMatch(/RFC1918/i);
  });
});
