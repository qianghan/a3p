import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { TelegramCard } from '../components/TelegramCard';

export const TelegramSettingsPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <button
        onClick={() => navigate('/settings')}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Settings
      </button>
      <TelegramCard />
    </div>
  );
};
