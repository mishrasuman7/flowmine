/**
 * SkillList — responsive grid of SkillCards with AnimatePresence so cards can
 * animate in (skill generated, PusherEvent name='skill-activated') or out
 * (transitioned to retired) without layout jumps.
 */
'use client';

import { AnimatePresence } from 'framer-motion';
import * as React from 'react';

import { SkillCard } from '@/components/SkillCard';
import type { Skill } from '@/lib/types';

interface SkillListProps {
  skills: Skill[];
}

export function SkillList({ skills }: SkillListProps) {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <AnimatePresence initial mode="popLayout">
        {skills.map((skill, idx) => (
          <li key={skill.skill_id} className="contents">
            <SkillCard skill={skill} index={idx} />
          </li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
