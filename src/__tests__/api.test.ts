import { describe, it, expect } from 'vitest';
import { isPrivateHost } from '../api';

describe('isPrivateHost', () => {
  // -- Should block --

  it('blocks localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
  });

  it('blocks 127.0.0.1', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
  });

  it('blocks 0.0.0.0', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
  });

  it('blocks IPv6 unspecified ::', () => {
    expect(isPrivateHost('::')).toBe(true);
  });

  it('blocks 10.x.x.x (class A private)', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('blocks 192.168.x.x (class C private)', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true);
    expect(isPrivateHost('192.168.100.200')).toBe(true);
  });

  it('blocks 172.16-31.x.x (class B private)', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
  });

  it('blocks 169.254.x.x (link-local / cloud metadata)', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('169.254.0.1')).toBe(true);
  });

  it('blocks .local domains', () => {
    expect(isPrivateHost('myserver.local')).toBe(true);
  });

  it('blocks .internal domains', () => {
    expect(isPrivateHost('db.internal')).toBe(true);
  });

  // -- Should allow --

  it('allows public domains', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('google.com')).toBe(false);
    expect(isPrivateHost('api.stripe.com')).toBe(false);
  });

  it('allows public IPs', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
  });

  it('allows 172.x outside private range', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('allows 192.x that is not 192.168', () => {
    expect(isPrivateHost('192.0.2.1')).toBe(false);
  });
});
