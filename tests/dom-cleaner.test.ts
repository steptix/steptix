import { describe, it, expect } from 'vitest';
import { cleanHtmlString } from '../src/browser/dom-cleaner.js';

describe('cleanHtmlString', () => {
  it('extracts button elements', () => {
    const html = `<div><button type="submit">Sign In</button></div>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<button');
    expect(result).toContain('Sign In');
  });

  it('extracts input elements', () => {
    const html = `<form><input type="email" name="email" placeholder="you@example.com"></form>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<input');
    expect(result).toContain('type="email"');
  });

  it('extracts anchor elements', () => {
    const html = `<nav><a href="/dashboard">Dashboard</a></nav>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<a');
    expect(result).toContain('Dashboard');
  });

  it('extracts select elements', () => {
    const html = `<select name="month"><option value="1">January</option></select>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<select');
  });

  it('extracts textarea elements', () => {
    const html = `<textarea name="notes" placeholder="Enter notes"></textarea>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<textarea');
  });

  it('skips inputs with type="hidden"', () => {
    const html = `<input type="hidden" name="csrf" value="abc123"><input type="text" name="user">`;
    const result = cleanHtmlString(html);
    expect(result).not.toContain('name="csrf"');
    expect(result).toContain('name="user"');
  });

  it('skips elements with display:none', () => {
    const html = `<button style="display:none">Hidden</button><button>Visible</button>`;
    const result = cleanHtmlString(html);
    expect(result).not.toContain('Hidden');
    expect(result).toContain('Visible');
  });

  it('skips elements with visibility:hidden', () => {
    const html = `<button style="visibility:hidden">Invisible</button><button>OK</button>`;
    const result = cleanHtmlString(html);
    expect(result).not.toContain('Invisible');
    expect(result).toContain('OK');
  });

  it('returns empty string for html with no interactive elements', () => {
    const html = `<div><p>Just a paragraph</p><span>Some text</span></div>`;
    const result = cleanHtmlString(html);
    expect(result).toBe('');
  });

  it('extracts form elements', () => {
    const html = `<form id="login-form" action="/login" method="post"><input type="text"></form>`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<form');
  });

  it('extracts label elements', () => {
    const html = `<label for="email">Email address</label><input type="email" id="email">`;
    const result = cleanHtmlString(html);
    expect(result).toContain('<label');
    expect(result).toContain('Email address');
  });

  it('handles multiple elements on separate lines', () => {
    const html = `
      <form>
        <input type="email" name="email">
        <input type="password" name="password">
        <button type="submit">Sign In</button>
      </form>
    `;
    const result = cleanHtmlString(html);
    const lines = result.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('normalises whitespace in extracted elements', () => {
    const html = `<button   type="submit"   class="btn">   Sign   In   </button>`;
    const result = cleanHtmlString(html);
    // Each extracted element should be a single cleaned line
    expect(result).not.toMatch(/\s{2,}/);
  });
});
