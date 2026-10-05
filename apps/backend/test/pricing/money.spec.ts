import { describe, expect, it } from 'vitest';
import { compare, currencyExponent, format, fromMinorUnits, multiply, parseAmount, sum, dec } from '../../src/pricing/money.js';

describe('money', () => {
  it('parses provider amounts exactly and treats unknown as null, never zero', () => {
    expect(parseAmount('9.68')).toBe('9.68');
    expect(parseAmount('13000.0000')).toBe('13000.00');
    expect(parseAmount(10.95)).toBe('10.95');
    expect(parseAmount('1,299.00')).toBe('1299.00');
    expect(parseAmount('$19.99', { stripSymbol: true })).toBe('19.99');
    expect(parseAmount('-19.99', { stripSymbol: true })).toBeNull();
    expect(parseAmount('$-19.99', { stripSymbol: true })).toBeNull();
    expect(parseAmount('\u221219.99', { stripSymbol: true })).toBeNull();
    expect(parseAmount('19.99-', { stripSymbol: true })).toBeNull();
    expect(parseAmount('--')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount(-1)).toBeNull();
    expect(parseAmount('9,68')).toBeNull();
    expect(parseAmount(Number.NaN)).toBeNull();
  });

  it('converts minor units with the ISO 4217 exponent', () => {
    expect(fromMinorUnits(1199, 'USD')).toBe('11.99');
    expect(fromMinorUnits(1500, 'JPY')).toBe('1500.00');
    expect(fromMinorUnits(12345, 'TND')).toBe('12.345');
    expect(currencyExponent('JPY')).toBe(0);
    expect(fromMinorUnits('12.5', 'USD')).toBeNull();
  });

  it('adds and multiplies without floating point error', () => {
    expect(sum('0.10', '0.20')).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sum('9.99', '9.99', '9.99')).toBe('29.97');
    expect(multiply('11.08', 3)).toBe('33.24');
    expect(multiply('19.99', '0.9312')).toBe('18.614688');
    expect(sum('1.00', null)).toBeNull();
    expect(multiply(null, 2)).toBeNull();
    expect(compare('10.10', '10.1')).toBe(0);
    expect(compare('2', '10')).toBeLessThan(0);
    expect(format(dec('1e3'))).toBe('1000.00');
  });
});
