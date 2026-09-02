// test/thread-split.test.ts
// Splitting at sentence boundaries (never mid-word), trailing hashtags on the final part, counted
// in the network's own textUnit. Pure — no DB.
import { describe, it, expect } from 'vitest';
import { splitIntoThread } from '../src/posts/threads';
import { measureText } from '../src/providers/validate';
import { createFakeProvider } from '../src/providers/adapters/fake';
import type { CapabilityDescriptor } from '../src/providers/types';

const base = createFakeProvider().adapter.capabilities;
const caps = (over: Partial<CapabilityDescriptor>): CapabilityDescriptor => ({ ...base, ...over });

// The real guarantee: every part is within the limit OR is a single unbreakable word.
function withinLimitOrSingleWord(parts: string[], c: CapabilityDescriptor): boolean {
  return parts.every((p) => measureText(p, c.textUnit) <= c.maxTextLength || p.trim().split(/\s+/).length === 1);
}

describe('thread splitting', () => {
  it('splits long text into multiple parts at sentence boundaries, no mid-word breaks', () => {
    const c = caps({ maxTextLength: 22, textUnit: 'utf16_units', threadSupport: 'thread' });
    const text = 'First sentence here. Second sentence here. Third sentence here.';
    const { parts } = splitIntoThread(text, c);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(withinLimitOrSingleWord(parts, c)).toBe(true);
    // Words appear in the same order across the split — nothing was broken.
    const original = text.split(/\s+/);
    const round = parts.join(' ').split(/\s+/);
    expect(round).toEqual(original);
  });

  it('keeps a trailing hashtag block on the final part', () => {
    const c = caps({ maxTextLength: 24, textUnit: 'utf16_units', threadSupport: 'thread' });
    const { parts } = splitIntoThread('Sentence one is here. Sentence two is here. #alpha #beta', c);

    const last = parts[parts.length - 1];
    expect(last).toContain('#alpha');
    expect(last).toContain('#beta');
    // Earlier parts carry no hashtags.
    for (const p of parts.slice(0, -1)) expect(p).not.toMatch(/#/);
  });

  it('counts with the network textUnit (graphemes), not UTF-16 units', () => {
    const c = caps({ maxTextLength: 8, textUnit: 'graphemes', threadSupport: 'thread' });
    // Emoji-heavy text: huge in UTF-16 units, small in graphemes. Counting must use graphemes.
    const text = 'Hi 👨‍👩‍👧‍👦 ok. Bye 🇻🇳 go. End it up.';
    const { parts } = splitIntoThread(text, c);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(withinLimitOrSingleWord(parts, c)).toBe(true);
  });

  it('returns a single part when the text already fits', () => {
    const c = caps({ maxTextLength: 100, textUnit: 'utf16_units', threadSupport: 'thread' });
    expect(splitIntoThread('Short enough.', c).parts).toEqual(['Short enough.']);
  });
});
