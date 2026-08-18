import React from 'react';
import type { NextMoment } from './types';
import { useI18n } from '@naap/plugin-sdk';

interface Props { moments: NextMoment[]; }

export const NextMomentsList: React.FC<Props> = ({ moments }) => {
  const { t } = useI18n();
  if (moments.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('dashboard.no_upcoming')}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {moments.map((m, i) => (
        <li key={i} className="text-sm font-medium text-foreground">{m.label}</li>
      ))}
    </ul>
  );
};
