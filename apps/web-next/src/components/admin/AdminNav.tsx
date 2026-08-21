'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/hooks/use-t';
import { Users, MessageSquare, Key, Blocks, Sparkles, Banknote, ToggleRight, Bell, LayoutDashboard, Handshake } from 'lucide-react';

// labelKey, not label: this array is evaluated at module scope, where there is
// no request and therefore no translator. The label is resolved inside the
// component, per render.
const adminTabs = [
  { labelKey: 'admin_ui.nav_overview', href: '/admin/overview', icon: LayoutDashboard },
  { labelKey: 'admin_ui.nav_users', href: '/admin/users', icon: Users },
  { labelKey: 'admin_ui.nav_sales_reps', href: '/admin/sales-reps', icon: Handshake },
  { labelKey: 'admin_ui.nav_notifications', href: '/admin/notifications', icon: Bell },
  { labelKey: 'admin_ui.nav_plugins', href: '/admin/plugins', icon: Blocks },
  { labelKey: 'admin_ui.nav_skills', href: '/admin/skills', icon: Sparkles },
  { labelKey: 'admin_ui.nav_payroll', href: '/admin/payroll', icon: Banknote },
  { labelKey: 'admin_ui.nav_config', href: '/admin/config', icon: ToggleRight },
  { labelKey: 'admin_ui.nav_feedback', href: '/admin/feedback', icon: MessageSquare },
  { labelKey: 'admin_ui.nav_secrets', href: '/admin/secrets', icon: Key },
];

export function AdminNav() {
  const pathname = usePathname();
  const t = useT();

  return (
    <div className="flex items-center gap-1 border-b border-border mb-6 pb-0">
      {adminTabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
              isActive
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
            }`}
          >
            <Icon size={16} />
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
