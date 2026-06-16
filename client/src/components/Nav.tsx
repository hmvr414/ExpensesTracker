import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  GMAIL_PENDING_REFRESH_EVENT,
  getGmailPendingCount,
} from '../api/gmail';

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/movements', label: 'Movements' },
  { to: '/import', label: 'Import from Image' },
  { to: '/categories', label: 'Categories' },
  { to: '/payment-methods', label: 'Payment Methods' },
  { to: '/settings/gmail', label: 'Gmail' },
] as const;

export function Nav() {
  const [pendingMovements, setPendingMovements] = useState(0);

  useEffect(() => {
    const baseTitle = document.title.replace(/^\(\d+\)\s*/, '');
    let mounted = true;

    async function loadCount() {
      try {
        const count = await getGmailPendingCount();
        if (!mounted) return;
        setPendingMovements(count.movements);
        document.title = count.movements > 0 ? `(${count.movements}) ${baseTitle}` : baseTitle;
      } catch {
        if (mounted) {
          setPendingMovements(0);
          document.title = baseTitle;
        }
      }
    }

    void loadCount();
    const interval = window.setInterval(loadCount, 5 * 60 * 1000);
    window.addEventListener(GMAIL_PENDING_REFRESH_EVENT, loadCount);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener(GMAIL_PENDING_REFRESH_EVENT, loadCount);
      document.title = baseTitle;
    };
  }, []);

  return (
    <aside className="w-56 bg-primary-950 flex flex-col flex-shrink-0 select-none">
      <div className="px-5 py-5 border-b border-primary-800/70">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center shadow-inner">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <div className="text-white font-semibold text-sm leading-tight">ExpenseTracker</div>
            <div className="text-primary-400 text-xs leading-tight">Personal Finance</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {links.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary-800/60 text-white'
                  : 'text-primary-300 hover:bg-primary-800/40 hover:text-primary-100',
              ].join(' ')
            }
          >
            <span className="flex-1">{label}</span>
            {to === '/import' && pendingMovements > 0 && (
              <span
                aria-label={`${pendingMovements} pending movements`}
                className="min-w-5 rounded-full bg-warning-500 px-1.5 py-0.5 text-center text-xs font-semibold text-primary-950"
              >
                {pendingMovements}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
