// src/posts/threads.ts
// Split over-long text into a thread at SENTENCE boundaries (never mid-word), keeping any trailing
// block of hashtags on the FINAL part, and counting with the network's own textUnit so the preview
// matches what actually posts. Returns the parts for the composer to show before the user agrees.
import type { CapabilityDescriptor } from '../providers/types';
import { measureText } from '../providers/validate';

export interface ThreadSplit { parts: string[] }

export function splitIntoThread(text: string, caps: CapabilityDescriptor): ThreadSplit {
  const limit = caps.maxTextLength;
  const len = (s: string) => measureText(s, caps.textUnit);
  if (len(text) <= limit) return { parts: [text] };

  // Peel off a trailing run of hashtags so it can ride on the last part.
  let body = text;
  let tail = '';
  const tailMatch = text.match(/(\s*(?:#[^\s#]+)(?:\s+#[^\s#]+)*\s*)$/u);
  if (tailMatch) {
    tail = tailMatch[1].trim();
    body = text.slice(0, text.length - tailMatch[1].length).trimEnd();
  }

  const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const sentences = [...seg.segment(body)].map((s) => s.segment.trim()).filter(Boolean);

  const parts: string[] = [];
  let cur = '';
  const flush = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };

  for (const sentence of sentences) {
    if (len(sentence) > limit) {
      // A single sentence longer than the limit: flush, then pack whole WORDS.
      flush();
      let wcur = '';
      for (const word of sentence.split(/(\s+)/)) {
        if (wcur && len(wcur + word) > limit) { parts.push(wcur.trim()); wcur = word.trimStart(); }
        else wcur += word;
      }
      cur = wcur.trim();
    } else if (cur && len(`${cur} ${sentence}`) > limit) {
      flush();
      cur = sentence;
    } else {
      cur = cur ? `${cur} ${sentence}` : sentence;
    }
  }
  flush();

  if (tail) {
    const last = parts.length - 1;
    if (last >= 0 && len(`${parts[last]} ${tail}`) <= limit) parts[last] = `${parts[last]} ${tail}`;
    else parts.push(tail);
  }

  return { parts: parts.length ? parts : [text] };
}
