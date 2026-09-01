// Phone-number extraction from the paired WhatsApp account.
//
// This is what the studio owner sees under "🟢 WhatsApp Connected", so a wrong
// answer is visible and alarming — it looks like the wrong account was linked.

import { describe, it, expect } from 'vitest';
import { extractPhoneE164 } from '../domain/baileysConnector.js';

describe('extractPhoneE164', () => {
  it('prefers the PN field over the id', () => {
    expect(extractPhoneE164({ id: '123456789@lid', phoneNumber: '919876543210' })).toBe(
      '+919876543210',
    );
  });

  it('parses a phone-format JID, stripping the device suffix', () => {
    expect(extractPhoneE164({ id: '919876543210:12@s.whatsapp.net' })).toBe('+919876543210');
    expect(extractPhoneE164({ id: '919876543210@s.whatsapp.net' })).toBe('+919876543210');
  });

  it('returns null for a LID rather than showing it as a phone number', () => {
    // In Baileys 7 `user.id` is often a LID, which is NOT a phone number.
    // Rendering it would show a studio owner a number they do not recognise
    // next to "Connected" — worse than showing no number at all.
    expect(extractPhoneE164({ id: '188889999000111@lid' })).toBeNull();
  });

  it('returns null rather than guessing when there is nothing usable', () => {
    expect(extractPhoneE164(undefined)).toBeNull();
    expect(extractPhoneE164({})).toBeNull();
    expect(extractPhoneE164({ id: '' })).toBeNull();
  });

  it('rejects digit strings that cannot be a phone number', () => {
    // E.164 allows at most 15 digits and no real number is under 8.
    expect(extractPhoneE164({ phoneNumber: '12345' })).toBeNull();
    expect(extractPhoneE164({ phoneNumber: '1234567890123456789' })).toBeNull();
  });

  it('normalises punctuation in a supplied number', () => {
    expect(extractPhoneE164({ phoneNumber: '+91 98765-43210' })).toBe('+919876543210');
  });
});
