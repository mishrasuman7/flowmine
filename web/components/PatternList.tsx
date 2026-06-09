/**
 * PatternList — responsive grid of PatternCards with a wrapping
 * AnimatePresence so cards can animate in (new pattern detected) or out
 * (skill generated, status flips to reviewed) without layout jumps.
 */
'use client';

import { AnimatePresence } from 'framer-motion';
import * as React from 'react';

import { PatternCard } from '@/components/PatternCard';
import type { PatternWithUsers } from '@/lib/types';

interface PatternListProps {
  patterns: PatternWithUsers[];
}

export function PatternList({ patterns }: PatternListProps) {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <AnimatePresence initial mode="popLayout">
        {patterns.map((pattern, idx) => (
          <li key={pattern.pattern_id} className="contents">
            <PatternCard pattern={pattern} index={idx} />
          </li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
