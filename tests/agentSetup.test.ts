import { describe, expect, it } from 'vitest';
import { cleanGeminiKey } from '../src/server/agentSetup.js';

describe('cleanGeminiKey', () => {
  it('keeps only the key from what people paste', () => {
    expect(cleanGeminiKey('  AIzaSyABC_def-123  \n')).toBe('AIzaSyABC_def-123');
    expect(cleanGeminiKey('"AIzaSyABC_def-123"')).toBe('AIzaSyABC_def-123');
    expect(cleanGeminiKey('GEMINI_API_KEY=AIzaSyABC_def-123')).toBe('AIzaSyABC_def-123');
    expect(cleanGeminiKey('export GEMINI_API_KEY="AIzaSy ABC_def-123"')).toBe('AIzaSyABC_def-123');
    expect(cleanGeminiKey('\uFEFFAQ.Ab8RN6abc.def')).toBe('AQ.Ab8RN6abc.def');
  });
});
